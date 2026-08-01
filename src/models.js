import * as THREE from 'three';
import { GLTFLoader } from 'three/loaders/GLTFLoader.js';
import { rig } from './wheels.js';
import { MeshoptDecoder } from 'three/libs/meshopt_decoder.module.js';

/**
 * Asset loading and car normalisation.
 *
 * The seven car models come from different Sketchfab uploads and are all over
 * the place: McQueen is 2005 units long, The King 17, the rest about 5. Rather
 * than hand-tuning scales we measure each bounding box at load and scale it to
 * a real-world length, recentre it and drop it onto y=0. The only thing that
 * cannot be derived is which way the model faces, so that comes from
 * assets/cars.json (verified with tools/render_cars.py).
 */

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

const ASSETS = new URL('../assets/', import.meta.url);

// Height of the axis the body leans about, in metres above the road.
const ROLL_HEIGHT = 0.42;

/**
 * Resolve an asset path against the module, not the page that loaded it, and
 * stamp it with the build id so a model and its physics data can never come
 * from different deploys.
 */
export function assetUrl(path) {
  const url = new URL(path, ASSETS);
  const build = globalThis.__BUILD__;
  if (build && build !== 'dev') url.searchParams.set('v', build);
  return url.href;
}

export function loadGLTF(url, onProgress) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, onProgress, reject);
  });
}

/**
 * Load a car and wrap it in a pivot whose origin is on the ground at the
 * centre of the wheelbase, facing +Z.
 */
export async function loadCar(spec) {
  const gltf = await loadGLTF(assetUrl(`cars/${spec.id}.glb`));
  const inner = gltf.scene;

  inner.rotation.y = spec.yaw;
  inner.updateMatrixWorld(true);

  // `precise` matters: McQueen is a skinned mesh, and the cheap path measures
  // the geometry's bind pose rather than where the skeleton actually puts the
  // vertices. That left the player's car - and only the player's car - sitting
  // a wheel's height above the road.
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  const scale = spec.length / (size.z || 1);
  inner.scale.setScalar(scale);
  // Recentre horizontally and sit the lowest point on the ground.
  inner.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);

  const pivot = new THREE.Group();
  pivot.name = spec.id;
  // The body hangs off its own pivot at about axle height so that roll and
  // dive swing it about a sensible axis. Rolling it about the pivot origin
  // instead - which is on the road - dips a wing 9 cm into the asphalt.
  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'body';
  bodyPivot.position.y = ROLL_HEIGHT;
  inner.position.y -= ROLL_HEIGHT;
  bodyPivot.add(inner);
  pivot.add(bodyPivot);
  pivot.add(contactShadow(size.x * scale, size.z * scale));

  pivot.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    o.frustumCulled = false;      // skinned bounds are unreliable here
    for (const m of materialsOf(o)) {
      m.metalness = Math.min(m.metalness ?? 0, 0.25);
      m.roughness = Math.max(m.roughness ?? 1, 0.45);
    }
  });

  // Wheels come off the pivot, not out of `inner`, so the body can lean while
  // they stay on the road.
  const wheels = rig(pivot, bodyPivot);
  pivot.userData.wheels = wheels;

  return {
    object: pivot,
    wheels,
    size: size.clone().multiplyScalar(scale),
  };
}

export async function loadTrack(file, scale = 1, onProgress, asphalt = []) {
  const gltf = await loadGLTF(assetUrl(file), onProgress);
  const scene = gltf.scene;
  scene.scale.setScalar(scale);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = true;
    for (const m of materialsOf(o)) {
      // Sketchfab exports a lot of mirror-finish metal that reads as black
      // without an environment map.
      if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.3);
      if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.5);
      // One circuit hides an alpha-0 collision shell above the road. Leaving
      // it visible makes the track look fogged from inside.
      if (m.transparent && m.opacity === 0) o.visible = false;
      // Untextured tarmac lit by a strong sun goes pale and flat, which hides
      // the banking and swallows the cars' shadows. Give it a real asphalt
      // tone and a matte finish so light and shade read on it.
      if (asphalt.includes(m.name)) {
        m.color?.setHex(0x43464a);
        if (m.roughness !== undefined) m.roughness = 0.97;
        if (m.metalness !== undefined) m.metalness = 0.0;
      }
    }
  });
  scene.updateMatrixWorld(true);
  return scene;
}

/** Free a track's GPU memory before swapping in another one. */
export function disposeTrack(scene) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    for (const m of materialsOf(o)) {
      if (!m) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                         'emissiveMap', 'aoMap', 'alphaMap']) {
        m[key]?.dispose?.();
      }
      m.dispose();
    }
  });
}

function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

let shadowTexture = null;

/**
 * A soft dark patch that rides under a car, flat on the track.
 *
 * The shadow map alone is not enough to sell contact: it is off entirely on
 * Low quality, and on dark asphalt a soft shadow barely registers, which
 * leaves the car looking like it is hovering. This blob is always there,
 * costs one transparent quad, and is what actually plants the car.
 */
function contactShadow(width, length) {
  if (!shadowTexture) {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.72)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.42)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    shadowTexture = new THREE.CanvasTexture(c);
    shadowTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 1.5, length * 1.15),
    new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;          // just clear of the road to avoid z-fighting
  mesh.renderOrder = 1;
  mesh.name = 'contact-shadow';
  return mesh;
}
