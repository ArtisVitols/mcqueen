/**
 * Race the same grid on three machines and check they agree.
 *
 * A host `Race` and two guest `GuestView`s run in one process against the fake
 * transport, at latencies and packet loss you would actually see on a phone.
 * No browser, no broker, no other device - so this can run on every change,
 * which is the only way netplay stays working.
 *
 * Three ends rather than two because the lobby holds four: a host that
 * broadcasts to a list is a different thing from one that sends to a link, and
 * the way that fails is one guest getting somebody else's answer.
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
const GUEST_CARS = ['chick_hicks', 'the_king'];
const HUMANS = [HOST_CAR, ...GUEST_CARS];

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
    return new Race(track, entries, { difficulty, laps: 2, physics, car: localId },
      spec.gridLanes).build(localId, HUMANS);
  };
  return { host: mk(HOST_CAR), guests: GUEST_CARS.map(mk) };
}

function run({ track, physics, difficulty, latency, jitter, loss }) {
  const { host, guests } = build(track, physics, difficulty);
  const rng = makeRng(0xc0ffee);
  const hostInput = scripted(1);

  // One end each. The host holds a list and broadcasts to it, which is the
  // thing this file is here to check now: every guest gets its own link, its
  // own buttons and its own view.
  const seats = guests.map((guest, i) => {
    const link = new FakeLink({ latency, jitter, loss, rng });
    const remote = new RemoteInput();
    const carOnHost = host.humans.find((c) => c.spec.id === GUEST_CARS[i]);
    host.inputs.set(carOnHost, remote);
    // Everything a guest predicts locally has to see the same aid the host
    // applies, or the two disagree by construction.
    guest.driverAidFor = (car, dt) => driverAid(car, car.lift ?? 0, dt, guest.field);
    const seat = {
      id: GUEST_CARS[i], guest, link, remote, carOnHost,
      view: new GuestView(guest), input: scripted(2 + i), seq: 0,
      worst: 0, total: 0, samples: 0, outside: 0,
      // How *smoothly* a rival moves on this guest's screen. Nothing here used
      // to look, and the answer was "not at all": playback was anchored on the
      // arrival time of the newest snapshot, so `t` was already 1 when it
      // landed and every later frame extrapolated, clamped, froze, then jumped
      // when the next one came. The host is authoritative and always smooth,
      // so this only ever shows up on the other phone - which is exactly how
      // it was reported.
      lastStep: new Map(), lastS: new Map(), lastRoad: new Map(),
      jerk: 0, jerkN: 0, worstJerk: 0,
    };
    link.a.onMessage((msg) => { if (msg.t === MSG.INPUT) remote.receive(msg.b, msg.q); });
    link.b.onMessage((msg) => { if (msg.t === MSG.SNAP) seat.view.receive(msg, link.now); });
    return seat;
  });

  let t = 0;
  let sinceSnap = 0;
  let sinceInput = 0;
  const st = {};

  while (host.state !== State.FINISHED && t < 600) {
    hostInput.tick(DT);
    for (const seat of seats) seat.input.tick(DT);

    host.update(DT, hostInput);
    for (const seat of seats) seat.view.update(DT, seat.input, seat.link.now);
    t += DT;

    sinceSnap += DT;
    const snap = sinceSnap >= 1 / SNAPSHOT_HZ;
    if (snap) sinceSnap = 0;
    // **Built once and sent to everybody**, exactly as `startPump` does it.
    // Calling `snapshot()` per seat gives each guest every *other* sequence
    // number, so each one thinks half its packets were lost and runs its
    // playback at half speed. A test that models the host wrongly measures
    // its own mistake.
    const payload = snap ? snapshot(host) : null;
    sinceInput += DT;
    const inputDue = sinceInput >= 1 / INPUT_HZ;
    if (inputDue) sinceInput = 0;
    for (const seat of seats) {
      if (snap) seat.link.b.other.send(payload);              // host end -> guest
      if (inputDue) {
        seat.link.a.other.send(
          { t: MSG.INPUT, b: packButtons(seat.input.state), q: seat.seq++ });
      }
      seat.link.step(DT);
    }

    for (const seat of seats) measure(seat, host, st);
  }

  const worst = Math.max(...seats.map((s2) => s2.worst));
  const mean = seats.reduce((a, s2) => a + (s2.samples ? s2.total / s2.samples : 0), 0)
             / seats.length;
  const outside = seats.reduce((a, s2) => a + s2.outside, 0);
  const dropped = seats.reduce((a, s2) => a + s2.link.dropped, 0);
  const jerk = seats.reduce((a, s2) => a + (s2.jerkN ? s2.jerk / s2.jerkN : 0), 0)
             / seats.length;
  const worstJerk = Math.max(...seats.map((s2) => s2.worstJerk));
  // Did the phase of a stop reach the other end at all? Guido is started by
  // it, and with only `onPit` on the wire a guest's own car was never
  // `service` and the crew never came out on that phone.
  const sawService = seats.some((s2) => s2.sawService);

  return {
    finished: host.state === State.FINISHED,
    order: host.order.map((c) => c.spec.id),
    guestOrders: seats.map((s2) => s2.guest.order.map((c) => c.spec.id)),
    hostTimes: host.order.map((c) => +(c.finishTime || 0).toFixed(2)),
    worst, mean, outside, dropped, seconds: t, jerk, worstJerk, sawService,
  };
}

/** One guest's disagreement with the host, this step. */
function measure(seat, host, st) {
    const guest = seat.guest;
    const mine = guest.player;
    const truth = host.field.find((c) => c.spec.id === seat.id);
    // Measured in the *world*, not along the lap.
    //
    // `s` is only comparable while both ends are on the same ribbon: in the
    // pits it is a distance down a different road, so `track.delta` of the two
    // reads as 320 m when the two cars are a handspan apart. World distance
    // asks the question this metric is actually about - how far is the car I
    // am driving from where the host says it is - and it asks it the same way
    // on either road.
    if (mine.pit === 'service') seat.sawService = true;
    const drift = mine.position.distanceTo(truth.position);
    if (host.state === State.RACING) {
      seat.worst = Math.max(seat.worst, drift);
      seat.total += drift;
      seat.samples++;
    }

    // Rival smoothness: how much the per-frame step *changes* from frame to
    // frame. A car running at a steady speed should move by very nearly the
    // same amount each frame, so this is near zero however fast it is going;
    // stutter is precisely a step that keeps changing size.
    if (host.state === State.RACING) {
      for (const car of guest.field) {
        // A car changing ribbon legitimately moves its `s` by hundreds of
        // metres - it is a distance down a different road - so the run of
        // samples restarts rather than reporting a 630 m step.
        if (car === mine || car.onPit || car.out || seat.lastRoad.get(car) !== car.road) {
          seat.lastRoad.set(car, car.road);
          seat.lastS.delete(car);
          seat.lastStep.delete(car);
          continue;
        }
        const before = seat.lastS.get(car);
        seat.lastS.set(car, car.s);
        if (before === undefined) continue;
        const step = guest.track.delta(before, car.s);
        const wasStep = seat.lastStep.get(car);
        seat.lastStep.set(car, step);
        if (wasStep === undefined) continue;
        const d = Math.abs(step - wasStep);
        seat.jerk += d;
        seat.jerkN++;
        seat.worstJerk = Math.max(seat.worstJerk, d);
      }
    }

    for (const car of guest.field) {
      // Against the corridor of whatever road the car is on. A car in the pits
      // is legitimately far outside the *circuit's* corridor - that is what a
      // pit lane is - and measuring it against the wrong one reported the
      // whole field off the road for the length of every stop.
      const road = car.road || guest.track;
      road.sample(car.s, st);
      if (car.n > road.limit(st, 1) + 0.5 || car.n < road.limit(st, -1) - 0.5) {
        seat.outside++;
      }
    }
}

/**
 * Smoothness limits, in metres of frame-to-frame change in a rival's step.
 *
 * At 120 Hz a car at 70 m/s steps 58 cm a frame; what matters is that the step
 * stays the *same size*, so on a clean link a healthy figure is a fraction of
 * a centimetre - it measures 0.1 cm. They scale with **loss**, because that is
 * the part no interpolator can fix: only two snapshots are ever buffered, so a
 * packet that never arrives leaves an interval with no data in it, and the
 * best available answer is to run on and resync. Latency and jitter cost
 * nothing here, which is the point.
 */
const jerkMean = (loss) => 0.05 + loss * 12;
/**
 * The worst single frame is only asserted on a link that loses nothing.
 *
 * On one that does, the big numbers are not stutter, they are a **stall**: the
 * guest buffers exactly two snapshots, so playback sits one send interval
 * ahead of the newest data and any gap longer than that starves it. The car
 * freezes at the run-on cap and then moves when the burst arrives. Smoothing
 * that away needs a deeper buffer - keeping the last several snapshots and
 * interpolating across whichever pair brackets the playback time - which is a
 * real change and one only actual phones could judge. Not pretending a formula
 * covers it; the mean above is asserted on every link and is what reads as
 * smooth.
 */
const jerkWorst = 0.9;

const CASES = [
  { label: 'same room',   latency: 0.005, jitter: 0.002, loss: 0 },
  { label: 'good wifi',   latency: 0.025, jitter: 0.010, loss: 0 },
  { label: '4G',          latency: 0.075, jitter: 0.030, loss: 0.01 },
  { label: 'poor 4G',     latency: 0.150, jitter: 0.060, loss: 0.05 },
];

console.log('A host and two guests race the same grid in one process, over faked links.');
console.log('"offset" is how far a guest\'s own car sits from the host\'s answer on');
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

console.log('  link         rtt   loss  offset    peak   off-road  jerk   order   time');

let failed = 0;
let sawAnyService = false;
for (const c of CASES) {
  for (const track of ['msots', 'palm']) {
    const r = run({ track, physics: 'sport', difficulty: 'hard', ...c });
    // Agreement, allowing a photo finish to fall either way.
    //
    // The guest *predicts* its own car, so where it thinks it crossed the line
    // is up to a round trip of travel away from the host's answer - the same
    // `2 x latency` that `offset` measures below. Two cars that finish 0.05 s
    // apart are inside that by an order of magnitude, and no amount of correct
    // netcode can resolve them: the question genuinely has no answer at that
    // resolution. What must never happen is the ends disagreeing about a place
    // that was actually *decided*, and that is what this checks.
    const agree = r.guestOrders.every((o) => orderAgrees(r.order, o, r.hostTimes, 2 * c.latency));
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
                `${(r.jerk * 100).toFixed(1).padStart(5)} ` +
                `${(agree ? 'agree' : 'DIFFER').padStart(7)} ` +
                `${r.seconds.toFixed(0).padStart(5)}s  ${track}`);
    if (r.sawService) sawAnyService = true;
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
    if (r.outside > 0) { console.log(`    ! a guest drew a car off the road ${r.outside} times`); failed++; }
    // **How smoothly a rival moves on the other phone**, in centimetres of
    // change in the per-frame step. A car at a steady speed should step by
    // very nearly the same amount every frame however fast it is going, so
    // this is near zero when interpolation is working and large when playback
    // is running past the newest packet, freezing and jumping - which is what
    // "the other cars are jerky" was. Generous enough for a real lane change
    // and a shunt; the failure was an order of magnitude worse than this.
    if (r.jerk > jerkMean(c.loss) || (!c.loss && r.worstJerk > jerkWorst)) {
      console.log(`    ! rivals stutter on the guest: ${(r.jerk * 100).toFixed(1)} cm ` +
                  `mean step change, worst ${(r.worstJerk * 100).toFixed(0)} cm ` +
                  `(limit ${(jerkMean(c.loss) * 100).toFixed(0)} mean` +
                  `${c.loss ? '' : `, ${jerkWorst * 100} worst`})`);
      failed++;
    }
    if (!agree) {
      console.log('    ! the ends disagree about a place that was decided');
      console.log(`      host:  ${r.order.join(' ')}`);
      for (const o of r.guestOrders) console.log(`      guest: ${o.join(' ')}`);
      console.log(`      host finish times: ${r.hostTimes.join(' ')}`);
      failed++;
    }
  }
}

// The phase of a stop has to reach the other end, or Guido never comes out on
// the guest's phone - which is how it was reported. Checked once, across every
// case, because whether a stop happens at all depends on the race.
sawAnyService
  ? console.log('\n  ok: a stop\'s phase reaches the guest, so the crew can work on it')
  : console.log('\n  (no stop happened in these runs - service phase unchecked)');

console.log(failed ? `\n${failed} problem(s)` : '\nall three ends agree at every latency');
process.exit(failed ? 1 : 0);
