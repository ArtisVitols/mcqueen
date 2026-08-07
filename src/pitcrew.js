import * as THREE from 'three';

/**
 * Guido going round the wheels, and Mack parked up.
 *
 * Purely visual - the stop's timing lives in `src/pitstop.js` and does not
 * depend on where Guido has got to. That split matters: an animation that the
 * simulation waited on would make the race depend on the frame rate, and this
 * one renders at 1.7 fps under SwiftShader.
 *
 * There is no wheel-change animation, by request. He drives to each corner in
 * turn, pauses, and goes home when all of them are done.
 *
 * **He drives *around* the car, never through it.** The route is built in the
 * car's own frame: each stop sits beside a wheel and outside the bodywork, the
 * stops are ordered so he works his way round rather than criss-crossing, and
 * whenever the next one is on the opposite side a waypoint is inserted past
 * the nose or the tail. Straight lines between wheels took him clean through
 * the middle of the car.
 */

const SPEED = 3.2;              // m/s, Guido's trundle
const TURN = 6.0;               // rad/s he can swing round
const PAUSE = 0.45;             // seconds spent at each wheel
const REACH = 0.4;              // how close to a waypoint counts as arrived
// Metres clear of the bodywork he works from - on top of his own radius, so
// this is the gap you actually see. Kept small on purpose: he is changing a
// wheel, and standing back far enough to be obviously safe read as him doing
// the job from the next parking space. It cannot go to zero, because the ring
// is built on his worst-case radius and the clearance test measures his
// footprint against the same rectangle.
const STANDOFF = 0.30;

const UP = new THREE.Vector3(0, 1, 0);

export class PitCrew {
  /**
   * @param {THREE.Object3D} guido  the loaded Guido pivot
   * @param {THREE.Object3D} mack   the loaded Mack pivot, or null
   */
  constructor(guido, mack, guidoSize = null) {
    this.guido = guido;
    this.mack = mack;
    // His own footprint, as a radius. The ring below has to clear the car by
    // this much *plus* the standoff, because Guido is a vehicle and not a
    // point - his centre staying outside the bodywork still swings his nose
    // through it at every corner of the route, which is exactly what it
    // looked like.
    this.radius = guidoSize
      ? Math.hypot(guidoSize.x, guidoSize.z) / 2 : 0.8;
    this.active = false;
    this.at = 0;                // which waypoint he is on
    this.wait = 0;
    this.route = [];            // world positions, in order
    this.isWheel = [];          // ... and which of them are wheels to work at
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
   * Start a stop: plan a lap of the car and set off.
   *
   * @param {THREE.Vector3[]} wheels world positions of the wheels
   * @param {THREE.Object3D} car     the car's pivot - position and heading
   * @param {THREE.Vector3} size     the car's measured size, in metres
   */
  begin(wheels, car, size) {
    if (!this.guido || !wheels || wheels.length < 3 || !car) return;

    const centre = car.position;
    // The car's own axes, flattened: it is sitting on a banked road and this
    // is a route across the ground, not over the bodywork.
    const fwd = this._v.set(0, 0, 1).applyQuaternion(car.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const f = fwd.clone();

    // Clear of the *bodywork*, not of the wheels: the wheels sit inside the
    // nose and tail, so standing off from them would put him in the bumper.
    const clear = STANDOFF + this.radius;
    const halfW = (size ? size.x : 1.9) / 2 + clear;
    const halfL = (size ? size.z : 4.4) / 2 + clear;

    // Everything below happens on a **rectangle around the car** - the ring.
    // Every waypoint sits on its perimeter and every move follows that
    // perimeter, turning the ring's corners rather than cutting them. A ring
    // is convex and contains the car, so a path that never leaves it can never
    // enter the bodywork. Bridging only the changes of *side* was not enough:
    // the last leg, from the tail back to his spot, clipped the rear corner.
    const ang = (q) => Math.atan2(q.v / halfL, q.u / halfW);
    const CORNERS = [
      { u: halfW, v: halfL }, { u: -halfW, v: halfL },
      { u: -halfW, v: -halfL }, { u: halfW, v: -halfL },
    ];
    // Angles wrapped into [0, 2pi). Merely forcing them positive is not the
    // same thing and is not enough: a corner one whole turn "ahead" then reads
    // as 6.65 rad against a span of 2.31 and is skipped, which put a leg
    // straight across the back of the car.
    const TAU = Math.PI * 2;
    const wrap = (a) => ((a % TAU) + TAU) % TAU;
    /** The ring corners passed going anticlockwise from `a` round to `b`. */
    const corners = (a, b) => {
      const t0 = ang(a);
      const span = wrap(ang(b) - t0) || TAU;
      const hit = [];
      for (let k = 0; k < 4; k++) {
        const d2 = wrap(Math.PI / 4 + k * Math.PI / 2 - t0);
        if (d2 > 1e-6 && d2 < span - 1e-6) hit.push({ k, d2 });
      }
      hit.sort((x, y) => x.d2 - y.d2);
      return hit.map((h) => ({ ...CORNERS[h.k], wheel: false }));
    };

    // Each wheel, pushed out onto the side of the ring it belongs to.
    const stops = wheels.map((w) => {
      const d = w.clone().sub(centre);
      d.y = 0;
      const u = d.dot(right);
      return { u: (u >= 0 ? 1 : -1) * halfW, v: d.dot(f), wheel: true };
    });

    // He joins and leaves the ring at the point on it nearest his spot, which
    // is a straight run out from the side of the car and clear of everything.
    const hd = this._v.copy(this.home).sub(centre);
    hd.y = 0;
    const hu = hd.dot(right);
    const gate = {
      u: (hu >= 0 ? 1 : -1) * halfW,
      v: Math.max(-halfL, Math.min(halfL, hd.dot(f))),
      wheel: false,
    };

    // Round the ring one way, starting from the gate.
    const t0 = ang(gate);
    const order = stops.slice().sort((a, b) => wrap(ang(a) - t0) - wrap(ang(b) - t0));

    const path = [gate];
    let prev = gate;
    for (const s of order) { path.push(...corners(prev, s), s); prev = s; }
    path.push(...corners(prev, gate), gate);

    const at = (q) => centre.clone()
      .addScaledVector(right, q.u)
      .addScaledVector(f, q.v)
      .setY(centre.y);
    this.route = path.map(at);
    this.isWheel = path.map((q) => q.wheel);
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

  /** True once he has visited every waypoint. */
  get finished() {
    return this.at >= this.route.length;
  }

  /** How many wheels he has actually worked at, for the tests. */
  get wheelsDone() {
    let n = 0;
    for (let i = 0; i < Math.min(this.at, this.isWheel.length); i++) {
      if (this.isWheel[i]) n++;
    }
    return n;
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

    // Only the wheels are worth stopping at; a bridge is just a corner to turn.
    if (this.isWheel[this.at]) {
      this.wait += dt;
      if (this.wait < PAUSE) return;
    }
    this.at++;
    this.wait = 0;
  }
}
