/**
 * Re-derive a track's surface by raycasting the shipped model, and write it
 * back into the data file.
 *
 * extract_oval.py gets the racing line's shape right - that comes from an
 * overhead render at good resolution - but its heights come from the same
 * render, whose effective vertical sampling is a pixel wide once a 1:15 model
 * is scaled up. That left the physics surface up to two metres off the road.
 * Raycasting the asset the game actually loads makes the two agree by
 * construction, which is the only way this stays fixed.
 *
 * What it writes is a measured cross-section (`profOffsets` + `profile`), not
 * a single cross-slope. These roads are banked and low-poly, so the surface
 * curves between facets and no plane fits it: forcing one cost 11 cm of
 * typical height error, and narrowing the road to where a plane did fit left
 * it too tight to race on. The profile gets both - 3 mm at full width.
 *
 * Not idempotent: it reads the file it writes, so always run extract_oval.py
 * first or the width capping compounds.
 *
 *   python3 tools/extract_oval.py msots && node tools/refine_track.mjs msots
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
    // Widest half-road we will model. Track.limit() then takes 1.6 m off each
    // side for the car's own width, leaving about 5 m of usable lane either
    // way - enough for the field to race without the corridor spilling onto
    // the apron.
    const MAX_HALF = 6.5;
    // Where the cross-section is sampled, as fractions of the half-width.
    const PROF_FRACTIONS = [-1, -0.5, 0, 0.5, 1];
    const N = track.count;
    // Widths come from extract_oval.py's road mask, only capped here: walking
    // outwards by raycast happily wanders onto the apron, which would let the
    // AI put a wheel somewhere that is not road.
    const out = { y: new Array(N), bank: new Array(N),
                  outW: new Array(N), inW: new Array(N), profile: [] };
    let expect = ys[0];
    let misses = 0;

    for (let i = 0; i < N; i++) {
      const st = track.sample(i * track.step, {});
      const yc = surfaceAt(st, 0, expect);
      if (yc === null) { misses++; out.y[i] = expect; } else { out.y[i] = yc; expect = yc; }

      // Measure the cross-section rather than fitting a plane to it. These
      // roads are banked and low-poly, so the surface curves between facets;
      // forcing one slope through it left cars hovering at the edges however
      // the fit was weighted, and trimming the road back to where a plane did
      // fit just made the circuit too narrow to race on.
      const half = Math.min(MAX_HALF, Math.min(data0.outW[i], data0.inW[i]));
      const offs = PROF_FRACTIONS.map((f) => f * half);
      const rel = [];
      let prev = 0;
      for (const a of offs) {
        const h = surfaceAt(st, a, out.y[i] + prev);
        const r = h === null ? prev : h - out.y[i];
        rel.push(r);
        prev = r;
      }
      out.profile.push({ offs, rel });
      out.outW[i] = Math.min(data0.outW[i], MAX_HALF);
      out.inW[i] = Math.min(data0.inW[i], MAX_HALF);

    }

    // These circuits are modelled low-poly and then scaled up 15-23x, so
    // raycasting them returns a faceted surface: kinks a centimetre high in
    // the model become knee-high steps in the game, and at 50 m/s that is
    // 20 g of vertical jitter - the car visibly shakes. Along-lap elevation
    // change is tiny on every circuit here (well under 2 m a lap), so the
    // high frequencies are all noise and can go. Three passes approximate a
    // Gaussian; curvature falls with the square of the window.
    const smooth = (arr, half, passes = 1) => {
      let a = arr;
      for (let p = 0; p < passes; p++) {
        const b = a.map((_, i) => {
          let sum = 0;
          for (let k = -half; k <= half; k++) sum += a[(i + k + a.length) % a.length];
          return sum / (2 * half + 1);
        });
        a = b;
      }
      return a;
    };
    out.y = smooth(out.y, 6, 3);
    // Smooth each lateral sample along the lap, then rebuild the profile on a
    // fixed set of offsets so the game can interpolate it cheaply.
    const P = PROF_FRACTIONS.length;
    const halfMax = Math.max(...out.outW, ...out.inW);
    const profOffsets = PROF_FRACTIONS.map((f) => +(f * halfMax).toFixed(3));
    const cols = [];
    for (let k = 0; k < P; k++) {
      // Resample each station's measured pair onto the common offsets.
      const col = out.profile.map((pr, i) => {
        const want = profOffsets[k];
        const o = pr.offs;
        let a = 0;
        while (a < P - 2 && want > o[a + 1]) a++;
        const span = o[a + 1] - o[a];
        const t = span > 1e-9 ? (want - o[a]) / span : 0;
        return pr.rel[a] + (pr.rel[a + 1] - pr.rel[a]) * t;
      });
      cols.push(smooth(col, 6, 3));
    }
    const flat = [];
    for (let i = 0; i < N; i++) for (let k = 0; k < P; k++) flat.push(+cols[k][i].toFixed(4));
    out.profOffsets = profOffsets;
    out.flatProfile = flat;
    // Keep `bank` as the mid-road cross-slope, for anything still using it.
    out.bank = out.profile.map((_, i) => {
      const lo = cols[1][i], hi = cols[3][i];
      const span = profOffsets[3] - profOffsets[1];
      return span > 1e-9 ? Math.atan((hi - lo) / span) : 0;
    });
    out.outW = smooth(out.outW, 8, 2);
    out.inW = smooth(out.inW, 8, 2);

    const deg = out.bank.map((b) => b * 180 / Math.PI);
    return {
      misses,
      y: out.y.map((v) => +v.toFixed(3)),
      bank: out.bank.map((v) => +v.toFixed(5)),
      outW: out.outW, inW: out.inW,
      profOffsets: out.profOffsets, profile: out.flatProfile,
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
  data.profOffsets = result.profOffsets;
  data.profile = result.profile;
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
