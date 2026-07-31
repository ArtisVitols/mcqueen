/**
 * Screenshot the chase camera at points all the way round a lap.
 *
 * Checking one spot proves nothing: a racing line can sit perfectly on the
 * asphalt at the start line and run through the infield in turn three. This
 * teleports the player to N evenly spaced stations and shoots each one, so the
 * whole lap gets looked at.
 *
 *   node tools/lap_tour.mjs msots [shots]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(homedir(), 'mcqueen-shots');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8205;
const TRACK = process.argv[2] || 'msots';
const SHOTS = Number(process.argv[3] || 8);
// Chrome rejects very small windows here; shoot big and shrink when stitching.
const TILE = { w: 900, h: 440 };
const SHRINK = 0.5;

mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  // SwiftShader is slow enough that the default protocol timeout trips.
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', `--window-size=${TILE.w},${TILE.h}`],
});
const page = await browser.newPage();
await page.setViewport({ width: TILE.w, height: TILE.h });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });
await page.evaluate(async (t) => { await window.game.loadTrackById(t); }, TRACK);
await page.click('#btn-start');
await page.waitForFunction("window.game.race", { timeout: 180000 });
await sleep(2000);
await page.evaluate(() => {
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('controls').classList.add('hidden');
});

const tiles = [];
for (let k = 0; k < SHOTS; k++) {
  const info = await page.evaluate(async (frac) => {
    const THREE = await import('three');
    const g = window.game;
    const race = g.race;
    race.state = 'racing';
    const s = frac * g.track.lapLength;
    // Park the whole field around this point so the shot looks like a race.
    race.field.forEach((c, i) => {
      c.s = g.track.wrap(s - i * 7);
      c.n = ((i % 3) - 1) * 3;
      c.speed = 45;
      c.psi = 0;
      c.sync();
    });
    g.camN = race.player.n;
    g.placeCamera(race.player, 1);
    g.renderer.render(g.scene, g.camera);

    // Is the surface where the physics says it is, right here?
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ray = new THREE.Raycaster();
    ray.far = 500;
    const p = race.player.position;
    ray.set(new THREE.Vector3(p.x, p.y + 200, p.z), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(g.trackScene, true).filter((h) => !invisible(h.object));
    let best = null;
    for (const h of hits) {
      if (!best || Math.abs(h.point.y - p.y) < Math.abs(best.point.y - p.y)) best = h;
    }
    const m = best && (Array.isArray(best.object.material)
      ? best.object.material[0] : best.object.material);
    return {
      s: Math.round(s),
      drop: best ? +(p.y - best.point.y).toFixed(2) : null,
      mat: m?.name || 'NONE',
    };
  }, k / SHOTS);
  await sleep(500);
  const file = join(OUT, `lap_${TRACK}_${String(k).padStart(2, '0')}.png`);
  await page.screenshot({ path: file });
  tiles.push(file);
  console.log(`  s=${String(info.s).padStart(5)}  drop ${String(info.drop).padStart(6)} m  ${info.mat}`);
}

await browser.close();
server.kill();

// Stitch into one contact sheet.
const { spawnSync } = await import('node:child_process');
spawnSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
files = sys.argv[1:]
cols = 4
rows = (len(files) + cols - 1) // cols
w, h = int(${TILE.w} * ${SHRINK}), int(${TILE.h} * ${SHRINK})
sheet = Image.new('RGB', (w * cols, h * rows), (10, 12, 16))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    sheet.paste(Image.open(f).resize((w, h), Image.LANCZOS), (i % cols * w, i // cols * h))
    d.text((i % cols * w + 6, i // cols * h + 6), str(i), fill=(255, 230, 80))
sheet.save('${join(OUT, `laptour_${TRACK}.png`)}')
print('wrote laptour_${TRACK}.png')
`, ...tiles], { stdio: 'inherit' });
