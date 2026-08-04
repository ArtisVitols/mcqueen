/**
 * Watch a pit stop happen, in the real game, and photograph it.
 *
 * `check_pits.mjs` proves the geometry and the state machine. This proves the
 * part neither of them can: that you can *see* it - the tyre bar draining, the
 * yellow box on the road, Guido going round the car, Mack parked up. Every bug
 * the owner has reported was visible in an image and invisible in the numbers.
 *
 * The race is driven forward by stepping the simulation directly rather than
 * waiting: SwiftShader renders Yoyleland at under two frames a second, and a
 * ten-lap race would take an hour of wall clock to watch.
 *
 *   node tools/shots_pits.mjs [trackId]
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
const PORT = 8343;
const TRACK = process.argv[2] || 'yoyle';

mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 440, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });

// A long race on the circuit under test, so a stop is actually needed.
await page.evaluate(async (tid) => {
  window.game.settings.laps = 15;
  // Easy: the aid steers into the pits for you, which is the path that
  // matters most here - a five-year-old holding the throttle down has to
  // get a stop without knowing pit lanes exist. On the other settings you
  // steer down to the inside yourself, which check_pits covers.
  window.game.settings.difficulty = 'easy';
  if (window.game.settings.track !== tid) await window.game.pickTrack(tid);
}, TRACK);
await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
  { timeout: 300000 });

// A long service, so the stop can actually be photographed. SwiftShader draws
// Yoyleland at under two frames a second and Easy's real stop is three - the
// crew would be finished before the shutter opened.
await page.evaluate(() => { window.game.race.serviceTime = 40; });

const hasPits = await page.evaluate(() => !!window.game.race.pits);
hasPits ? ok(`${TRACK} has a pit road`) : fail(`${TRACK} has no pit road`);
if (!hasPits) { await browser.close(); server.kill(); process.exit(1); }

/**
 * Advance the simulation without waiting for frames.
 *
 * Stepping `race.update` directly is the only way to see a fifteen-lap race
 * at 1.7 fps. The renderer still draws whatever the last step left behind, so
 * the screenshots are of a real race state, not a posed one.
 */
const advance = (seconds) => page.evaluate((s) => {
  const g = window.game;
  const held = { applyTo: (car, dt, ph) => {
    car.steerCmd = 0;
    if (!ph?.assisted) car.steer = 0;
    car.throttle = 1;
    car.brake = 0;
  } };
  for (let t = 0; t < s; t += 1 / 60) {
    g.race.update(1 / 60, held);
    // The crew live in the render loop, which is not running while the
    // simulation is stepped by hand - so drive them here too, or Guido never
    // leaves his spot and the screenshots show an empty pit box.
    g.updatePits(g.race, g.race.player, 1 / 60);
  }
  const p = g.race.player;
  return { lap: p.lap, tyre: +p.tyre.toFixed(3), pit: p.pit, onPit: p.onPit,
           kmh: Math.round(p.speedKmh), stops: p.pitStops };
}, seconds);

// --- the tyre bar, fresh and worn ------------------------------------------
const shown = await page.evaluate(() =>
  !document.getElementById('tyres').classList.contains('hidden'));
shown ? ok('the tyre bar is on screen') : fail('the tyre bar is hidden on a circuit with pits');
await page.screenshot({ path: join(OUT, `pit_0_fresh_${TRACK}.png`) });

let state = await advance(200);
console.log(`  after 200 s: ${JSON.stringify(state)}`);
await page.screenshot({ path: join(OUT, `pit_1_worn_${TRACK}.png`) });
state.tyre < 0.75 ? ok(`tyres wearing (${(state.tyre * 100).toFixed(0)}%)`)
                  : fail(`tyres barely worn after 200 s (${state.tyre})`);

// --- catch the stop itself -------------------------------------------------
// Step in small slices and photograph the first moment the crew are working.
let caught = null;
for (let i = 0; i < 260 && !caught; i++) {
  state = await advance(2);
  if (state.pit === 'service') caught = { ...state };
}
if (!caught) {
  fail('the player never pitted in fifteen laps');
} else {
  ok(`stopped for service on lap ${caught.lap} with ${(caught.tyre * 100).toFixed(0)}% left`);
  await page.screenshot({ path: join(OUT, `pit_2_stopped_${TRACK}.png`) });

  // The crew, and where Guido has got to.
  const crew = await page.evaluate(() => {
    const c = window.game.crew;
    if (!c) return null;
    const g = c.guido;
    return {
      active: c.active, at: c.at, route: c.route.length,
      visible: g ? g.visible : false,
      guido: g ? [+g.position.x.toFixed(1), +g.position.y.toFixed(1), +g.position.z.toFixed(1)] : null,
      mack: c.mack ? c.mack.visible : null,
      car: [+window.game.race.player.position.x.toFixed(1),
            +window.game.race.player.position.z.toFixed(1)],
    };
  });
  console.log(`  crew: ${JSON.stringify(crew)}`);
  crew && crew.active && crew.route === 4
    ? ok('Guido is out, with four wheels on his round')
    : fail(`the crew are not working: ${JSON.stringify(crew)}`);
  crew && crew.mack ? ok('Mack is parked in the pits') : fail('Mack is not in the pits');
  // He has to be *at the car*, not parked on the far side of the circuit.
  const near = crew && Math.hypot(crew.guido[0] - crew.car[0], crew.guido[2] - crew.car[1]);
  near !== null && near < 25
    ? ok(`Guido is ${near.toFixed(1)} m from the car`)
    : fail(`Guido is ${near} m from the car`);

  // A few frames through the service, so his route round it is visible.
  for (let k = 0; k < 3; k++) {
    await advance(1.2);
    await page.screenshot({ path: join(OUT, `pit_3_service_${k}_${TRACK}.png`) });
  }

  // ... and away again.
  for (let i = 0; i < 40; i++) {
    state = await advance(1);
    if (!state.onPit) break;
  }
  !state.onPit ? ok(`rejoined the circuit (${state.stops} stop(s), ${state.kmh} km/h)`)
               : fail('never left the pit lane');
  await page.screenshot({ path: join(OUT, `pit_4_rejoined_${TRACK}.png`) });
}

console.log(`  wrote pit_*_${TRACK}.png to ${OUT}`);
await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  failed++;
}
console.log(failed ? `\n${failed} problem(s)` : '\nthe stop is visible and works');
process.exit(failed ? 1 : 0);
