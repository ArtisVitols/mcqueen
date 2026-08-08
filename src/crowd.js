import * as THREE from 'three';

/**
 * People in the grandstands.
 *
 * Where they sit is measured, not guessed: `tools/extract_crowd.mjs` raycasts
 * the shipped model and writes the seats into the track data, for the same
 * reason the racing line and the pit road are measured - a band placed by eye
 * in track space puts a crowd in mid-air on one circuit and inside the
 * concrete on another.
 *
 * What they are is one `THREE.Points`: one draw call, one buffer, two
 * triangles each, and a shader that sways them from the clock so the per-frame
 * cost is a single uniform. They are only ever seen from tens of metres away
 * past a catch fence, so a billboard with a shirt colour is the whole of it -
 * and modelling them would cost more than every car on the grid put together.
 *
 * Nothing is loaded. The sprite is drawn into a canvas, like the contact
 * shadows and the sky.
 */

let sprite = null;
/** Head, shoulders and a body. At this size that is all a person needs. */
function personTexture() {
  if (sprite) return sprite;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  // Body: a rounded torso filling the lower two thirds.
  ctx.beginPath();
  ctx.moveTo(s * 0.28, s * 0.98);
  ctx.lineTo(s * 0.30, s * 0.52);
  ctx.quadraticCurveTo(s * 0.5, s * 0.40, s * 0.70, s * 0.52);
  ctx.lineTo(s * 0.72, s * 0.98);
  ctx.closePath();
  ctx.fill();
  // Head.
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.30, s * 0.15, 0, Math.PI * 2);
  ctx.fill();
  sprite = new THREE.CanvasTexture(c);
  sprite.colorSpace = THREE.SRGBColorSpace;
  return sprite;
}

const VERT = `
  attribute vec3 aTint;
  attribute vec2 aWho;        // size, phase
  varying vec3 vTint;
  uniform float uTime;
  uniform float uScale;
  void main() {
    // A crowd is never still. One sine off the clock and a per-person phase is
    // enough at this distance, and it costs one uniform for the whole stand.
    float sway = sin(uTime * 2.1 + aWho.y) * 0.06;
    vec4 mv = modelViewMatrix * vec4(position + vec3(sway, 0.0, 0.0), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aWho.x * uScale / max(1.0, -mv.z);
    vTint = aTint;
  }
`;

const FRAG = `
  uniform sampler2D uMap;
  varying vec3 vTint;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a;
    if (a < 0.35) discard;
    gl_FragColor = vec4(vTint, 1.0);
  }
`;

/** Bright, various, and none of them the colour of a car. */
const SHIRTS = [
  [0.92, 0.30, 0.28], [0.95, 0.72, 0.25], [0.35, 0.62, 0.90], [0.40, 0.78, 0.45],
  [0.88, 0.88, 0.90], [0.85, 0.45, 0.75], [0.55, 0.42, 0.85], [0.95, 0.55, 0.25],
  [0.30, 0.75, 0.78], [0.75, 0.75, 0.35], [0.60, 0.60, 0.65], [0.20, 0.35, 0.55],
];

/**
 * Build the crowd for a circuit, or nothing if its data has none.
 *
 * @param {object} data  the track JSON, which may carry `crowd`
 * @returns {THREE.Points|null}
 */
export function makeCrowd(data) {
  const c = data.crowd;
  if (!c || !c.x || !c.x.length) return null;
  const n = c.x.length;

  const pos = new Float32Array(n * 3);
  const tint = new Float32Array(n * 3);
  const who = new Float32Array(n * 2);
  // Deterministic: two phones in a race see the same crowd, and a rebuild of
  // the same circuit is the same crowd again.
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < n; i++) {
    const tall = 1.5 + rnd() * 0.45;
    pos[i * 3] = c.x[i];
    // The seat is where their feet are, and a point sprite is centred on its
    // position - so lift them by half their height or the crowd is buried to
    // the waist in the terracing.
    pos[i * 3 + 1] = c.y[i] + tall * 0.5;
    pos[i * 3 + 2] = c.z[i];
    const shirt = SHIRTS[(rnd() * SHIRTS.length) | 0];
    tint[i * 3] = shirt[0]; tint[i * 3 + 1] = shirt[1]; tint[i * 3 + 2] = shirt[2];
    who[i * 2] = tall;
    who[i * 2 + 1] = rnd() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geo.setAttribute('aWho', new THREE.BufferAttribute(who, 2));
  geo.computeBoundingSphere();

  const points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: personTexture() },
      uScale: { value: 300 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    // Cut out rather than blended: a crowd is thousands of sprites and every
    // one of them would otherwise have to be sorted against the stand behind
    // it. `discard` on the alpha keeps them in the depth buffer where they
    // belong, and at this size the hard edge is invisible.
    transparent: false,
    fog: false,
  }));
  points.name = 'crowd';
  points.frustumCulled = true;
  return points;
}

/** One number a frame, for the whole stadium. */
export function swayCrowd(points, time, height) {
  if (!points) return;
  points.material.uniforms.uTime.value = time;
  if (height) points.material.uniforms.uScale.value = height * 0.9;
}
