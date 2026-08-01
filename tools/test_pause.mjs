/**
 * Exercise the in-race pause menu: pause, resume, change the circuit mid-race,
 * restart on it, and check the controls are laid out the right way up.
 *
 * Also measures the options panel at every phone size we care about. It has to
 * fit with no scrolling: it once pushed BACK off the bottom of the screen and
 * the owner concluded a feature was missing.
 *
 *   node tools/test_pause.mjs
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
const PORT = 8211;

mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=844,390'],
});
const page = await browser.newPage();
await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });

const fail = (m) => { console.log('  FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);

await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'", { timeout: 180000 });
await page.evaluate(() => { window.game.input.state.gas = true; });
await sleep(6000);

// --- control layout --------------------------------------------------------
const pads = await page.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const p = document.getElementById('btn-pause').getBoundingClientRect();
  return {
    gasTop: Math.round(r('.ctl.gas').top), brakeTop: Math.round(r('.ctl.brake').top),
    pause: { top: Math.round(p.top), left: Math.round(p.left), w: Math.round(p.width) },
  };
});
pads.gasTop < pads.brakeTop ? ok(`gas above brake (${pads.gasTop} < ${pads.brakeTop})`)
                            : fail(`gas is not above brake: ${JSON.stringify(pads)}`);
pads.pause.w > 20 ? ok(`pause button on screen at ${pads.pause.left},${pads.pause.top}`)
                  : fail('pause button missing');

// --- pause -----------------------------------------------------------------
const before = await page.evaluate(() => window.game.race.player.progress);
await page.click('#btn-pause');
await sleep(1500);
await page.screenshot({ path: join(OUT, 'pause_menu.png') });
const paused = await page.evaluate(() => ({
  paused: window.game.paused,
  optionsOpen: !document.getElementById('options').classList.contains('hidden'),
  resumeShown: !document.getElementById('btn-resume').classList.contains('hidden'),
  backHidden: document.getElementById('btn-back').classList.contains('hidden'),
  progress: window.game.race.player.progress,
}));
paused.paused && paused.optionsOpen ? ok('paused with options open') : fail(JSON.stringify(paused));
paused.backHidden && paused.resumeShown ? ok('shows resume/restart, not BACK') : fail('wrong buttons');
await sleep(2500);
const stillFrozen = await page.evaluate(() => window.game.race.player.progress);
Math.abs(stillFrozen - paused.progress) < 0.01 ? ok('race is frozen while paused')
                                               : fail(`race advanced ${stillFrozen - paused.progress} m`);

// --- resume ----------------------------------------------------------------
await page.click('#btn-resume');
await sleep(3000);
const resumed = await page.evaluate(() => ({
  paused: window.game.paused, progress: window.game.race.player.progress,
  hud: !document.getElementById('hud').classList.contains('hidden'),
}));
!resumed.paused && resumed.progress > stillFrozen && resumed.hud
  ? ok(`resumed and moving (${Math.round(resumed.progress - stillFrozen)} m)`)
  : fail(JSON.stringify(resumed));

// --- change the circuit mid-race, then restart -----------------------------
await page.click('#btn-pause');
await sleep(1200);
await page.click('#track-picker button[data-track="palm"]');
await page.waitForFunction(
  "window.game.settings.track === 'palm' && !document.getElementById('track-picker').classList.contains('busy')",
  { timeout: 300000, polling: 400 });
const switched = await page.evaluate(() => ({
  resumeHidden: document.getElementById('btn-resume').classList.contains('hidden'),
  race: !!window.game.race,
}));
switched.resumeHidden && !switched.race
  ? ok('changing circuit mid-pause closes off resume')
  : fail(JSON.stringify(switched));
await page.screenshot({ path: join(OUT, 'pause_switched.png') });

await page.click('#btn-restart');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'", { timeout: 180000 });
await page.evaluate(() => { window.game.input.state.gas = true; });
await sleep(8000);
const restarted = await page.evaluate(() => ({
  track: window.game.settings.track,
  lapLength: Math.round(window.game.track.lapLength),
  lap: window.game.race.player.lap,
  kmh: Math.round(window.game.race.player.speedKmh),
  cars: window.game.race.field.filter((c) => c.model.visible).length,
  optionsClosed: document.getElementById('options').classList.contains('hidden'),
}));
restarted.track === 'palm' && restarted.cars === 7 && restarted.kmh > 30 && restarted.optionsClosed
  ? ok(`restarted on ${restarted.track} (${restarted.lapLength} m, ${restarted.kmh} km/h, 7 cars)`)
  : fail(JSON.stringify(restarted));
await page.screenshot({ path: join(OUT, 'pause_restarted.png') });

// --- the options panel has to fit, at every size ---------------------------
await page.click('#btn-pause');
await sleep(1200);
for (const [w, h] of [[667, 375], [844, 390], [915, 412]]) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await sleep(700);
  const fit = await page.evaluate(() => {
    const p = document.querySelector('#options .panel');
    const last = document.getElementById('btn-restart').getBoundingClientRect();
    return {
      over: p.scrollHeight - p.clientHeight,
      lastBottom: Math.round(last.bottom),
      view: innerHeight,
      physics: document.querySelectorAll('#opt-physics .pill').length,
    };
  });
  fit.over <= 1 && fit.lastBottom <= fit.view
    ? ok(`options fit at ${w}x${h} (${fit.physics} handling pills, ` +
         `last button ends at ${fit.lastBottom} of ${fit.view})`)
    : fail(`options overflow at ${w}x${h}: ${JSON.stringify(fit)}`);
  await page.screenshot({ path: join(OUT, `options_${w}x${h}.png`) });
}

await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exit(1);
}
console.log('\nno page errors');
