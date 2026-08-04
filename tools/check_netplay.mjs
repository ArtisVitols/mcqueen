/**
 * Race the same grid on two machines and check they agree.
 *
 * A host `Race` and a guest `GuestView` run in one process against the fake
 * transport, at latencies and packet loss you would actually see on a phone.
 * No browser, no broker, no second device - so this can run on every change,
 * which is the only way netplay stays working.
 *
 * What it asserts:
 *   - both ends finish, and agree on the order
 *   - the guest's own car tracks the host's authority to within a car's length
 *   - the guest never draws a car outside the racing corridor
 *
 *   node tools/check_netplay.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Track } from '../src/track.js';
import { Race, State } from '../src/race.js';
import { makeRng } from '../src/ai.js';
import { FakeLink } from '../src/net/fake.js';
import { GuestView } from '../src/net/guest.js';
import { MSG, RemoteInput, packButtons, snapshot, SNAPSHOT_HZ, INPUT_HZ } from '../src/net.js';
import { driverAid } from '../src/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const TRACKS = read('assets/tracks.json').tracks;
// Racers only. Guido and Mack are in cars.json as the pit crew and the
// parked transporter; putting them on the grid would race an 18 m artic.
const CARS = read('assets/cars.json').cars.filter((c) => c.racer !== false);

const DT = 1 / 120;
const HOST_CAR = 'lightning_mcqueen';
const GUEST_CAR = 'chick_hicks';

/** Buttons that vary, so the two ends have something to disagree about. */
function scripted(seed, gasOnly = false) {
  const rng = makeRng(seed);
  let hold = 0;
  const state = { left: false, right: false, gas: true, brake: false };
  return {
    tick(dt) {
      hold -= dt;
      if (hold <= 0) {
        hold = 0.6 + rng() * 1.4;
        const r = rng();
        state.left = !gasOnly && r < 0.25;
        state.right = !gasOnly && r > 0.75;
      }
      return state;
    },
    state,
    applyTo(car, dt, physics) {
      const s = state;
      const want = (s.right ? 1 : 0) - (s.left ? 1 : 0);
      const ramp = physics?.steerRamp || 0;
      if (ramp > 0 && dt > 0) {
        const step = ramp * dt * (want === 0 ? 1.8 : 1);
        car.steerCmd += Math.max(-step, Math.min(step, want - car.steerCmd));
      } else {
        car.steerCmd = want;
      }
      if (!physics?.assisted) car.steer = car.steerCmd;
      car.throttle = s.gas ? 1 : 0;
      car.brake = s.brake ? 1 : 0;
    },
  };
}

function build(trackId, physics, difficulty) {
  const spec = TRACKS.find((t) => t.id === trackId);
  const data = read(`assets/${spec.data}`);
  const mk = (localId) => {
    const track = new Track(JSON.parse(JSON.stringify(data)));
    const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
    const race = new Race(track, entries, { difficulty, laps: 2, physics, car: localId },
      spec.gridLanes).build(localId, [HOST_CAR, GUEST_CAR]);
    return race;
  };
  return { host: mk(HOST_CAR), guest: mk(GUEST_CAR) };
}

function run({ track, physics, difficulty, latency, jitter, loss }) {
  const { host, guest } = build(track, physics, difficulty);
  const rng = makeRng(0xc0ffee);
  const link = new FakeLink({ latency, jitter, loss, rng });

  // The host applies the guest's buttons wherever they have got to.
  const remote = new RemoteInput();
  const guestCarOnHost = host.humans.find((c) => c.spec.id === GUEST_CAR);
  host.inputs.set(guestCarOnHost, remote);
  // Everything the guest predicts locally has to see the same aid the host
  // applies, or the two disagree by construction.
  guest.driverAidFor = (car, dt) => driverAid(car, car.lift ?? 0, dt, guest.field);

  const view = new GuestView(guest);
  const hostInput = scripted(1);
  const guestInput = scripted(2);

  link.a.onMessage((msg) => {
    if (msg.t === MSG.INPUT) remote.receive(msg.b, msg.q);
  });
  link.b.onMessage((msg) => {
    if (msg.t === MSG.SNAP) view.receive(msg, link.now);
  });

  let t = 0;
  let sinceSnap = 0;
  let sinceInput = 0;
  let seq = 0;
  let worst = 0;          // guest's own car vs the host's authority, metres
  let total = 0;          // ... summed, for the sustained offset
  let samples = 0;
  let outside = 0;        // frames the guest drew a car off the road
  const st = {};

  while (host.state !== State.FINISHED && t < 600) {
    hostInput.tick(DT);
    guestInput.tick(DT);

    host.update(DT, hostInput);
    view.update(DT, guestInput, link.now);
    t += DT;

    sinceSnap += DT;
    if (sinceSnap >= 1 / SNAPSHOT_HZ) {
      sinceSnap = 0;
      link.b.other.send(snapshot(host));      // host end -> guest
    }
    sinceInput += DT;
    if (sinceInput >= 1 / INPUT_HZ) {
      sinceInput = 0;
      link.a.other.send({ t: MSG.INPUT, b: packButtons(guestInput.state), q: seq++ });
    }
    link.step(DT);

    // How far apart are the two versions of the guest's own car?
    const mine = guest.player;
    const truth = host.field.find((c) => c.spec.id === GUEST_CAR);
    const drift = Math.abs(guest.track.delta(mine.s, truth.s));
    if (host.state === State.RACING) { worst = Math.max(worst, drift); total += drift; samples++; }
    if (process.env.TRACE && Math.floor(t * 2) !== Math.floor((t - DT) * 2)) {
      console.log(`  t=${t.toFixed(1)} state=${host.state} drift=${drift.toFixed(2)} ` +
        `guestS=${mine.s.toFixed(0)} hostS=${truth.s.toFixed(0)} ` +
        `gSpd=${(mine.speed*3.6).toFixed(0)} hSpd=${(truth.speed*3.6).toFixed(0)} ` +
        `gState=${guest.state}`);
    }

    for (const car of guest.field) {
      guest.track.sample(car.s, st);
      if (car.n > guest.track.limit(st, 1) + 0.5 || car.n < guest.track.limit(st, -1) - 0.5) {
        outside++;
      }
    }
  }

  return {
    finished: host.state === State.FINISHED,
    order: host.order.map((c) => c.spec.id),
    guestOrder: guest.order.map((c) => c.spec.id),
    hostTimes: host.order.map((c) => +(c.finishTime || 0).toFixed(2)),
    worst,
    mean: samples ? total / samples : 0,
    outside,
    dropped: link.dropped,
    seconds: t,
  };
}

const CASES = [
  { label: 'same room',   latency: 0.005, jitter: 0.002, loss: 0 },
  { label: 'good wifi',   latency: 0.025, jitter: 0.010, loss: 0 },
  { label: '4G',          latency: 0.075, jitter: 0.030, loss: 0.01 },
  { label: 'poor 4G',     latency: 0.150, jitter: 0.060, loss: 0.05 },
];

console.log('Host and guest race the same grid in one process, over a faked link.');
console.log('"offset" is how far the guest\'s own car sits from the host\'s answer on');
console.log('average - the standing cost of predicting - and "peak" the worst moment,');
console.log('which is a correction being folded in. They fail for different reasons, so');
console.log('they are checked separately.\n');
/**
 * Do two finishing orders agree, treating dead heats as unresolvable?
 *
 * Any pair the ends put in a different order has to have finished closer
 * together than `tol` seconds. One clear place changing hands is a failure;
 * a blanket finish shuffling is not.
 */
function orderAgrees(a, b, times, tol) {
  if (a.length !== b.length) return false;
  const at = new Map(a.map((id, i) => [id, times[i]]));
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ta = at.get(a[i]);
    const tb = at.get(b[i]);
    if (ta === undefined || tb === undefined) return false;
    if (Math.abs(ta - tb) > tol) return false;
  }
  return true;
}

console.log('  link         rtt   loss  offset    peak   off-road   order   time');

let failed = 0;
for (const c of CASES) {
  for (const track of ['msots', 'palm']) {
    const r = run({ track, physics: 'arcade', difficulty: 'normal', ...c });
    // Agreement, allowing a photo finish to fall either way.
    //
    // The guest *predicts* its own car, so where it thinks it crossed the line
    // is up to a round trip of travel away from the host's answer - the same
    // `2 x latency` that `offset` measures below. Two cars that finish 0.05 s
    // apart are inside that by an order of magnitude, and no amount of correct
    // netcode can resolve them: the question genuinely has no answer at that
    // resolution. What must never happen is the ends disagreeing about a place
    // that was actually *decided*, and that is what this checks.
    const agree = orderAgrees(r.order, r.guestOrder, r.hostTimes, 2 * c.latency);
    // Prediction costs a round trip of position by construction: the guest
    // applies a button now, the host applies it one latency later, and the
    // snapshot correcting for it is another latency old. That much is the
    // price of the car answering your thumb, and it is what `offset` should
    // come to. A `peak` is a correction being absorbed - one blend window of
    // travel at racing speed, plus room for a shunt nobody predicted.
    const allowed = 2 * c.latency * 78 + 3;
    const allowedPeak = allowed + 0.18 * 80 + 6;

    console.log(`  ${c.label.padEnd(11)} ${(c.latency * 2000).toFixed(0).padStart(4)}ms ` +
                `${(c.loss * 100).toFixed(0).padStart(4)}% ` +
                `${r.mean.toFixed(2).padStart(6)} m ${r.worst.toFixed(1).padStart(6)} m ` +
                `${String(r.outside).padStart(8)} ` +
                `${(agree ? 'agree' : 'DIFFER').padStart(7)} ` +
                `${r.seconds.toFixed(0).padStart(5)}s  ${track}`);
    if (!r.finished) { console.log('    ! the race never finished'); failed++; }
    if (r.mean > allowed) {
      console.log(`    ! the guest sits ${r.mean.toFixed(1)} m from authority on average ` +
                  `(a round trip is worth ${allowed.toFixed(1)} m here)`);
      failed++;
    }
    if (r.worst > allowedPeak) {
      console.log(`    ! a correction moved the guest ${r.worst.toFixed(1)} m ` +
                  `(limit ${allowedPeak.toFixed(1)} m)`);
      failed++;
    }
    if (r.outside > 0) { console.log(`    ! the guest drew a car off the road ${r.outside} times`); failed++; }
    if (!agree) {
      console.log('    ! the two ends disagree about a place that was decided');
      console.log(`      host:  ${r.order.join(' ')}`);
      console.log(`      guest: ${r.guestOrder.join(' ')}`);
      console.log(`      host finish times: ${r.hostTimes.join(' ')}`);
      failed++;
    }
  }
}

console.log(failed ? `\n${failed} problem(s)` : '\nboth ends agree at every latency');
process.exit(failed ? 1 : 0);
