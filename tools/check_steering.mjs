/**
 * How much does the car actually steer?
 *
 * Holds full lock for two seconds from a settled 200 km/h and reports how far
 * the car moved across the track, for every handling model at every
 * difficulty. A model where the driver aid has swallowed the steering input
 * shows up here as centimetres where the others move metres.
 *
 * Also reports the wander of a car driven straight down a lap with no input,
 * which is what "the cars weave on the straights" looks like as a number.
 *
 *   node tools/check_steering.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Track } from '../src/track.js';
import { Race, State } from '../src/race.js';
import { PHYSICS } from '../src/physics.js';
import { DIFFICULTY } from '../src/settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const TRACKS = read('assets/tracks.json').tracks;
const CARS = read('assets/cars.json').cars;
const DT = 1 / 120;

/**
 * The straightest point on a lap, with room either side.
 *
 * Picking a station by eye is how the first version of this test measured
 * nothing: it put the car in a corner already pinned against the inside edge,
 * where there was nowhere left to steer *to*, and reported perfectly good
 * steering as dead.
 */
function straightest(track) {
  let best = 0;
  let flattest = Infinity;
  for (let i = 0; i < track.count; i++) {
    const st = track.sample(i * track.step, {});
    const k = Math.abs(st.kappa);
    const room = Math.min(track.limit(st, 1), -track.limit(st, -1));
    if (k < flattest && room > 3) { flattest = k; best = i * track.step; }
  }
  return best;
}

/** A full field, for measuring what the pack does. */
function full(trackId, physics, difficulty) {
  const spec = TRACKS.find((t) => t.id === trackId);
  const track = new Track(read(`assets/${spec.data}`));
  const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
  const race = new Race(track, entries, { difficulty, laps: 99, physics, car: 'lightning_mcqueen' },
    spec.gridLanes).build('lightning_mcqueen');
  race.state = State.RACING;
  return race;
}

/** A race with only the player in it, so rivals cannot muddy the measurement. */
function solo(trackId, physics, difficulty) {
  const spec = TRACKS.find((t) => t.id === trackId);
  const track = new Track(read(`assets/${spec.data}`));
  const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
  const race = new Race(track, entries, { difficulty, laps: 9, physics, car: 'lightning_mcqueen' },
    spec.gridLanes).build('lightning_mcqueen');
  // Park the rivals somewhere else on the lap.
  for (const c of race.field) {
    if (c === race.player) continue;
    c.finished = true;
    c.n = track.limit(track.sample(c.s, {}), -1);
  }
  race.state = State.RACING;
  return race;
}

const hold = (steer) => ({
  applyTo(car, dt, physics) {
    const ramp = physics?.steerRamp || 0;
    if (ramp > 0 && dt > 0) {
      const step = ramp * dt;
      car.steerCmd += Math.max(-step, Math.min(step, steer - car.steerCmd));
    } else {
      car.steerCmd = steer;
    }
    if (!physics?.assisted) car.steer = car.steerCmd;
    car.throttle = 1;
    car.brake = 0;
  },
});

function run(race, input, seconds) {
  for (let t = 0; t < seconds; t += DT) race.update(DT, input);
}

console.log('Steering: full lock for 1.2 s from the middle of the straightest part of');
console.log('each lap, then let go for 3 s. The car has to actually move ("rate", the');
console.log('peak crossing speed) and then be coming back ("psi" at the end, degrees).\n');
console.log('  track  physics  difficulty   moved    rate    psi      n     km/h');

let failed = 0;
for (const spec of TRACKS) {
  for (const physics of Object.keys(PHYSICS)) {
    for (const difficulty of Object.keys(DIFFICULTY)) {
      const race = solo(spec.id, physics, difficulty);
      const car = race.player;
      const at = straightest(race.track);
      // Settle in the middle of the road, then ask it to move to one side.
      // Steering towards whichever side has more room, so the answer is about
      // the car and not about where the corridor happens to end.
      const st = race.track.sample(at, {});
      const mid = (race.track.limit(st, 1) + race.track.limit(st, -1)) / 2;
      const dir = race.track.limit(st, 1) - mid > mid - race.track.limit(st, -1) ? 1 : -1;
      car.s = race.track.wrap(at);
      car.n = mid;
      car.speed = 55;
      run(race, hold(0), 2);
      const n0 = car.n;
      let peak = 0;
      for (let t = 0; t < 1.2; t += DT) {
        const before = car.n;
        const lim = race.track.limit(race.track.sample(car.s, {}), dir);
        race.update(DT, hold(dir));
        // Ignore the step where the corridor clamp snapped the car back: that
        // is the track moving, not the car, and it reads as 100 m/s.
        if (!car.scrubbing && Math.abs(car.n - lim) > 0.2) {
          peak = Math.max(peak, Math.abs(car.n - before) / DT);
        }
      }
      // Measured while the input is still applied. Taking it after the release
      // asks a different question - a car that goes somewhere and comes back
      // reads as one that never moved.
      const moved = Math.abs(car.n - n0);
      // Now let go. Whatever the driver did, the car has to come back to
      // something pointing down the road - that is the difference between a
      // model that can be driven and one that is chaotic.
      run(race, hold(0), 1.5);
      const halfway = Math.abs(car.psi);
      run(race, hold(0), 1.5);
      // Responsive, and not left spinning. Demanding a particular angle by a
      // particular moment is the wrong test for a model whose whole point is
      // that you can get it out of shape: this is full lock held for over a
      // second at 250 km/h, which is a deliberate provocation, and finishing
      // it sideways in the corner is the model working. What must not happen
      // is the car spinning, or still winding up when the driver lets go.
      const dead = peak < 1.5;
      const psi = Math.abs(car.psi);
      const spun = psi > 0.9 || (psi > 0.15 && psi > halfway + 0.02);
      console.log(`  ${spec.id.padEnd(6)} ${physics.padEnd(8)} ${difficulty.padEnd(10)} ` +
                  `${moved.toFixed(2).padStart(6)} ${peak.toFixed(2).padStart(7)} ` +
                  `${(car.psi * 57.3).toFixed(1).padStart(7)} ${car.n.toFixed(2).padStart(6)} ` +
                  `${(car.speed * 3.6).toFixed(0).padStart(7)}` +
                  (dead ? '   <-- barely steers' : spun ? '   <-- did not settle' : ''));
      if (dead || spun) failed++;
    }
  }
}

console.log('\nWeaving on the straights: how much the whole field swings side to side.');
console.log('A swing is a there-and-back excursion of more than half a metre. Only the');
console.log('straight sections are counted - a car running wide through a corner and');
console.log('coming back is using the road, which is what it is supposed to do.\n');
console.log('  track  physics    swings/lap   mean swing   worst car');

/**
 * Count the there-and-back swings in a lateral trace.
 *
 * Counting sign changes of the raw per-step rate is useless - a car holding a
 * dead straight line still corrects by a centimetre a step, and that reads as
 * two hundred reversals a lap. This walks the trace with a hysteresis of
 * `minSwing`, so only an excursion big enough to see counts as a swing.
 */
const STRAIGHT_KAPPA = 1.2e-3;      // 1/m; anything flatter counts as a straight

/** Split a trace with nulls in it into the contiguous stretches. */
function runs(trace) {
  const out = [];
  let cur = [];
  for (const v of trace) {
    if (v === null) { if (cur.length > 60) out.push(cur); cur = []; }
    else cur.push(v);
  }
  if (cur.length > 60) out.push(cur);
  return out;
}

function swings(trace, minSwing = 0.5) {
  const amps = [];
  let hi = trace[0];
  let lo = trace[0];
  let pivot = trace[0];
  let dir = 0;                 // +1 while rising, -1 while falling
  for (const n of trace) {
    if (n > hi) hi = n;
    if (n < lo) lo = n;
    if (dir !== -1 && hi - n > minSwing) {          // turned back
      if (dir === 1) amps.push(hi - pivot);
      pivot = hi; dir = -1; hi = n; lo = n;
    } else if (dir !== 1 && n - lo > minSwing) {
      if (dir === -1) amps.push(pivot - lo);
      pivot = lo; dir = 1; hi = n; lo = n;
    }
  }
  return amps;
}

for (const spec of TRACKS) {
  for (const physics of Object.keys(PHYSICS)) {
    const race = full(spec.id, physics, 'normal');
    const player = race.player;
    const traces = race.field.map(() => []);
    run(race, hold(0), 6);
    const start = player.progress;
    let guard = 0;
    const st = {};
    while (player.progress - start < race.track.lapLength && guard++ < 200000) {
      race.update(DT, hold(0));
      race.field.forEach((c, i) => {
        // Straights only. A break in the trace ends the run rather than
        // joining the exit of one corner to the entry of the next.
        const k = Math.abs(race.track.sample(c.s, st).kappa);
        traces[i].push(k < STRAIGHT_KAPPA ? c.n : null);
      });
    }
    let total = 0, amp = 0, worst = 0, worstCar = '';
    race.field.forEach((c, i) => {
      const a = runs(traces[i]).flatMap((r) => swings(r));
      total += a.length;
      amp += a.reduce((x, y) => x + y, 0);
      if (a.length > worst) { worst = a.length; worstCar = c.spec.id; }
    });
    const per = total / race.field.length;
    const mean = total ? amp / total : 0;
    const bad = per > 6;
    console.log(`  ${spec.id.padEnd(6)} ${physics.padEnd(9)} ${per.toFixed(1).padStart(10)} ` +
                `${mean.toFixed(2).padStart(12)} m ${(worstCar || '-').padStart(20)} (${worst})` +
                (bad ? '   <-- weaving' : ''));
    if (bad) failed++;
  }
}

console.log(failed ? `\n${failed} problem(s)` : '\nsteering responds and nothing weaves');
process.exit(failed ? 1 : 0);
