/**
 * Close-up diagnostics: how each car sits on the road, and which way it faces.
 *
 * Renders a low side-on shot of the player's car on a chosen track, and a
 * textured three-quarter shot of every car - Cars characters have eyes on the
 * windscreen, so a textured render settles which end is the front far more
 * reliably than an untextured silhouette.
 *
 *   node tools/diag_cars.mjs [trackId]
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
const PORT = 8190;
const TRACK = process.argv[2] || 'msots';
// Optional list of car ids for the facing sheet. Eighteen cars in one frame
// are too small to read, and reading one wrong is how a car ships backwards.
const ONLY = process.argv.slice(3);

mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--window-size=1100,620'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 620 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
  { timeout: 300000, polling: 500 });

await page.evaluate(async (t) => { await window.game.loadTrackById(t); }, TRACK);
await page.click('#btn-start');
await page.waitForFunction("window.game.race", { timeout: 180000 });
await sleep(2500);

// --- how far are the wheels off the road? ---------------------------------
console.log(await page.evaluate(async () => {
  const THREE = await import('three');
  const g = window.game;
  const invisible = (o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
  };
  const ray = new THREE.Raycaster();
  ray.far = 400;
  const down = new THREE.Vector3(0, -1, 0);
  const lines = ['car                     pivot   surface   lowestPoint   wheelGap'];
  for (const car of g.race.field) {
    // Lowest vertex of the car, in world space - the tyre contact patch.
    // getVertexPosition applies bone transforms, which raw attribute data does
    // not: McQueen is skinned, and reading the buffer directly reports his
    // bind pose rather than where he is actually drawn.
    let lowest = Infinity;
    const v = new THREE.Vector3();
    car.model.updateMatrixWorld(true);
    car.model.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
        if (v.y < lowest) lowest = v.y;
      }
    });
    const p = car.position;
    ray.set(new THREE.Vector3(p.x, p.y + 60, p.z), down);
    const hits = ray.intersectObject(g.trackScene, true).filter((h) => !invisible(h.object));
    let surf = NaN;
    for (const h of hits) {
      if (Number.isNaN(surf) || Math.abs(h.point.y - p.y) < Math.abs(surf - p.y)) surf = h.point.y;
    }
    lines.push(`${car.spec.id.padEnd(22)} ${p.y.toFixed(2).padStart(6)} ` +
      `${surf.toFixed(2).padStart(9)} ${lowest.toFixed(2).padStart(13)} ` +
      `${(lowest - surf).toFixed(2).padStart(10)}`);
  }
  return lines.join('\n');
}));

// --- low side-on shot of the player -----------------------------------------
await page.evaluate(async () => {
  const THREE = await import('three');
  const g = window.game;
  const car = g.race.player;
  g.frozen = true;
  cancelAnimationFrame(g.raf);
  const st = g.track.sample(car.s, {});
  const up = g.track.normal(st, new THREE.Vector3());

  // A magenta reference strip laid exactly on the track surface under the car.
  // Eyeballing "is it floating" from a screenshot is unreliable; against a
  // known plane it is obvious.
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 3),
    new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide,
                                  transparent: true, opacity: 0.75 }));
  const q = new THREE.Quaternion();
  g.track.orient(st, 0, q);
  strip.quaternion.copy(q);
  strip.rotateX(-Math.PI / 2);
  strip.position.copy(g.track.position(st, car.n, new THREE.Vector3()));
  strip.position.addScaledVector(up, 0.005);
  g.scene.add(strip);

  const side = g.track.position(st, car.n + 7, new THREE.Vector3());
  g.camera.position.copy(side).addScaledVector(up, 0.35);
  g.camera.up.copy(up);
  g.camera.fov = 26;
  g.camera.updateProjectionMatrix();
  g.camera.lookAt(car.position.x, car.position.y + 0.35, car.position.z);
  g.renderer.render(g.scene, g.camera);
});
await sleep(700);
await page.screenshot({ path: join(OUT, `diag_${TRACK}_side.png`) });
console.log(`\nwrote diag_${TRACK}_side.png`);

// --- textured three-quarter view of every car -------------------------------
await page.evaluate(async (only) => {
  const THREE = await import('three');
  const g = window.game;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f28);
  scene.add(new THREE.AmbientLight(0xffffff, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 4);
  scene.add(key);
  // Skinned meshes cannot be lifted into a scratch scene and repositioned -
  // they bind to the world matrix they had at load - so McQueen is checked
  // separately, in place, by the shot below.
  const specs = g.carSpecs.filter((s) => !g.models.get(s.id).object
    .getObjectByProperty('isSkinnedMesh', true))
    .filter((s) => !only.length || only.includes(s.id));
  specs.forEach((spec, i) => {
    const m = g.models.get(spec.id).object;
    m.visible = true;
    // Two rows once the field outgrew one: eighteen cars on a single line
    // put half of them outside the frame, and a picture you cannot see the
    // cars in is exactly how a car shipped facing backwards.
    const per = 3;
    const row = Math.floor(i / per), col = i % per;
    m.position.set((col - (per - 1) / 2) * 6.2, 0, row * -8.5);
    m.quaternion.identity();          // local +Z is "forward" by our convention
    scene.add(m);
  });
  const cam = new THREE.PerspectiveCamera(42, 1100 / 620, 0.1, 400);
  // Look from front-right-above so a car facing +Z shows us its face.
  cam.position.set(1, 7, 17);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0.6, -6);
  g.renderer.render(scene, cam);
  window.__labels = specs.map((s) => s.id).join(' | ');
}, ONLY);
await sleep(700);
await page.evaluate(() => { document.getElementById('hud').classList.add('hidden');
                            document.getElementById('controls').classList.add('hidden'); });
await sleep(200);
await page.screenshot({ path: join(OUT, 'diag_car_facing.png') });
console.log('wrote diag_car_facing.png  (three per row, front row first):');
console.log(' ', await page.evaluate(() => window.__labels));
console.log('  camera is in front; a correctly oriented car shows its face');

// The skinned car, checked where it actually sits on the grid.
await page.evaluate(async () => {
  const THREE = await import('three');
  const g = window.game;
  const car = g.race.field.find((c) => c.model.getObjectByProperty('isSkinnedMesh', true));
  window.__skinned = car ? car.spec.id : null;
  if (!car) return;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.model.quaternion);
  const up = new THREE.Vector3(0, 1, 0);
  g.camera.position.copy(car.position).addScaledVector(fwd, 9).addScaledVector(up, 2.2);
  g.camera.up.copy(up);
  g.camera.fov = 32;
  g.camera.updateProjectionMatrix();
  g.camera.lookAt(car.position.x, car.position.y + 0.7, car.position.z);
  g.renderer.render(g.scene, g.camera);
});
await sleep(600);
await page.screenshot({ path: join(OUT, 'diag_skinned_front.png') });
console.log('wrote diag_skinned_front.png for',
  await page.evaluate(() => window.__skinned), '- looking back down the track at it');

await browser.close();
server.kill();
