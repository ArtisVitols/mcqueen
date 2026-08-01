/**
 * Trace the player through a race under one handling model.
 *
 * simulate.mjs says who won; this says why. It prints speed, the slide the
 * heading does not show (`vy`), lane, controls, gear and the corner-speed limit
 * every half second, alongside the leading AI, so a lap that is slow for the
 * wrong reason - braking too early, sliding, stuck against the wall - is
 * visible rather than inferred.
 *
 *   node tools/trace_lap.mjs [track] [physics] [difficulty] [seconds]
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

const [trackId = 'msots', physics = 'sport', difficulty = 'easy', secs = '40'] =
  process.argv.slice(2);

const spec = read('assets/tracks.json').tracks.find((t) => t.id === trackId);
const track = new Track(read(`assets/${spec.data}`));
const entries = read('assets/cars.json').cars
  .map((s) => ({ spec: s, object: new THREE.Object3D() }));
const race = new Race(track, entries, { difficulty, laps: 3, physics, car: 'lightning_mcqueen' },
  spec.gridLanes).build('lightning_mcqueen');

/** The five-year-old: throttle pinned, nothing else. */
const input = { applyTo(car) { car.throttle = 1; car.brake = 0; car.steer = 0; } };

const DT = 1 / 60;
const p = race.player;
const rival = race.order.find((c) => c !== p);
console.log(`${spec.short} / ${PHYSICS[physics].label} / ${DIFFICULTY[difficulty].label}` +
            `   assist ${p.assist}  lift ${DIFFICULTY[difficulty].lift ?? 0}`);
console.log('    t      s  speed     vy      n  thr  brk  g |  limit   lead  gap');

let t = 0;
let next = 0;
while (race.state !== State.FINISHED && t < Number(secs)) {
  race.update(DT, input);
  t += DT;
  if (race.state !== State.RACING || t < next) continue;
  next += 0.5;
  const st = track.sample(p.s, {});
  const limit = PHYSICS[physics].cornerSpeed(p, st, p.n);
  console.log(
    `${t.toFixed(1).padStart(5)} ${p.s.toFixed(0).padStart(6)} ` +
    `${p.speed.toFixed(1).padStart(6)} ${p.vy.toFixed(2).padStart(6)} ` +
    `${p.n.toFixed(1).padStart(6)} ${p.throttle.toFixed(2)} ${p.brake.toFixed(2)}  ` +
    `${p.gear} | ${(limit < Infinity ? limit.toFixed(1) : 'inf').padStart(6)} ` +
    `${rival.speed.toFixed(1).padStart(6)} ` +
    `${track.delta(p.progress, rival.progress).toFixed(0).padStart(5)}`);
}
