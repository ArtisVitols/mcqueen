/**
 * Two browser tabs, one race.
 *
 * check_netplay.mjs proves the protocol in isolation; this drives the whole
 * thing the way a person does - main menu, 2 PLAYERS, host, join, lights,
 * flag - in two real pages with the real render loop. It uses the
 * `?net=loopback` transport so it does not depend on somebody else's free
 * broker being up, which means it can run on every change. The broker itself
 * can only be tested on two real devices.
 *
 *   node tools/check_twoplayer.mjs
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
const PORT = 8301;

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

const fail = (m) => { console.log('  FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok:', m);
const errors = [];

// Both tabs share a browser context, which is what makes BroadcastChannel
// reach between them - the same thing that makes it work on one machine.
const open = async (label) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?net=loopback`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
    { timeout: 300000, polling: 500 });
  return page;
};

const host = await open('host');
const guest = await open('guest');
ok('both tabs reached the menu');

// The guest must not be driving the same car as the host.
await guest.evaluate(() => {
  window.game.settings.car = 'lightning_mcqueen';   // deliberately the same
  window.game.settings.help = 'easy';
});
await host.evaluate(() => {
  window.game.settings.car = 'lightning_mcqueen';
  window.game.settings.laps = 1;
  window.game.settings.difficulty = 'normal';
});

await host.click('#btn-two');
await host.click('#btn-host');
await host.waitForFunction("document.getElementById('room-code').textContent !== '----'",
  { timeout: 60000, polling: 200 });
const code = await host.evaluate(() => document.getElementById('room-code').textContent);
ok(`host is showing a room code (${code})`);

await guest.click('#btn-two');
await guest.click('#btn-join');
await guest.evaluate((c) => { document.getElementById('join-code').value = c; }, code);
await guest.click('#btn-connect');

// Wait for the race to be *seated*, not merely to exist. `window.game.race`
// is set the moment the grid is built, and on the host the second human is
// added when the start message is acknowledged - a hair later. Reading between
// the two saw one human on one tab and two on the other, which looks exactly
// like the grid bug this file exists to catch.
const seated = "window.game.race && window.game.race.humans.length === 2";
await host.waitForFunction(seated, { timeout: 240000, polling: 300 });
await guest.waitForFunction(seated, { timeout: 240000, polling: 300 });
ok('both tabs built a race');

const grids = await Promise.all([host, guest].map((p) => p.evaluate(() => ({
  role: window.game.net?.role,
  humans: window.game.race.humans.map((c) => c.spec.id),
  order: window.game.race.field.map((c) => c.spec.id),
  slots: window.game.race.field.map((c) => [Math.round(c.s), +c.n.toFixed(2)]),
  mine: window.game.race.player.spec.id,
  laps: window.game.race.totalLaps,
}))));
const [h, g] = grids;
h.humans.length === 2 && g.humans.length === 2
  ? ok(`two humans on the grid (${h.humans.join(' + ')})`)
  : fail(`wrong human count: ${JSON.stringify([h.humans, g.humans])}`);
h.mine !== g.mine ? ok(`each drives their own car (${h.mine} / ${g.mine})`)
                  : fail(`both tabs think they are ${h.mine}`);
JSON.stringify(h.order) === JSON.stringify(g.order) &&
JSON.stringify(h.slots) === JSON.stringify(g.slots)
  ? ok('both tabs laid out an identical grid')
  : fail(`the grids differ:\n    host  ${JSON.stringify(h.slots)}\n    guest ${JSON.stringify(g.slots)}`);
h.laps === 1 && g.laps === 1 ? ok("the host's lap count won") : fail(`laps ${h.laps}/${g.laps}`);

// Drive. One lap, both flat out.
for (const p of [host, guest]) await p.evaluate(() => { window.game.input.state.gas = true; });
await sleep(60000);   // SwiftShader runs at single-digit fps; be generous

const moving = await Promise.all([host, guest].map((p) => p.evaluate(() => {
  const r = window.game.race;
  const me = r.player;
  return { state: r.state, kmh: Math.round(me.speedKmh), s: Math.round(me.s), lap: me.lap };
})));
moving.every((m) => m.kmh > 30)
  ? ok(`both cars are moving (${moving.map((m) => m.kmh + ' km/h').join(', ')})`)
  : fail(`not moving: ${JSON.stringify(moving)}`);

// The start gantry has to go out on the guest too. It is driven by the host's
// snapshots, and keying it on the bulb count alone leaves it lit all race.
const lights = await Promise.all([host, guest].map((p) => p.evaluate(() =>
  document.getElementById('lights').classList.contains('hidden'))));
lights.every(Boolean) ? ok('the start lights cleared on both tabs')
                      : fail(`lights still showing: host=${!lights[0]} guest=${!lights[1]}`);

// Does each tab agree about where the *other* car is?
const cross = await Promise.all([host, guest].map((p) => p.evaluate(() => {
  const r = window.game.race;
  const out = {};
  for (const c of r.field) out[c.spec.id] = Math.round(c.progress);
  return out;
})));
const drift = Object.keys(cross[0])
  .map((id) => Math.abs(cross[0][id] - cross[1][id]));
const worst = Math.max(...drift);
worst < 40
  ? ok(`both tabs agree where everybody is (worst ${worst} m apart)`)
  : fail(`the tabs disagree by ${worst} m: ${JSON.stringify(cross)}`);

await host.screenshot({ path: join(OUT, 'two_host.png') });
await guest.screenshot({ path: join(OUT, 'two_guest.png') });

// The guest leaving must not strand the host.
await guest.close();
await sleep(30000);   // comfortably longer than DROP_AFTER, which is 12 s
const after = await host.evaluate(() => ({
  humans: window.game.race.humans.length,
  drivers: window.game.race.drivers.length,
  state: window.game.race.state,
}));
after.drivers === FIELD - 1 && after.humans === 1
  ? ok('the guest leaving handed their car to the AI')
  : fail(`after the guest left: ${JSON.stringify(after)}`);

await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exitCode = 1;
} else {
  console.log('\nno page errors');
}
