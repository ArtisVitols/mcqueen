import * as THREE from 'three';
import { PHYSICS } from './physics.js';

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
    this.track = track;
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
    this.steer = 0;
    this.steerAngle = 0;             // front wheel angle, for the visuals
    this.slip = 0;                   // 0..1, drives tyre squeal
    this.rev = 0;                    // 0..1 within the current gear
    this.gear = 0;
    this.draft = 0;                  // 0..1, how deep in someone's tow
    this.assist = 1;                 // grip multiplier, raised on Easy
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
    this.s = this.track.wrap(-back);
    this.n = lane;
    this.psi = 0;
    this.speed = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.psiPrev = 0;
    this.gear = 0;
    this.shiftT = 0;
    this.aidLane = lane;
    this.progress = -back;
    this.lap = 1;
    this.finished = false;
    this.sync();
  }

  step(dt) {
    const track = this.track;
    const st = track.sample(this.s, this.st);
    const wasSpeed = this.speed;
    const wasPsi = this.psi;

    this.physics.drive(this, st, dt);

    // Shared invariants. Keeping these here rather than in the models is what
    // stops a handling change from becoming a lap-counting bug.
    this.psi = THREE.MathUtils.clamp(this.psi, -this.physics.maxPsi, this.physics.maxPsi);
    if (this.speed > this.topSpeed) {
      this.speed += (this.topSpeed - this.speed) * Math.min(1, dt * 3);
    }

    // --- integrate in track space ----------------------------------------
    const along = this.speed * Math.cos(this.psi);
    const across = this.speed * Math.sin(this.psi) + this.vy;
    const ds = along * track.arcScale(st, this.n) * dt;
    this.s = track.wrap(this.s + ds);
    this.progress += ds;
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
    this.lap = THREE.MathUtils.clamp(
      Math.floor(this.progress / track.lapLength) + 1, 1, this.totalLaps);

    this.accelLong = (this.speed - wasSpeed) / dt;
    // Sideways movement and a wall rub always squeal. A model may report more
    // than this - a slide the heading does not show - so take whichever is
    // louder rather than overwriting it.
    const squeal = Math.abs(across) / 14 + (this.scrubbing ? 0.5 : 0);
    this.slip = Math.min(1, Math.max(squeal, this.slip));
    this.sync(now);
  }

  /** Push the physics state into the three.js model. */
  sync(st = this.track.sample(this.s, this.st)) {
    this.track.position(st, this.n, this.position);
    this.model.position.copy(this.position);
    this.track.orient(st, this.psi, this._q, this.n);
    this.model.quaternion.copy(this._q);
  }

  get speedKmh() {
    return this.speed * 3.6;
  }
}
