/**
 * Four people in a lobby, in one process.
 *
 * `check_twoplayer.mjs` drives real tabs and takes minutes; this drives the
 * lobby itself over fake links and takes no time at all, so it can be run on
 * every change. What it proves is the part that has no pictures: that two
 * people cannot take the same car, that RACE stays dark until everybody is
 * green, that changing the race under somebody un-readies them, and - the one
 * that matters most - that all four devices build a byte-identical grid from
 * the same start message.
 *
 * That last one is the oldest rule in the netcode. Two machines laying out two
 * different grids are nine metres apart before the lights go out, and with a
 * field that is no longer *every* car it is now the AI list that has to agree
 * as well as the order.
 *
 *   node tools/check_lobby.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

import { Lobby } from '../src/net/lobby.js';
import { FakeLink } from '../src/net/fake.js';
import { MSG, MAX_PLAYERS } from '../src/net.js';
import { Track } from '../src/track.js';
import { Race } from '../src/race.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const CARS = read('assets/cars.json').cars.filter((c) => c.racer !== false);
const CAR_IDS = CARS.map((c) => c.id);
const TRACKS = read('assets/tracks.json').tracks;

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);

/** A guest, holding whatever the host last told it. */
class Guest {
  constructor(link, want) {
    this.link = link;
    this.want = want;
    this.lobby = null;
    this.start = null;
    link.onMessage((msg) => {
      if (msg.t === MSG.LOBBY) this.lobby = msg;
      if (msg.t === MSG.START) this.start = msg;
    });
  }

  pick(car) { this.link.send({ t: MSG.PICK, car }); }
  ready(on = true) { this.link.send({ t: MSG.READY, ready: on }); }
  get car() { return this.lobby?.players.find((p) => p.id === this.id)?.car; }
}

console.log('=== a lobby fills up ===');

const links = [];
const guests = [];
const host = new Lobby({
  room: 3,
  cars: CAR_IDS,
  settings: { track: 'msots', laps: 5, difficulty: 'normal', physics: 'arcade',
              help: 'easy', ai: 14 },
  onChange: (l) => {
    const msg = l.message();
    for (const p of l.players) p.link?.send(msg);
  },
});
host.seatHost('lightning_mcqueen');

// Three guests knock. Each fake link is a two-ended pipe with no latency here -
// check_netplay is where latency is the subject.
const seat = (want) => {
  const pipe = new FakeLink({ latency: 0 });
  links.push(pipe);
  const player = host.add(pipe.a, want);
  if (!player) return null;
  const g = new Guest(pipe.b, want);
  g.id = player.id;
  pipe.a.onMessage((msg) => host.receive(player.id, msg));
  guests.push(g);
  return player;
};

const p2 = seat('chick_hicks');
const p3 = seat('the_king');
const p4 = seat('mater');
// A message and the answer to it are two hops, and a fake link delivers one
// hop per step - so settle rather than step once.
const pump = () => { for (let i = 0; i < 4; i++) for (const l of links) l.step(0.05); };
pump();

host.players.length === MAX_PLAYERS
  ? ok(`four players seated (${host.players.map((p) => p.id).join(', ')})`)
  : fail(`seated ${host.players.length}`);

const fifth = seat('doc_hudson');
fifth === null ? ok('a fifth is turned away - the room holds four')
               : fail('a fifth player got in');

// --- cars are one to a customer ---------------------------------------------
console.log('\n=== two people cannot drive the same car ===');
guests[0].pick('the_king');          // p3 already has it
pump();
const stillKing = host.players.find((p) => p.id === p3.id).car === 'the_king';
const p2Kept = host.players.find((p) => p.id === p2.id).car === 'chick_hicks';
stillKing && p2Kept
  ? ok('the car was refused and both players kept what they had')
  : fail(`clash resolved wrongly: ${host.players.map((p) => `${p.id}=${p.car}`).join(' ')}`);

guests[0].pick('doc_hudson');        // nobody has this one
pump();
host.players.find((p) => p.id === p2.id).car === 'doc_hudson'
  ? ok('a free car is taken straight away')
  : fail('a free car was refused');

const cars = host.players.map((p) => p.car);
new Set(cars).size === cars.length ? ok(`all four cars are different (${cars.join(', ')})`)
                                   : fail(`duplicate cars: ${cars.join(', ')}`);

// --- ready, and only then RACE ----------------------------------------------
console.log('\n=== RACE lights up when everybody is green ===');
host.canStart ? fail('RACE was live before anybody was ready')
              : ok('RACE is dark with nobody ready');
guests[0].ready();
guests[1].ready();
pump();
host.canStart ? fail('RACE went live with two of three ready')
              : ok('RACE is still dark with one player not ready');
guests[2].ready();
pump();
host.canStart ? ok('RACE is live with all three guests green')
              : fail('RACE never went live');

// Changing the race under somebody who has already agreed to it.
host.set('laps', 10);
pump();
!host.canStart && guests.every((g) => g.lobby.players.find((p) => p.id === g.id).ready === false)
  ? ok('changing the laps un-readied everybody, on every screen')
  : fail('a settings change left players ready');
for (const g of guests) g.ready();
pump();

// --- everybody sees the same lobby ------------------------------------------
const mine = JSON.stringify(host.message().players);
guests.every((g) => JSON.stringify(g.lobby.players) === mine)
  ? ok('all four screens show the same players and cars')
  : fail('the lobby differs between screens');
guests.every((g) => g.lobby.room === 3 && g.lobby.settings.laps === 10)
  ? ok('the room number and the host\'s settings reached everybody')
  : fail('settings did not reach the guests');

// --- one grid, four devices -------------------------------------------------
console.log('\n=== the grid ===');
host.set('ai', 6);
for (const g of guests) g.ready();     // ... which un-readied them, as it should
pump();
host.canStart ? ok('six AI chosen, everybody green again')
              : fail('RACE did not come back after the AI count changed');
const start = host.startMessage();
for (const p of host.players) p.link?.send(start);
pump();

start.field.length === host.players.length + 6
  ? ok(`the field is ${start.field.length} cars: four people and six AI`)
  : fail(`the field is ${start.field.length} cars`);
new Set(start.field).size === start.field.length
  ? ok('no car appears twice in the field')
  : fail(`the field repeats a car: ${start.field.join(', ')}`);

const spec = TRACKS.find((t) => t.id === start.track);
const track = new Track(read(`assets/${spec.data}`));
const grids = [];
for (const player of host.players) {
  const msg = player.host ? start : guests.find((g) => g.id === player.id).start;
  const entries = msg.field.map((id) => ({
    spec: CARS.find((c) => c.id === id), object: new THREE.Object3D(),
  }));
  const race = new Race(track, entries, {
    difficulty: msg.difficulty, laps: msg.laps, physics: msg.physics, car: player.car,
  }, spec.gridLanes).build(player.car, msg.humans.map((h) => h.car));
  grids.push({
    id: player.id,
    mine: race.player.spec.id,
    humans: race.humans.map((c) => c.spec.id),
    slots: race.field.map((c) => [c.spec.id, Math.round(c.s), +c.n.toFixed(2)]),
    boxes: race.field.map((c) => race.pits.road.boxFor(c.gridIndex).d),
  });
}
const first = JSON.stringify(grids[0].slots);
grids.every((g) => JSON.stringify(g.slots) === first)
  ? ok(`all ${grids.length} devices laid out an identical grid`)
  : fail(`the grids differ:\n${grids.map((g) => `    ${g.id} ${JSON.stringify(g.slots)}`).join('\n')}`);
new Set(grids.map((g) => g.mine)).size === grids.length
  ? ok(`each device drives its own car (${grids.map((g) => g.mine).join(', ')})`)
  : fail('two devices think they are the same car');
grids.every((g) => g.humans.length === MAX_PLAYERS)
  ? ok('every device knows there are four people on the grid')
  : fail(`human counts: ${grids.map((g) => g.humans.length).join(', ')}`);
// A box each, including the people. Boxes are handed out by grid slot, so this
// is really a check that the slots are unique - but it is the thing the owner
// asked about, so it is worth saying in those words.
const boxes = grids[0].boxes;
new Set(boxes).size === boxes.length
  ? ok(`a pit box each, no sharing (${boxes.length} boxes for ${boxes.length} cars)`)
  : fail('two cars share a pit box');

// --- somebody drops ----------------------------------------------------------
console.log('\n=== somebody puts their phone down ===');
host.remove(p3.id);
pump();
host.players.length === 3 && !host.players.some((p) => p.id === p3.id)
  ? ok('they are gone from the lobby')
  : fail('the lobby still holds them');
guests[0].lobby.players.length === 3
  ? ok('and gone from everybody else\'s screen')
  : fail(`other screens still show ${guests[0].lobby.players.length}`);
host.canStart ? ok('RACE is still live for the three who are left')
              : fail('RACE went dark when a ready player left');

// --- a short field actually races -------------------------------------------
//
// Nothing has raced fewer than seven cars since the grid was widened and the
// pit boxes were laid out, and the host can now ask for two. The grid lanes are
// fitted to the corridor per row, the boxes are handed out by slot, and both
// have only ever been exercised on a full field.
console.log('\n=== a short field ===');
const FLAT = { applyTo(car, dt, ph) {
  car.steerCmd = 0; if (!ph?.assisted) car.steer = 0; car.throttle = 1; car.brake = 0; } };
for (const spec of TRACKS) {
  const short = new Track(read(`assets/${spec.data}`));
  for (const size of [2, 4]) {
    const ids = CAR_IDS.slice(0, size);
    const entries = ids.map((id) => ({
      spec: CARS.find((c) => c.id === id), object: new THREE.Object3D(),
    }));
    const race = new Race(short, entries,
      { difficulty: 'normal', laps: 2, physics: 'arcade', car: ids[0] },
      spec.gridLanes).build(ids[0], [ids[0]]);
    let t = 0;
    let offRoad = 0;
    while (race.state !== 'finished' && t < 400) {
      race.update(1 / 120, FLAT);
      t += 1 / 120;
      for (const c of race.field) {
        const st = c.road.sample(c.s, {});
        if (c.n > c.road.limit(st, 1) + 0.5 || c.n < c.road.limit(st, -1) - 0.5) offRoad++;
      }
    }
    const boxes = race.field.map((c) => race.pits.road.boxFor(c.gridIndex).d);
    race.state === 'finished' && offRoad === 0 && new Set(boxes).size === boxes.length
      ? ok(`${spec.short}: a ${size}-car race finished cleanly, a box each`)
      : fail(`${spec.short}: ${size} cars - finished ${race.state === 'finished'}, ` +
             `${offRoad} off-road samples, ${new Set(boxes).size} boxes for ${size}`);
  }
}

console.log(failed ? `\n${failed} problem(s)` : '\nthe lobby holds four, and they all agree');
process.exit(failed ? 1 : 0);
