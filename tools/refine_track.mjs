/**
 * Re-derive a track's heights, widths and banking by raycasting the shipped
 * model, and write them back into its data file.
 *
 * extract_oval.py gets the racing line's shape right - that comes from an
 * overhead render at good resolution - but its heights come from the same
 * render, whose effective vertical sampling is a pixel wide once a 1:15 model
 * is scaled up. That was leaving the physics surface up to two metres off the
 * rendered road.
 *
 * Raycasting the asset the game actually loads makes the two agree by
 * construction, which is the only way this stays fixed.
 *
 *   node tools/refine_track.mjs msots palm
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8177;

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'tracks.json'), 'utf8')).tracks;
const wanted = process.argv.slice(2);
const todo = wanted.length ? manifest.filter((t) => wanted.includes(t.id)) : manifest;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => { console.log('pageerror:', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

for (const spec of todo) {
  console.log(`\n=== ${spec.name} ===`);
  const result = await page.evaluate(async (trackSpec) => {
    const THREE = await import('three');
    const { loadTrack, assetUrl } = await import('../src/models.js');
    const { Track } = await import('../src/track.js');

    const track = await Track.load(assetUrl(trackSpec.data));
    const data0 = track.data;      // banking seed from the overhead extraction
    const scene = await loadTrack(trackSpec.model, track.modelScale);
    scene.updateMatrixWorld(true);

    // Raycast only against meshes that could be road. Dropping the grandstands
    // and roofs cuts the triangle count by an order of magnitude, and stops
    // overhead structures shadowing the surface below.
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ys = track.data.y;
    const yLo = Math.min(...ys) - 8;
    const yHi = Math.max(...ys) + 8;
    // Keep the originals - re-parenting clones would drop the scene's scale.
    const ground = [];
    const box = new THREE.Box3();
    scene.traverse((o) => {
      if (!o.isMesh || invisible(o)) return;
      box.setFromObject(o);
      if (box.min.y > yHi || box.max.y < yLo) return;
      ground.push(o);
    });

    const ray = new THREE.Raycaster();
    ray.far = 400;
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const p = new THREE.Vector3();

    /** Surface height at (s, n), picking the hit nearest `expect`. */
    const surfaceAt = (st, n, expect) => {
      track.position(st, n, p);
      origin.set(p.x, expect + 60, p.z);
      ray.set(origin, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) return null;
      let best = null;
      for (const h of hits) {
        const d = Math.abs(h.point.y - expect);
        if (best === null || d < Math.abs(best - expect)) best = h.point.y;
      }
      return Math.abs(best - expect) > 12 ? null : best;
    };

    if (!ground.length) throw new Error('no ground meshes in the height band');
    // Beyond this the real cross-section curves away from any single plane,
    // so the racing surface is trimmed to where the model is honest.
    const MAX_HALF = 6.5;
    const MIN_HALF = 2.6;      // narrow enough to pinch at a pit entry, wide enough to race
    const PLANE_TOL = 0.30;    // metres the mesh may stray from the fitted plane
    const N = track.count;
    // Widths stay as extract_oval.py measured them off the road mask: walking
    // outwards by raycast happily wanders onto the apron, which then lets the
    // AI put a wheel somewhere that is not road.
    const out = { y: new Array(N), bank: new Array(N),
                  outW: new Array(N), inW: new Array(N) };
    let expect = ys[0];
    let misses = 0;

    for (let i = 0; i < N; i++) {
      const st = track.sample(i * track.step, {});
      const yc = surfaceAt(st, 0, expect);
      if (yc === null) { misses++; out.y[i] = expect; } else { out.y[i] = yc; expect = yc; }

      // Least-squares plane fit across the lanes cars actually use. Two
      // probes either side of the centreline would nail the middle and let
      // the error pile up at the edges, which is where the AI runs; fitting
      // over the whole width spreads it instead. Iterated, because each probe
      // has to look for the road at the height the current fit predicts.
      const half = Math.min(MAX_HALF, Math.min(data0.outW[i], data0.inW[i]));
      const arms = [-half, -half / 2, half / 2, half];
      let slope = Math.tan(data0.bank[i] || 0);
      let base = out.y[i];
      for (let pass = 0; pass < 3; pass++) {
        const pts = [[0, out.y[i]]];
        for (const a of arms) {
          const h = surfaceAt(st, a, base + slope * a);
          if (h !== null && Math.abs(h - (base + slope * a)) < 1.5) pts.push([a, h]);
        }
        if (pts.length < 3) break;
        const n0 = pts.length;
        const sx = pts.reduce((t, q) => t + q[0], 0);
        const sy = pts.reduce((t, q) => t + q[1], 0);
        const sxx = pts.reduce((t, q) => t + q[0] * q[0], 0);
        const sxy = pts.reduce((t, q) => t + q[0] * q[1], 0);
        const den = n0 * sxx - sx * sx;
        if (Math.abs(den) < 1e-9) break;
        const b = (n0 * sxy - sx * sy) / den;
        if (Math.abs(b) > 0.6) break;         // >31 deg is not a racing surface
        slope = b;
        base = (sy - b * sx) / n0;
      }
      out.y[i] = base;
      out.bank[i] = Math.atan(slope);

      // Width is defined as the span over which the fitted plane actually
      // matches the mesh. Anywhere the real cross-section curves away - pit
      // entries, apron transitions - the racing surface simply narrows, which
      // is honest and keeps cars from floating over the gap.
      const reach = (sign) => {
        let last = MIN_HALF;
        for (let d = MIN_HALF; d <= MAX_HALF; d += 0.25) {
          const want = base + slope * sign * d;
          const h = surfaceAt(st, sign * d, want);
          if (h === null || Math.abs(h - want) > PLANE_TOL) break;
          last = d;
        }
        return last;
      };
      out.outW[i] = Math.min(data0.outW[i], reach(1));
      out.inW[i] = Math.min(data0.inW[i], reach(-1));

    }

    // Light periodic smoothing so nothing jitters under the camera.
    const smooth = (arr, half) => arr.map((_, i) => {
      let sum = 0;
      for (let k = -half; k <= half; k++) sum += arr[(i + k + arr.length) % arr.length];
      return sum / (2 * half + 1);
    });
    out.y = smooth(out.y, 1);
    out.bank = smooth(out.bank, 5);
    out.outW = smooth(out.outW, 6);
    out.inW = smooth(out.inW, 6);

    const deg = out.bank.map((b) => b * 180 / Math.PI);
    return {
      misses,
      y: out.y.map((v) => +v.toFixed(3)),
      bank: out.bank.map((v) => +v.toFixed(5)),
      outW: out.outW, inW: out.inW,
      summary: {
        yMin: Math.min(...out.y), yMax: Math.max(...out.y),
        bankMin: Math.min(...deg), bankMax: Math.max(...deg),
      },
    };
  }, spec);

  const file = join(ROOT, 'assets', spec.data);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const before = { yMin: Math.min(...data.y), yMax: Math.max(...data.y) };
  data.y = result.y;
  data.bank = result.bank;
  data.outW = result.outW;
  data.inW = result.inW;
  writeFileSync(file, JSON.stringify(data));

  const s = result.summary;
  console.log(`  stations with no surface found: ${result.misses} / ${data.stationCount}`);
  console.log(`  height  ${before.yMin.toFixed(2)}..${before.yMax.toFixed(2)} m  ->  ` +
              `${s.yMin.toFixed(2)}..${s.yMax.toFixed(2)} m`);
  console.log(`  bank    ${s.bankMin.toFixed(1)}..${s.bankMax.toFixed(1)} deg`);
  const w = data.outW.map((v, i) => v + data.inW[i]);
  console.log(`  width   ${Math.min(...w).toFixed(1)}..${Math.max(...w).toFixed(1)} m (from extraction)`);
  console.log(`  rewrote assets/${spec.data}`);
}

await browser.close();
server.kill();
