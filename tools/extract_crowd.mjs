/**
 * Find somewhere to put a crowd, by asking the model where the seats are.
 *
 * The grandstands are geometry the circuit already has; what the game lacks is
 * anybody sitting in them. Guessing at it in track space - "a band so many
 * metres outboard, rising" - is the class of mistake this repo keeps paying
 * for: it puts people in mid-air on one circuit and inside the concrete on
 * another. So this raycasts the shipped model, the same way `refine_track`
 * re-derives the road, and writes the seats it finds into the track data.
 *
 * The trick is the *roof*. Every stand here has one, and a downward ray hits
 * it long before it hits a seat. Starting the ray underneath it does not work
 * either: the roofs are at different heights all the way round, so a ceiling
 * that clears one is inside the next, and the first attempt found seating
 * along a single straight and nowhere else on the whole lap.
 *
 * So the ray is fired from well above everything and **every** hit it makes is
 * collected, not just the first. A grandstand from above is roof, then seats,
 * then the ground; the seats are the lowest upward-facing surface that is
 * still clearly above the road. That is one ray, no per-track tuning, and it
 * cannot be fooled by a low roof.
 *
 * Writes `crowd: {x, y, z}` into assets/track-<id>.json.
 *
 *   node tools/extract_crowd.mjs [trackId ...]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8391;

const STEP = 7;             // metres of lap between columns of seats
// Start well outboard of the wall. The top of a retaining wall is a level
// surface a couple of metres above the road, right beside the circuit, and it
// collected a neat row of people perched over the racing line - which is where
// nobody sits and where a crowd looks most wrong.
const OUT_FROM = 8;
const OUT_TO = 46;          // ... and give up here
const OUT_STEP = 2.0;
const FLOOR = 4.0;          // a seat is at least this far above the road
const CEIL = 24;            // ... and no higher than this above it
const SKY = 90;             // the ray starts here, above every roof
const UP_ENOUGH = 0.55;     // how level a surface has to be to sit on
const KEEP = 0.30;          // thin the result, or the stands are solid people

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const manifest = read('assets/tracks.json').tracks;
const wanted = process.argv.slice(2);
const todo = manifest.filter((t) => (wanted.length ? wanted.includes(t.id) : true));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

for (const spec of todo) {
  // Per-track, because these three stadiums are nothing like each other:
  // Yoyleland's seating is a bare concrete bowl a long way out and well up,
  // and the defaults tuned for Motor Speedway's tiered stand find its
  // retaining wall instead - a neat row of people perched over the racing
  // line, which is the one place nobody sits.
  const K = { STEP, OUT_FROM, OUT_TO, OUT_STEP, FLOOR, CEIL, SKY, UP_ENOUGH, KEEP,
              ...(spec.crowdScan || {}) };
  const found = await page.evaluate(async (trackSpec, K) => {
    const THREE = await import('three');
    const { loadTrack, assetUrl } = await import('../src/models.js');
    const { Track } = await import('../src/track.js');
    const { chunkForRays } = await import('./chunk.js');

    const track = await Track.load(assetUrl(trackSpec.data));
    const scene = await loadTrack(trackSpec.model, track.modelScale, undefined,
      trackSpec.asphalt || []);
    scene.updateMatrixWorld(true);
    // Yoyleland ships an invisible collision shell over the road; every ray
    // here would lock onto it instead of the thing being looked for.
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const visible = [];
    scene.traverse((o) => { if (o.isMesh && !invisible(o)) visible.push(o); });
    // The stands *ring* the stadium, so their bounding boxes reject nothing
    // and every ray would brute-force the lot. Same answers, minutes saved.
    const ground = chunkForRays(visible);

    const ray = new THREE.Raycaster();
    ray.far = K.SKY + 30;
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();
    const st = {};
    const at = new THREE.Vector3();

    // Deterministic thinning, so re-running gives the same crowd.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const out = { x: [], y: [], z: [] };
    for (let s = 0; s < track.lapLength; s += K.STEP) {
      track.sample(s, st);
      const roadY = st.y;
      // Only outboard: the infield of an oval is where the pit lane and the
      // grass are, and a crowd standing on the racing side of the wall is a
      // crowd about to be hit.
      for (let d = K.OUT_FROM; d < K.OUT_TO; d += K.OUT_STEP) {
        const n = track.limit(st, 1) + d;
        track.position(st, n, at);
        from.set(at.x, roadY + K.SKY, at.z);
        ray.set(from, down);
        // Every hit, not the first: from above a stand that is roof, then
        // seats, then ground. The seats are the *lowest* one that is still
        // well above the road.
        const hits = ray.intersectObjects(ground, false);
        // Every qualifying surface, not just one: a stand is *tiered*, and
        // taking a single row per column gave a crowd that was all front row
        // and an empty bowl behind it.
        for (const h2 of hits) {
          const height = h2.point.y - roadY;
          if (height < K.FLOOR || height > K.CEIL) continue;
          // A seat is something you could sit on. A wall, a fence panel and
          // the side of a stand are all vertical, and every one of them would
          // otherwise collect a row of people standing on nothing.
          const up = h2.face
            ? h2.face.normal.clone().applyMatrix3(
              new THREE.Matrix3().getNormalMatrix(h2.object.matrixWorld)).normalize().y
            : 1;
          if (Math.abs(up) < K.UP_ENOUGH) continue;
          if (rnd() > K.KEEP) continue;
          out.x.push(+(h2.point.x + (rnd() - 0.5) * 1.2).toFixed(1));
          out.y.push(+h2.point.y.toFixed(1));
          out.z.push(+(h2.point.z + (rnd() - 0.5) * 1.2).toFixed(1));
        }
      }
    }
    return out;
  }, spec, K);

  const file = join(ROOT, 'assets', spec.data);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.crowd = found;
  writeFileSync(file, JSON.stringify(data));
  const ys = found.y;
  console.log(`${spec.short.padEnd(16)} ${found.x.length} spectators, ` +
    `${ys.length ? `${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)} m` : '-'}` +
    `  -> ${spec.data}`);
}

await browser.close();
server.kill();
