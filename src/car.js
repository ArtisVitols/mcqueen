import * as THREE from 'three';
import { PHYSICS, tyreSpeed } from './physics.js';

/**
 * A car in track space.
 *
 * The car carries a heading `psi` relative to the track tangent. Because the
 * tangent itself rotates as the car goes round the oval, a player who just
 * holds the throttle follows the track on their own - steering only moves them
 * between lanes.
 *
 * The handling model is pluggable (`src/physics.js`), but this class keeps
 * everything the rest of the game depends on: integration in track space, the
 * heading clamp, the rev limiter, track limits, and lap counting. A model
 * supplies forces and nothing else, so no model can put a car outside the
 * corridor or break the lap counter.
 */

export const MAX_PSI = 0.87;          // ~50 degrees; the arcade model's clamp

export class Car {
  constructor(spec, model, track, physics = PHYSICS.arcade) {
    this.spec = spec;
    this.track = track;              // the circuit: owns laps and race order
    // The ribbon the car is driving on. Normally the circuit; on a pit stop a
    // PitRoad, which implements the same surface interface. Keeping the two
    // apart is what stops a pit stop from ever becoming a lap-counting bug -
    // the same split that lets three handling models share one integrator.
    this.road = track;
    this.onPit = false;
    this.pitBase = 0;                // lap offset while on the pit road
    this.model = model;              // THREE.Object3D, already normalised
    this.physics = physics;
    this.isPlayer = false;

    this.s = 0;                      // distance along the centreline
    this.n = 0;                      // metres outboard of the centreline
    this.psi = 0;                    // heading relative to the tangent
    this.speed = 0;                  // m/s along the heading
    this.vy = 0;                     // lateral velocity the heading does not
                                     // account for - a slide. Zero in Arcade.
    this.progress = 0;               // signed distance from the start line
    this.lap = 1;                    // lap currently being driven, 1-based
    this.totalLaps = Infinity;
    this.place = 1;
    this.finished = false;
    this.finishTime = 0;

    this.throttle = 0;
    this.brake = 0;
    // What the driver is asking for, and what the tyres are actually given.
    // They are not the same field, because the driver aid rewrites the second
    // one: ramping the input on top of the controller's own output fed it back
    // on itself and the car stopped responding to the buttons at all.
    this.steerCmd = 0;
    this.steer = 0;
    this.steerAngle = 0;             // front wheel angle, for the visuals
    this.slip = 0;                   // 0..1, drives tyre squeal
    this.rev = 0;                    // 0..1 within the current gear
    this.gear = 0;
    this.draft = 0;                  // 0..1, how deep in someone's tow
    this.assist = 1;                 // grip multiplier, raised on Easy
    this.tyre = 1;                   // tyre life, 1 fresh to 0 worn out
    this.wearRate = 0;               // per metre; 0 disables wear entirely
    this.topSpeed = 78;              // m/s, overridden per difficulty
    this.accelLat = 0;               // for body roll
    this.accelLong = 0;              // for brake dive

    this.st = {};
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this.position = new THREE.Vector3();
  }

  /** Place the car on the grid, `back` metres behind the start line. */
  placeOnGrid(back, lane) {
    this.road = this.track;
    this.onPit = false;
    this.s = this.track.wrap(-back);
    this.n = lane;
    this.psi = 0;
    this.speed = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.psiPrev = 0;
    this.psiRate = 0;
    this.gear = 0;
    this.shiftT = 0;
    this.aidLane = lane;
    this.steerCmd = 0;
    this.steer = 0;
    this.progress = -back;
    this.lap = 1;
    this.tyre = 1;
    this.finished = false;
    this.sync();
  }

  /**
   * Move the car onto another ribbon - into the pits, or back out.
   *
   * The two overlap in space wherever this is allowed, so nothing jumps: the
   * pit road merges into the racing surface at both ends and the handover
   * happens inside that overlap.
   */
  useRoad(road, s, n) {
    // Keep the car pointing where it was actually pointing.
    //
    // `psi` is measured from the tangent of whichever ribbon the car is on,
    // and the two meet at an angle - 4 degrees at Motor Speedway, 20 at
    // Yoyleland. Carrying the number across therefore rotates the car on the
    // spot by exactly that angle, in one frame, at pit-exit speed. Preserve
    // the *world* heading instead and the handover is invisible; the car
    // rejoins pointing across the road, which is what a pit exit looks like,
    // and steers straight.
    const was = this.road.sample(this.s, {});
    const now = road.sample(s, {});
    const turn = Math.atan2(was.tz, was.tx) - Math.atan2(now.tz, now.tx);
    this.psi = wrapAngle(this.psi + turn);
    // Anything low-passing the heading sees this as a step otherwise, and
    // reports a yaw rate of hundreds of degrees a second that never happened.
    this.psiPrev = this.psi;
    this.psiRate = 0;
    this.road = road;
    this.s = s;
    this.n = n;
    this.onPit = road !== this.track;
    // Anchor the mapping so `progress` is continuous across the handover.
    if (this.onPit) this.pitBase = this.progress - road.lapAt(s);
    this.sync();
  }

  step(dt) {
    const track = this.road;
    const st = track.sample(this.s, this.st);
    const wasSpeed = this.speed;
    const wasPsi = this.psi;

    this.physics.drive(this, st, dt);

    // Shared invariants. Keeping these here rather than in the models is what
    // stops a handling change from becoming a lap-counting bug.
    this.psi = THREE.MathUtils.clamp(this.psi, -this.physics.maxPsi, this.physics.maxPsi);
    // The rev limiter, and with it what worn tyres cost in a straight line.
    // Here rather than in a model because every model shares this line, and
    // because the model that most needs it - Arcade - has no tyres in it at
    // all. See tyreSpeed.
    const top = this.topSpeed * tyreSpeed(this);
    if (this.speed > top) {
      this.speed += (top - this.speed) * Math.min(1, dt * 3);
    }

    // --- integrate in track space ----------------------------------------
    const along = this.speed * Math.cos(this.psi);
    const across = this.speed * Math.sin(this.psi) + this.vy;
    const ds = along * track.arcScale(st, this.n) * dt;
    this.s = track.wrap(this.s + ds);
    // On the pit road, progress is *mapped* rather than accumulated: the pit
    // lane is a chord and the lap is an arc, so paying out its own metres
    // would hand a place to anybody who stopped. See PitRoad.lapAt.
    this.progress = this.onPit ? this.pitBase + track.lapAt(this.s)
                               : this.progress + ds;
    this.n += across * dt;

    // What the body is feeling, so every model drives the visuals the same
    // way. Outward-positive: the track's own centrifugal push, less whatever
    // the car unwinds by rotating its heading out of the corner. Zero when the
    // car is travelling straight in world space, which is the test that
    // matters - a car on a straight must not lean.
    this.accelLat = this.speed * this.speed * st.kappa
                  - this.speed * (this.psi - wasPsi) / dt;

    // --- track limits -----------------------------------------------------
    // Clamp against the station we have arrived at, not the one we left, or
    // the car creeps over the edge wherever the ribbon narrows.
    // Rubbing the wall scrubs speed and pushes the car back on, but never
    // spins it. In NASCAR you lean on the wall; you do not lose the race.
    const now = track.sample(this.s, this.st);
    const outer = track.limit(now, 1);
    const inner = track.limit(now, -1);
    const side = this.n > outer ? 1 : this.n < inner ? -1 : 0;
    if (side) {
      this.n = side > 0 ? outer : inner;
      if (Math.sign(this.psi) === side) this.psi *= 0.3;
      if (Math.sign(this.vy) === side) this.vy = 0;
      // Scrub in proportion to how hard the car went in, not just for being
      // there. The corridor narrows through the turns, so a car sitting on the
      // line gets clamped every step without ever having hit anything - and a
      // flat rate charged it 70% of its speed per second for the privilege.
      const into = Math.min(1, Math.abs(across) / 3);
      this.speed *= Math.pow(this.physics.wallScrub, dt * into);
      this.scrubbing = into > 0.15;
    } else {
      this.scrubbing = false;
    }

    // Cars line up behind the line, so progress starts negative and the first
    // crossing does not advance the counter - lap 1 is the one being driven
    // from the green light until they come back round.
    // Laps belong to the circuit, never to whatever ribbon the car is on.
    this.lap = THREE.MathUtils.clamp(
      Math.floor(this.progress / this.track.lapLength) + 1, 1, this.totalLaps);

    // --- tyre wear ---------------------------------------------------------
    // Charged per metre and per unit of cornering load, so a driver who leans
    // on them wears them faster than one who does not - which is the only
    // thing that makes a stop a decision rather than a timer. Not charged in
    // the pit lane: crawling down it must not cost what it is there to fix.
    if (this.wearRate > 0 && !this.onPit) {
      // Squared load would be more realistic and is far too sharp here: at
      // 2.5 g it wears seven times as fast as cruising, and a player running
      // at the limit on a banked superspeedway burned a set every other lap.
      // Linear tops out at about twice, which is enough for "lean on them and
      // you will stop sooner" to be a real decision without being a leash.
      const load = Math.min(2.5, Math.abs(this.accelLat) / 9.81);
      const along = Math.abs(this.speed) * dt;
      this.tyre = Math.max(0, this.tyre - this.wearRate * along * (1 + 0.5 * load));
    }

    this.accelLong = (this.speed - wasSpeed) / dt;
    // Sideways movement and a wall rub always squeal. A model may report more
    // than this - a slide the heading does not show - so take whichever is
    // louder rather than overwriting it.
    const squeal = Math.abs(across) / 14 + (this.scrubbing ? 0.5 : 0);
    this.slip = Math.min(1, Math.max(squeal, this.slip));
    this.sync(now);
  }

  /** Push the physics state into the three.js model. */
  sync(st = this.road.sample(this.s, this.st)) {
    this.road.position(st, this.n, this.position);
    this.model.position.copy(this.position);
    this.road.orient(st, this.psi, this._q, this.n);
    this.model.quaternion.copy(this._q);
  }

  get speedKmh() {
    return this.speed * 3.6;
  }
}

/** Into (-pi, pi]. */
function wrapAngle(a) {
  const TAU = Math.PI * 2;
  return a - TAU * Math.round(a / TAU);
}
