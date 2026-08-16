import * as THREE from 'three';

/**
 * Little pictures of the cars, for the picker.
 *
 * **Rendered from the models, not downloaded.** Every car is already in memory
 * before the menu appears - the grid is the whole field, so they all load up
 * front - which means a portrait of one costs a single small draw and nothing
 * on the wire. That is the same rule the sky, the smoke, the crowd and the
 * contact shadows follow, and it is why a session is 5 MB rather than 15.
 *
 * **Each car is drawn where it stands.** Lifting one into a scratch scene is
 * the obvious way to do this and it is wrong here: McQueen is skinned and
 * binds to the world matrix he had at load, so reparenting him folds him
 * inside out. Instead the scene is left alone, everything else in it is hidden
 * for one frame, and a throwaway camera is pointed at the car from a
 * three-quarter angle. Whatever was visible goes back afterwards.
 *
 * The work is spread over frames: eighteen cars in one go is a visible hitch on
 * a phone, and the picker is perfectly usable while the pictures arrive.
 */

const W = 132;                  // enough for a card at 2x on a phone
const H = 84;
// Three-quarter *front*, slightly above - the angle a toy car is photographed
// from. These characters have their eyes on the windscreen, so a rear view
// makes them unidentifiable in a picture this small: it is the face and the
// nose that say which car this is, not the tail.
const YAW = Math.PI * 0.28;
const PITCH = 0.30;
const FILL = 1.24;              // how much of the frame the car takes up
// The scene is lit for racing in daylight; a card on a dark panel wants a
// little more than that, or every car reads as the same dark shape.
const EXPOSURE = 1.35;

export class CarThumbs {
  /**
   * @param {THREE.WebGLRenderer} renderer  the game's own, so the models stay
   *   on the one GL context and nothing is uploaded twice
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.cache = new Map();
    this.target = new THREE.WebGLRenderTarget(W, H, {
      colorSpace: THREE.SRGBColorSpace,
    });
    this.camera = new THREE.PerspectiveCamera(28, W / H, 0.1, 60);
    this.pixels = new Uint8Array(W * H * 4);
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * One car's picture, as a data URL.
   *
   * @param {object} model  a `loadCar` result: `{object, size}`
   */
  draw(model) {
    const { renderer, scene, camera } = this;
    // Hide the world, remember exactly what was hidden, and put it all back.
    // A car that was invisible - which is all of them but one, on the menu -
    // has to *stay* invisible afterwards or the idle camera ends up looking at
    // eighteen cars in a heap on the start line.
    const was = [];
    for (const child of scene.children) {
      was.push(child.visible);
      if (child.isLight || child.isCamera) continue;
      child.visible = child === model.object;
    }
    model.object.visible = true;
    const bg = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;

    // Frame it on the car's measured size, so an eighteen-metre transporter
    // and a hatchback both fill the card.
    const reach = Math.max(model.size.x, model.size.y, model.size.z) * FILL;
    const focus = model.object.position.clone();
    focus.y += model.size.y * 0.45;
    camera.position.set(
      focus.x + Math.sin(YAW) * Math.cos(PITCH) * reach,
      focus.y + Math.sin(PITCH) * reach,
      focus.z + Math.cos(YAW) * Math.cos(PITCH) * reach,
    );
    camera.lookAt(focus);
    camera.updateProjectionMatrix();

    const oldTarget = renderer.getRenderTarget();
    const oldAlpha = renderer.getClearAlpha();
    const oldExposure = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.target);
    renderer.setClearAlpha(0);
    renderer.toneMappingExposure = oldExposure * EXPOSURE;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(this.target, 0, 0, W, H, this.pixels);
    renderer.setRenderTarget(oldTarget);
    renderer.setClearAlpha(oldAlpha);
    renderer.toneMappingExposure = oldExposure;

    scene.background = bg;
    scene.fog = fog;
    scene.children.forEach((child, i) => { child.visible = was[i]; });

    // GL hands back rows bottom-up; a canvas wants them the other way.
    const img = this.ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const from = (H - 1 - y) * W * 4;
      img.data.set(this.pixels.subarray(from, from + W * 4), y * W * 4);
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas.toDataURL();
  }

  /**
   * Fill in a whole set, a few per frame.
   *
   * @param {Array} models  `[{id, model}]`
   * @param {function} onOne called with `(id, dataUrl)` as each is ready
   */
  fill(models, onOne) {
    const queue = models.filter((m) => !this.cache.has(m.id));
    for (const [id, url] of this.cache) onOne(id, url);
    if (!queue.length) return;
    const step = () => {
      const next = queue.shift();
      if (!next) return;
      let url;
      try {
        url = this.draw(next.model);
      } catch {
        return;                 // a lost context, or a model that will not draw
      }
      this.cache.set(next.id, url);
      onOne(next.id, url);
      if (queue.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  dispose() {
    this.target.dispose();
    this.cache.clear();
  }
}
