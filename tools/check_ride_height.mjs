/**
 * Measure the gap between the bottom of each car model and the track surface
 * underneath it, in a running race. Answers "are the cars floating?" directly
 * rather than by inspecting the pieces separately.
 *
 *   node tools/check_ride_height.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8161;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--window-size=900,440'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 440 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });
await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
  { timeout: 120000 });
await sleep(3000);

const out = await page.evaluate(async () => {
  const THREE = await import('three');
  const g = window.game;
  const ray = new THREE.Raycaster();
  ray.far = 300;
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const box = new THREE.Box3();

  // The model ships a fully transparent collision shell above the road; it
  // must not count as ground.
  const invisible = (o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
  };

  const rows = [];
  for (const car of g.race.field) {
    box.setFromObject(car.model);
    const p = car.position;
    origin.set(p.x, p.y + 40, p.z);
    ray.set(origin, down);
    const hits = ray.intersectObject(g.trackScene, true)
      .filter((h) => !invisible(h.object) && h.point.y < p.y + 2);
    const surface = hits.length ? hits[0].point.y : NaN;
    rows.push({
      car: car.spec.id,
      pivotY: +p.y.toFixed(3),
      modelBottom: +box.min.y.toFixed(3),
      surface: +surface.toFixed(3),
      gap: +(box.min.y - surface).toFixed(3),      // >0 means floating
      hit: hits.length ? hits[0].object.name : null,
    });
  }
  return rows;
});

console.log('gap = bottom of the car model minus the track surface beneath it (metres)');
console.log('car                     pivotY  bottom  surface    gap   hit');
for (const r of out) {
  console.log(`${r.car.padEnd(22)} ${String(r.pivotY).padStart(6)} ` +
    `${String(r.modelBottom).padStart(7)} ${String(r.surface).padStart(7)} ` +
    `${String(r.gap).padStart(6)}   ${r.hit}`);
}

await browser.close();
server.kill();
