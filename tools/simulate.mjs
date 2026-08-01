/**
 * Headless race simulation.
 *
 * Runs the real Track/Car/Driver/Race code with no renderer so the racing
 * logic can be checked without a browser: lap counting, finishing order, track
 * limits, whether overtakes actually happen and whether each difficulty is
 * winnable by a player who simply holds the throttle down.
 *
 *   node tools/simulate.mjs all            every physics x track x difficulty
 *   node tools/simulate.mjs <track> <difficulty> [physics] [laps]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Track } from '../src/track.js';
import { Race, State } from '../src/race.js';
import { DIFFICULTY } from '../src/settings.js';
import { PHYSICS } from '../src/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const DT = 1 / 60;
const LIMIT_SECONDS = 900;

/** A player that just holds the gas, like a five-year-old would. */
class FlatOut {
  constructor(steerNoise = 0) { this.t = 0; this.noise = steerNoise; }
  applyTo(car) {
    this.t += DT;
    car.throttle = 1;
    car.brake = 0;
    // Optional wobble to emulate a child sawing at the steering buttons.
    car.steer = this.noise ? Math.sin(this.t * 1.7) * this.noise : 0;
  }
}

export const TRACKS = read('assets/tracks.json').tracks;

export function simulate({ trackId = TRACKS[0].id, difficulty = 'easy', laps = 3,
                           physics = 'arcade', partnerId = null,
                           playerId = 'lightning_mcqueen', steerNoise = 0 } = {}) {
  const spec = TRACKS.find((t) => t.id === trackId) || TRACKS[0];
  const track = new Track(read(`assets/${spec.data}`));
  const specs = read('assets/cars.json').cars;

  const entries = specs.map((carSpec) => ({ spec: carSpec, object: new THREE.Object3D() }));
  // gridLanes has to come through, or the sim races a grid the game never uses
  // and quietly misses cars starting outside the corridor.
  // A second human, when asked for, is the two-player grid: no Driver, driven
  // by its own scripted input exactly as a guest's would be over the wire.
  const humans = partnerId ? [playerId, partnerId] : [playerId];
  const race = new Race(track, entries, { difficulty, laps, physics, car: playerId },
                        spec.gridLanes).build(playerId, humans);
  if (partnerId) {
    const partner = race.humans.find((c) => c.spec.id === partnerId);
    // The other person is a worse driver who saws at the buttons - which also
    // means the two humans do not move in lockstep and actually interact.
    race.inputs.set(partner, new FlatOut(0.4));
    race.setAssist(partner, 'easy');
  }

  const input = new FlatOut(steerNoise);
  const stats = {
    offTrack: 0, maxLateral: 0, minSpeed: Infinity, maxSpeed: 0,
    laneChanges: 0, overtakes: 0, contact: 0, maxPsi: 0, offExamples: [],
  };
  const lapCrossings = new Map(race.field.map((c) => [c, 0]));
  let prevOrder = race.order.map((c) => c.spec.id);
  const prevLane = new Map(race.field.map((c) => [c, c.n]));
  const seenLaps = new Map(race.field.map((c) => [c, c.lap]));

  let t = 0;
  while (race.state !== State.FINISHED && t < LIMIT_SECONDS) {
    race.update(DT, input);
    t += DT;

    for (const car of race.field) {
      const st = track.sample(car.s, {});
      const outer = track.limit(st, 1);
      const inner = track.limit(st, -1);
      if (car.n > outer + 0.05 || car.n < inner - 0.05) {
        stats.offTrack++;
        if (stats.offExamples.length < 5) {
          stats.offExamples.push({
            car: car.spec.id, s: Math.round(car.s), n: +car.n.toFixed(2),
            lo: +inner.toFixed(2), hi: +outer.toFixed(2),
            outW: +st.outW.toFixed(2), inW: +st.inW.toFixed(2),
          });
        }
      }
      stats.maxLateral = Math.max(stats.maxLateral, Math.abs(car.n));
      stats.maxPsi = Math.max(stats.maxPsi, Math.abs(car.psi));
      if (race.state === State.RACING && !car.finished) {
        stats.minSpeed = Math.min(stats.minSpeed, car.speed);
        stats.maxSpeed = Math.max(stats.maxSpeed, car.speed);
      }
      if (car.lap !== seenLaps.get(car)) {
        seenLaps.set(car, car.lap);
        lapCrossings.set(car, lapCrossings.get(car) + 1);
      }
      if (Math.abs(car.n - prevLane.get(car)) > 2.5) {
        stats.laneChanges++;
        prevLane.set(car, car.n);
      }
    }

    const order = race.order.map((c) => c.spec.id);
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== prevOrder[i]) { stats.overtakes++; break; }
    }
    prevOrder = order;
  }

  return { race, track, stats, seconds: t, laps, difficulty, physics, lapCrossings, spec,
           partnerId };
}

function report(run) {
  const { race, stats, seconds, laps, difficulty, physics, track, spec } = run;
  const player = race.player;
  const lapTime = seconds / laps;

  console.log(`\n=== ${spec.short} / ${PHYSICS[physics].label} / ${difficulty.toUpperCase()}` +
              `  ${laps} lap(s)${run.partnerId ? ' / two players' : ''} ===`);
  console.log(`race time      ${seconds.toFixed(1)} s   (~${lapTime.toFixed(1)} s/lap)`);
  console.log(`lap length     ${track.lapLength.toFixed(0)} m`);
  console.log(`speeds         ${(stats.minSpeed * 3.6).toFixed(0)} - ${(stats.maxSpeed * 3.6).toFixed(0)} km/h`);
  console.log(`off-track      ${stats.offTrack} samples   max |lateral| ${stats.maxLateral.toFixed(1)} m`);
  console.log(`max heading    ${(stats.maxPsi * 57.3).toFixed(0)} deg off the tangent`);
  console.log(`lane changes   ${stats.laneChanges}   position swaps ${stats.overtakes}`);
  console.log('finishing order:');
  for (const car of race.order) {
    const tag = car === player ? '  <-- player' : '';
    console.log(`  P${car.place}  ${car.spec.name.padEnd(20)} ` +
                `lap ${car.lap}  ${car.finishTime ? car.finishTime.toFixed(1) + 's' : '-'}${tag}`);
  }

  const problems = [];
  if (race.state !== State.FINISHED) problems.push('race did not finish inside the time limit');
  if (stats.offTrack > 0) {
    problems.push(`${stats.offTrack} samples off the racing surface: ` +
                  JSON.stringify(stats.offExamples));
  }
  // Cars start behind the line on lap 1, so a 3-lap race shows 1->2 and 2->3:
  // one fewer increment than there are laps.
  for (const [car, crossings] of run.lapCrossings) {
    if (crossings !== laps - 1) {
      problems.push(`${car.spec.name} counted ${crossings} lap changes, expected ${laps - 1}`);
    }
  }
  for (const car of race.field) {
    if (!car.finished) problems.push(`${car.spec.name} never finished`);
    if (car.lap !== laps) problems.push(`${car.spec.name} ended on lap ${car.lap}, expected ${laps}`);
  }
  if (stats.laneChanges < 3) problems.push('almost no lane changes - the AI is not racing');
  if (stats.overtakes < 2) problems.push('almost no position swaps - the field is static');
  if (stats.maxSpeed * 3.6 < 150) problems.push('cars never got up to racing speed');
  if (stats.maxPsi > 3.0) problems.push(`a car reached ${(stats.maxPsi * 57.3).toFixed(0)} deg off the tangent`);
  return problems;
}

// Only run the CLI when invoked directly, so other scripts can import simulate().
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const args = process.argv.slice(2);
if (!isMain) {
  // imported as a library
} else if (args[0] === 'all' || args.length === 0) {
  let failed = 0;
  const placings = {};
  for (const physics of Object.keys(PHYSICS)) {
    for (const spec of TRACKS) {
      for (const difficulty of Object.keys(DIFFICULTY)) {
        const run = simulate({ trackId: spec.id, difficulty, laps: 3, physics });
        const problems = report(run);
        placings[`${physics}/${spec.id}/${difficulty}`] = run.race.player.place;
        if (problems.length) {
          failed++;
          console.log('PROBLEMS:');
          for (const p of problems) console.log('  ! ' + p);
        } else {
          console.log('OK');
        }
      }
    }
  }
  // The two-player grid, once per circuit. It shares every code path with the
  // single-player race, so what this is really checking is that seating a
  // second human does not break lap counting, the corridor or the finish.
  console.log('\n=== two players on the same grid ===');
  for (const spec of TRACKS) {
    const run = simulate({ trackId: spec.id, difficulty: 'normal', laps: 3,
                           physics: 'arcade', partnerId: 'chick_hicks' });
    const problems = report(run);
    if (problems.length) {
      failed++;
      console.log('PROBLEMS:');
      for (const p of problems) console.log('  ! ' + p);
    } else {
      console.log('OK');
    }
  }

  console.log('\n=== player position, holding the throttle flat ===');
  for (const [k, p] of Object.entries(placings)) console.log(`  ${k.padEnd(24)} P${p}`);
  // A five-year-old can tap any entry in the menu, so Easy has to be winnable
  // under every handling model, not just the default one.
  for (const physics of Object.keys(PHYSICS)) {
    for (const spec of TRACKS) {
      if (placings[`${physics}/${spec.id}/easy`] > 2) {
        console.log(`  ! easy on ${spec.short} / ${PHYSICS[physics].label} should be winnable`);
        failed++;
      }
    }
  }
  process.exit(failed ? 1 : 0);
} else {
  const problems = report(simulate({ trackId: args[0], difficulty: args[1] || 'easy',
                                     physics: args[2] || 'arcade',
                                     laps: Number(args[3] || 3) }));
  if (problems.length) { console.log('PROBLEMS:'); problems.forEach((p) => console.log('  ! ' + p)); }
  process.exit(problems.length ? 1 : 0);
}
