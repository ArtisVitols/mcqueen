import * as THREE from 'three';

/**
 * Wheels that turn, and a body that leans on them.
 *
 * None of these models arrive with usable wheel nodes. Six of the seven are
 * Sketchfab OBJ exports that were merged by *material*, so all four wheels sit
 * inside one mesh alongside nothing else; the seventh, McQueen, is a skinned
 * mesh with a 3ds Max biped whose `Bip01_wheel_*` bones are already in the
 * right places. So there are two routes:
 *
 *   split   find the wheels as connected components of a mesh and re-parent
 *           each one under its own pivot
 *   bones   rotate the bones that are already there
 *
 * A wheel is a disc: round in the plane across the car, thin along the axle,
 * and sitting on the road with its centre one radius up. That test finds
 * exactly four clusters on every car here and nothing else, so no per-car
 * table is needed - see tools/check_wheels.mjs, which prints what it found.
 *
 * The spin direction is derived, never assumed. McQueen's left-hand wheel
 * bones carry a rotation that flips their local X, so a shared angle would
 * counter-rotate one side of the car; every axle is signed against the car's
 * own lateral axis instead.
 */

const ROUNDNESS = 0.22;         // how far from circular a wheel may be
const MIN_RADIUS = 0.14;        // metres, after the model is scaled to size
const MAX_RADIUS = 0.75;
const GROUND_TOL = 0.45;        // centre height must be about one radius
const MIN_TRIS = 8;

const ROLL_PER_G = 0.030;       // radians of body roll per g of cornering
const DIVE_PER_G = 0.022;       // ... and of pitch per g of braking
const MAX_ROLL = 0.075;         // ~4 degrees; more reads as broken, not lively
const MAX_DIVE = 0.055;
const BODY_LAG = 6.0;           // how fast the body follows the load, 1/s
const STEER_VISUAL = 0.42;      // radians of front wheel angle at full lock

/**
 * Give a loaded car turning wheels.
 *
 * @param {THREE.Group} pivot  the car pivot from loadCar, origin on the road
 * @param {THREE.Object3D} body  the inner model, which is what rolls and dives
 * @returns {Wheels|null}
 */
export function rig(pivot, body) {
  pivot.updateMatrixWorld(true);
  const wheels = fromBones(pivot) || fromSplit(pivot);
  return wheels && wheels.length ? new Wheels(pivot, body, wheels) : null;
}

export class Wheels {
  constructor(pivot, body, wheels) {
    this.pivot = pivot;
    this.body = body;
    this.wheels = wheels;
    this.angle = 0;
    this.roll = 0;
    this.dive = 0;
    this._q = new THREE.Quaternion();
    this._r = new THREE.Quaternion();

    // How far the body has to rise to keep its lowest corner out of the road
    // while it leans. These models sit right down on the asphalt - the bottom
    // of the bodywork *is* y = 0 - so without this the outside sill ploughs
    // 9 cm through the track in every corner.
    this.baseY = body ? body.position.y : 0;
    const box = body ? new THREE.Box3().setFromObject(body, true) : null;
    this.halfW = box ? Math.max(box.max.x, -box.min.x) : 0;
    this.halfL = box ? Math.max(box.max.z, -box.min.z) : 0;
  }

  /** @param {import('./car.js').Car} car */
  update(car, dt) {
    // Rolling distance, not engine speed: a car being dragged sideways along a
    // wall still has its wheels going round at road speed.
    this.angle += car.speed * dt;
    const steer = (car.steerAngle || car.steer * STEER_VISUAL);

    for (const w of this.wheels) {
      this._q.setFromAxisAngle(w.axle, this.angle / w.radius);
      if (w.front) {
        this._r.setFromAxisAngle(w.up, -steer);
        w.node.quaternion.copy(this._r).multiply(this._q).multiply(w.base);
      } else {
        w.node.quaternion.copy(this._q).multiply(w.base);
      }
    }

    if (!this.body) return;
    // The load is a per-step difference and jumps about; the body has mass and
    // does not. Chase it rather than tracking it.
    const g = 9.81;
    const wantRoll = THREE.MathUtils.clamp(
      -(car.accelLat || 0) / g * ROLL_PER_G, -MAX_ROLL, MAX_ROLL);
    const wantDive = THREE.MathUtils.clamp(
      -(car.accelLong || 0) / g * DIVE_PER_G, -MAX_DIVE, MAX_DIVE);
    const k = Math.min(1, BODY_LAG * dt);
    this.roll += (wantRoll - this.roll) * k;
    this.dive += (wantDive - this.dive) * k;
    // Only the body leans. The wheels hang off the pivot so they stay on the
    // road, and the contact shadow stays flat where it belongs.
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.dive;
    this.body.position.y = this.baseY
      + Math.abs(this.roll) * this.halfW + Math.abs(this.dive) * this.halfL;
  }

  /** What check_wheels.mjs reports. */
  describe() {
    return this.wheels.map((w) => ({
      kind: w.kind,
      front: w.front,
      radius: +w.radius.toFixed(3),
      centre: [+w.centre.x.toFixed(2), +w.centre.y.toFixed(2), +w.centre.z.toFixed(2)],
      axle: [+w.axle.x.toFixed(2), +w.axle.y.toFixed(2), +w.axle.z.toFixed(2)],
    }));
  }
}

/* ------------------------------------------------------------- the bones -- */

function fromBones(pivot) {
  const found = [];
  pivot.traverse((o) => {
    if (/(^|_)wheel_(front|rear)_[LR]/i.test(o.name)) found.push(o);
  });
  if (found.length !== 4) return null;

  const inv = new THREE.Matrix4();
  const local = new THREE.Vector3();
  const zs = found.map((n) => {
    n.getWorldPosition(local);
    return pivot.worldToLocal(local.clone()).z;
  });
  const mid = (Math.min(...zs) + Math.max(...zs)) / 2;

  return found.map((node, i) => {
    node.getWorldPosition(local);
    const centre = pivot.worldToLocal(local.clone());
    inv.copy(node.parent.matrixWorld).invert();
    return {
      kind: 'bone',
      node,
      base: node.quaternion.clone(),
      // The car's own axes, expressed in the bone's parent space. Doing it this
      // way is what makes the left and right sides turn the same way despite
      // their bind rotations pointing opposite.
      axle: carAxis(pivot, inv, 1, 0, 0),
      up: carAxis(pivot, inv, 0, 1, 0),
      centre,
      radius: Math.max(0.15, centre.y),
      front: zs[i] > mid,
    };
  });
}

function carAxis(pivot, parentInv, x, y, z) {
  return new THREE.Vector3(x, y, z)
    .transformDirection(pivot.matrixWorld)
    .transformDirection(parentInv)
    .normalize();
}

/* ------------------------------------------------------------- the split -- */

function fromSplit(pivot) {
  const out = [];
  const meshes = [];
  pivot.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && o.name !== 'contact-shadow') meshes.push(o);
  });

  for (const mesh of meshes) {
    const found = splitMesh(pivot, mesh);
    if (found) out.push(...found);
  }
  if (out.length !== 4) return null;

  const zs = out.map((w) => w.centre.z);
  const mid = (Math.min(...zs) + Math.max(...zs)) / 2;
  for (const w of out) w.front = w.centre.z > mid;
  return out;
}

/** Pull every wheel-shaped island out of one mesh into its own pivot. */
function splitMesh(pivot, mesh) {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  if (count < MIN_TRIS * 3) return null;

  // Positions in the pivot's frame, which is the one with the road at y = 0.
  const toPivot = new THREE.Matrix4()
    .copy(pivot.matrixWorld).invert().multiply(mesh.matrixWorld);
  const p = new THREE.Vector3();
  const pts = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(toPivot);
    pts[i * 3] = p.x; pts[i * 3 + 1] = p.y; pts[i * 3 + 2] = p.z;
  }

  // Weld first. These are OBJ exports: the same corner appears once per face,
  // so without welding every triangle is its own island.
  const parent = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pts[i * 3] * 1e4)},${Math.round(pts[i * 3 + 1] * 1e4)},` +
                `${Math.round(pts[i * 3 + 2] * 1e4)}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i); else join(i, first);
  }
  const at = (k) => (index ? index.getX(k) : k);
  for (let k = 0; k + 2 < count; k += 3) {
    join(at(k), at(k + 1));
    join(at(k + 1), at(k + 2));
  }

  // Group the triangles by island and measure each one.
  const tris = new Map();
  for (let k = 0; k + 2 < count; k += 3) {
    const root = find(at(k));
    let list = tris.get(root);
    if (!list) tris.set(root, list = []);
    list.push(k);
  }

  const keep = [];
  const rest = [];
  for (const [, list] of tris) {
    const box = new THREE.Box3();
    for (const k of list) {
      for (let j = 0; j < 3; j++) {
        const v = at(k + j);
        box.expandByPoint(p.set(pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]));
      }
    }
    if (list.length >= MIN_TRIS && isWheel(box)) keep.push({ list, box });
    else rest.push(...list);
  }
  if (!keep.length) return null;

  // A wheel can arrive as more than one island - a tyre and a rim, or Mater's
  // twinned rears - so gather them by where they sit rather than one to one.
  const clusters = [];
  keep.sort((a, b) => size(b.box).y - size(a.box).y);
  for (const item of keep) {
    const c = item.box.getCenter(new THREE.Vector3());
    const near = clusters.find((cl) =>
      Math.hypot(cl.centre.x - c.x, cl.centre.z - c.z) < Math.max(0.3, cl.radius * 0.9));
    if (near) { near.items.push(item); near.box.union(item.box); }
    else clusters.push({ items: [item], box: item.box.clone(), centre: c, radius: size(item.box).y / 2 });
  }
  if (clusters.length !== 4) return null;

  const wheels = [];
  for (const cl of clusters) {
    const centre = cl.box.getCenter(new THREE.Vector3());
    const list = cl.items.flatMap((i) => i.list);
    // A compact geometry, not the whole buffer with a narrower index. Sharing
    // the buffer is tempting and cheaper, but every bounding box would still
    // span the entire car: check_ride_height reported the split cars sitting
    // three metres under the road, and shadow and frustum bounds would be just
    // as wrong.
    const g = extract(geo, list, at);
    const node = new THREE.Group();
    node.position.copy(centre);
    const m = new THREE.Mesh(g, mesh.material);
    m.applyMatrix4(new THREE.Matrix4()
      .makeTranslation(-centre.x, -centre.y, -centre.z).multiply(toPivot));
    m.castShadow = true;
    m.frustumCulled = false;
    node.add(m);
    pivot.add(node);

    wheels.push({
      kind: 'split',
      node,
      base: new THREE.Quaternion(),
      axle: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      centre,
      radius: Math.max(MIN_RADIUS, size(cl.box).y / 2),
      front: false,
    });
  }

  // Everything that was not a wheel stays on the original mesh.
  const remaining = [];
  for (const k of rest) remaining.push(at(k), at(k + 1), at(k + 2));
  geo.setIndex(remaining);
  geo.clearGroups();
  return wheels;
}

/**
 * A standalone geometry holding just these triangles.
 *
 * Uses the attribute accessors rather than the backing arrays, because after
 * meshopt these are interleaved and `attribute.array` is the whole interleaved
 * block, not this attribute's values.
 */
function extract(geo, list, at) {
  const remap = new Map();
  const idx = [];
  for (const k of list) {
    for (let j = 0; j < 3; j++) {
      const v = at(k + j);
      let n = remap.get(v);
      if (n === undefined) remap.set(v, n = remap.size);
      idx.push(n);
    }
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const items = attr.itemSize;
    const arr = new Float32Array(remap.size * items);
    for (const [src, dst] of remap) {
      for (let c = 0; c < items; c++) arr[dst * items + c] = attr.getComponent(src, c);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, items, attr.normalized));
  }
  out.setIndex(idx);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function size(box) {
  return box.getSize(_size);
}
const _size = new THREE.Vector3();

/** Round across the car, thin along the axle, sitting one radius off the road. */
function isWheel(box) {
  const s = size(box);
  const r = Math.max(s.y, s.z) / 2;
  if (r < MIN_RADIUS || r > MAX_RADIUS) return false;
  if (Math.abs(s.y - s.z) / Math.max(s.y, s.z) > ROUNDNESS) return false;
  if (s.x > Math.min(s.y, s.z) * 1.3) return false;
  const centreY = (box.min.y + box.max.y) / 2;
  return Math.abs(centreY - r) < r * GROUND_TOL;
}
