/**
 * The showroom: does every car appear, turn, zoom, and give the track back?
 *
 * The museum borrows the game's scene, camera, fog and background rather than
 * building its own - McQueen is skinned and cannot be lifted into a scratch
 * scene - so the thing most likely to break is not the museum but the *race
 * after it*. Half of this checks that everything is put back.
 *
 * It also renders each car, because "visible = true" is not the same as
 * "on screen and lit", and the whole feature is a picture.
 *
 *   node tools/check_museum.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// How many cars are on the grid. Read from the data rather than written
// here: the field grew from seven to eighteen in one commit, and a test
// that hardcodes the number fails for a reason that has nothing to do
// with what it is checking.
const FIELD = JSON.parse(readFileSync(join(ROOT, 'assets/cars.json'), 'utf8'))
  .cars.filter((c) => c.racer !== false).length;
const OUT = join(homedir(), 'mcqueen-shots');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8331;

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
await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const fail = (m) => { console.log('  FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });

// What the race looked like before, so it can be compared afterwards.
const before = await page.evaluate(() => ({
  fov: window.game.camera.fov,
  fog: window.game.scene.fog?.far ?? null,
  bg: window.game.scene.background?.getHex?.() ?? null,
  track: window.game.trackScene?.visible,
}));

await page.click('#btn-museum');
await sleep(2500);
const opened = await page.evaluate(() => ({
  shown: !document.getElementById('museum').classList.contains('hidden'),
  trackHidden: window.game.trackScene ? !window.game.trackScene.visible : null,
  car: document.getElementById('mus-title').textContent,
}));
opened.shown && opened.trackHidden
  ? ok(`the showroom opened on ${opened.car}, circuit hidden`)
  : fail(JSON.stringify(opened));

// Every car, and a render of each. A tiny image means an unlit or missing car.
// All nine, not the seven racers: Guido and Mack are cars, and the showroom is
// for looking at cars.
const COUNT = await page.evaluate(() => window.game.carSpecs.length);
const names = [];
for (let i = 0; i < COUNT; i++) {
  const info = await page.evaluate(() => {
    const g = window.game;
    const spec = g.carSpecs[g.museumAt];
    const o = g.models.get(spec.id).object;
    return { name: spec.name, visible: o.visible, dist: +g.museum.dist.toFixed(1),
             maxDist: +g.museum.maxDist.toFixed(1) };
  });
  names.push(info.name);
  if (!info.visible) fail(`${info.name} is not visible on the plinth`);
  // The upper bound is per-car now: Mack is 18 m long and is looked at from
  // four times as far back as a car.
  if (info.dist < 3 || info.dist > info.maxDist) {
    fail(`${info.name} framed at ${info.dist} m (max ${info.maxDist})`);
  }
  await page.screenshot({ path: join(OUT, `museum_${String(i).padStart(2, '0')}.png`) });
  if (i < COUNT - 1) { await page.click('#mus-next'); await sleep(1600); }
}
ok(`all ${names.length} cars shown and framed: ${names.join(', ')}`);

// Wrapping round, both ways.
await page.click('#mus-next'); await sleep(1200);
const wrapped = await page.evaluate(() => document.getElementById('mus-title').textContent);
wrapped === names[0] ? ok('next wraps back to the first car')
                     : fail(`next wrapped to ${wrapped}, expected ${names[0]}`);
await page.click('#mus-prev'); await sleep(1200);
const back = await page.evaluate(() => document.getElementById('mus-title').textContent);
back === names[COUNT - 1] ? ok('prev wraps to the last car') : fail(`prev gave ${back}`);

// Drag must reach the canvas. The caption sits mid-screen and has swallowed
// this before, so aim the drag exactly where the caption is.
const y0 = await page.evaluate(() => +window.game.museum.yaw.toFixed(3));
await page.mouse.move(422, 195);
await page.mouse.down();
for (let i = 0; i < 10; i++) { await page.mouse.move(422 - i * 20, 195); await sleep(30); }
await page.mouse.up();
await sleep(300);
const dragged = await page.evaluate(() => ({
  yaw: +window.game.museum.yaw.toFixed(3), spin: window.game.museum.spin,
}));
!dragged.spin && Math.abs(dragged.yaw - y0) > 0.5
  ? ok(`drag turns the car (yaw ${y0} -> ${dragged.yaw}) and stops the turntable`)
  : fail(`drag did nothing: ${JSON.stringify(dragged)} - something is over the canvas`);

// Pinch, and the limits that stop it turning inside out.
const d0 = await page.evaluate(() => window.game.museum.dist);
await page.evaluate(() => { window.game.museum.pinch(1.5); });
const d1 = await page.evaluate(() => window.game.museum.dist);
await page.evaluate(() => { for (let i = 0; i < 40; i++) window.game.museum.pinch(1.5); });
const dMin = await page.evaluate(() => window.game.museum.dist);
await page.evaluate(() => { for (let i = 0; i < 80; i++) window.game.museum.pinch(0.6); });
const dMax = await page.evaluate(() => window.game.museum.dist);
// The far clamp is per-exhibit - 12 m for a car, four times that for Mack -
// so ask the museum what its own limit is rather than hard-coding one.
const limit = await page.evaluate(() => window.game.museum.maxDist);
d1 < d0 && dMin >= 3 && dMax <= limit + 1e-6
  ? ok(`pinch zooms (${d0.toFixed(1)} -> ${d1.toFixed(1)} m) and clamps to ${dMin}..${dMax} m`)
  : fail(`zoom limits wrong: ${[d0, d1, dMin, dMax].map((v) => v.toFixed(1)).join(' ')}`);

await page.screenshot({ path: join(OUT, 'museum_zoomed.png') });

// ... and hand everything back.
await page.click('#mus-back');
await sleep(2500);
const after = await page.evaluate(() => ({
  menu: !document.getElementById('menu').classList.contains('hidden'),
  fov: window.game.camera.fov,
  fog: window.game.scene.fog?.far ?? null,
  bg: window.game.scene.background?.getHex?.() ?? null,
  track: window.game.trackScene?.visible,
}));
after.menu && after.fov === before.fov && after.fog === before.fog &&
after.bg === before.bg && after.track === before.track
  ? ok('leaving restored the camera, sky, fog and circuit exactly')
  : fail(`state not restored:\n    before ${JSON.stringify(before)}\n    after  ${JSON.stringify(after)}`);

// The real test of that: can you still race?
await page.click('#btn-start');
await page.waitForFunction("window.game.race && window.game.race.state === 'racing'",
  { timeout: 240000 });
await page.evaluate(() => { window.game.input.state.gas = true; });
await sleep(12000);
const racing = await page.evaluate(() => {
  const p = window.game.race.player;
  return { kmh: Math.round(p.speedKmh), cars: window.game.race.field.length,
           fov: window.game.camera.fov };
});
racing.kmh > 30 && racing.cars === FIELD
  ? ok(`racing normally after a museum visit (${racing.kmh} km/h, ${racing.cars} cars)`)
  : fail(JSON.stringify(racing));
await page.screenshot({ path: join(OUT, 'museum_then_race.png') });

await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exitCode = 1;
} else {
  console.log('\nno page errors');
}
