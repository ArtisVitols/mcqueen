/**
 * Do rivals have incidents, and is an incident *safe*?
 *
 * A wreck is there to be watched, so most of what matters is what it must not
 * do: it must not happen on top of the player, it must not leave a car off the
 * road, it must not block the circuit, and it must not stop the race ending -
 * which is the one that has bitten before, when finished cars parked on the
 * racing line and the field behind them would not drive through.
 *
 * The rate is turned up here, hard. At the shipped rate a five-lap race sees an
 * incident about half the time, which is the right amount to play and useless
 * to test - so this asks the same code for many more of them and checks the
 * cap still holds.
 *
 *   node tools/check_crashes.mjs [track ...]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Track } from '../src/track.js';
import { Race, State } from '../src/race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const TRACKS = read('assets/tracks.json').tracks;
const CARS = read('assets/cars.json').cars.filter((c) => c.racer !== false);
const wanted = process.argv.slice(2);
const todo = TRACKS.filter((t) => (wanted.length ? wanted.includes(t.id) : true));

const DT = 1 / 120;
const LAPS = 6;
const RATE = 0.05;           // 50x the shipped rate, so every run has one

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);

/** The five-year-old: throttle pinned, nothing else. */
const FLAT_OUT = {
  applyTo(car, dt, physics) {
    car.steerCmd = 0;
    if (!physics?.assisted) car.steer = 0;
    car.throttle = 1;
    car.brake = 0;
  },
};

for (const spec of todo) {
  console.log(`\n=== ${spec.name} ===`);
  const track = new Track(read(`assets/${spec.data}`));
  const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
  const race = new Race(track, entries,
    { difficulty: 'normal', laps: LAPS, physics: 'arcade', car: 'lightning_mcqueen' },
    spec.gridLanes).build('lightning_mcqueen');
  race.crashRate = RATE;
  const player = race.player;

  let t = 0;
  let nearest = Infinity;      // closest an incident *started* to the player
  let offRoad = 0;
  let moved = 0;               // a parked car that did not stay parked
  const parkedAt = new Map();
  const wasOut = new Set();

  while (race.state !== State.FINISHED && t < 900) {
    for (const c of race.field) {
      if (c.crash === 0) nearest = Math.min(nearest, Math.abs(track.delta(player.s, c.s)));
    }
    race.update(DT, FLAT_OUT);
    t += DT;
    for (const c of race.field) {
      if (!c.out) continue;
      if (!wasOut.has(c)) { wasOut.add(c); parkedAt.set(c, [c.s, c.n]); }
      const [s0, n0] = parkedAt.get(c);
      if (Math.abs(track.delta(s0, c.s)) > 0.5 || Math.abs(c.n - n0) > 0.5) moved++;
    }
    // Nobody, ever, outside the corridor of whatever road they are on - and
    // that includes a car nobody is driving any more.
    for (const c of race.field) {
      const st = c.road.sample(c.s, {});
      if (c.n > c.road.limit(st, 1) + 0.5 || c.n < c.road.limit(st, -1) - 0.5) offRoad++;
    }
  }

  const out = race.field.filter((c) => c.out);
  race.state === State.FINISHED
    ? ok(`the race finished (${t.toFixed(0)} s) with ${out.length} car(s) out`)
    : fail('the race never ended - a wreck is blocking it, or nobody is counted');
  out.length > 0 && out.length <= 2
    ? ok(`${out.map((c) => c.spec.name).join(', ')} retired, and the cap held`)
    : fail(out.length === 0 ? 'no incident in a race at 50x the rate'
      : `${out.length} cars retired - the cap is not holding`);
  offRoad === 0 ? ok('no car was ever outside its corridor, wrecked or not')
                : fail(`${offRoad} samples outside the corridor`);
  moved === 0 ? ok('a parked car stayed parked')
              : fail(`a wreck was shoved ${moved} times - it is being pushed about`);
  nearest >= 45
    ? ok(`no incident started within ${nearest === Infinity ? 'reach' : nearest.toFixed(0) + ' m'} ` +
         'of the player')
    : fail(`an incident started ${nearest.toFixed(0)} m from the player - unavoidable`);
  // Classified behind everybody who got to the end, whatever their progress.
  const worstFinisher = Math.max(...race.field.filter((c) => !c.out).map((c) => c.place));
  const bestOut = Math.min(...out.map((c) => c.place));
  bestOut > worstFinisher
    ? ok(`the wrecks are classified last (P${bestOut} and back)`)
    : fail(`a retired car was classified P${bestOut}, ahead of a finisher at P${worstFinisher}`);
  race.results.length === race.field.length
    ? ok('everybody is on the results sheet')
    : fail(`${race.results.length} of ${race.field.length} cars on the results sheet`);
  // The wreck must not have cost the player their race. Not a strict position
  // check - the field is racing - but they have to have got to the end.
  player.finished && player.lap === LAPS
    ? ok(`the player still finished, P${player.place}`)
    : fail('the player did not finish');
}

console.log(failed ? `\n${failed} problem(s)` : '\nincidents happen, and they are safe');
process.exit(failed ? 1 : 0);
