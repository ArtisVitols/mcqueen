import * as THREE from 'three';

/**
 * Clouds, drawn once into a canvas and used as the scene background.
 *
 * A background texture costs one full-screen pass and *nothing* per frame:
 * no geometry, no draw call per cloud, no sorting against the fog. That is the
 * whole reason for doing it this way rather than with billboards - this is a
 * phone already drawing a 420k-triangle stadium, and the sky is the one part
 * of the picture that never moves relative to the camera.
 *
 * Nothing is loaded. The clouds are drawn with the same tool `models.js` uses
 * for contact shadows: a 2D canvas and a radial gradient. It also keeps the
 * "no asset files" rule the audio has - zero bytes, zero licensing.
 *
 * The image is equirectangular, so `u` is the compass and `v` is up. Only the
 * top half is ever seen; the bottom is the horizon haze the fog blends into.
 */

const W = 1024;
const H = 512;

/** Deterministic, so two phones in a race see the same sky. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One cloud: a handful of overlapping soft blobs.
 *
 * Drawn brightest at the top and grey underneath, because a flat white blob
 * reads as a smudge on the glass rather than as something with a bottom to it.
 */
function drawCloud(ctx, x, y, scale, r) {
  const lumps = 5 + Math.floor(r() * 5);
  for (let i = 0; i < lumps; i++) {
    const dx = (r() - 0.5) * scale * 2.4;
    const dy = (r() - 0.5) * scale * 0.7;
    const rad = scale * (0.45 + r() * 0.55);
    const lift = 1 - (dy / (scale * 0.5)) * 0.4;
    const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
    const bright = Math.max(0, Math.min(1, lift));
    // Solid most of the way out, then a quick edge. A gradient that fades from
    // the centre reads as haze on the glass; a cloud wants a body and a soft
    // rim, which is two stops rather than one.
    const tone = 232 + Math.round(23 * bright);
    g.addColorStop(0, `rgba(${tone},${tone},${tone + 3},0.98)`);
    g.addColorStop(0.6, `rgba(${tone - 10},${tone - 7},${tone},0.92)`);
    g.addColorStop(0.85, `rgba(${tone - 22},${tone - 16},${tone - 4},0.4)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Build the sky texture.
 *
 * @param {number} seed     same seed, same sky
 * @param {string} horizon  the colour the fog fades to
 */
export function skyTexture(seed = 7, horizon = '#9ecbf0') {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  // Blue overhead fading to the fog colour at the horizon, so the join is
  // invisible wherever the stadium does not already cover it.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#4f8fd6');
  sky.addColorStop(0.42, '#8fc4ee');
  sky.addColorStop(0.62, horizon);
  sky.addColorStop(1, horizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const r = rng(seed);
  // Higher in the picture means further overhead. Kept off the very top,
  // where an equirectangular map pinches to a point and a cloud smears.
  // Kept in the band that is actually on screen: the chase camera sits low and
  // looks at the horizon, so clouds at the zenith are clouds nobody sees.
  for (let i = 0; i < 30; i++) {
    const x = r() * W;
    const y = H * (0.16 + r() * 0.34);
    const scale = 24 + r() * 44;
    drawCloud(ctx, x, y, scale, r);
    // The map wraps, so a cloud near an edge has to be drawn at both.
    if (x < scale * 3) drawCloud(ctx, x + W, y, scale, rng(seed + i));
    if (x > W - scale * 3) drawCloud(ctx, x - W, y, scale, rng(seed + i));
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
