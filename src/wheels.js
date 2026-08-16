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
 * and sitting on the road with its centre one radius up. That test finds the
 * wheels and nothing else on every model here, so no per-car table is needed -
 * see tools/check_wheels.mjs, which prints what it found. The *count* is not
 * fixed: the racers have four, Guido has three and Mack has ten.
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
// Not everything here has four. Guido is a three-wheeled forklift and Mack is
// a ten-wheeled artic; insisting on four is what left both of them sliding
// down the road on frozen tyres. The range is still a sanity check - a car
// that "finds" twenty wheels has found something else.
const MIN_WHEELS = 3;
const MAX_WHEELS = 12;

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
    // McQueen's 3ds Max biped names them Bip01_wheel_front_L_050; Guido's CAT
    // rig calls his three CATRig_wheel_b_55 / _l_57 / _r_59. Both are already
    // in the right places, which is the whole reason for this route.
    //
    // The terminator is `(_|$)`, never `\b`: these names carry a numeric
    // suffix, and `\b` between the `R` and the `_` matches nothing at all
    // because both are word characters - which silently took every wheel off
    // the player's car. It is also what excludes the `wheelbase_*` bones,
    // which sit at the same places and would double the count.
    if (/(^|_)wheel_(front|rear)_[LR](_|$)/i.test(o.name)
        || /(^|_)wheel_[blrf](_|$)/i.test(o.name)) found.push(o);
  });
  if (found.length < MIN_WHEELS || found.length > MAX_WHEELS) return null;

  const inv = new THREE.Matrix4();
  const local = new THREE.Vector3();
  const zs = found.map((n) => {
    n.getWorldPosition(local);
    return pivot.worldToLocal(local.clone()).z;
  });
  const steered = frontAxle(zs);

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
      front: steered(zs[i]),
    };
  });
}

/**
 * Which wheels steer: the frontmost axle only.
 *
 * A midpoint test is right for a car and wrong for anything else - it would
 * have Mack steering with his drive axles and half his trailer. Group the
 * wheels into axles by z and let only the foremost group turn.
 */
function frontAxle(zs) {
  const front = Math.max(...zs);
  const span = front - Math.min(...zs);
  // A car's two axles are far apart, so half the span keeps its behaviour
  // exactly; a lorry's are close, so the tolerance has to be absolute.
  const tol = Math.min(span * 0.5, Math.max(0.35, span * 0.12));
  return (z) => z > front - tol;
}

function carAxis(pivot, parentInv, x, y, z) {
  return new THREE.Vector3(x, y, z)
    .transformDirection(pivot.matrixWorld)
    .transformDirection(parentInv)
    .normalize();
}

/* ------------------------------------------------------------- the split -- */

function fromSplit(pivot) {
  const meshes = [];
  pivot.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && o.name !== 'contact-shadow') meshes.push(o);
  });

  // Find every wheel-shaped island in every mesh *first*, and only then decide
  // which of them are the same wheel.
  //
  // Clustering inside one mesh is not enough: Cruz Ramirez and Shu Todoroki
  // carry the tyre and the rim as separate materials, so each mesh yielded a
  // clean set of four and the car ended up with eight wheels and four steered
  // ones. A wheel is a *place*, not a mesh.
  const cut = [];
  const found = [];
  const spare = [];
  for (const mesh of meshes) {
    const split = splitMesh(pivot, mesh);
    if (!split) continue;
    cut.push(split);
    for (const island of split.islands) (island.wheelish ? found : spare).push(island);
  }
  if (!found.length) return null;

  const clusters = [];
  found.sort((a, b) => size(b.box).y - size(a.box).y);
  for (const item of found) {
    const c = item.box.getCenter(new THREE.Vector3());
    const near = clusters.find((cl) =>
      Math.hypot(cl.centre.x - c.x, cl.centre.z - c.z) < Math.max(0.3, cl.radius * 0.9));
    if (near) { near.items.push(item); near.box.union(item.box); }
    else clusters.push({ items: [item], box: item.box.clone(), centre: c, radius: size(item.box).y / 2 });
  }
  if (clusters.length < MIN_WHEELS || clusters.length > MAX_WHEELS) return null;

  // Now the pieces that are *in* a wheel without looking like one: tread
  // blocks, rims, hub bolts, brake discs. Without this the parts of a wheel
  // that have any features on them are exactly the parts left behind, and a
  // turning wheel is indistinguishable from a still one.
  for (const cl of clusters) cl.seed = cl.box.clone();
  const taken = new Set(found);
  for (const island of spare) {
    const home = clusters.find((cl) => adopt(cl, island));
    if (!home) continue;
    home.items.push(island);
    home.box.union(island.box);
    taken.add(island);
  }
  for (const split of cut) split.strip(taken);

  const out = [];
  for (const cl of clusters) {
    // **The axle comes from the seed, not from what the cluster grew into.**
    //
    // This is the same rule `adopt` already states and the radius below already
    // obeys; the centre was the one place still reading the grown box, and it
    // is the one that decides where the wheel *turns about*. Adoption is not
    // symmetric - a piece of arch above the tyre has nothing below it to
    // balance it - so the union's centre drifts off the axle. Shu Todoroki's
    // fronts ended up pivoting 10 cm above their own tyres: the wheel orbited
    // rather than spun, which reads as turning strangely and drags the
    // adopted bodywork through the car once a lap of the wheel.
    const centre = cl.seed.getCenter(new THREE.Vector3());
    const node = new THREE.Group();
    node.position.copy(centre);
    for (const item of cl.items) {
      const m = new THREE.Mesh(item.build(), item.material);
      m.applyMatrix4(new THREE.Matrix4()
        .makeTranslation(-centre.x, -centre.y, -centre.z).multiply(item.toPivot));
      m.castShadow = true;
      m.frustumCulled = false;
      node.add(m);
    }
    pivot.add(node);
    out.push({
      kind: 'split',
      node,
      base: new THREE.Quaternion(),
      axle: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      centre,
      // Tread adds a little to a tyre; nothing adds a lot. Clamped to the
      // seed, so an adoption that was slightly too generous cannot turn into
      // a wheel that rolls at the wrong rate.
      radius: Math.max(MIN_RADIUS,
        Math.min(size(cl.box).y / 2, size(cl.seed).y / 2 * 1.25)),
      front: false,
    });
  }

  const steered = frontAxle(out.map((w) => w.centre.z));
  for (const w of out) w.front = steered(w.centre.z);
  return out;
}

/**
 * Every wheel-shaped island in one mesh, as items the caller can cluster.
 *
 * The triangles are removed from the source mesh here, but the geometry for
 * each island is only *built* if the caller keeps it - `build()` - because a
 * cluster may span two meshes and wants one node holding both halves.
 */
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

  const islands = [];
  for (const [, list] of tris) {
    const box = new THREE.Box3();
    for (const k of list) {
      for (let j = 0; j < 3; j++) {
        const v = at(k + j);
        box.expandByPoint(p.set(pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]));
      }
    }
    islands.push({
      list,
      box,
      // Round, thin and sitting a radius off the road: that is a *wheel*, and
      // only these seed a cluster. The rest are offered to the clusters
      // afterwards - see `adopt` - because a tread block is part of a wheel
      // without being one.
      wheelish: list.length >= MIN_TRIS && isWheel(box),
      material: mesh.material,
      toPivot,
      // A compact geometry, not the whole buffer with a narrower index. Sharing
      // the buffer is tempting and cheaper, but every bounding box would still
      // span the entire car: check_ride_height reported the split cars sitting
      // three metres under the road, and shadow and frustum bounds would be just
      // as wrong.
      build: () => extract(geo, list, at),
    });
  }
  // Returned even when nothing here looks like a wheel. A mesh can hold only
  // the *pieces* of one - Ivy's tread lugs and rims are their own material -
  // and bailing out here left them behind, which is the whole bug: the parts
  // with features on them were the parts that stayed still.

  // The source geometry is *not* stripped here: which triangles leave depends
  // on what the clusters adopt, and that is only known once every mesh has
  // been read. `strip` is called by the caller when it is.
  return {
    islands,
    strip(taken) {
      const remaining = [];
      for (const island of islands) {
        if (taken.has(island)) continue;
        for (const k of island.list) remaining.push(at(k), at(k + 1), at(k + 2));
      }
      geo.setIndex(remaining);
      geo.clearGroups();
    },
  };
}

/**
 * Does this leftover island belong to that wheel?
 *
 * **A tread block is not wheel-shaped and is still part of the wheel.** Ivy is
 * a monster truck whose tyres are modelled as a smooth carcass plus a ring of
 * separate lugs, with the rim as another island again: only the carcass looked
 * like a wheel, so only the carcass turned - and the carcass is the one part
 * with no features on it. The wheels were rotating perfectly and the truck
 * looked exactly as though they were not.
 *
 * The test is containment, not shape: the piece has to sit inside the wheel it
 * is joining and be no bigger than it. That cannot swallow the body, which
 * fails on both counts, and it does not care what the piece is.
 */
function adopt(cluster, island) {
  // Against the *seed* - the wheel-shaped islands this cluster started from -
  // and never against what it has grown into. Testing against the growing box
  // is a runaway: each piece taken makes the box bigger, which lets a bigger
  // piece in next time, and three adoptions later a wheel has swallowed the
  // chassis. Sarge's front wheel reached a 1.2 m radius and 2,548 triangles
  // that way.
  // Each into its own vector: `size()` hands back a shared one, so measuring
  // two boxes with it gives you the second box twice.
  const c = cluster.seed.getCenter(_c1);
  const w = cluster.seed.getSize(_s1);
  const ic = island.box.getCenter(_c2);
  const is = island.box.getSize(_s2);

  // **A wheel is a disc, and that is the shape the test has to be.** A box
  // around the seed admits anything in the corners of it - which is where a
  // suspension arm, a diffuser and a wheel arch all live. Shu Todoroki's
  // wheels came out 1.32 m long against 0.88 tall and Ivy's grew half a metre
  // of upright: bodywork and suspension, turning with the wheel.
  const r = Math.max(w.y, w.z) / 2;
  const off = Math.hypot(ic.y - c.y, ic.z - c.z);      // from the axle, sideways on

  // Across the car it may be a little wider than the tyre - a hub sticks out -
  // and no more. This is what keeps a suspension arm, which reaches inboard,
  // from being part of the wheel.
  if (Math.abs(ic.x - c.x) > w.x * 0.6 || is.x > w.x * 1.5) return false;

  // Two shapes belong to a wheel and nothing else does:
  //
  //   a rim or a disc  - as big as the wheel, but *centred on the axle*
  //   a tread block    - out at the rim, but *small*
  //
  // Bodywork is the third case, big and off-centre, and it is the one to
  // refuse. Sizing alone cannot do it: a rim is nearly the whole wheel, and a
  // tread lug sticks out past the tyre by a third on a monster truck.
  const centred = off < r * 0.35;
  const small = is.y < w.y * 0.5 && is.z < w.z * 0.5;
  if (!centred && !small) return false;
  // **And it has to touch the tyre.** A tread block is stuck *on* the
  // circumference, so part of it is inside the disc; a wheel arch floats
  // entirely outside, above the crown, and nothing about being small and near
  // the rim tells the two apart. Shu Todoroki's front wheels adopted a piece
  // of arch sitting 5 cm clear of the top of the tyre, which turned with them
  // and dragged through the bodywork - and, because it made the cluster's box
  // half a tyre taller, gave the fronts a rolling radius 26% too big so they
  // visibly span too slowly for the road.
  const reach = Math.max(is.y, is.z) / 2;
  if (!centred && off - reach > r * 1.05) return false;
  return off + reach < r * (centred ? 1.15 : 1.45);
}
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();

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
