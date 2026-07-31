/**
 * Report the topmost visible material at given world XZ points of a GLB.
 *
 * Circuits with 90-odd auto-named materials cannot be read from a material
 * list. Render the track from above with tools/topdown.mjs, read a few pixel
 * coordinates off the road, convert them to world XZ with the mapping that
 * tool prints, and ask this what is actually there.
 *
 *   node tools/probe_points.mjs raw/msots.glb -14.9,0.7 16.6,0.7 0.5,-7.5
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8176;

const file = process.argv[2];
const points = process.argv.slice(3).map((s) => s.split(',').map(Number));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

console.log(await page.evaluate(async (url, pts) => {
  const THREE = await import('three');
  const { loadGLTF } = await import('../src/models.js');
  const gltf = await loadGLTF(new URL(url, location.origin).href);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);

  const invisible = (o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
  };
  const ray = new THREE.Raycaster();
  ray.far = 1e5;
  const down = new THREE.Vector3(0, -1, 0);
  const out = [`model y range ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`,
               '     x        z        y   material            mesh'];
  for (const [x, z] of pts) {
    ray.set(new THREE.Vector3(x, box.max.y + 50, z), down);
    const hits = ray.intersectObject(scene, true).filter((h) => !invisible(h.object));
    if (!hits.length) { out.push(`${x.toFixed(1).padStart(6)} ${z.toFixed(1).padStart(8)}   (nothing)`); continue; }
    const h = hits[0];
    const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    const col = m?.color ? '#' + m.color.getHexString() : '';
    out.push(`${x.toFixed(1).padStart(6)} ${z.toFixed(1).padStart(8)} ${h.point.y.toFixed(2).padStart(8)}   ` +
             `${String(m?.name).padEnd(20)}${String(h.object.name).padEnd(18)}${col}`);
  }
  return out.join('\n');
}, file, points));

await browser.close();
server.kill();
