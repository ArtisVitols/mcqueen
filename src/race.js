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
const PIT_APPROACH = 700;
// How hard a car slows on its way to the pit entrance. Sized so that a car at
// full speed is down to the pit limit by the time it turns in, over the 320 m
// `PIT_APPROACH` gives it.
const PIT_BRAKE = 3.5;

/**
 * Incidents: a rival gets it wrong, runs off the racing line and stops.
 *
 * A wreck is the best thing that happens in an oval race to a five-year-old
 * watching one, so this exists purely to be seen. Three rules keep it from
 * being anything worse than that:
 *
 *   - It is **rare**, and capped, so a race is not a demolition derby.
 *   - It never starts within `CRASH_CLEAR` of a human. A car that spears off
 *     in front of you and cannot be avoided is not a spectacle, it is the game
 *     crashing *you*.
 *   - The car stops **inside the corridor**, at its very edge - against the
 *     wall on the outside, down on the apron on the inside. Past that edge is
 *     wherever `refine_track` found a drop or a barrier, which is exactly the
 *     place not to park a car nobody is driving any more.
 */
const CRASH_RATE = 0.001;    // per rival per second, once the race has settled
const CRASH_MAX = 2;         // ... and never more than this in one race
const CRASH_CLEAR = 45;      // metres of lap either side of a human
const CRASH_COAST = 0.7;     // seconds off the throttle before the brakes
const CRASH_CLOSE = 3.4;     // m/s it is allowed to cross the road at
const CRASH_STOPPED = 1.2;   // m/s that counts as parked
// How fast contact may push two cars apart, in metres per second. Firm enough
// to keep a pack from overlapping and slow enough to look like a push.
const SEPARATE_RATE = 2.4;
/**
 * How much of a touch the driver actually feels, as a fraction.
 *
 * **Contact used to end races.** Running alongside somebody bled 35-40% of a
 * car's speed *per second* and shoved it sideways at 6 m/s, which on an oval -
 * where the whole point is to run side by side - made close racing something
 * to avoid rather than the game. It read as the car braking and steering by
 * itself whenever anyone came near.
 *
 * At a fifth of that a brush is a nudge and a rub costs a few km/h, so two
 * cars can hold a line beside each other for a corner. What it must still do
 * is stop them occupying the same place: the *shove* is what does that, and it
 * is why `SEPARATE_RATE` came down by rather less than the penalty did.
 * Measured, worst overlap in a full race: 1.58 m at the old rate of 6, 1.61 m
 * at 2.4, and 2.28 m at 1.2 - which is two cars two centimetres apart, i.e.
 * inside each other. Anything from about 2.4 up behaves the same; below it
 * falls off a cliff. `check_pits` measures the same thing with eighteen cars
 * in one lane.
 */
const CONTACT_BITE = 0.2;
// A conceding rival never drops below this, however slowly the human is going.
// A race where the whole field waits for a stopped car is not a race.
const CONCEDE_FLOOR = 30;    // m/s, about 108 km/h

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
    // Cars that did not get to the end. Kept apart from `results` so the
    // finishers keep their places and the race can still know when everybody
    // is accounted for - a retired car never crosses the line, and a race that
    // waits for it to do so never ends.
    this.retired = [];
    this.incidents = 0;                     // incidents *started*, see maybeCrash
    // Tests that measure something else turn this off: `check_pits` asserts
    // every car takes a stop, and a car in the wall cannot.
    this.crashRate = CRASH_RATE;
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
      // When this car decides its tyres have gone. Scattered, because a field
      // that all wears at the same rate all comes in on the same lap - and
      // sixteen cars in one pit lane is a queue nobody enjoys, however well it
      // is handled. Real teams stagger their stops for the same reason.
      car.pitAt = AI_PIT_AT * (0.7 + this.rng() * 0.6);
      car.crash = null;                 // seconds into an incident, or null
      car.out = false;                  // ... and parked at the side for good

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
        // Unconditionally, because `aimForPits` owns `car.pitCap` and clearing
        // it is half its job. See the note on it.
        this.aimForPits(car, dt, auto);
        // Turning in is *asking* - holding the button towards the inside -
        // never merely being near the edge. On Easy the aid parks the car on
        // the low line, so "close enough" pitted a five-year-old every single
        // lap without them touching anything, and Easy stopped being a win.
        if (auto || car.steerCmd < -0.2) this.pits.tryEnter(car, this.field);
      }
    }

    for (const driver of this.drivers) {
      const car = driver.car;
      if (car.out) continue;                    // parked, and staying there
      if (this.stepCrash(car, dt)) continue;
      if (car.finished) {
        this.coolDown(car, dt);
        continue;
      }
      if (this.stepPit(car, dt)) continue;
      driver.update(dt, this.field, this.tuning, this.physics);
      this.concede(car);
      this.maybeCrash(car, dt);
      this.rubberBand(car);
      // Rivals stop too, or a stop is a penalty rather than a strategy - and
      // "Easy is winnable by holding the throttle down" would stop being true
      // the moment tyres mattered.
      //
      // **`aimForPits` is called every step, whether or not this car wants to
      // come in.** It is the only thing that writes `car.pitCap`, and the AI
      // reads that cap every step - so calling it only when a stop is due left
      // the last value it wrote standing for the rest of the race. A car that
      // had just pitted has `tyre = 1`, so `shouldPit` is false, so nothing
      // ever cleared the pit speed limit off it: eighteen rivals aiming at
      // 22 m/s of a possible 87 from their stop to the flag. `concede` above
      // has always had this shape; this one did not.
      const wantsPit = !car.isPlayer && this.shouldPit(car);
      this.aimForPits(car, dt, wantsPit);
      // A rival has to be *steered* in. Without this it wants to pit, is
      // told it may, and sails past the entry every lap on the racing line.
      if (wantsPit) this.pits.tryEnter(car, this.field);
    }

    // The AI gets its tow through its own target speed; a human has no such
    // controller, so the models that model drag need to be told about it here.
    for (const car of this.humans) this.updateDraft(car);

    for (const car of this.field) {
      if (car.out) continue;                    // nothing left to integrate
      const before = car.lap;
      car.step(dt);
      if (car.lap !== before && car.lap > 1 && car === this.player) {
        this.onLap?.(car.lap);
      }
      if (!car.finished && car.progress >= this.totalLaps * this.track.lapLength) {
        car.finished = true;
        car.finishTime = this.clock;
        this.results.push(car);
        if (car === this.player || this.accountedFor === this.field.length) {
          this.onFinish?.(this.results.length, car);
        }
      }
    }

    this.separate(dt);
    this.updateOrder();

    if (this.accountedFor === this.field.length && this.state !== State.FINISHED) {
      // Classify the retirements behind the finishers, the one that got
      // furthest first, so the results screen lists everybody.
      this.results.push(...this.retired.slice()
        .sort((a, b) => b.progress - a.progress));
      this.state = State.FINISHED;
    }
  }

  /** Cars whose race is over one way or the other. */
  get accountedFor() {
    let n = 0;
    for (const car of this.field) if (car.finished || car.out) n++;
    return n;
  }

  /**
   * Roll for an incident.
   *
   * Per second rather than per lap, so it does not depend on the circuit or
   * on how fast this car happens to be going, and off the seeded `rng` so a
   * simulated race is still reproducible.
   */
  maybeCrash(car, dt) {
    // Counted from the moment an incident *starts*, not from when the car
    // finally stops. It takes a few seconds to come to rest, and with a
    // full grid several rivals rolled the dice inside that window: the cap
    // read two and let five of them off the road.
    if (!this.crashRate || this.incidents >= CRASH_MAX) return;
    if (car.crash !== null || car.out || car.finished || car.onPit) return;
    // Not off the line, and not on the run to the flag: an incident wants to
    // be something that happens *during* the race.
    if (car.lap < 2) return;
    const left = this.totalLaps * this.track.lapLength - car.progress;
    if (left < this.track.lapLength * 0.5) return;
    // Including one that has already taken the flag: they are still on the
    // road, rolling round to the outside, and still watching.
    for (const human of this.humans) {
      if (Math.abs(this.track.delta(human.s, car.s)) < CRASH_CLEAR) return;
    }
    if (this.rng() < this.crashRate * dt) {
      car.crash = 0;
      this.incidents++;
      // Half of them slide down to the apron and half run up to the wall,
      // because a race where every incident looks the same stops being one.
      car.crashSide = this.rng() < 0.5 ? 1 : -1;
    }
  }

  /**
   * One step of an incident: off the power, across the road, and stopped.
   *
   * Deliberately not a spin. Under Arcade a car *cannot* spin - that is the
   * rule the whole game is built on - so this is what a rival getting it wrong
   * looks like here: it runs wide, scrubs its speed off and parks. The aim is
   * past the edge of the corridor so it commits all the way there; `Car.step`
   * clamps it to the road, which is where it should stop anyway.
   */
  stepCrash(car, dt) {
    if (car.crash === null || car.crash === undefined) return false;
    car.crash += dt;
    const st = car.road.sample(car.s, car.st);
    const edge = car.road.limit(st, car.crashSide) + car.crashSide * 3;
    car.steer = laneSteer(car, edge, dt, CRASH_CLOSE);
    car.throttle = 0;
    car.brake = car.crash > CRASH_COAST ? 1 : 0.4;
    if (car.speed < CRASH_STOPPED) this.retire(car);
    return true;
  }

  /** Park a car for good. */
  retire(car) {
    const st = car.road.sample(car.s, car.st);
    // Just inside the edge, not on it: a car sitting at an angle is wider than
    // the half-car-width `Track.limit` reserves, and half of it would be
    // through the wall.
    car.n = car.road.limit(st, car.crashSide) - car.crashSide * 0.5;
    // Stopped square looks parked; stopped askew looks like it happened.
    car.psi = car.crashSide * (0.25 + this.rng() * 0.25);
    car.speed = 0;
    car.vy = 0;
    car.throttle = 0;
    car.brake = 1;
    car.crash = null;
    car.out = true;
    car.finishTime = this.clock;
    car.sync(st);
    this.retired.push(car);
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
    const took = this.pits.step(car, dt, this.serviceTime, car.gridIndex, this.field);
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
    if (!this.pits || car.tyre > (car.pitAt ?? AI_PIT_AT)) return false;
    const left = this.totalLaps * this.track.lapLength - car.progress;
    return left > this.track.lapLength * 1.2;
  }

  /**
   * Steer a car that wants to pit down to the inside edge, so it can turn in.
   *
   * Overrides whatever the driver or the aid asked for, and only inside the
   * entry window - the same `laneSteer` everything else uses, so a car heading
   * for the pits moves like a car and not like a magnet.
   *
   * **This function owns `car.pitCap`, so it must be called every step for
   * every car** - `want` is how a caller says "not this one", not a reason to
   * skip the call. The cap is read unconditionally by `Driver.update`, so any
   * step that does not run this leaves the last value it wrote in force.
   */
  aimForPits(car, dt, want = true) {
    car.pitCap = null;
    if (!want || !this.pits || car.pit !== Pit.OUT || car.finished) return;
    // From well *before* the entrance, not only once inside the window.
    //
    // The two ribbons only overlap for the first few metres of the taper - by
    // twenty metres in, the pit road is already eight metres off the racing
    // line - so a car that starts moving over when it reaches the entry is
    // still out on the racing line when the only place it could have crossed
    // has gone by. It then sails past every lap, which is how a race ended
    // with one car pitting and six driving round on dead tyres.
    const d = this.track.delta(this.pits.road.entryS, car.s);
    if (d < -PIT_APPROACH) return;
    // Past the entrance, only while *this* car could still turn in.
    //
    // `pits.entryWindow` is the widest window anybody has - it is for sizing
    // the approach - and a car's own is `windowFor(gridIndex)`, which for the
    // first box is a third of it: 105 m against 354 m at Motor Speedway, 209
    // against 635 at Yoyleland. Releasing on the wide one held a car that
    // could no longer possibly pit at the pit speed limit, on the racing line,
    // for another quarter of a lap. `canEnter` is the rule itself, and it also
    // covers having already been in this lap.
    if (d >= 0 && !this.pits.canEnter(car)) return;
    const st = this.track.sample(car.s, car.st);
    car.steer = laneSteer(car, this.track.limit(st, -1) + 0.6, dt, PIT_AIM_CLOSE);

    // **Slow down before the entrance, not after it.**
    //
    // This is what a pit road entry is for, and leaving it out was the whole
    // problem: eighteen cars strung over two hundred metres of track at 250
    // km/h become eighteen cars in sixty-five metres of pit lane at the limit,
    // and no amount of queueing inside the lane can undo a threefold
    // compression that has already happened. They arrive on top of each other
    // because they were never asked to slow down.
    //
    // The earlier answer - refuse entry unless the lane ahead is clear - kept
    // them apart by keeping them *out*: two or three cars a lap got in and the
    // rest drove round again, lap after lap, which is exactly what the owner
    // saw. Braking on the approach lets the whole field in at once and strings
    // it out on the racing line first, which is also what it looks like in the
    // sport.
    if (d < 0) {
      const left = -d;
      car.pitCap = Math.sqrt(this.pits.speedLimit * this.pits.speedLimit
                             + 2 * PIT_BRAKE * left);
    } else {
      car.pitCap = this.pits.speedLimit;
    }
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
    if (car.onPit && this.pits) {
      this.pits.step(car, dt, this.serviceTime, car.gridIndex, this.field);
      return;
    }
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

  /**
   * The last lap, on Normal: anybody still ahead of a human lifts.
   *
   * `tuning.concede` is metres per second off the pace, and it is what makes
   * Normal a setting a five-year-old finishes in front however the race has
   * gone - the rest of Normal is Hard, which is deliberate and is the point.
   * It comes off the *target* speed rather than the limiter so it reads as a
   * lift: they keep racing each other, they simply stop driving away from you.
   *
   * Ahead of *any* human, so a two-player grid lets both of them through.
   */
  concede(car) {
    car.concedeCap = null;
    const off = this.tuning.concede;
    if (!off || car.finished) return;
    for (const human of this.humans) {
      // Not while they are in the pits: a car held to the pit limit - or sat
      // stationary in its box being serviced - would have the whole field
      // waiting for it.
      if (human.finished || human.onPit) continue;
      if (human.lap < this.totalLaps) continue;
      // Everybody, not only whoever happens to be ahead at this instant.
      //
      // Capping just the cars in front leaks: a rival that concedes, drops
      // behind and is no longer "in front" is released, and with Normal
      // carrying Hard's chase pace it comes straight back past at the flag.
      // Nine races of it produced six photo finishes lost by hundredths. On
      // the last lap of a Normal race nobody is quicker than the person, and
      // that is the setting's whole promise.
      // Twenty km/h slower **than the person**, not than its own pace. That is
      // what "so I can pass them" actually requires: measured against its own
      // pace, a rival that was already quicker than you stays quicker than you
      // and the lift changes the gap rather than closing it. Measured against
      // yours, you close at exactly 20 km/h and the last lap comes to you.
      const cap = Math.max(CONCEDE_FLOOR, human.speed - off);
      car.concedeCap = car.concedeCap === null ? cap : Math.min(car.concedeCap, cap);
    }
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
    // Cars that are where they are meant to be and are not going to be moved:
    // a wreck at the roadside, and a car stopped on its mark being serviced.
    const fixed = (c) => c.out || c.pit === Pit.STOPPED || c.pit === Pit.SERVICE;
    const slow = new Map();       // car -> the harshest contact it earned
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i], b = f[j];
        // Two ribbons: a car in the pits and a car on the racing line can sit
        // at the same lap position and be seventy metres apart. Only cars on
        // the same road can touch.
        if (a.road !== b.road) continue;
        // A parked car is scenery: it pushes, it does not get pushed. Letting
        // the contact move it would walk a wreck back onto the racing line -
        // or a car off the mark its crew is working on - one nudge at a time.
        // Being *serviced* counts: with eighteen boxes the lane is tight
        // enough that a car peeling into its own drives across its
        // neighbour's, and the one on the mark is the one that must not move.
        if (fixed(a) && fixed(b)) continue;
        const ds = a.road.delta(a.s, b.s);
        if (Math.abs(ds) > 5.2) continue;
        const dn = b.n - a.n;
        const overlap = 2.3 - Math.abs(dn);
        if (overlap <= 0) continue;

        // Move each of them away from the other, but only as far as the road
        // allows. Shoving them the full distance regardless is how the field
        // ended up outside the corridor wherever the track narrows.
        const dir = dn >= 0 ? 1 : -1;
        // One of them may be immovable, and then the other one does all the
        // moving - the same total separation, out of one car instead of two.
        const share = fixed(a) || fixed(b) ? 1 : 0.5;
        // **Per second, not per step.** This is the same lesson the speed
        // penalty below already learned, and the lateral shove had never had
        // it: pushing cars apart by the whole overlap every step is a lateral
        // velocity of hundreds of metres a second, and with a car between two
        // others it happens twice. In a full pit lane - eighteen cars, boxes
        // 15 m apart, a corridor a couple of metres wide - it threw cars four
        // and five metres sideways in a single frame and then threw them back,
        // which is not contact, it is a teleport with a pattern.
        const want = Math.min(overlap * share, SEPARATE_RATE * dt);
        if (!fixed(a)) { a.n -= dir * Math.min(want, this.room(a, -dir)); this.clampLateral(a); }
        if (!fixed(b)) { b.n += dir * Math.min(want, this.room(b, dir)); this.clampLateral(b); }

        // If they still overlap there is simply no room to run side by side
        // here, so the car behind lifts rather than being pushed off the road.
        //
        // Per second, not per step. Unscaled this ran 120 times a second and
        // took 14 m/s off a car in half a second of light contact - a touch
        // read as a crash, and on a superspeedway where the field runs nose to
        // tail that is most of the race.
        const left = 2.3 - Math.abs(b.n - a.n);
        const behind = ds > 0 ? a : b;
        if (fixed(behind)) continue;              // it is already stopped
        // Recorded, not applied. **Once per car, not once per neighbour.**
        // Charging it per pair compounds: in a queue a car is behind several
        // others at once, and 0.6 per second each became 97% of its speed gone
        // in a second. That is what a pit lane full of cars felt like - ten
        // km/h, sideways, and nothing the driver could do about it.
        // Scaled by CONTACT_BITE: the shape is unchanged - deeper overlap
        // costs more, and running clean costs nothing - it just no longer
        // takes half a car's speed away for touching somebody.
        const bite = left > 0 ? Math.min(0.35, left * 0.2) : 0.4;
        const keep = 1 - bite * CONTACT_BITE;
        slow.set(behind, Math.min(slow.get(behind) ?? 1, keep));
      }
    }
    for (const [car, keep] of slow) car.speed *= Math.pow(keep, dt);
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
      // A car in the wall is classified behind everybody who is still going,
      // whatever its progress says - and its `progress` is frozen, so without
      // this it would drift down the order as the race went on rather than
      // simply being out of it. Between two of them, the one that got
      // furthest is ahead.
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (!a.out) {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
      }
      return b.progress - a.progress;
    });
    this.order.forEach((car, i) => { car.place = i + 1; });
  }
}
