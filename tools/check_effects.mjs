/**
 * Clouds, tyre smoke and a wreck cooking at the roadside.
 *
 * All three are cosmetic, which is exactly why they need a test: nothing else
 * in the game will fail if the smoke stops appearing, and nobody reads a
 * screenshot every release. So this asserts the numbers - a puff is spawned
 * when a car is sliding, a wreck makes some on its own, the pool never
 * overflows its budget, and a clean lap costs nothing at all - and then takes
 * the pictures, because "there is smoke" and "it looks like smoke" are
 * different claims.
 *
 *   node tools/check_effects.mjs [trackId]
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
const PORT = 8371;
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

// --- the sky ---------------------------------------------------------------
const sky = await page.evaluate(() => {
  const bg = window.game.scene.background;
  return { isTexture: !!bg?.isTexture, w: bg?.image?.width, h: bg?.image?.height,
           mapping: bg?.mapping };
});
sky.isTexture && sky.w >= 512
  ? ok(`the sky is a ${sky.w}x${sky.h} cloud texture, not a flat colour`)
  : fail(`the background is ${JSON.stringify(sky)}`);
await page.screenshot({ path: join(OUT, 'fx_0_menu_sky.png') });

await page.evaluate(async (tid) => {
  window.game.settings.laps = 10;
  window.game.settings.difficulty = 'normal';
  if (window.game.settings.track !== tid) await window.game.pickTrack(tid);
}, TRACK);
await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
  { timeout: 300000 });

/** Step the simulation and the effects by hand: SwiftShader is far too slow. */
const advance = (seconds, slide = 0) => page.evaluate((s, sl) => {
  const g = window.game;
  const held = { applyTo: (car, dt, ph) => {
    car.steerCmd = 0;
    if (!ph?.assisted) car.steer = 0;
    car.throttle = 1;
    car.brake = 0;
  } };
  let peak = 0;
  for (let t = 0; t < s; t += 1 / 60) {
    g.race.update(1 / 60, held);
    // A scripted slide, so the test does not depend on the AI getting one
    // wrong. `slip` is what the game itself sets when a car is sideways.
    if (sl) for (const c of g.race.field) c.slip = Math.max(c.slip, sl);
    for (const c of g.race.field) window.__fx(c, 1 / 60);
    g.smoke.update(1 / 60);
    peak = Math.max(peak, g.smoke.alive);
  }
  return { peak, alive: g.smoke.alive };
}, seconds, slide);

await page.evaluate(async () => {
  const { smokeFor } = await import('../src/smoke.js');
  window.__fx = (car, dt) => smokeFor(window.game.smoke, car, dt, 1);
});

/**
 * Photograph the smoke.
 *
 * The render loop has to be stopped first, and that is not a quirk of the
 * test: a puff lives about a second, and under SwiftShader one frame *is* a
 * second or three. Left running, the loop would age every puff to death
 * between the burst and the shutter - which says nothing at all about how this
 * looks at 60 fps on a phone. So: stop the loop, make the smoke, draw one
 * frame by hand, and take the picture of that.
 */
async function shoot(name, slide, lookAt = null) {
  // Stop the loop *and* let any frame already in flight land, or it redraws
  // with the chase camera a moment after this one was set up.
  await page.evaluate(() => { window.game.paused = true; cancelAnimationFrame(window.game.raf); });
  await sleep(2500);
  await page.evaluate((sl, at) => {
    const g = window.game;
    const held = { applyTo: (car, dt, ph) => {
      car.steerCmd = 0; if (!ph?.assisted) car.steer = 0; car.throttle = 1; car.brake = 0; } };
    for (let t = 0; t < 0.6; t += 1 / 60) {
      g.race.update(1 / 60, held);
      if (sl) for (const c of g.race.field) c.slip = Math.max(c.slip, sl);
      for (const c of g.race.field) window.__fx(c, 1 / 60);
      g.smoke.update(1 / 60);
    }
    if (at) {
      // Look at the wreck from a few metres back, because the point of this
      // picture is the wreck and the chase camera is looking somewhere else.
      const c = g.race.field.find((x) => x.spec.id === at);
      const fwd = new (Object.getPrototypeOf(c.position).constructor)(0, 0, 1)
        .applyQuaternion(c.model.quaternion);
      g.camera.position.copy(c.position).addScaledVector(fwd, -9);
      g.camera.position.y += 3.2;
      g.camera.up.set(0, 1, 0);
      g.camera.lookAt(c.position.x, c.position.y + 0.8, c.position.z);
    } else {
      g.placeCamera(g.race.player, 1);
    }
    g.renderer.render(g.scene, g.camera);
  }, slide, lookAt);
  await sleep(300);
  await page.screenshot({ path: join(OUT, name) });
  await page.evaluate(() => { window.game.paused = false; window.game.loop(performance.now()); });
}

// --- a clean lap makes none ------------------------------------------------
const clean = await advance(6, 0);
clean.peak === 0
  ? ok('a clean lap makes no smoke at all')
  : fail(`${clean.peak} puffs with nobody sliding`);

// --- a slide makes some ----------------------------------------------------
const sliding = await advance(3, 0.9);
sliding.peak > 20
  ? ok(`sliding makes tyre smoke (${sliding.peak} puffs alive at once)`)
  : fail(`only ${sliding.peak} puffs while the whole field was sideways`);
const budget = await page.evaluate(() => window.game.smoke.budget);
sliding.peak <= budget
  ? ok(`the pool held its budget (${sliding.peak} of ${budget})`)
  : fail(`the pool overflowed: ${sliding.peak} of ${budget}`);
await shoot(`fx_1_tyres_${TRACK}.png`, 0.9);

// It has to stop, too - smoke that never clears is fog.
const after = await advance(4, 0);
after.alive === 0
  ? ok('and it clears once the sliding stops')
  : fail(`${after.alive} puffs still alive four seconds later`);

// --- a wreck cooks ---------------------------------------------------------
const who = await page.evaluate(() => {
  const race = window.game.race;
  const p = race.player;
  let best = null, gap = -Infinity;
  for (const c of race.field) {
    if (c === p) continue;
    const d = race.track.delta(p.s, c.s);
    if (d > gap) { best = c; gap = d; }
  }
  best.crash = 0;
  best.crashSide = -1;
  return best.spec.id;
});
await advance(8, 0);
const wreck = await page.evaluate((id) => {
  const c = window.game.race.field.find((x) => x.spec.id === id);
  return { out: c.out, alive: window.game.smoke.alive };
}, who);
wreck.out && wreck.alive > 3
  ? ok(`the wreck is cooking (${who}, ${wreck.alive} puffs)`)
  : fail(`wreck out=${wreck.out} with ${wreck.alive} puffs`);

// Drive up to it and photograph it from the car.
await page.evaluate((id) => {
  const race = window.game.race;
  const c = race.field.find((x) => x.spec.id === id);
  const held = { applyTo: (car, dt, ph) => {
    car.steerCmd = 0; if (!ph?.assisted) car.steer = 0; car.throttle = 1; car.brake = 0; } };
  for (let t = 0; t < 120; t += 1 / 60) {
    const d = race.track.delta(race.player.s, c.s);
    if (d > 12 && d < 55) break;
    race.update(1 / 60, held);
    for (const x of race.field) window.__fx(x, 1 / 60);
    window.game.smoke.update(1 / 60);
  }
  window.game.placeCamera(race.player, 1);
}, who);
await shoot(`fx_2_wreck_${TRACK}.png`, 0, who);
console.log(`  wrote fx_*.png to ${OUT}`);

if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  failed++;
}
await browser.close();
server.kill();
console.log(failed ? `\n${failed} problem(s)` : '\nclouds, tyre smoke and a smoking wreck');
process.exit(failed ? 1 : 0);
