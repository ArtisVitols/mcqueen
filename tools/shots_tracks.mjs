/**
 * Drive the real game through every circuit in headless Chrome: pick each one
 * in OPTIONS, look at the menu, then race on it.
 *
 *   node tools/shots_tracks.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(homedir(), 'mcqueen-shots');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8185;
const VIEW = { width: 900, height: 440 };

mkdirSync(OUT, { recursive: true });
const tracks = JSON.parse(readFileSync(join(ROOT, 'assets', 'tracks.json'), 'utf8')).tracks;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--hide-scrollbars',
         '--autoplay-policy=no-user-gesture-required',
         `--window-size=${VIEW.width},${VIEW.height}`],
});
const page = await browser.newPage();
await page.setViewport(VIEW);
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`failed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });
console.log('booted');

for (const spec of tracks) {
  console.log(`\n--- ${spec.name}`);
  await page.click('#btn-options');
  await sleep(800);
  await page.click(`#track-picker button[data-track="${spec.id}"]`);
  await page.waitForFunction(
    `window.game.settings.track === '${spec.id}' && !document.getElementById('track-picker').classList.contains('busy')`,
    { timeout: 300000, polling: 400 });
  await sleep(1500);
  await page.click('#btn-back');
  await sleep(2500);
  await page.screenshot({ path: join(OUT, `track_${spec.id}_menu.png`) });

  await page.click('#btn-start');
  await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
    { timeout: 180000 });
  await page.evaluate(() => { window.game.input.state.gas = true; });
  await sleep(14000);
  const st = await page.evaluate(() => {
    const g = window.game, p = g.race.player;
    return {
      track: g.settings.track, lap: p.lap, place: p.place,
      kmh: Math.round(p.speedKmh), n: +p.n.toFixed(1),
      y: +p.position.y.toFixed(2), lapLength: Math.round(g.track.lapLength),
      cars: g.race.field.filter((c) => c.model.visible).length,
    };
  });
  console.log('  ', JSON.stringify(st));
  await page.screenshot({ path: join(OUT, `track_${spec.id}_race.png`) });

  await page.evaluate(() => { window.game.input.state.gas = false; window.game.toMenu(); });
  await sleep(2000);
}

await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exit(1);
}
console.log('\nno page errors');
