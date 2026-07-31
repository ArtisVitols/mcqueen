/**
 * Report what surface each starting slot sits on, per circuit.
 *
 * The grid is laid out in track space, so it lands wherever the racing line's
 * lateral offsets put it - which on one circuit was partly down the pit lane.
 *
 *   node tools/check_grid.mjs [trackId ...]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8213;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });

const wanted = process.argv.slice(2);
const ids = await page.evaluate(() => window.game.trackSpecs.map((t) => t.id));
for (const id of (wanted.length ? wanted : ids)) {
  await page.evaluate(async (t) => { await window.game.loadTrackById(t); }, id);
  await page.click('#btn-start');
  await page.waitForFunction("window.game.race", { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1500));
  console.log(await page.evaluate(async (tid) => {
    const THREE = await import('three');
    const g = window.game;
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ray = new THREE.Raycaster();
    ray.far = 500;
    const down = new THREE.Vector3(0, -1, 0);
    const lines = [`\n=== ${tid} ===`, ' slot  car                   back    n      surface'];
    const order = [...g.race.field].sort((a, b) => a.gridIndex - b.gridIndex);
    for (const car of order) {
      const p = car.position;
      ray.set(new THREE.Vector3(p.x, p.y + 120, p.z), down);
      const hits = ray.intersectObject(g.trackScene, true).filter((h) => !invisible(h.object));
      let best = null;
      for (const h of hits) {
        if (!best || Math.abs(h.point.y - p.y) < Math.abs(best.point.y - p.y)) best = h;
      }
      const m = best && (Array.isArray(best.object.material)
        ? best.object.material[0] : best.object.material);
      const back = -car.progress;
      lines.push(`  ${String(car.gridIndex).padStart(2)}   ${car.spec.id.padEnd(20)} ` +
        `${back.toFixed(0).padStart(4)}  ${car.n.toFixed(1).padStart(5)}   ${m?.name || 'NONE'}`);
    }
    return lines.join('\n');
  }, id));
  await page.evaluate(() => window.game.toMenu());
  await new Promise((r) => setTimeout(r, 1200));
}

await browser.close();
server.kill();
