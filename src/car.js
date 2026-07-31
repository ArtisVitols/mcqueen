import * as THREE from 'three';

/**
 * Arcade car physics in track space.
 *
 * The car carries a heading `psi` relative to the track tangent, hard-clamped
 * to +/-50 degrees. Because the tangent itself rotates as the car goes round
 * the oval, a player who just holds the throttle follows the track on their
 * own - steering only moves them between lanes. That is what makes this
 * playable for a five-year-old, and it also makes spinning out, facing the
 * wrong way and getting permanently stuck all structurally impossible.
 */

export const MAX_PSI = 0.87;          // ~50 degrees off the tangent
const STEER_RATE = 1.9;               // rad/s of heading change at full lock
const STEER_RETURN = 2.6;             // self-centring rate
const ENGINE = 15.0;                  // m/s^2 at full throttle
const BRAKE = 22.0;
const DRAG = 0.00055;                 // quadratic, sets the top speed
const ROLL_DRAG = 0.6;
const WALL_SCRUB = 0.55;              // speed kept per second scrubbing a wall

export class Car {
  constructor(spec, model, track) {
    this.spec = spec;
    this.track = track;
    this.model = model;              // THREE.Object3D, already normalised
    this.isPlayer = false;

    this.s = 0;                      // distance along the centreline
    this.n = 0;                      // metres outboard of the centreline
    this.psi = 0;                    // heading relative to the tangent
    this.speed = 0;                  // m/s along the heading
    this.progress = 0;               // signed distance from the start line
    this.lap = 1;                    // lap currently being driven, 1-based
    this.totalLaps = Infinity;
    this.place = 1;
    this.finished = false;
    this.finishTime = 0;

    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.slip = 0;                   // 0..1, drives tyre squeal
    this.topSpeed = 78;              // m/s, overridden per difficulty

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
    this.progress = -back;
    this.lap = 1;
    this.finished = false;
    this.sync();
  }

  step(dt) {
    const track = this.track;
    const st = track.sample(this.s, this.st);

    // --- longitudinal -----------------------------------------------------
    const drag = DRAG * this.speed * this.speed + ROLL_DRAG;
    let accel = this.throttle * ENGINE * this.powerCurve() - this.brake * BRAKE - drag;
    this.speed = Math.max(0, this.speed + accel * dt);
    if (this.speed > this.topSpeed) {
      this.speed += (this.topSpeed - this.speed) * Math.min(1, dt * 3);
    }

    // --- steering ---------------------------------------------------------
    // Authority fades in from a standstill and tapers at speed, so the car
    // feels planted on the straights without going numb in the corners.
    const grip = Math.min(1, this.speed / 12) * (0.45 + 0.55 * (1 - Math.min(1, this.speed / 110)));
    this.psi += this.steer * STEER_RATE * grip * dt;
    if (Math.abs(this.steer) < 0.05) {
      this.psi -= this.psi * Math.min(1, STEER_RETURN * dt);
    }
    this.psi = THREE.MathUtils.clamp(this.psi, -MAX_PSI, MAX_PSI);

    // --- integrate in track space ----------------------------------------
    const along = this.speed * Math.cos(this.psi);
    const across = this.speed * Math.sin(this.psi);
    const ds = along * track.arcScale(st, this.n) * dt;
    this.s = track.wrap(this.s + ds);
    this.progress += ds;
    this.n += across * dt;

    // --- track limits -----------------------------------------------------
    // Clamp against the station we have arrived at, not the one we left, or
    // the car creeps over the edge wherever the ribbon narrows.
    // Rubbing the wall scrubs speed and pushes the car back on, but never
    // spins it. In NASCAR you lean on the wall; you do not lose the race.
    const now = track.sample(this.s, this.st);
    const outer = track.limit(now, 1);
    const inner = track.limit(now, -1);
    if (this.n > outer) {
      this.n = outer;
      if (this.psi > 0) this.psi *= 0.3;
      this.speed *= Math.pow(WALL_SCRUB, dt);
      this.scrubbing = true;
    } else if (this.n < inner) {
      this.n = inner;
      if (this.psi < 0) this.psi *= 0.3;
      this.speed *= Math.pow(WALL_SCRUB, dt);
      this.scrubbing = true;
    } else {
      this.scrubbing = false;
    }

    // Cars line up behind the line, so progress starts negative and the first
    // crossing does not advance the counter - lap 1 is the one being driven
    // from the green light until they come back round.
    this.lap = THREE.MathUtils.clamp(
      Math.floor(this.progress / track.lapLength) + 1, 1, this.totalLaps);
    this.slip = Math.min(1, Math.abs(across) / 14 + (this.scrubbing ? 0.5 : 0));
    this.sync(now);
  }

  /** Torque falls away near the top end so acceleration tapers off. */
  powerCurve() {
    const r = this.speed / this.topSpeed;
    return Math.max(0.15, 1.25 - 0.85 * r * r);
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
