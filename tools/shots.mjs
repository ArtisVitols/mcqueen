/**
 * Drive the real game in headless Chrome and capture screenshots.
 *
 * There is no GPU here, so Chrome falls back to SwiftShader. It renders the
 * scene correctly but slowly - expect single-digit fps, which is why the waits
 * below are generous. It is enough to prove the track, the cars, the camera,
 * the HUD, the start lights and the menus all actually draw.
 *
 *   node tools/shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(homedir(), 'mcqueen-shots');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8140;
const VIEW = { width: 900, height: 440 };   // a phone in landscape

mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 1800000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${VIEW.width},${VIEW.height}`,
  ],
});

const page = await browser.newPage();
await page.setViewport(VIEW);

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));

const shot = async (name) => {
  const path = join(OUT, `game_${name}.png`);
  await page.screenshot({ path });
  console.log('  shot', name);
};

console.log('loading…');
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });

await page.waitForFunction(
  "!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 240000, polling: 500 });
console.log('menu is up');
await sleep(2500);
await shot('1_menu');

// --- options ---------------------------------------------------------------
await page.click('#btn-options');
await sleep(1200);
await shot('2_options');

// Pick a different car to prove the picker works, then switch back.
await page.click('#car-picker button[data-car="chick_hicks"]');
await sleep(900);
await shot('3_options_chick');
await page.click('#car-picker button[data-car="lightning_mcqueen"]');
await page.click('#btn-back');
await sleep(1500);

// --- countdown -------------------------------------------------------------
console.log('starting race…');
await page.click('#btn-start');
await page.waitForFunction("!document.getElementById('hud').classList.contains('hidden')",
  { timeout: 60000 });
await sleep(2500);
await shot('4_countdown');

// Report what the game thinks is going on, straight from its own state.
const grid = await page.evaluate(() => {
  const r = window.game.race;
  return r.field.map((c) => ({
    car: c.spec.id, s: +c.s.toFixed(1), n: +c.n.toFixed(2),
    y: +c.position.y.toFixed(2), lap: c.lap, place: c.place,
  }));
});
console.log('grid:', JSON.stringify(grid, null, 1));

// --- racing ----------------------------------------------------------------
await page.waitForFunction("window.game.race.state === 'racing'", { timeout: 60000 });
console.log('green flag');

// Hold the throttle the way a player would.
await page.evaluate(() => { window.game.input.state.gas = true; });

for (const wait of [6000, 9000, 12000]) {
  await sleep(wait);
  const st = await page.evaluate(() => {
    const g = window.game, p = g.race.player;
    return {
      lap: p.lap, place: p.place, kmh: Math.round(p.speedKmh),
      n: +p.n.toFixed(2), y: +p.position.y.toFixed(2),
      camY: +g.camera.position.y.toFixed(2),
      visible: g.race.field.filter((c) => c.model.visible).length,
    };
  });
  console.log('  state:', JSON.stringify(st));
}
await shot('5_racing');

await sleep(9000);
await shot('6_racing_later');

// --- controls pressed ------------------------------------------------------
await page.evaluate(() => {
  for (const el of document.querySelectorAll('[data-action]')) el.classList.add('down');
});
await sleep(1500);
await shot('7_controls_pressed');

// --- results ---------------------------------------------------------------
// Fast-forward to the flag rather than sitting through three laps at 5fps.
console.log('fast-forwarding to the finish…');
await page.evaluate(() => {
  const r = window.game.race;
  for (const c of r.field) c.progress = r.totalLaps * r.track.lapLength - 60;
});
await page.waitForFunction("!document.getElementById('result').classList.contains('hidden')",
  { timeout: 180000, polling: 500 });
await sleep(2000);
await shot('8_result');

const result = await page.evaluate(() => ({
  title: document.getElementById('result-title').textContent,
  sub: document.getElementById('result-sub').textContent,
  order: [...document.querySelectorAll('#result-order li')].map((li) => li.innerText.replace(/\n/g, ' ')),
}));
console.log('result:', JSON.stringify(result, null, 1));

// --- portrait nag ----------------------------------------------------------
await page.setViewport({ width: 440, height: 900 });
await sleep(1200);
await shot('9_portrait');

await browser.close();
stop();

if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exit(1);
}
console.log('\nno page errors');
