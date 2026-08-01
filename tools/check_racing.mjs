/**
 * How hard is it actually to overtake?
 *
 * simulate.mjs says who won. This says what the race felt like: how many cars
 * the player got past, how many took the place back, and how long a pass took
 * from drawing alongside to being clear ahead. Those are the numbers behind
 * "on Normal I can pass them easily, on Hard it should be a real fight", and
 * without them that is a matter of opinion.
 *
 * The player holds the throttle down and does not steer, which is both the
 * five-year-old's technique and the only way to compare difficulties without
 * a driver in the loop.
 *
 * The opening lap does not count. The player starts at the back and goes by
 * most of the field while everyone is still accelerating off the grid, which
 * is the standing start rather than overtaking - counting it gave every
 * difficulty an identical six passes a race and hid the thing being measured.
 *
 *   node tools/check_racing.mjs [track ...]
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
const LAPS = 5;              // long enough for the traffic to mean something
const ALONGSIDE = 6;         // metres of separation that counts as wheel to wheel
const CLEAR = 12;            // ... and as done with them

/** The five-year-old: throttle pinned, nothing else. */
const FLAT_OUT = {
  applyTo(car, dt, physics) {
    car.steerCmd = 0;
    if (!physics?.assisted) car.steer = 0;
    car.throttle = 1;
    car.brake = 0;
  },
};

function race(trackId, physics, difficulty) {
  const spec = TRACKS.find((t) => t.id === trackId);
  const track = new Track(read(`assets/${spec.data}`));
  const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
  return new Race(track, entries, { difficulty, laps: LAPS, physics, car: 'lightning_mcqueen' },
    spec.gridLanes).build('lightning_mcqueen');
}

/**
 * Watch one rival relative to the player for the whole race.
 *
 * A pass is not a place change - places swap the instant one car's progress
 * exceeds another's, which happens repeatedly while two cars run side by side
 * and would count one overtake as fifteen. This tracks the move itself: from
 * drawing alongside to being clear by a couple of car lengths, with the sign
 * at the end deciding whose it was.
 */
class Duel {
  constructor() {
    this.state = 'apart';     // apart | alongside
    this.entered = 0;         // gap sign on drawing alongside
    this.since = 0;
    this.playerPasses = [];   // seconds each completed pass took
    this.aiPasses = [];
    this.entries = 0;         // times we drew alongside at all
  }

  step(gap, t) {              // gap = player.progress - rival.progress
    const d = Math.abs(gap);
    if (this.state === 'apart') {
      if (d < ALONGSIDE) {
        this.state = 'alongside';
        this.entered = Math.sign(gap);
        this.since = t;
        this.entries++;
      }
      return;
    }
    if (d < CLEAR) return;
    // Clear again. If the sign flipped, somebody completed a move.
    const now = Math.sign(gap);
    if (now !== this.entered && this.entered !== 0) {
      (now > 0 ? this.playerPasses : this.aiPasses).push(t - this.since);
    }
    this.state = 'apart';
  }
}

const wanted = process.argv.slice(2);
const tracks = wanted.length ? TRACKS.filter((t) => wanted.includes(t.id)) : TRACKS;

console.log(`Player holds the throttle down for ${LAPS} laps and never steers.`);
console.log('The opening lap is not counted - that is the standing start, not racing.');
console.log('"duels" is how often they drew alongside anybody, "passed" how many of');
console.log('those they converted, "lost" places taken back, "took" the mean seconds');
console.log('from alongside to clear ahead. The conversion rate is the real answer to');
console.log('"how hard is it to overtake" - passes alone cannot tell a player who is');
console.log('dominant, and has nobody left to pass, from one who cannot get by.\n');
console.log('  track  physics  difficulty   duels  passed   lost    took   final');

let failed = 0;
const summary = {};

for (const spec of tracks) {
  for (const physics of Object.keys(PHYSICS)) {
    for (const difficulty of Object.keys(DIFFICULTY)) {
      const r = race(spec.id, physics, difficulty);
      const player = r.player;
      const duels = new Map(r.field.filter((c) => c !== player).map((c) => [c, new Duel()]));
      let t = 0;
      let fightPeak = 0;
      while (r.state !== State.FINISHED && t < 1200) {
        r.update(DT, FLAT_OUT);
        t += DT;
        if (player.lap > 1) {
          for (const [rival, duel] of duels) duel.step(player.progress - rival.progress, t);
        }
        for (const d of r.drivers) fightPeak = Math.max(fightPeak, d.fight);
      }
      let passed = 0, lost = 0, entries = 0, times = [];
      for (const [, d] of duels) {
        passed += d.playerPasses.length;
        lost += d.aiPasses.length;
        entries += d.entries;
        times.push(...d.playerPasses);
      }
      const took = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      const key = `${physics}/${difficulty}`;
      (summary[key] ||= { passed: 0, lost: 0, entries: 0, times: [] });
      summary[key].passed += passed;
      summary[key].lost += lost;
      summary[key].entries += entries;
      summary[key].times.push(...times);
      console.log(`  ${spec.id.padEnd(6)} ${physics.padEnd(8)} ${difficulty.padEnd(10)} ` +
                  `${String(entries).padStart(7)} ${String(passed).padStart(7)} ` +
                  `${String(lost).padStart(6)} ` +
                  `${(took ? took.toFixed(1) : '-').padStart(7)} ` +
                  `${('P' + player.place).padStart(7)}`);
      void fightPeak;
      if (r.state !== State.FINISHED) { console.log('    ! the race never finished'); failed++; }
    }
  }
}

console.log('\n=== totals across every circuit ===');
console.log('  physics  difficulty   duels  passed   lost    took   converted');
for (const [key, v] of Object.entries(summary)) {
  const [physics, difficulty] = key.split('/');
  const took = v.times.length ? v.times.reduce((a, b) => a + b, 0) / v.times.length : 0;
  v.rate = v.entries ? v.passed / v.entries : null;
  console.log(`  ${physics.padEnd(8)} ${difficulty.padEnd(10)} ${String(v.entries).padStart(7)} ` +
              `${String(v.passed).padStart(7)} ${String(v.lost).padStart(6)} ` +
              `${(took ? took.toFixed(1) : '-').padStart(7)} ` +
              `${(v.rate === null ? '-' : (v.rate * 100).toFixed(0) + '%').padStart(11)}`);
}

// What the owner asked for, as three checks.
//
// Not "did the count of passes go down" - on Easy the player goes by all six
// rivals once and never sees them again, which is the *maximum* a clean race
// can produce, so a harder setting with more scrapping can easily show more.
// What separates the difficulties is whether the places stay taken.
const perTrack = (v, n) => v / tracks.length / n;
for (const physics of Object.keys(PHYSICS)) {
  const e = summary[`${physics}/easy`];
  const n = summary[`${physics}/normal`];
  const h = summary[`${physics}/hard`];

  // Easy: nobody takes a place back off a five-year-old.
  if (e.lost > 0) {
    console.log(`  ! ${physics}: Easy took ${e.lost} place(s) back off the player`);
    failed++;
  }
  // Hard: rivals hold on to places and take them back.
  // Hard has to be a race you can join - somebody to fight - and one where
  // fewer of those fights come off than on Normal.
  if (h.entries < 4) {
    console.log(`  ! ${physics}: Hard never gives the player anyone to race ` +
                `(${h.entries} duels)`);
    failed++;
  } else if (n.rate !== null && h.rate !== null && h.rate >= n.rate) {
    console.log(`  ! ${physics}: Hard converts as many moves as Normal ` +
                `(${(h.rate * 100).toFixed(0)}% vs ${(n.rate * 100).toFixed(0)}%)`);
    failed++;
  }
  // ... and one where a place, once taken, has to be held. Unless the player
  // never got past anybody at all, in which case there was nothing to take
  // back and Hard is doing its job the hard way.
  if (h.passed > 0 && h.lost < 1) {
    console.log(`  ! ${physics}: Hard never takes a place back off the player`);
    failed++;
  }
}

console.log(failed ? `\n${failed} problem(s)` : '\novertaking gets harder with the difficulty');
process.exit(failed ? 1 : 0);
