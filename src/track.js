import * as THREE from 'three';

/**
 * The oval as a centreline spline, loaded from assets/track-data.json.
 *
 * Everything in the game lives in track space: a position is (s, n) where s is
 * distance travelled along the centreline and n is metres sideways from it,
 * positive towards the outside wall. That makes lap counting, race order and
 * NASCAR-style lane changes into plain arithmetic, and means nothing ever has
 * to raycast against the 420k-triangle stadium.
 */
export class Track {
  constructor(data) {
    this.data = data;
    this.lapLength = data.lapLength;
    this.count = data.stationCount;
    this.step = data.stationStep;

    // How much longer a lap gets per metre of outward offset. An offset path
    // around a curve is longer on the outside and shorter on the inside, which
    // is exactly why the low line pays on an oval - so the game models it.
    this.kappa = new Float32Array(this.count);
    const { x, z, ox, oz } = data;
    for (let i = 0; i < this.count; i++) {
      const j = (i + 1) % this.count;
      const ax = x[i] + ox[i], az = z[i] + oz[i];
      const bx = x[j] + ox[j], bz = z[j] + oz[j];
      const base = Math.hypot(x[j] - x[i], z[j] - z[i]) || this.step;
      this.kappa[i] = Math.hypot(bx - ax, bz - az) / base - 1;
    }

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`track data ${res.status}`);
    return new Track(await res.json());
  }

  wrap(s) {
    const L = this.lapLength;
    return ((s % L) + L) % L;
  }

  /** Shortest signed distance from a to b along the lap, in (-L/2, L/2]. */
  delta(a, b) {
    const L = this.lapLength;
    let d = this.wrap(b - a);
    if (d > L / 2) d -= L;
    return d;
  }

  /**
   * Interpolated station data at distance s.
   * Fills and returns `out` to avoid allocating in the hot loop.
   */
  sample(s, out = {}) {
    const d = this.data;
    const f = this.wrap(s) / this.step;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    const t = f - Math.floor(f);
    const u = 1 - t;

    out.x = d.x[i] * u + d.x[j] * t;
    out.z = d.z[i] * u + d.z[j] * t;
    out.y = d.y[i] * u + d.y[j] * t;
    // Tangents and normals are unit vectors a fraction of a degree apart, so
    // lerping without renormalising is well within tolerance here.
    out.tx = d.tx[i] * u + d.tx[j] * t;
    out.tz = d.tz[i] * u + d.tz[j] * t;
    out.ox = d.ox[i] * u + d.ox[j] * t;
    out.oz = d.oz[i] * u + d.oz[j] * t;
    out.outW = d.outW[i] * u + d.outW[j] * t;
    out.inW = d.inW[i] * u + d.inW[j] * t;
    out.bank = d.bank[i] * u + d.bank[j] * t;
    out.kappa = this.kappa[i] * u + this.kappa[j] * t;
    return out;
  }

  /** Metres of centreline covered per metre driven at lateral offset n. */
  arcScale(st, n) {
    return 1 / (1 + n * st.kappa);
  }

  /** How far sideways a car may go before it is off the racing surface. */
  limit(st, n) {
    // Half a car width of margin so models never hang over the edge.
    return n > 0 ? st.outW - 1.2 : -(st.inW - 1.2);
  }

  /** World position of the track surface at (s, n). */
  position(st, n, out = new THREE.Vector3()) {
    return out.set(
      st.x + st.ox * n,
      st.y + Math.tan(st.bank) * n,
      st.z + st.oz * n,
    );
  }

  /** Surface normal at (s, n) - cars sit and lean on this. */
  normal(st, out = new THREE.Vector3()) {
    const cb = Math.cos(st.bank), sb = Math.sin(st.bank);
    // Cross-slope direction lying in the surface, pointing outwards.
    this._a.set(st.ox * cb, sb, st.oz * cb);
    this._b.set(st.tx, 0, st.tz);
    return out.copy(this._a).cross(this._b).normalize();
  }

  /** Heading of the centreline at st, as a three.js Y rotation. */
  yaw(st) {
    return Math.atan2(st.tx, st.tz);
  }

  /**
   * Orientation for a car at st heading `psi` radians off the tangent,
   * banked with the track. Writes into `quat`.
   */
  orient(st, psi, quat) {
    const up = this.normal(st, this._c);
    const cos = Math.cos(psi), sin = Math.sin(psi);
    // Tangent rotated by psi about the vertical, then made perpendicular to up.
    const fx = st.tx * cos + st.ox * sin;
    const fz = st.tz * cos + st.oz * sin;
    const fwd = this._a.set(fx, 0, fz);
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    // Right-handed basis: X = Y cross Z.
    const right = this._b.copy(up).cross(fwd);
    _m.makeBasis(right, up, fwd);
    quat.setFromRotationMatrix(_m);
    return quat;
  }
}

const _m = new THREE.Matrix4();
