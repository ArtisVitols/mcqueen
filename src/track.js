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
    // Two of the circuits are modelled at roughly 1:15. The extractor already
    // baked this into the racing line, so the visual model has to match.
    this.modelScale = data.modelScale ?? 1;

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

    // Optional measured cross-section: heights relative to the centreline at
    // a handful of lateral offsets. A single cross-slope cannot describe a
    // banked road on a low-poly mesh - the surface curves between facets - and
    // trying to force one is what left cars hovering at the edges of the road.
    // Tracks without a profile fall back to the flat `bank` model.
    this.profOffsets = data.profOffsets || null;
    this.profile = data.profile ? Float32Array.from(data.profile) : null;
    this.profN = this.profOffsets ? this.profOffsets.length : 0;
    this._prof = new Float64Array(Math.max(1, this.profN));

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
  /**
   * The two stations either side of `s`, and the blend between them.
   *
   * Its own method so that a ribbon with *ends* rather than a loop - the pit
   * road, see src/pits.js - can share every other piece of geometry here.
   * Wrapping from the last station back to the first is exactly right for a
   * lap and exactly wrong for a pit lane.
   */
  span(s) {
    const f = this.wrap(s) / this.step;
    const i = Math.floor(f) % this.count;
    return [i, (i + 1) % this.count, f - Math.floor(f)];
  }

  /** Station `i`, wrapped round the lap. A ribbon with ends says -1 instead. */
  idx(i) {
    return ((i % this.count) + this.count) % this.count;
  }

  /**
   * Where a world point sits on this ribbon, as `{s, n}` - or null if it is
   * nowhere near it.
   *
   * This is how a car changes ribbon. The alternative - mapping one ribbon's
   * distance onto the other's in proportion and picking a lane - is not a
   * *place*: the pit road is a chord and the lap is an arc, so proportional
   * distance is off by tens of metres inside the tapers, and a car handed over
   * that way teleports. It was 46 m at Yoyleland's entry and 5 m sideways at
   * every exit, which is what the shake on rejoining the circuit was.
   *
   * Searched near a hint rather than over the whole ribbon, because a chord
   * across an oval passes close to two quite different parts of the lap.
   */
  project(x, z, hintS, reach = 120) {
    const d = this.data;
    const half = Math.ceil(reach / this.step);
    const i0 = Math.round(this.wrap(hintS) / this.step);
    let bi = -1;
    let best = Infinity;
    for (let k = -half; k <= half; k++) {
      const i = this.idx(i0 + k);
      if (i < 0) continue;
      const dx = x - d.x[i], dz = z - d.z[i];
      const q = dx * dx + dz * dz;
      if (q < best) { best = q; bi = i; }
    }
    if (bi < 0) return null;
    // Then walk it in. One linear step off the nearest station is close but not
    // close enough: a point five metres off the centreline sits on a path with
    // its own arc length, and reading its offset in a station's frame and then
    // *rebuilding* it in the frame half a metre further on left the pit exit
    // 0.75 m along the road from where the car actually was - a visible jump,
    // and one that had nothing to do with the lateral placement everything
    // else about the handover was busy getting right. Three iterations of the
    // same step converge to millimetres.
    let s = bi * this.step;
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const st = this.sample(s, _proj);
      const dx = x - st.x, dz = z - st.z;
      n = dx * st.ox + dz * st.oz;
      const along = dx * st.tx + dz * st.tz;
      if (Math.abs(along) < 1e-4) break;
      s = this.wrap(s + along);
    }
    return { s, n };
  }

  sample(s, out = {}) {
    const d = this.data;
    const [i, j, t] = this.span(s);
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
    if (this.profile) {
      const P = this.profN;
      const pi = i * P, pj = j * P;
      for (let k = 0; k < P; k++) {
        this._prof[k] = this.profile[pi + k] * u + this.profile[pj + k] * t;
      }
      out.prof = this._prof;
    } else {
      // Must be cleared, not left alone: station objects are reused across
      // tracks, so a profile left over from the previous circuit would send
      // rise() down the profile path with no offsets to read.
      out.prof = null;
    }
    return out;
  }

  /**
   * Metres of centreline covered per metre driven at lateral offset n.
   *
   * Clamped, because the expression is singular: at `n * kappa = -1` the car
   * is exactly on the centre of curvature and the scale goes to infinity. An
   * oval never gets near it - the offsets are metres and the radii hundreds -
   * but the pit road's entry taper sweeps across the infield in a short
   * distance, and there a car three metres off the ribbon's centreline
   * advanced five metres of lap in a single 1/120 s step. The floor is far
   * below anything a real corner produces, so no circuit behaviour changes.
   */
  arcScale(st, n) {
    return 1 / Math.max(0.35, 1 + n * st.kappa);
  }

  /** How far sideways a car may go before it is off the racing surface. */
  limit(st, n) {
    // The clamp constrains the car's centre, so the margin has to cover half
    // its width or the bodywork hangs over the edge and clips the wall. The
    // widest car here is Mater at 2.46 m.
    return n > 0 ? st.outW - EDGE_MARGIN : -(st.inW - EDGE_MARGIN);
  }

  /** Height of the surface above the centreline point, at lateral offset n. */
  rise(st, n) {
    if (!st.prof) return Math.tan(st.bank) * n;
    const off = this.profOffsets;
    const P = this.profN;
    let k = 0;
    while (k < P - 2 && n > off[k + 1]) k++;
    const span = off[k + 1] - off[k];
    const t = span > 1e-9 ? (n - off[k]) / span : 0;   // extrapolates past the ends
    return st.prof[k] + (st.prof[k + 1] - st.prof[k]) * t;
  }

  /** Cross-slope of the surface at lateral offset n, as dy/dn. */
  slope(st, n) {
    if (!st.prof) return Math.tan(st.bank);
    const off = this.profOffsets;
    const P = this.profN;
    let k = 0;
    while (k < P - 2 && n > off[k + 1]) k++;
    const span = off[k + 1] - off[k];
    return span > 1e-9 ? (st.prof[k + 1] - st.prof[k]) / span : 0;
  }

  /** World position of the track surface at (s, n). */
  position(st, n, out = new THREE.Vector3()) {
    return out.set(
      st.x + st.ox * n,
      st.y + this.rise(st, n),
      st.z + st.oz * n,
    );
  }

  /** Surface normal at (s, n) - cars sit and lean on this. */
  normal(st, out = new THREE.Vector3(), n = 0) {
    const a = Math.atan(this.slope(st, n));
    const cb = Math.cos(a), sb = Math.sin(a);
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
  orient(st, psi, quat, n = 0) {
    const up = this.normal(st, this._c, n);
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
// Scratch for project(), which must not borrow a caller's station object.
const _proj = {};

// Half the widest car, plus a little clearance.
const EDGE_MARGIN = 1.6;
