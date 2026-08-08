import * as THREE from 'three';

/**
 * Puffs of smoke: tyres under a slide, and a wrecked car's engine.
 *
 * One pooled `THREE.Points` for the whole race - one draw call, one buffer,
 * and a fixed budget that cannot grow however hard everybody is driving. The
 * per-frame cost is a single uniform: a particle's whole life is worked out in
 * the shader from where it was born, how fast it was going and how old it is,
 * so nothing here walks the pool every frame. Spawning writes four numbers.
 *
 * That matters more than it sounds. This runs on a phone that is already
 * drawing a 420k-triangle stadium and eighteen cars, and the obvious version -
 * a mesh per puff, positions integrated on the CPU - would cost more than the
 * cars do.
 *
 * Nothing is loaded: the sprite is a canvas gradient, the same way
 * `models.js` builds its contact shadows and `museum.js` its plinth.
 */

/** Soft round puff, drawn once and shared. */
let sprite = null;
function puffTexture() {
  if (sprite) return sprite;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  sprite = new THREE.CanvasTexture(c);
  sprite.colorSpace = THREE.SRGBColorSpace;
  return sprite;
}

const VERT = `
  attribute vec3 aVel;
  attribute vec4 aLife;      // birth, span, size0, growth
  attribute vec3 aTint;
  varying float vFade;
  varying vec3 vTint;
  uniform float uTime;
  uniform float uScale;      // pixels per world unit at the near plane
  void main() {
    float age = uTime - aLife.x;
    // Dead particles are pushed behind the camera rather than branched on:
    // a point with zero size still costs a vertex, and this costs nothing.
    if (age < 0.0 || age > aLife.y) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float t = age / aLife.y;
    // Smoke slows as it spreads, and lifts a little as it cools.
    vec3 pos = position + aVel * (age * (1.0 - 0.45 * t)) + vec3(0.0, 0.9 * t * t, 0.0);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aLife.z + aLife.w * t) * uScale / max(1.0, -mv.z);
    // In fast, out slow: a puff appears at once and thins away.
    vFade = (1.0 - t) * (1.0 - t) * min(1.0, t * 8.0);
    vTint = aTint;
  }
`;

const FRAG = `
  uniform sampler2D uMap;
  varying float vFade;
  varying vec3 vTint;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vTint, tex.a * vFade);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

export class Smoke {
  /** @param {number} budget  how many puffs may be alive at once */
  constructor(budget = 320) {
    this.budget = budget;
    this.at = 0;
    this.time = 0;

    const pos = new Float32Array(budget * 3);
    const vel = new Float32Array(budget * 3);
    const life = new Float32Array(budget * 4);
    const tint = new Float32Array(budget * 3);
    // Born long ago and already over, so nothing shows until something spawns.
    for (let i = 0; i < budget; i++) life[i * 4 + 1] = 0.0001;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 4));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    // The pool is scattered all over the circuit, so a bounding sphere fitted
    // to it is meaningless and frustum culling on it would blink the whole
    // system in and out as one.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: puffTexture() },
        uScale: { value: 300 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.geo = geo;
  }

  /**
   * Add a puff.
   *
   * The pool is a ring: when it is full the oldest puff is overwritten, which
   * is the right answer at a glance - the thing you notice is the smoke that
   * is being made now, not the wisp that was about to fade anyway.
   */
  puff(x, y, z, vx, vy, vz, size, grow, span, tint) {
    const i = this.at;
    this.at = (this.at + 1) % this.budget;
    const p = this.geo.attributes.position.array;
    const v = this.geo.attributes.aVel.array;
    const l = this.geo.attributes.aLife.array;
    const c = this.geo.attributes.aTint.array;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    l[i * 4] = this.time; l[i * 4 + 1] = span; l[i * 4 + 2] = size; l[i * 4 + 3] = grow;
    c[i * 3] = tint[0]; c[i * 3 + 1] = tint[1]; c[i * 3 + 2] = tint[2];
    this.dirty = true;
  }

  /**
   * One frame. Uploads only if something was spawned.
   *
   * Everything else - drift, growth, fade, death - happens in the shader from
   * the clock, so a race where nobody is sliding costs a single uniform write.
   */
  update(dt) {
    this.time += dt;
    this.points.material.uniforms.uTime.value = this.time;
    if (!this.dirty) return;
    this.dirty = false;
    for (const name of ['position', 'aVel', 'aLife', 'aTint']) {
      this.geo.attributes[name].needsUpdate = true;
    }
  }

  /** Point size is in pixels, so it has to follow the drawing buffer. */
  resize(height) {
    this.points.material.uniforms.uScale.value = height * 0.9;
  }

  /** How many puffs are alive right now. For the tests, and for nothing else. */
  get alive() {
    const l = this.geo.attributes.aLife.array;
    let n = 0;
    for (let i = 0; i < this.budget; i++) {
      const age = this.time - l[i * 4];
      if (age >= 0 && age <= l[i * 4 + 1]) n++;
    }
    return n;
  }

  dispose() {
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// Tyres: pale grey, thrown backwards and out from the wheel.
const TYRE_TINT = [0.88, 0.87, 0.85];
// A dead engine: grey, slow, straight up. Lighter than it "should" be, because
// the thing it has to be seen against is asphalt.
const ENGINE_TINT = [0.52, 0.52, 0.55];

/** How hard a car has to be sliding before it makes any smoke at all. */
const SLIP_FLOOR = 0.35;
// Puffs a second at full slide, and from a wreck. Deliberately modest: this is
// seen at 60 fps and a hundred a second reads as fog, not as a moment.
const TYRE_RATE = 40;
const ENGINE_RATE = 15;

/**
 * Spawn whatever this car is making, this frame.
 *
 * Rates are per second and carried as a fractional debt on the car, so the
 * amount of smoke does not depend on the frame rate - the same reason contact
 * and tyre wear are charged per second.
 *
 * @param {Smoke} smoke
 * @param {import('./car.js').Car} car
 * @param {number} dt
 * @param {number} quality  0..1, scales the budget on a slow device
 */
export function smokeFor(smoke, car, dt, quality = 1) {
  const rig = car.model.userData.wheels;

  // A wreck at the side of the road, cooking. Nothing else about a stopped car
  // says "that one is out" from a moving car three seconds later.
  if (car.out) {
    car.smokeDebt = (car.smokeDebt || 0) + ENGINE_RATE * quality * dt;
    while (car.smokeDebt >= 1) {
      car.smokeDebt -= 1;
      const p = car.position;
      smoke.puff(
        p.x + (Math.random() - 0.5) * 0.7, p.y + 0.8, p.z + (Math.random() - 0.5) * 0.7,
        (Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6,
        0.8, 3.6, 2.6 + Math.random() * 1.2, ENGINE_TINT,
      );
    }
    return;
  }

  // Tyres, and only when they are actually being abused: `car.slip` is the
  // same number the squeal is mixed from, so what you hear and what you see
  // are the same event.
  const slip = car.slip || 0;
  if (slip < SLIP_FLOOR || car.speed < 4) return;
  const hard = (slip - SLIP_FLOOR) / (1 - SLIP_FLOOR);
  car.smokeDebt = (car.smokeDebt || 0) + TYRE_RATE * hard * quality * dt;
  if (car.smokeDebt < 1) return;

  // At the driven wheels if the car has a rig, at its back end if not.
  const rear = rig ? rig.wheels.filter((w) => !w.front) : null;
  while (car.smokeDebt >= 1) {
    car.smokeDebt -= 1;
    let x = car.position.x, y = car.position.y + 0.25, z = car.position.z;
    if (rear && rear.length) {
      const w = rear[(Math.random() * rear.length) | 0];
      const at = car.model.localToWorld(w.centre.clone());
      x = at.x; y = at.y * 0.5 + car.position.y * 0.5 + 0.1; z = at.z;
    }
    smoke.puff(
      x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 1.6, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 1.6,
      0.62 + hard * 0.4, 3.2, 0.85 + Math.random() * 0.7, TYRE_TINT,
    );
  }
}
