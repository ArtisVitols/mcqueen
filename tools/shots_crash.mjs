/**
 * Photograph a wreck.
 *
 * `check_crashes.mjs` proves an incident is safe - inside the corridor, out of
 * the player's way, still classified, race still ends. It cannot prove the one
 * thing that actually matters here, which is that a car stopped at the side of
 * the road *looks* like a car stopped at the side of the road: on the surface
 * rather than sunk into it, not halfway through the wall, and pointing the way
 * something that just had a moment would point.
 *
 * The incident is triggered by hand. At the shipped rate it happens about once
 * every couple of races and never on demand, and the guard that keeps them away
 * from the player would rule out the one place a chase camera can see it.
 *
 *   node tools/shots_crash.mjs [trackId]
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
const PORT = 8347;
const TRACK = process.argv[2] || 'msots';

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

await page.evaluate(async (tid) => {
  window.game.settings.laps = 10;
  window.game.settings.difficulty = 'normal';
  if (window.game.settings.track !== tid) await window.game.pickTrack(tid);
}, TRACK);
await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
  { timeout: 300000 });

/** Step the simulation by hand: SwiftShader draws this at a couple of fps. */
const advance = (seconds) => page.evaluate((s) => {
  const held = { applyTo: (car, dt, ph) => {
    car.steerCmd = 0;
    if (!ph?.assisted) car.steer = 0;
    car.throttle = 1;
    car.brake = 0;
  } };
  for (let t = 0; t < s; t += 1 / 60) window.game.race.update(1 / 60, held);
}, seconds);

await advance(25);

// Send a rival off, to the inside. Whichever one is furthest up the road -
// and if the player is leading, that is the one furthest *back*, which the
// player then comes round and catches. Either way the chase camera ends up
// driving straight past it, which is the whole point of the exercise.
const who = await page.evaluate(() => {
  const race = window.game.race;
  const p = race.player;
  let best = null, gap = -Infinity;
  for (const c of race.field) {
    if (c === p || c.isPlayer) continue;
    const d = race.track.delta(p.s, c.s);
    if (d > gap) { best = c; gap = d; }
  }
  if (!best) return null;
  best.crash = 0;
  best.crashSide = -1;
  return { id: best.spec.id, gap: Math.round(gap) };
});
who ? ok(`sent ${who.id} off, ${who.gap} m up the road`)
    : fail('nobody to crash');
if (!who) { await browser.close(); server.kill(); process.exit(1); }

// Let it come to rest, then close on it until it is in shot.
await advance(6);
const closed = await page.evaluate((id) => {
  const race = window.game.race;
  const c = race.field.find((x) => x.spec.id === id);
  const held = { applyTo: (car, dt, ph) => {
    car.steerCmd = 0;
    if (!ph?.assisted) car.steer = 0;
    car.throttle = 1; car.brake = 0;
  } };
  for (let t = 0; t < 90; t += 1 / 60) {
    const d = race.track.delta(race.player.s, c.s);
    if (d > 15 && d < 70) return Math.round(d);
    race.update(1 / 60, held);
  }
  return -1;
}, who.id);
closed > 0 ? ok(`caught it up (${closed} m ahead)`)
           : fail('never got near the wreck again');
await page.screenshot({ path: join(OUT, `crash_0_off_${TRACK}.png`) });

const state = await page.evaluate((id) => {
  const race = window.game.race;
  const c = race.field.find((x) => x.spec.id === id);
  const st = c.road.sample(c.s, {});
  const surface = c.road.position(st, c.n, new (Object.getPrototypeOf(c.position).constructor)());
  return {
    out: c.out,
    speed: +c.speed.toFixed(2),
    n: +c.n.toFixed(2),
    inner: +c.road.limit(st, -1).toFixed(2),
    outer: +c.road.limit(st, 1).toFixed(2),
    psiDeg: Math.round(c.psi * 57.3),
    // How far the drawn model is from the road surface it should be sitting on.
    ride: +(c.model.position.y - surface.y).toFixed(3),
    place: c.place,
    of: race.field.length,
  };
}, who.id);
console.log('  wreck:', JSON.stringify(state));

state.out ? ok(`it stopped and is out (${state.speed} m/s)`)
          : fail(`it is still going at ${state.speed} m/s`);
state.n >= state.inner && state.n <= state.outer
  ? ok(`parked inside the corridor (n ${state.n} of ${state.inner}..${state.outer})`)
  : fail(`parked at n ${state.n}, outside ${state.inner}..${state.outer}`);
Math.abs(state.ride) < 0.05
  ? ok(`sitting on the road (${(state.ride * 100).toFixed(1)} cm off the surface)`)
  : fail(`drawn ${state.ride.toFixed(2)} m from the road surface`);
Math.abs(state.psiDeg) >= 10 && Math.abs(state.psiDeg) <= 45
  ? ok(`stopped askew (${state.psiDeg} deg), which is what makes it read as a wreck`)
  : fail(`stopped at ${state.psiDeg} deg off the tangent`);
state.place === state.of
  ? ok(`classified last (P${state.place} of ${state.of})`)
  : fail(`classified P${state.place} of ${state.of}`);

// Drive past it: the wreck has to be visible from the car, and the player has
// to get by without being collected by it.
for (let k = 0; k < 3; k++) {
  await advance(2.5);
  await page.screenshot({ path: join(OUT, `crash_1_past_${k}_${TRACK}.png`) });
}
const after = await page.evaluate(() => ({
  kmh: Math.round(window.game.race.player.speedKmh),
  state: window.game.race.state,
}));
after.kmh > 100 ? ok(`the player drove past and kept going (${after.kmh} km/h)`)
                : fail(`the player is doing ${after.kmh} km/h - collected by the wreck?`);

console.log(`  wrote crash_*_${TRACK}.png to ${OUT}`);
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  failed++;
}
await browser.close();
server.kill();
console.log(failed ? `\n${failed} problem(s)` : '\nthe wreck is where it should be, and looks it');
process.exit(failed ? 1 : 0);
