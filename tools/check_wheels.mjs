/**
 * Prove every car's wheels were found, and that they actually turn.
 *
 * A tyre is close to rotationally symmetric, so a spinning one can look
 * perfectly still in a render - and reading an untextured render wrong is what
 * got Chick Hicks shipped facing backwards. So this checks two ways:
 *
 *   numerically  track one marked rim vertex through a quarter turn, report how
 *                far it moved, and confirm every wheel turns the same way in
 *                world space
 *   visually     textured frames of the whole field at four wheel angles
 *
 * It also prints what the detector found - how many wheels, their radius,
 * where they sit - so a car that silently ended up with none is visible rather
 * than merely still. The count is per-model (see EXPECTED): the racers have
 * four, Guido three and Mack ten.
 *
 *   node tools/check_wheels.mjs [carId ...]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(homedir(), 'mcqueen-shots');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8271;

// How many wheels each model should have. Four unless stated: Guido is a
// three-wheeled forklift and Mack a five-axle artic.
const EXPECTED = { guido: 3, mack: 10 };

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
await page.setViewport({ width: 1500, height: 300 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async (only) => {
  const THREE = await import('three');
  const { loadCar, assetUrl } = await import('../src/models.js');
  // Racers by default. Guido and Mack have wheels and are checked here, but
  // an 18 m artic parked in the middle of the contact sheet stands between
  // the camera and everything else - so they are opt-in by name.
  const specs = (await (await fetch(assetUrl('cars.json'))).json()).cars
    .filter((c) => (only.length ? only.includes(c.id) : c.racer !== false));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x93b7d6);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a7c90, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(5, 7, 9);
  scene.add(sun);
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 40),
    new THREE.MeshStandardMaterial({ color: 0x45484d, roughness: 0.97 }));
  road.rotation.x = -Math.PI / 2;
  scene.add(road);

  const cars = [];
  const report = [];
  let x = 0;
  for (const spec of specs) {
    const { object, wheels, size } = await loadCar(spec);
    object.position.set(x + size.x / 2, 0, 0);
    x += size.x + 0.9;
    scene.add(object);
    cars.push({ spec, object, wheels, size });

    const marks = [];
    if (wheels) {
      // A point one radius out from the axle, so a quarter turn swings it by
      // about a radius. It is specified in the *pivot's* metres and converted
      // into whatever units the node happens to live in - McQueen's bones are
      // in model units, 2005 of them to his 4.4 m, and a marker written in
      // those units moves a millimetre and looks like a wheel that never
      // turned.
      for (const w of wheels.wheels) {
        const mesh = w.node.isMesh ? w.node : w.node.children.find((c) => c.isMesh);
        const target = mesh || w.node;
        target.updateWorldMatrix(true, false);
        const inPivot = new THREE.Vector3(w.centre.x, w.centre.y + w.radius * 0.8, w.centre.z);
        const local = target.worldToLocal(object.localToWorld(inPivot.clone()));
        marks.push({ target, local, front: w.front, side: w.centre.x, centre: w.centre.clone() });
      }
    }
    // The shape of what each wheel node is *holding*. A wheel that has quietly
    // adopted a suspension arm or a piece of bodywork shows up here as a wheel
    // that is not the same size as the others, which is the only signal that
    // survives - the count is right, the render looks busy, and the thing
    // turning with it is only obvious once somebody watches it go round.
    const shapes = wheels ? wheels.wheels.map((w) => {
      const b = new THREE.Box3().setFromObject(w.node, true);
      const s2 = new THREE.Vector3();
      b.getSize(s2);
      return [+s2.x.toFixed(3), +s2.y.toFixed(3), +s2.z.toFixed(3)];
    }) : [];
    report.push({ id: spec.id, wheels: wheels ? wheels.describe() : null, marks, object, shapes });
  }

  const at = (car, m) => {
    m.target.updateWorldMatrix(true, false);
    return car.worldToLocal(m.local.clone().applyMatrix4(m.target.matrixWorld));
  };
  const rest = (speed) => ({ speed, steerAngle: 0, steer: 0, accelLat: 0, accelLong: 0 });

  for (const c of cars) c.wheels?.update(rest(0), 0);
  const before = report.map((r) => r.marks.map((m) => at(r.object, m)));
  for (const c of cars) {
    if (!c.wheels) continue;
    const r = Math.min(...c.wheels.wheels.map((w) => w.radius));
    c.wheels.update(rest(r * Math.PI / 2), 1);         // exactly a quarter turn
  }
  const after = report.map((r) => r.marks.map((m) => at(r.object, m)));

  const measured = report.map((r, i) => ({
    id: r.id,
    wheels: r.wheels,
    shapes: r.shapes,
    moved: r.marks.map((m, k) => {
      const a = before[i][k].clone().sub(m.centre);
      const b = after[i][k].clone().sub(m.centre);
      // Signed angle swept about the car's lateral axis. Comparing raw
      // displacement cannot tell direction: each wheel's marked vertex starts
      // at a different point on the rim, so one at the top and one at the
      // bottom move opposite ways while turning together.
      let turn = Math.atan2(b.z, b.y) - Math.atan2(a.z, a.y);
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn < -Math.PI) turn += 2 * Math.PI;
      return {
        front: m.front,
        side: m.side > 0 ? 'L' : 'R',
        dist: +before[i][k].distanceTo(after[i][k]).toFixed(3),
        turn: +(turn * 180 / Math.PI).toFixed(1),
      };
    }),
  }));

  // --- the pictures ------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(1500, 300, false);
  renderer.setPixelRatio(1);
  document.body.appendChild(renderer.domElement);
  // Close, low and from three-quarters: a tyre is nearly symmetric, so
  // head-on it looks identical at every angle. The rim faces are the only
  // part that shows rotation, and they only show it from the side.
  //
  // Stand back in proportion to what is being looked at. The framing was
  // written for a 4.4 m car and put the camera *inside* Mack, who is 18 m
  // long - a full-frame close-up of one tyre proves nothing.
  // Stand back in proportion to the *longest* car in the scene, not the first.
  // Cars are spread along x but extend along z, straight down the camera's
  // line of sight, so one long vehicle anywhere in the row fills the frame -
  // Mack put the lens inside his own front tyre.
  const first = cars[0].object.position.x;
  const zoom = Math.max(1, Math.max(...cars.map((c) => c.size.z)) / 4.6);
  const camera = new THREE.PerspectiveCamera(30, 5, 0.1, 400);
  camera.position.set(first + 4.2 * zoom, 0.85 * zoom, 4.6 * zoom);
  camera.lookAt(first + 0.2 * zoom, 0.42 * zoom, 0.4 * zoom);

  const frames = [];
  for (const turn of [0, 0.08, 0.16, 0.24]) {
    for (const c of cars) {
      if (!c.wheels) continue;
      c.wheels.angle = 0;
      c.wheels.update(rest(c.wheels.wheels[0].radius * Math.PI * 2 * turn), 1);
    }
    renderer.render(scene, camera);
    // From the canvas, never a page screenshot: the page has padding and it
    // has silently shifted every image in this repo before.
    frames.push(renderer.domElement.toDataURL('image/png'));
  }
  return { measured, frames };
}, process.argv.slice(2));

let failed = 0;
for (const car of out.measured) {
  console.log(`\n=== ${car.id}`);
  if (!car.wheels || !car.wheels.length) {
    console.log('  ! no wheels found');
    failed++;
    continue;
  }
  console.log(`  ${car.wheels.length} wheels, found by ${car.wheels[0].kind}`);
  for (const w of car.wheels) {
    console.log(`    ${w.front ? 'front' : 'rear '} r=${w.radius.toFixed(3)} ` +
                `centre=[${w.centre.join(', ')}] axle=[${w.axle.join(', ')}]`);
  }
  // Per-car, because the count is not four everywhere any more: Guido is a
  // three-wheeled forklift and Mack a ten-wheeled artic. Asserting the exact
  // number still matters - "found some wheels" would pass while quietly
  // missing an axle.
  const want = EXPECTED[car.id] ?? 4;
  if (car.wheels.length !== want) {
    console.log(`  ! expected ${want} wheels, found ${car.wheels.length}`);
    failed++;
  }
  // Only the front axle steers. On a car that is half the wheels; on Mack it
  // must be two of ten, or he crab-walks down the pit lane.
  const steering = car.wheels.filter((w) => w.front).length;
  if (steering !== 2) {
    console.log(`  ! ${steering} steered wheel(s) - the front axle should be 2`);
    failed++;
  }

  // Every wheel on a car is the same wheel. Mater's twinned rears are twice as
  // wide as his fronts, so the *width* is allowed to differ - but a wheel is a
  // disc, and its diameter is the same in both directions and the same at both
  // ends of the car. Ivy came back from a fix with her front wheels half a
  // metre taller than her rears: the suspension was turning with them.
  if (car.shapes && car.shapes.length > 1) {
    for (const axis of [1, 2]) {
      const all = car.shapes.map((sh) => sh[axis]).sort((a, b) => a - b);
      const mid = all[all.length >> 1];
      const worst = Math.max(...all.map((v) => Math.abs(v - mid) / mid));
      if (worst > 0.2) {
        console.log(`  ! wheels differ by ${(worst * 100).toFixed(0)}% in ` +
                    `${axis === 1 ? 'height' : 'length'} (${all.join(', ')}) - ` +
                    'one of them is holding something that is not a wheel');
        failed++;
      }
    }
  }

  console.log('  quarter turn: ' +
    car.moved.map((m) => `${m.side}${m.front ? 'F' : 'R'} ${m.dist} m / ${m.turn} deg`).join('  '));
  const still = car.moved.filter((m) => Math.abs(m.turn) < 60);
  if (still.length) {
    console.log(`  ! ${still.length} wheel(s) did not turn a quarter`);
    failed++;
  }
  // Forward roll takes the top of the wheel towards the nose: positive here.
  const back = car.moved.filter((m) => m.turn < 0);
  if (back.length) {
    console.log(`  ! ${back.length} wheel(s) turn backwards - an axle sign is wrong`);
    failed++;
  }
}

out.frames.forEach((data, i) => {
  writeFileSync(join(OUT, `wheels_${i}.png`), Buffer.from(data.split(',')[1], 'base64'));
});
console.log(`\nwrote ${out.frames.length} frames to ${OUT}/wheels_*.png`);

await browser.close();
server.kill();
console.log(failed ? `${failed} problem(s)` : 'all wheels turn');
process.exit(failed ? 1 : 0);
