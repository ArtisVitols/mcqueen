import * as THREE from 'three';

/**
 * Guido going round the wheels, and Mack parked up.
 *
 * Purely visual - the stop's timing lives in `src/pitstop.js` and does not
 * depend on where Guido has got to. That split matters: an animation that the
 * simulation waited on would make the race depend on the frame rate, and this
 * one renders at 1.7 fps under SwiftShader.
 *
 * There is no wheel-change animation, by request. Guido drives to each corner
 * of the car in turn, pauses there, and when all four are done he goes back to
 * his spot by the wall.
 */

const SPEED = 3.2;              // m/s, Guido's trundle
const TURN = 6.0;               // rad/s he can swing round
const PAUSE = 0.45;             // seconds spent at each wheel
const REACH = 0.55;             // how close to a wheel counts as arrived
const STANDOFF = 0.95;          // metres outboard of the wheel he stops

export class PitCrew {
  /**
   * @param {THREE.Object3D} guido  the loaded Guido pivot
   * @param {THREE.Object3D} mack   the loaded Mack pivot, or null
   */
  constructor(guido, mack) {
    this.guido = guido;
    this.mack = mack;
    this.active = false;
    this.at = 0;                // which wheel he is on
    this.wait = 0;
    this.route = [];
    this.home = new THREE.Vector3();
    this.homeYaw = 0;
    this._v = new THREE.Vector3();
    if (guido) guido.visible = false;
  }

  /**
   * Park the crew beside a point on the pit road.
   * @param {THREE.Vector3} pos  where the box is
   * @param {THREE.Vector3} side unit vector pointing at the pit wall
   * @param {number} yaw         heading down the lane
   */
  place(pos, side, yaw) {
    this.home.copy(pos).addScaledVector(side, 3.0);
    this.homeYaw = yaw;
    if (this.guido) {
      this.guido.position.copy(this.home);
      this.guido.rotation.set(0, yaw, 0);
    }
    if (this.mack) {
      // Well back down the lane so he is scenery rather than an obstacle.
      this.mack.position.copy(pos).addScaledVector(side, 7.5);
      this.mack.rotation.set(0, yaw, 0);
      this.mack.visible = true;
    }
  }

  /**
   * Start a stop. `wheels` are world positions of the four corners.
   *
   * He stands *outboard* of each wheel rather than on top of it - driving
   * into the middle of the car reads as a collision, not a pit stop.
   */
  begin(wheels, centre) {
    if (!this.guido || !wheels || wheels.length < 3) return;
    this.route = wheels.map((w) => {
      const out = this._v.clone().copy(w).sub(centre);
      out.y = 0;
      if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
      return w.clone().addScaledVector(out.normalize(), STANDOFF).setY(0);
    });
    // Nearest first, then round the car, so he never crosses under it.
    this.route.sort((a, b) => a.distanceToSquared(this.home) - b.distanceToSquared(this.home));
    this.active = true;
    this.at = 0;
    this.wait = 0;
    this.guido.visible = true;
  }

  /** Send him home. Called when service finishes, however it finished. */
  end() {
    this.active = false;
    this.at = this.route.length;
    this.wait = 0;
  }

  /** True once he has visited every wheel - what the HUD can show as done. */
  get finished() {
    return this.at >= this.route.length;
  }

  update(dt) {
    if (!this.guido || !this.guido.visible) return;
    const target = this.active && this.at < this.route.length
      ? this.route[this.at] : this.home;

    const to = this._v.copy(target).sub(this.guido.position);
    to.y = 0;
    const dist = to.length();

    if (dist > REACH) {
      to.normalize();
      this.guido.position.addScaledVector(to, Math.min(dist, SPEED * dt));
      // Face where he is going, swung round rather than snapped.
      const want = Math.atan2(to.x, to.z);
      let d = want - this.guido.rotation.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.guido.rotation.y += THREE.MathUtils.clamp(d, -TURN * dt, TURN * dt);
      return;
    }

    if (!this.active || this.at >= this.route.length) {
      // Home. Settle back to facing down the lane, then wait for the next stop.
      let d = this.homeYaw - this.guido.rotation.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.guido.rotation.y += THREE.MathUtils.clamp(d, -TURN * dt, TURN * dt);
      if (!this.active && Math.abs(d) < 0.05) this.guido.visible = false;
      return;
    }

    this.wait += dt;
    if (this.wait >= PAUSE) { this.at++; this.wait = 0; }
  }
}
