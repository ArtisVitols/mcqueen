/**
 * Three browser tabs, one lobby, one race.
 *
 * `check_lobby.mjs` proves the lobby rules in one process and takes no time;
 * this drives the whole thing the way people do - main menu, MULTIPLAYER,
 * HOST, JOIN, pick a car, READY, RACE, flag - in real pages with the real
 * render loop. It uses the `?net=loopback` transport so it does not depend on
 * somebody else's free broker being up, which means it can run on every
 * change. The broker itself can only be tested on real devices.
 *
 * Three tabs rather than two on purpose: two is the case that used to work by
 * accident, because the old transport hardcoded one host and one guest.
 *
 *   node tools/check_twoplayer.mjs
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
const PORT = 8301;
const AI = 4;                      // a short field, so three tabs can keep up

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

// All tabs share a browser context, which is what makes BroadcastChannel reach
// between them - the same thing that makes it work on one machine.
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
const g1 = await open('guest1');
const g2 = await open('guest2');
const tabs = [host, g1, g2];
ok('three tabs reached the menu');

// Everybody asks for the same car on purpose: the lobby has to hand out three
// different ones without anybody choosing.
for (const p of tabs) {
  await p.evaluate(() => {
    window.game.settings.car = 'lightning_mcqueen';
    // Three WebGL contexts on a software renderer is the heaviest thing this
    // repo asks of SwiftShader. `dt` is clamped to 0.1 s a frame, so a slow
    // frame rate does not just look bad here - it makes race time crawl, and
    // the cars never get off the line inside a sensible wait.
    window.game.settings.quality = 'low';
  });
}

await host.click('#btn-two');
await host.click('#btn-host');
await host.waitForFunction("!document.getElementById('lobby').classList.contains('hidden')",
  { timeout: 120000, polling: 200 });
const room = await host.evaluate(() => window.game.net.lobby.room);
ok(`the host opened room ${room}`);

for (const g of [g1, g2]) {
  await g.click('#btn-two');
  await g.click('#btn-join');
  await g.waitForFunction("document.querySelectorAll('#room-list .room').length > 0",
    { timeout: 120000, polling: 200 });
  await g.click('#room-list .room');
  await g.waitForFunction("!document.getElementById('lobby').classList.contains('hidden')",
    { timeout: 120000, polling: 200 });
}
ok('both guests found the room in the list and joined it');

await host.waitForFunction("window.game.net.lobby.players.length === 3",
  { timeout: 120000, polling: 200 });
const seated = await host.evaluate(() => window.game.net.lobby.players.map((p) => p.car));
new Set(seated).size === 3
  ? ok(`three different cars without anybody picking (${seated.join(', ')})`)
  : fail(`cars clashed: ${seated.join(', ')}`);

// Everybody's screen shows the same three players.
const seenBy = await Promise.all(tabs.map((p) => p.evaluate(() =>
  document.querySelectorAll('#lobby-players li').length)));
seenBy.every((n) => n === 3) ? ok('all three lobbies list three players')
                             : fail(`lobby rows: ${seenBy.join(', ')}`);

// The lobby is the fullest screen in the game - four player rows, a car picker
// and six host controls - and the rule that has been broken twice is that the
// last button must stay on the display. Checked on the host, which is the one
// with everything on it.
for (const [w, h] of [[667, 375], [844, 390], [915, 412]]) {
  await host.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await sleep(400);
  const fit = await host.evaluate(() => {
    const btns = [...document.querySelectorAll('#lobby .menu-buttons button')]
      .filter((b) => !b.classList.contains('hidden'));
    return { bottom: Math.round(btns[btns.length - 1].getBoundingClientRect().bottom),
             h: innerHeight };
  });
  fit.bottom <= fit.h
    ? ok(`the lobby fits at ${w}x${h} (last button ends at ${fit.bottom} of ${fit.h})`)
    : fail(`at ${w}x${h} the last button is at ${fit.bottom}, off a ${fit.h} screen`);
}
await host.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });

// RACE is dark until the guests are green.
let live = await host.evaluate(() => !document.getElementById('btn-race').disabled);
live ? fail('RACE was live before anybody was ready') : ok('RACE is dark');

await g1.click('#btn-ready');
await sleep(600);
live = await host.evaluate(() => !document.getElementById('btn-race').disabled);
live ? fail('RACE went live with one of two guests ready') : ok('RACE is still dark');

await g2.click('#btn-ready');
await host.waitForFunction("!document.getElementById('btn-race').disabled",
  { timeout: 60000, polling: 200 });
ok('RACE lit up when both guests were green');

// A short field, so three software-rendered tabs can actually keep up.
await host.evaluate((ai) => { window.game.net.lobby.set('ai', ai); }, AI);
await sleep(400);
// ... which un-readies everybody, exactly as it should.
for (const g of [g1, g2]) await g.click('#btn-ready');
await host.waitForFunction("!document.getElementById('btn-race').disabled",
  { timeout: 60000, polling: 200 });

await host.click('#btn-race');
const racing = "window.game.race && window.game.race.humans.length === 3";
try {
  for (const p of tabs) await p.waitForFunction(racing, { timeout: 240000, polling: 300 });
} catch (err) {
  console.log('  state at timeout:', JSON.stringify(await Promise.all(tabs.map((p) =>
    p.evaluate(() => ({ role: window.game.net?.role, race: !!window.game.race,
      humans: window.game.race?.humans.length ?? null,
      lobbyHidden: document.getElementById('lobby').classList.contains('hidden') }))))));
  console.log('  errors so far:', JSON.stringify([...new Set(errors)].slice(0, 6)));
  throw err;
}
ok('all three tabs built a race');

// **And the lobby is off the screen on every one of them.**
//
// The host hid it in `hostStartRace`, on its way past; a guest reaches the
// race through `beginJoined` and nothing closed it at all, so it drove the
// whole race with the lobby panel over the top. The state was already being
// collected here - `lobbyHidden`, in the timeout diagnostic below - and never
// asserted, which is the whole reason it shipped.
const panels = await Promise.all(tabs.map((p) => p.evaluate(() => ({
  lobby: document.getElementById('lobby').classList.contains('hidden'),
  two: document.getElementById('two').classList.contains('hidden'),
  menu: document.getElementById('menu').classList.contains('hidden'),
  controls: !document.getElementById('controls').classList.contains('hidden'),
}))));
panels.every((p) => p.lobby && p.two && p.menu && p.controls)
  ? ok('every tab is showing the race, not a menu over it')
  : fail(`a panel is still up: ${JSON.stringify(panels)}`);

const grids = await Promise.all(tabs.map((p) => p.evaluate(() => ({
  role: window.game.net?.role,
  humans: window.game.race.humans.map((c) => c.spec.id),
  order: window.game.race.field.map((c) => c.spec.id),
  slots: window.game.race.field.map((c) => [Math.round(c.s), +c.n.toFixed(2)]),
  boxes: window.game.race.field.map((c) => window.game.race.pits.road.boxFor(c.gridIndex).d),
  mine: window.game.race.player.spec.id,
  laps: window.game.race.totalLaps,
}))));
const [h, a, b] = grids;
grids.every((g) => g.humans.length === 3)
  ? ok(`three humans on the grid (${h.humans.join(' + ')})`)
  : fail(`human counts: ${grids.map((g) => g.humans.length).join(', ')}`);
new Set(grids.map((g) => g.mine)).size === 3
  ? ok(`each drives their own car (${grids.map((g) => g.mine).join(' / ')})`)
  : fail(`two tabs think they are the same car: ${grids.map((g) => g.mine).join(' / ')}`);
JSON.stringify(a.slots) === JSON.stringify(h.slots) &&
JSON.stringify(b.slots) === JSON.stringify(h.slots) &&
JSON.stringify(a.order) === JSON.stringify(h.order)
  ? ok(`all three tabs laid out an identical grid (${h.order.length} cars)`)
  : fail(`the grids differ:\n    host  ${JSON.stringify(h.slots)}\n` +
         `    g1    ${JSON.stringify(a.slots)}\n    g2    ${JSON.stringify(b.slots)}`);
h.order.length === 3 + AI
  ? ok(`the field is the three people plus ${AI} AI`)
  : fail(`the field is ${h.order.length} cars, expected ${3 + AI}`);
new Set(h.boxes).size === h.boxes.length
  ? ok('every car has its own pit box, players included')
  : fail('two cars share a pit box');

// Drive. Both flat out.
for (const p of tabs) await p.evaluate(() => { window.game.input.state.gas = true; });
// Race time advances at most 0.1 s per frame, and three tabs share one
// software renderer - so this is minutes of wall clock for seconds of racing.
await sleep(150000);

const moving = await Promise.all(tabs.map((p) => p.evaluate(() => {
  const r = window.game.race;
  return { state: r.state, kmh: Math.round(r.player.speedKmh), lap: r.player.lap };
})));
moving.every((m) => m.kmh > 30)
  ? ok(`all three cars are moving (${moving.map((m) => m.kmh + ' km/h').join(', ')})`)
  : fail(`not moving: ${JSON.stringify(moving)}`);

// The start gantry has to go out on the guests too. It is driven by the host's
// snapshots, and keying it on the bulb count alone leaves it lit all race.
const lights = await Promise.all(tabs.map((p) => p.evaluate(() =>
  document.getElementById('lights').classList.contains('hidden'))));
lights.every(Boolean) ? ok('the start lights cleared on every tab')
                      : fail(`lights still showing: ${lights.map((l) => !l).join(', ')}`);

// Does every tab agree about where everybody is?
const cross = await Promise.all(tabs.map((p) => p.evaluate(() => {
  const out = {};
  for (const c of window.game.race.field) out[c.spec.id] = Math.round(c.progress);
  return out;
})));
const worst = Math.max(...Object.keys(cross[0]).flatMap((id) =>
  cross.slice(1).map((other) => Math.abs(cross[0][id] - other[id]))));
worst < 40
  ? ok(`every tab agrees where everybody is (worst ${worst} m apart)`)
  : fail(`the tabs disagree by ${worst} m: ${JSON.stringify(cross)}`);

for (const [i, p] of tabs.entries()) {
  await p.screenshot({ path: join(OUT, `three_${i === 0 ? 'host' : `guest${i}`}.png`) });
}

// One of them leaving must not strand the others.
await g2.close();
await sleep(30000);   // comfortably longer than DROP_AFTER, which is 12 s
const after = await host.evaluate(() => ({
  humans: window.game.race.humans.length,
  drivers: window.game.race.drivers.length,
  state: window.game.race.state,
}));
after.humans === 2 && after.drivers === 3 + AI - 2
  ? ok('the guest leaving handed their car to the AI, and the rest raced on')
  : fail(`after a guest left: ${JSON.stringify(after)}`);
const stillGoing = await g1.evaluate(() => !!window.game.race);
stillGoing ? ok('the other guest is still racing')
           : fail('the remaining guest was dropped too');

await browser.close();
server.kill();
if (errors.length) {
  console.log('\nERRORS:');
  for (const e of new Set(errors)) console.log('  !', e);
  process.exitCode = 1;
} else {
  console.log('\nno page errors');
}
