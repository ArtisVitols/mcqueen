/**
 * Render a track GLB from directly overhead: a colour pass and a height pass.
 *
 * This is the input to tools/extract_oval.py. Identifying the road from the
 * material list is hopeless on circuits that export 90-odd materials all named
 * "Material.nnn", but it is obvious from above: the asphalt is a dark ring at
 * ground level between green infield and raised grandstands. So we render what
 * a human would look at, plus a per-pixel world height, and classify on that.
 *
 * Writes build/<name>_colour.png, build/<name>_height.png and
 * build/<name>_meta.json (the pixel-to-world mapping and height range).
 *
 *   node tools/topdown.mjs raw/palm_mile_speedway.glb palm [size]
 */
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8175;

const file = process.argv[2];
const name = process.argv[3] || basename(file).replace(/\.glb$/, '');
const SIZE = Number(process.argv[4] || 1600);

mkdirSync(BUILD, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', `--window-size=${SIZE},${SIZE}`],
});
const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE });
page.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

/**
 * Read the WebGL canvas itself, never a page screenshot.
 *
 * These images are a coordinate system: extract_oval.py maps pixels straight
 * back to world metres. A page screenshot includes whatever the host page's
 * CSS does to the canvas, and tools/smoke.html sets `body { padding: 14px }`.
 * That silently shifted every overhead pass by 14 px - about 6 m once scaled -
 * which is most of a road width, and put the cars on the grass.
 */
async function grab(file) {
  const data = await page.evaluate(() =>
    window.__ctx.renderer.domElement.toDataURL('image/png'));
  writeFileSync(join(BUILD, file), Buffer.from(data.split(',')[1], 'base64'));
}

const meta = await page.evaluate(async (url, size) => {
  const THREE = await import('three');
  const { loadGLTF } = await import('../src/models.js');
  const gltf = await loadGLTF(new URL(url, location.origin).href);
  const root = gltf.scene;

  // A fully transparent collision shell must not occlude the road below it.
  root.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false))) o.visible = false;
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(root);
  // Flat lighting so pixel colour reflects the texture, not the shading.
  scene.add(new THREE.AmbientLight(0xffffff, 3.0));

  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x, s.z) * 0.52;

  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, s.y * 4 + 2000);
  cam.position.set(c.x, box.max.y + s.y + 100, c.z);
  cam.up.set(0, 0, -1);        // image +x is world +x, image +y is world +z
  cam.lookAt(c.x, c.y, c.z);

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.appendChild(renderer.domElement);
  renderer.render(scene, cam);

  window.__ctx = { THREE, renderer, scene, cam, root, box };
  return {
    size,
    // pixel (px, py) -> world x = left + px * mpp, world z = top + py * mpp
    left: c.x - half, top: c.z - half,
    metresPerPixel: (half * 2) / size,
    yMin: box.min.y, yMax: box.max.y,
    extent: [s.x, s.y, s.z],
  };
}, file, SIZE);

await grab(`${name}_colour.png`);

// Height pass: pack world Y into 24 bits of RGB, no lighting or tone mapping.
await page.evaluate(async (yMin, yMax) => {
  const { THREE, renderer, scene, cam } = window.__ctx;
  scene.overrideMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { lo: { value: yMin }, hi: { value: yMax } },
    vertexShader: `
      varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying float vY;
      uniform float lo; uniform float hi;
      void main() {
        float t = clamp((vY - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
        float v = floor(t * 16777215.0 + 0.5);
        float r = floor(v / 65536.0);
        float g = floor((v - r * 65536.0) / 256.0);
        float b = v - r * 65536.0 - g * 256.0;
        gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
      }`,
  });
  scene.background = new THREE.Color(0x000000);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.render(scene, cam);
}, meta.yMin, meta.yMax);

await grab(`${name}_height.png`);

// Material-ID pass: each material a distinct flat colour. Reading the road
// straight off this is exact, where classifying by colour or height guesses.
meta.materials = await page.evaluate(async () => {
  const { THREE, renderer, scene, cam, root } = window.__ctx;
  scene.overrideMaterial = null;
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const key = ms[0]?.name || '?';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  const legend = {};
  let i = 1;
  for (const [key, meshes] of groups) {
    // Walk the 24-bit space in big strides so ids stay far apart.
    const id = (i * 2654435761) % 16777216;
    const col = new THREE.Color((id >> 16) / 255 / 65536 * 65536, 0, 0);
    col.setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255);
    for (const mesh of meshes) {
      mesh.userData.origMaterial = mesh.material;
      mesh.material = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
    }
    legend[key] = [(id >> 16) & 255, (id >> 8) & 255, id & 255];
    i++;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  scene.background = new THREE.Color(0x000000);
  renderer.render(scene, cam);
  return legend;
});

await grab(`${name}_id.png`);

writeFileSync(join(BUILD, `${name}_meta.json`), JSON.stringify(meta, null, 1));
console.log(name, JSON.stringify({
  extent: meta.extent.map((v) => +v.toFixed(1)),
  mpp: +meta.metresPerPixel.toFixed(4),
  y: [+meta.yMin.toFixed(2), +meta.yMax.toFixed(2)],
}));
console.log(`  build/${name}_{colour,height}.png  build/${name}_meta.json`);

await browser.close();
server.kill();
