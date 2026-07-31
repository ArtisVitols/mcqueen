/**
 * Load several builds of the speedway and report the topmost VISIBLE surface
 * across the track at a few stations, so we can see which compression settings
 * preserve the banked asphalt and which flatten it.
 *
 *   node tools/probe_candidates.mjs <file> [file...]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8164;
const files = process.argv.slice(2);

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

for (const file of files) {
  const res = await page.evaluate(async (url) => {
    const THREE = await import('three');
    const { loadGLTF, assetUrl } = await import('../src/models.js');
    const { Track } = await import('../src/track.js');
    const gltf = await loadGLTF(new URL(url, location.origin).href);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const track = await Track.load(assetUrl('track-data.json'));

    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ray = new THREE.Raycaster();
    ray.far = 800;
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const p = new THREE.Vector3();
    const lines = [];
    for (const [label, s] of [['straight', 20], ['turn', 700], ['back', 1420]]) {
      const st = track.sample(s, {});
      const cells = [];
      for (let n = -8; n <= 8; n += 4) {
        track.position(st, n, p);
        origin.set(p.x, p.y + 300, p.z);
        ray.set(origin, down);
        const hits = ray.intersectObject(scene, true).filter((h) => !invisible(h.object));
        const h = hits[0];
        const m = h && (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material);
        cells.push(`n=${String(n).padStart(3)}:${(h ? h.point.y.toFixed(2) : 'none').padStart(6)}` +
                   `/${(m?.name || '-').slice(0, 12)}`);
      }
      lines.push(`  ${label.padEnd(9)} ${cells.join('  ')}`);
    }
    return lines.join('\n');
  }, file);
  console.log(`\n${file}`);
  console.log(res);
}

await browser.close();
server.kill();
