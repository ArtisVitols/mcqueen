import * as THREE from 'three';

/**
 * Split large meshes into an XZ grid so raycasting them is not O(everything).
 *
 * three.js rejects a mesh cheaply only when the ray misses its bounding box.
 * Yoyleland's catch fence, grandstands and concrete each *ring the circuit* -
 * 180k to 230k triangles apiece with a bounding box covering the whole
 * stadium - so no ray is ever rejected and every one brute-forces the lot.
 * refine_track.mjs fires roughly 400,000 rays at it, which is billions of
 * triangle tests and hours of wall clock.
 *
 * Chunking gives each piece of those meshes a tight box, so a ray touches only
 * what is near it. Same geometry, same materials, same answers - just sorted.
 *
 * Two things to keep in mind:
 *
 * - **The chunks share the source vertex buffer.** That is fine here because
 *   nothing renders them; only the index differs. (`src/wheels.js` may *not*
 *   do this - its wheels are drawn, and a shared buffer gives every one of
 *   them the whole car's bounds.)
 * - **`computeBoundingBox()` would be wrong.** It measures the entire position
 *   attribute, not the triangles a chunk actually indexes, so every chunk
 *   would claim the whole mesh and reject nothing - the bug this exists to
 *   fix. The box is accumulated by hand instead, in local space, which is
 *   where `Mesh.raycast` tests it.
 */

const CHUNK_MIN_TRIS = 4000;      // below this, splitting costs more than it saves

/**
 * @param {THREE.Mesh[]} meshes  world-transformed meshes, as picked for raycasting
 * @param {number} cell          grid size in world metres
 * @returns {THREE.Mesh[]}       the same surface, in more and smaller pieces
 */
export function chunkForRays(meshes, cell = 40) {
  const out = [];
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    if (count / 3 <= CHUNK_MIN_TRIS) { out.push(mesh); continue; }
    const at = (k) => (index ? index.getX(k) : k);

    // Bin each triangle by the cell its world centroid falls in, and grow that
    // bin's local-space box to hold the whole triangle. Binning by centroid
    // and bounding by extent keeps the boxes conservative, so a triangle that
    // straddles a boundary is still found.
    const bins = new Map();
    for (let k = 0; k + 2 < count; k += 3) {
      let cx = 0, cz = 0;
      for (let j = 0; j < 3; j++) {
        v.fromBufferAttribute(pos, at(k + j));
        w.copy(v).applyMatrix4(mesh.matrixWorld);
        cx += w.x; cz += w.z;
      }
      const key = `${Math.floor(cx / 3 / cell)},${Math.floor(cz / 3 / cell)}`;
      let bin = bins.get(key);
      if (!bin) bins.set(key, bin = { idx: [], box: new THREE.Box3() });
      for (let j = 0; j < 3; j++) {
        const vi = at(k + j);
        bin.idx.push(vi);
        bin.box.expandByPoint(v.fromBufferAttribute(pos, vi));
      }
    }

    for (const bin of bins.values()) {
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
      g.setIndex(bin.idx);
      g.boundingBox = bin.box.clone();
      g.boundingSphere = bin.box.getBoundingSphere(new THREE.Sphere());

      const m = new THREE.Mesh(g, mesh.material);
      // Never parented, so the world matrix is copied across rather than
      // derived - re-parenting a clone is what silently drops a scene's scale.
      m.matrixAutoUpdate = false;
      m.matrixWorldAutoUpdate = false;
      m.matrix.copy(mesh.matrix);
      m.matrixWorld.copy(mesh.matrixWorld);
      m.userData.source = mesh;
      out.push(m);
    }
  }
  return out;
}
