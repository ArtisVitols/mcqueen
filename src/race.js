import * as THREE from 'three';
import { Car } from './car.js';
import { Driver, makeRng } from './ai.js';
import { DIFFICULTY } from './settings.js';
import { PHYSICS, driverAid, laneSteer } from './physics.js';

/**
 * A single race: the grid, the countdown, the running order and the finish.
 * Physics runs on a fixed timestep so the result does not depend on framerate.
 */

const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;
const GRID_ROW_GAP = 9;      // metres between rows
// Lateral offset of the two grid columns, where the road is wide enough for
// it. fitGridLanes() pulls them in where it is not.
const GRID_LANE = 3.2;
const COUNTDOWN_STEP = 0.9;  // seconds between red lights
const DRAFT_RANGE = 34;      // metres, matches the AI's own draft window

export const State = {
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

export class Race {
  constructor(track, cars, settings, gridLanes = null) {
    this.track = track;
    this.gridLanes = gridLanes;
    this.cars = cars;                       // [{spec, object}]
    this.settings = settings;
    this.tuning = DIFFICULTY[settings.difficulty] || DIFFICULTY.easy;
    this.physics = PHYSICS[settings.physics] || PHYSICS.arcade;
    this.totalLaps = settings.laps;
    this.rng = makeRng(0x5eed);

    this.field = [];
    this.drivers = [];
    this.humans = [];                       // every car with a person in it
    this.player = null;                     // ... the one on this device
    this.inputs = new Map();                // car -> something with applyTo()
    this.results = [];
    this.state = State.COUNTDOWN;
    this.clock = 0;
    this.lights = 0;
    this._accum = 0;
    this.onLight = null;
    this.onLap = null;
    this.onFinish = null;
  }

  /**
   * Lay out the grid.
   *
   * @param {string} playerId  the car driven from *this* device - what the
   *   camera follows and the HUD reports. Always one of `humanIds`.
   * @param {string[]} humanIds  every car with a person in it. More than one
   *   in a two-player race; the rest get an AI `Driver`.
   */
  build(playerId, humanIds = [playerId]) {
    const { track } = this;
    const humans = new Set(humanIds);
    // Humans start at the back so the camera opens on a full grid, and so a
    // parent and a five-year-old line up together rather than a lap apart.
    //
    // Their order among themselves comes from `humanIds`, never from who is
    // local. Sorting the local car to the back seems natural and puts a
    // *different* car on the back row of each device - two machines laying out
    // two different grids, nine metres apart before the lights even go out.
    const order = [...this.cars].sort((a, b) => {
      const ha = humanIds.indexOf(a.spec.id);
      const hb = humanIds.indexOf(b.spec.id);
      if ((ha >= 0) !== (hb >= 0)) return ha >= 0 ? 1 : -1;
      if (ha >= 0) return ha - hb;
      return b.spec.pace - a.spec.pace;
    });

    const lanes = this.fitGridLanes(Math.ceil(order.length / 2));

    order.forEach((entry, i) => {
      const car = new Car(entry.spec, entry.object, track, this.physics);
      car.isPlayer = humans.has(entry.spec.id);
      car.isLocal = entry.spec.id === playerId;
      car.totalLaps = this.totalLaps;
      car.topSpeed = 78 * (car.isPlayer ? this.tuning.playerSpeed : this.tuning.aiSpeed);
      // The grip assist is the humans'; rivals are paced by aiSpeed. Each
      // human may carry a different one - see `setAssist` - because a parent
      // and a five-year-old need very different help off the same grid.
      car.assist = car.isPlayer ? (this.tuning.assist ?? 1) : 1;
      car.lift = car.isPlayer ? (this.tuning.lift ?? 0) : 0;

      const row = Math.floor(i / 2);
      // Row 0 sits just behind the line; the pack stretches back from there.
      car.placeOnGrid(12 + row * GRID_ROW_GAP, lanes[i % 2]);
      car.gridIndex = i;

      this.field.push(car);
      if (car.isPlayer) this.humans.push(car);
      else this.drivers.push(new Driver(car, entry.spec, this.rng));
      if (car.isLocal) this.player = car;
    });

    this.order = [...this.field];
    this.updateOrder();
    return this;
  }

  /**
   * Give one human a different level of help from the other.
   *
   * The two of them are racing one field of AI, so the AI's difficulty can
   * only be one setting - but how much the car drives itself is per person,
   * and that is the setting that matters when a parent and a five-year-old
   * share a grid. `assist` is grip, `lift` is how much of `driverAid` applies.
   *
   * @param {Car} car
   * @param {string} level  a key of DIFFICULTY, used only for its aids
   */
  setAssist(car, level) {
    const t = DIFFICULTY[level];
    if (!t) return;
    car.assist = t.assist ?? 1;
    car.lift = t.lift ?? 0;
  }

  /**
   * Two starting columns that actually fit the road where the field lines up.
   *
   * The grid is laid out in track space, so it lands wherever the racing
   * line's lateral offsets put it - and on a pit straight the racing surface
   * is narrower and off-centre, because the pit lane takes part of the width
   * and a wall separates the two. A fixed symmetric grid put half the field on
   * the wrong side of that wall. This measures the corridor across every grid
   * row and centres the columns in what is actually there.
   */
  fitGridLanes(rows) {
    let lo = -Infinity;
    let hi = Infinity;
    const st = {};
    for (let r = 0; r < rows; r++) {
      this.track.sample(-(12 + r * GRID_ROW_GAP), st);
      lo = Math.max(lo, this.track.limit(st, -1));
      hi = Math.min(hi, this.track.limit(st, 1));
    }
    const want = this.gridLanes || [-GRID_LANE, GRID_LANE];
    if (want.every((v) => v >= lo && v <= hi)) return want;
    const centre = (lo + hi) / 2;
    const half = Math.min(GRID_LANE, Math.max(0.5, (hi - lo) / 2 - 0.6));
    return [centre - half, centre + half];
  }

  /** Advance the race. `input` drives the player car once the lights go out. */
  update(dt, input) {
    dt = Math.min(dt, 0.1);
    this.clock += dt;

    if (this.state === State.COUNTDOWN) {
      const lit = Math.floor(this.clock / COUNTDOWN_STEP);
      if (lit !== this.lights && lit <= 5) {
        this.lights = lit;
        this.onLight?.(Math.min(lit, 5), false);
      }
      if (this.clock >= COUNTDOWN_STEP * 6) {
        this.state = State.RACING;
        this.clock = 0;
        this.onLight?.(5, true);
      }
      // Cars sit still on the grid but still need their transforms set.
      for (const car of this.field) car.sync();
      return;
    }

    this._accum += dt;
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_STEPS) {
      this.fixedStep(FIXED_DT, input);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this._accum = 0;    // do not spiral after a stall
  }

  fixedStep(dt, input) {
    for (const car of this.humans) {
      if (car.finished) {
        this.coolDown(car, dt);
        continue;
      }
      // The local player's input comes in as an argument so single-player
      // needs no wiring at all; anyone else's arrives over the wire and is
      // registered in `inputs`.
      const source = car === this.player ? input : this.inputs.get(car);
      if (!source) continue;              // a guest who has not sent anything yet
      source.applyTo(car, dt, this.physics);
      driverAid(car, car.lift ?? 0, dt, this.field);
    }

    for (const driver of this.drivers) {
      const car = driver.car;
      if (car.finished) {
        this.coolDown(car, dt);
        continue;
      }
      driver.update(dt, this.field, this.tuning, this.physics);
      this.rubberBand(car);
    }

    // The AI gets its tow through its own target speed; a human has no such
    // controller, so the models that model drag need to be told about it here.
    for (const car of this.humans) this.updateDraft(car);

    for (const car of this.field) {
      const before = car.lap;
      car.step(dt);
      if (car.lap !== before && car.lap > 1 && car === this.player) {
        this.onLap?.(car.lap);
      }
      if (!car.finished && car.progress >= this.totalLaps * this.track.lapLength) {
        car.finished = true;
        car.finishTime = this.clock;
        this.results.push(car);
        if (car === this.player || this.results.length === this.field.length) {
          this.onFinish?.(this.results.length, car);
        }
      }
    }

    this.separate(dt);
    this.updateOrder();

    if (this.results.length === this.field.length) this.state = State.FINISHED;
  }

  /**
   * A car that has taken the flag keeps rolling, and moves out of the way.
   *
   * Braking to a stop is fine when the whole field finishes within a few
   * seconds of each other, and a race-stopper when it does not: over five laps
   * the leaders parked themselves on the racing line, the last car could not
   * get past - the AI will not drive through the back of anybody - and the
   * race simply never ended.
   */
  coolDown(car, dt) {
    const st = this.track.sample(car.s, car.st);
    car.steer = laneSteer(car, this.track.limit(st, 1) - 1.0, dt);
    const target = car.topSpeed * 0.45;
    car.throttle = THREE.MathUtils.clamp((target - car.speed) * 0.5, 0, 1);
    car.brake = THREE.MathUtils.clamp((car.speed - target) * 0.12, 0, 1);
  }

  /**
   * Keep the race close enough that a five-year-old stays in it. Only the AI
   * is adjusted, and only within a few per cent, so the pack still races each
   * other rather than waiting around.
   */
  rubberBand(car) {
    const band = this.tuning.band;
    if (!band) { car.paceScale = 1; return; }
    // Measured against whichever human is nearest, which is the same thing as
    // "the player" when there is only one of them. Picking the leader instead
    // would hand the slower of two humans a field that has already been reeled
    // in for somebody else.
    let gap = 0;                                       // negative: AI ahead
    let near = Infinity;
    for (const human of this.humans) {
      const d = human.progress - car.progress;
      if (Math.abs(d) < near) { near = Math.abs(d); gap = d; }
    }
    const norm = THREE.MathUtils.clamp(gap / 260, -1, 1);
    // Asymmetric on purpose: an AI that has escaped gets reeled in hard, but
    // one that is behind only gets a small tow. Falling behind should be
    // recoverable; leading should still feel earned.
    //
    // A car with a grudge is not reeled in at all. The handicap is what keeps
    // the pack catchable, and taking it off for the ten seconds after somebody
    // passes them is what lets them come back and have a go - then it fades in
    // again as the grudge does, and they settle.
    const scale = norm < 0 ? 0.22 * (1 - (car.fight || 0)) : 0.07;
    // Under a grip model an AI's pace is set by how hard it corners, not by
    // its top speed, so the band has to reach the corner cap as well or Easy
    // quietly stops reeling anybody in.
    car.paceScale = 1 + norm * band * scale;
    car.topSpeed = 78 * this.tuning.aiSpeed * car.paceScale;
  }

  /** How deep in another car's tow this car is, 0..1. */
  updateDraft(car) {
    let best = 0;
    for (const other of this.field) {
      if (other === car) continue;
      const gap = this.track.delta(car.s, other.s);
      if (gap <= 2 || gap > DRAFT_RANGE) continue;
      if (Math.abs(other.n - car.n) > 2.6) continue;
      best = Math.max(best, 1 - gap / DRAFT_RANGE);
    }
    car.draft = best;
  }

  /** Cars nudge each other apart instead of occupying the same metre of track. */
  separate(dt) {
    const f = this.field;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i], b = f[j];
        const ds = this.track.delta(a.s, b.s);
        if (Math.abs(ds) > 5.2) continue;
        const dn = b.n - a.n;
        const overlap = 2.3 - Math.abs(dn);
        if (overlap <= 0) continue;

        // Move each of them away from the other, but only as far as the road
        // allows. Shoving them the full distance regardless is how the field
        // ended up outside the corridor wherever the track narrows.
        const dir = dn >= 0 ? 1 : -1;
        const want = overlap * 0.5;
        a.n -= dir * Math.min(want, this.room(a, -dir));
        b.n += dir * Math.min(want, this.room(b, dir));
        this.clampLateral(a);
        this.clampLateral(b);

        // If they still overlap there is simply no room to run side by side
        // here, so the car behind lifts rather than being pushed off the road.
        //
        // Per second, not per step. Unscaled this ran 120 times a second and
        // took 14 m/s off a car in half a second of light contact - a touch
        // read as a crash, and on a superspeedway where the field runs nose to
        // tail that is most of the race.
        const left = 2.3 - Math.abs(b.n - a.n);
        const behind = ds > 0 ? a : b;
        const keep = left > 0 ? 1 - Math.min(0.35, left * 0.2) : 0.6;
        behind.speed *= Math.pow(keep, dt);
      }
    }
  }

  /** How much further this car can move towards `sign` before leaving the road. */
  room(car, sign) {
    const st = this.track.sample(car.s, car.st);
    const lim = this.track.limit(st, sign);
    return Math.max(0, sign > 0 ? lim - car.n : car.n - lim);
  }

  clampLateral(car) {
    const st = this.track.sample(car.s, car.st);
    car.n = THREE.MathUtils.clamp(car.n, this.track.limit(st, -1), this.track.limit(st, 1));
    car.sync(st);
  }

  updateOrder() {
    this.order.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.progress - a.progress;
    });
    this.order.forEach((car, i) => { car.place = i + 1; });
  }
}
