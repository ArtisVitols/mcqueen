/**
 * Is the pit road real, and can a car use it?
 *
 * Two halves, because they fail for different reasons:
 *
 *   geometry  every station of the ribbon sits on a road material, at the
 *             height the data claims, with the corridor clear of walls - and
 *             the entry and exit overlap the racing surface, which is what
 *             makes the handover invisible rather than a teleport
 *   driving   a car peels in, obeys the limit, reaches its box, is serviced,
 *             rejoins, and gains exactly the lap progress it would have had
 *             going the long way round
 *
 * The second half needs no renderer. The first raycasts the shipped asset,
 * because a pit lane drawn down the infield grass would look perfectly
 * correct in every number that did not ask what was underneath it.
 *
 *   node tools/check_pits.mjs [trackId ...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8342;

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const manifest = read('assets/tracks.json').tracks;
const wanted = process.argv.slice(2);
const todo = manifest.filter((t) => (wanted.length ? wanted.includes(t.id) : true));

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);

// ---------------------------------------------------------------- geometry --

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

for (const spec of todo) {
  const data = read(`assets/${spec.data}`);
  console.log(`\n=== ${spec.name} ===`);
  if (!data.pit) { console.log('  no pit road (run tools/extract_pits.mjs)'); continue; }

  const res = await page.evaluate(async (trackSpec) => {
    const THREE = await import('three');
    const { loadTrack, assetUrl } = await import('../src/models.js');
    const { Track } = await import('../src/track.js');
    const { PitRoad } = await import('../src/pits.js');
    const { chunkForRays } = await import('./chunk.js');

    const track = await Track.load(assetUrl(trackSpec.data));
    const pit = new PitRoad(track.data.pit);
    const scene = await loadTrack(trackSpec.model, track.modelScale);
    scene.updateMatrixWorld(true);
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const vis = [];
    scene.traverse((o) => { if (o.isMesh && !invisible(o)) vis.push(o); });
    const ground = chunkForRays(vis);

    const ray = new THREE.Raycaster();
    ray.far = 500;
    const down = new THREE.Vector3(0, -1, 0);
    const p = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const st = {};

    const surfaces = {};
    const offRoad = [];
    const heightErr = [];
    const walls = [];
    const ROAD = new Set([...(trackSpec.roadMaterials || []), ...(trackSpec.pitMaterials || [])]);

    // Walk the ribbon in the lanes a car can actually occupy.
    for (let d = 0; d <= pit.length; d += 3) {
      pit.sample(d, st);
      for (const frac of [-0.75, -0.25, 0.25, 0.75]) {
        const n = frac * pit.limit(st, frac > 0 ? 1 : -1) * (frac > 0 ? 1 : -1) * (frac > 0 ? 1 : -1);
        const lane = frac > 0 ? frac * pit.limit(st, 1) : -frac * pit.limit(st, -1);
        void n;
        pit.position(st, lane, p);
        ray.set(new THREE.Vector3(p.x, p.y + 120, p.z), down);
        const hits = ray.intersectObjects(ground, false);
        if (!hits.length) { offRoad.push({ d: Math.round(d), lane: +lane.toFixed(1), mat: null }); continue; }
        let best = hits[0];
        for (const h of hits) {
          if (Math.abs(h.point.y - p.y) < Math.abs(best.point.y - p.y)) best = h;
        }
        const m = Array.isArray(best.object.material) ? best.object.material[0] : best.object.material;
        const name = m ? m.name : '?';
        surfaces[name] = (surfaces[name] || 0) + 1;
        if (!ROAD.has(name)) offRoad.push({ d: Math.round(d), lane: +lane.toFixed(1), mat: name });
        heightErr.push(p.y - best.point.y);
      }
      // Nothing standing across the pit lane at bumper height.
      const loN = pit.limit(st, -1), hiN = pit.limit(st, 1);
      for (let n2 = loN; n2 < hiN - 1e-6; n2 += 0.5) {
        const c = Math.min(n2 + 0.5, hiN);
        pit.position(st, n2, a); a.y += 0.5;
        pit.position(st, c, b); b.y += 0.5;
        dir.copy(b).sub(a);
        const span = dir.length();
        if (span < 1e-6) continue;
        ray.set(a, dir.normalize());
        ray.far = span;
        if (ray.intersectObjects(ground, false).some((h) => h.distance > 0.05)) {
          walls.push({ d: Math.round(d), n: +n2.toFixed(1) });
          break;
        }
        ray.far = 500;
      }
      ray.far = 500;
    }

    // Entry and exit have to *overlap* the racing surface, or the handover is
    // a teleport. Measure how far the ribbon's ends are from the lane the car
    // leaves and rejoins.
    const gapAt = (d, lapS) => {
      pit.sample(d, st);
      pit.position(st, 0, a);
      const ts = track.sample(lapS, {});
      const lane = track.limit(ts, -1) + 1.2;
      track.position(ts, lane, b);
      return Math.hypot(a.x - b.x, a.z - b.z);
    };
    return {
      surfaces, offRoad: offRoad.slice(0, 8), offCount: offRoad.length,
      walls: walls.slice(0, 8), wallCount: walls.length,
      samples: heightErr.length,
      medianErr: heightErr.map(Math.abs).sort((x, y) => x - y)[Math.floor(heightErr.length / 2)],
      maxErr: Math.max(...heightErr.map(Math.abs)),
      entryGap: gapAt(0, pit.entryS),
      exitGap: gapAt(pit.length, pit.exitS),
      length: pit.length, boxes: pit.boxes.length,
    };
  }, spec);

  console.log(`  surfaces under the pit lanes: ${JSON.stringify(res.surfaces)}`);
  res.offCount === 0
    ? ok(`all ${res.samples} lane samples are on a road material`)
    : fail(`${res.offCount} samples off the road, e.g. ${JSON.stringify(res.offRoad)}`);
  res.wallCount === 0
    ? ok('nothing standing across the pit lane at bumper height')
    : fail(`${res.wallCount} obstructions, e.g. ${JSON.stringify(res.walls)}`);
  res.medianErr < 0.15
    ? ok(`surface matches the ribbon data (median ${(res.medianErr * 1000).toFixed(0)} mm, ` +
         `max ${res.maxErr.toFixed(2)} m)`)
    : fail(`ribbon sits ${res.medianErr.toFixed(2)} m off the road`);
  res.entryGap < 6 && res.exitGap < 6
    ? ok(`entry and exit overlap the racing line (${res.entryGap.toFixed(1)} m, ` +
         `${res.exitGap.toFixed(1)} m) - the handover is inside the road, not a jump`)
    : fail(`entry/exit ${res.entryGap.toFixed(1)} m / ${res.exitGap.toFixed(1)} m from the racing line`);
}

await browser.close();
server.kill();

// ---------------------------------------------------------------- driving --
// No renderer from here on: this is the state machine and the race, and both
// are pure arithmetic.
const THREE = await import('three');
const { Track } = await import('../src/track.js');
const { Race, State } = await import('../src/race.js');
const CARS = read('assets/cars.json').cars.filter((c) => c.racer !== false);

/** Holds the throttle and steers left - which is how you enter a pit lane. */
const AIM_LEFT = {
  applyTo(car, dt, physics) {
    car.steerCmd = -1;
    if (!physics?.assisted) car.steer = -1;
    car.throttle = 1;
    car.brake = 0;
  },
};

console.log('\n=== a stop, end to end ===');
for (const spec of todo) {
  const data = read(`assets/${spec.data}`);
  if (!data.pit) continue;
  const track = new Track(data);
  const entries = CARS.map((c) => ({ spec: c, object: new THREE.Object3D() }));
  const race = new Race(track, entries, { difficulty: 'normal', laps: 12,
    physics: 'arcade', car: 'lightning_mcqueen' }, spec.gridLanes)
    .build('lightning_mcqueen');
  const player = race.player;

  const DT = 1 / 120;
  let t = 0;
  let sawIn = false, sawStopped = false, sawService = false, sawEarly = false;
  let worst = 0, offRoad = 0, maxPitSpeed = 0;
  let lowest = 1;
  const firstBox = Math.min(...data.pit.boxes.map((b) => b.d));
  let progressJump = 0;
  let lastProgress = player.progress;
  while (race.state !== State.FINISHED && t < 1500) {
    race.update(DT, AIM_LEFT);
    t += DT;
    // Measured across the *field*, not the player. The scripted driver here
    // steers hard left all race, so now that a person may pit whenever they
    // like it comes in every lap and its tyres never get low - which would
    // read as 'wear does not work' when it is wear working perfectly and
    // being reset. The AI pits on strategy, so its minimum is the honest
    // measure of whether a set actually runs out.
    for (const c of race.field) if (!c.isPlayer) lowest = Math.min(lowest, c.tyre);
    if (player.pit === 'in') sawIn = true;
    // Coming in on good tyres, because the driver asked to. This is the
    // difference between a pit lane you may use whenever you like and one
    // that unlocks when a number runs out.
    if (player.pit === 'stopped' && player.tyre > 0.5) sawEarly = true;
    if (player.pit === 'stopped') sawStopped = true;
    if (player.pit === 'service') { sawService = true; if (player.speed > 0.01) worst++; }
    // Measured from the approach to the first box onwards. A car arrives at
    // racing speed and brakes - that is what happens in the sport, and where
    // it enters depends on where its tyres gave up, so "anywhere in the lane"
    // measures the entry rather than the limit. Being slowed by the time you
    // reach the boxes is the rule that actually matters.
    if (player.onPit && player.s > firstBox - 40) {
      maxPitSpeed = Math.max(maxPitSpeed, player.speed);
    }
    // Nobody, ever, outside the corridor of whatever road they are on.
    for (const c of race.field) {
      const st = c.road.sample(c.s, {});
      if (c.n > c.road.limit(st, 1) + 0.5 || c.n < c.road.limit(st, -1) - 0.5) offRoad++;
    }
    // Progress must not jump when a car changes ribbon: that is what the
    // mapped progress in PitRoad.lapAt exists to prevent, and a jump is a
    // free place.
    const step = Math.abs(player.progress - lastProgress);
    if (step > 3) progressJump = Math.max(progressJump, step);
    lastProgress = player.progress;
  }

  console.log(`\n  ${spec.short}`);
  race.state === State.FINISHED
    ? ok(`the race finished (${t.toFixed(0)} s, ${player.pitStops} stop(s) for the player)`)
    : fail('the race never finished - somebody is stuck in the pit lane');
  lowest < 0.5 ? ok(`tyres wore down to ${(lowest * 100).toFixed(0)}% before a stop was needed`)
               : fail(`tyres barely wore (lowest ${(lowest * 100).toFixed(0)}%) - no stop is ever needed`);
  sawIn && sawStopped && sawService
    ? ok('drove in, stopped in the box, and was serviced')
    : fail(`never completed a stop (in ${sawIn}, stopped ${sawStopped}, service ${sawService})`);
  sawEarly
    ? ok('came in on good tyres - the pits are open whenever you ask')
    : fail('only ever pitted on worn tyres - the entry is gated on wear');
  worst === 0 ? ok('the car was frozen for the whole stop')
              : fail(`the car moved on ${worst} steps while being serviced`);
  maxPitSpeed <= data.pit.speedLimit + 1.5
    ? ok(`under the limit at the boxes (${(maxPitSpeed * 3.6).toFixed(0)} km/h of ` +
         `${(data.pit.speedLimit * 3.6).toFixed(0)})`)
    : fail(`did ${(maxPitSpeed * 3.6).toFixed(0)} km/h at the pit boxes`);
  offRoad === 0 ? ok('no car was ever outside its corridor')
                : fail(`${offRoad} samples outside the corridor`);
  progressJump === 0
    ? ok('progress never jumped at a handover - the pit lane is not a shortcut')
    : fail(`progress jumped ${progressJump.toFixed(1)} m changing ribbon`);
  const stops = race.field.filter((c) => c.pitStops > 0).length;
  stops >= 2 ? ok(`${stops} of ${race.field.length} cars stopped - the AI pits too`)
             : fail(`only ${stops} car(s) stopped; rivals are not pitting`);
}

console.log(failed ? `\n${failed} problem(s)` : '\nthe pit roads are real, clear and driveable');
process.exit(failed ? 1 : 0);
