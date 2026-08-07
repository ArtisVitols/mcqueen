import * as THREE from 'three';
import { Car } from './car.js';
import { Driver, makeRng } from './ai.js';
import { DIFFICULTY } from './settings.js';
import { PHYSICS, driverAid, laneSteer } from './physics.js';
import { PitLane, Pit, SERVICE_TIME } from './pitstop.js';

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
const BASE_SPEED = 78;       // m/s that every pace figure is a fraction of
// Tyre life used per lap of clean running, before the load multiplier in
// Car.step - which on these circuits averages about 1.5. So a set lasts
// roughly eight laps and the AI comes in after six: a 5-lap race needs no
// stop, a 10-lap race needs one, and a 20-lap race is a three-stopper. That
// spread is why the 2/5/10/15/20 lap options exist.
const WEAR_PER_LAP = 1 / 12;
// The AI comes in below this, if the lane is there and the race is long
// enough to be worth it.
const AI_PIT_AT = 0.28;
// A car aiming for the pits has one taper to cross the road in, which is
// less time than an overtake - so it uses the committed gain, exactly as a
// move does. The ordinary one abandons the entry half-finished.
const PIT_AIM_CLOSE = 3.0;
// How far before the pit entrance a car that has decided to stop starts
// moving down to the inside.
//
// Sized by the widest circuit, not the tidiest number: `laneSteer` asks for a
// crossing *rate*, and at Yoyleland the entrance is thirteen metres in from
// the racing line, so at 3 m/s that is four and a half seconds - 320 m at
// racing speed. At 150 m four of the six rivals arrived at the entry still
// out on the line, could not turn in, and drove the last four laps of a race
// on dead tyres wanting a stop they could never take.
const PIT_APPROACH = 320;

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

    // The pit road, where the circuit has one. Without it there is no wear
    // either: a tyre bar draining with nowhere to drive into would be a
    // countdown to being slow, which is the opposite of a decision.
    this.pits = track.data.pit ? new PitLane(track, track.data.pit) : null;
    // Per metre. Sized so a five-lap race needs no stop on any circuit and a
    // long one does - which is what the 2/5/10/15/20 lap options are for.
    // Scaled by lap length so a stop falls at the same point of a race
    // whether the lap is 1.5 km or 2.8 km.
    this.wearRate = this.pits ? WEAR_PER_LAP / track.lapLength : 0;
    this.serviceTime = SERVICE_TIME[settings.difficulty] ?? SERVICE_TIME.normal;

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
      car.topSpeed = BASE_SPEED * (car.isPlayer ? this.tuning.playerSpeed
        : Math.max(this.tuning.aiSpeed, this.tuning.chaseSpeed ?? this.tuning.aiSpeed));
      car.baseSpeed = BASE_SPEED;
      // The grip assist is the humans'; rivals are paced by aiSpeed. Each
      // human may carry a different one - see `setAssist` - because a parent
      // and a five-year-old need very different help off the same grid.
      car.assist = car.isPlayer ? (this.tuning.assist ?? 1) : 1;
      car.lift = car.isPlayer ? (this.tuning.lift ?? 0) : 0;
      car.wearRate = this.wearRate;
      car.pit = Pit.OUT;
      car.pitTimer = 0;
      car.pitStops = 0;
      car.pitDone = -1;

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
   * Hand a human's car over to the AI.
   *
   * Used when the other phone drops out. The alternative is a car that either
   * holds its last buttons - pinned at full throttle for the rest of the race -
   * or releases them and parks on the racing line. Neither is acceptable, and
   * a rival that simply carries on racing is barely noticeable.
   */
  abandon(car) {
    if (!car || !car.isPlayer) return;
    car.isPlayer = false;
    this.humans = this.humans.filter((c) => c !== car);
    this.inputs.delete(car);
    car.assist = 1;
    car.lift = 0;
    car.topSpeed = BASE_SPEED * Math.max(this.tuning.aiSpeed,
      this.tuning.chaseSpeed ?? this.tuning.aiSpeed);
    this.drivers.push(new Driver(car, car.spec, this.rng));
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
      // A car being serviced is not being driven. Reading the buttons first
      // and letting the lane overwrite them keeps `steerCmd` honest for the
      // wheels and the HUD, but nothing the player presses moves the car.
      if (this.stepPit(car, dt)) continue;
      driverAid(car, car.lift ?? 0, dt, this.field);
      // A player turns in themselves: steer down to the inside while the entry
      // is open and you are in the pits. That is the whole gesture, and it is
      // how it works in the sport - `tryEnter` gates on where the car actually
      // is, so calling it every step costs nothing and needs no button.
      //
      // **Whenever they like**, not only when the tyres have gone. `shouldPit`
      // is a strategy call and belongs to the AI; applying it to a person made
      // the pit entrance ignore them for most of a race, which is not a
      // decision, it is a locked door. Coming in early is allowed to be a bad
      // idea - `pitDone` still limits it to one stop a lap.
      if (this.pits) {
        // The aid only steers *itself* in when a stop is actually due, or Easy
        // would pit every lap for no reason. Same rule that already makes the
        // aid overtake there.
        const auto = (car.lift ?? 0) >= 0.7 && this.shouldPit(car);
        if (auto) this.aimForPits(car, dt);
        // Turning in is *asking* - holding the button towards the inside -
        // never merely being near the edge. On Easy the aid parks the car on
        // the low line, so "close enough" pitted a five-year-old every single
        // lap without them touching anything, and Easy stopped being a win.
        if (auto || car.steerCmd < -0.2) this.pits.tryEnter(car);
      }
    }

    for (const driver of this.drivers) {
      const car = driver.car;
      if (car.finished) {
        this.coolDown(car, dt);
        continue;
      }
      if (this.stepPit(car, dt)) continue;
      driver.update(dt, this.field, this.tuning, this.physics);
      this.rubberBand(car);
      // Rivals stop too, or a stop is a penalty rather than a strategy - and
      // "Easy is winnable by holding the throttle down" would stop being true
      // the moment tyres mattered.
      if (!car.isPlayer && this.shouldPit(car)) {
        // A rival has to be *steered* in. Without this it wants to pit, is
        // told it may, and sails past the entry every lap on the racing line.
        this.aimForPits(car, dt);
        this.pits.tryEnter(car);
      }
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
   * One step of a car's pit stop. True if the lane took over the controls.
   *
   * Also holds the rev limiter down to the pit speed limit while it is in
   * there. Doing it here rather than inside the stop means it applies from the
   * moment the car commits, including the run down to the box.
   */
  stepPit(car, dt) {
    if (!this.pits) return false;
    if (car.pit === Pit.OUT) {
      car.topSpeed = car.pitSpeedWas ?? car.topSpeed;
      car.pitSpeedWas = null;
      return false;
    }
    if (car.pitSpeedWas === null || car.pitSpeedWas === undefined) {
      car.pitSpeedWas = car.topSpeed;
    }
    car.topSpeed = Math.min(car.pitSpeedWas, this.pits.speedLimit);
    const was = car.pit;
    const took = this.pits.step(car, dt, this.serviceTime, car.gridIndex);
    if (was === Pit.SERVICE && car.pit === Pit.LEAVING) car.pitStops++;
    return took;
  }

  /**
   * Should this AI come in?
   *
   * Only when the tyres are actually gone, and only if there is enough race
   * left to be worth the time - stopping on the last lap is how a rival
   * throws away a place for nothing.
   */
  shouldPit(car) {
    if (!this.pits || car.tyre > AI_PIT_AT) return false;
    const left = this.totalLaps * this.track.lapLength - car.progress;
    return left > this.track.lapLength * 1.2;
  }

  /**
   * Steer a car that wants to pit down to the inside edge, so it can turn in.
   *
   * Overrides whatever the driver or the aid asked for, and only inside the
   * entry window - the same `laneSteer` everything else uses, so a car heading
   * for the pits moves like a car and not like a magnet.
   */
  aimForPits(car, dt) {
    if (!this.pits || car.pit !== Pit.OUT || car.finished) return;
    // From well *before* the entrance, not only once inside the window.
    //
    // The two ribbons only overlap for the first few metres of the taper - by
    // twenty metres in, the pit road is already eight metres off the racing
    // line - so a car that starts moving over when it reaches the entry is
    // still out on the racing line when the only place it could have crossed
    // has gone by. It then sails past every lap, which is how a race ended
    // with one car pitting and six driving round on dead tyres.
    const d = this.track.delta(this.pits.road.entryS, car.s);
    if (d < -PIT_APPROACH || d > this.pits.entryWindow) return;
    const st = this.track.sample(car.s, car.st);
    car.steer = laneSteer(car, this.track.limit(st, -1) + 0.6, dt, PIT_AIM_CLOSE);
  }

  /**
   * Is this car in the stretch of lap where it could turn in? Drives the HUD
   * prompt, so a player knows when steering left will actually do something
   * rather than just running them down the apron.
   */
  pitOpen(car) {
    return !!this.pits && car.pit === Pit.OUT && !car.finished
      && this.pits.canEnter(car);
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
    // Whichever ribbon it is on: a car can take the flag on its way down the
    // pit lane, and steering it towards the *circuit's* outside wall from in
    // there would drive it through the pit wall.
    if (car.onPit && this.pits) { this.pits.step(car, dt, this.serviceTime, car.gridIndex); return; }
    const st = car.road.sample(car.s, car.st);
    car.steer = laneSteer(car, car.road.limit(st, 1) - 1.0, dt);
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
    // Two different numbers, and conflating them cost an afternoon.
    //
    // `baseSpeed` is what the driver aims at, and the driver scales it by
    // whichever pace its grudge calls for. `topSpeed` is the rev limiter in
    // `Car.step`, which clamps regardless of what anybody asked for - so it
    // has to admit the *chasing* pace or the fight-back is computed and then
    // thrown away one line later. Raising them together instead just makes
    // the whole field permanently faster.
    const t = this.tuning;
    car.baseSpeed = BASE_SPEED * car.paceScale;
    car.topSpeed = BASE_SPEED * Math.max(t.aiSpeed, t.chaseSpeed ?? t.aiSpeed) * car.paceScale;
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
        // Two ribbons: a car in the pits and a car on the racing line can sit
        // at the same lap position and be seventy metres apart. Only cars on
        // the same road can touch.
        if (a.road !== b.road) continue;
        const ds = a.road.delta(a.s, b.s);
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
    const st = car.road.sample(car.s, car.st);
    const lim = car.road.limit(st, sign);
    return Math.max(0, sign > 0 ? lim - car.n : car.n - lim);
  }

  clampLateral(car) {
    const st = car.road.sample(car.s, car.st);
    car.n = THREE.MathUtils.clamp(car.n, car.road.limit(st, -1), car.road.limit(st, 1));
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
