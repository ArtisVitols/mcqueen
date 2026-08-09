/**
 * Find each circuit's pit road and write it into the track data as a second
 * ribbon.
 *
 * A pit lane cannot be "more `n`" - see src/pits.js for why - so what this
 * produces is a ribbon of its own: stations, tangents, outward normals,
 * heights and half-widths, plus the two lap positions where it leaves the
 * racing surface and rejoins it.
 *
 * How it finds one, uniformly across three circuits that name nothing the
 * same way: scan inboard from the centreline and classify each sample as road
 * or not-road by material. The first contiguous band is the racing surface.
 * Skip whatever separates them - grass at Yoyleland, a pit wall at Motor
 * Speedway - and the next band wide enough to drive down is the pit road.
 * Where the two bands touch, the pit road is merging into the circuit, and
 * that is the entry and the exit.
 *
 * Every height comes from a downward raycast. Nothing here may take one from
 * `track.position()`: the loaded data is what the game believes, and on Palm
 * Mile it has sat a metre under the road.
 *
 * Not idempotent in spirit - it rewrites the `pit` block from scratch each
 * time, so it is safe to re-run, but run refine_track.mjs first if the
 * corridor has changed.
 *
 *   node tools/extract_pits.mjs [trackId ...]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8178;

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'tracks.json'), 'utf8')).tracks;
const wanted = process.argv.slice(2);
const todo = wanted.length ? manifest.filter((t) => wanted.includes(t.id)) : manifest;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
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
    const { chunkForRays } = await import('./chunk.js');

    const track = await Track.load(assetUrl(trackSpec.data));
    const scene = await loadTrack(trackSpec.model, track.modelScale);
    scene.updateMatrixWorld(true);

    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ys = track.data.y;
    const yLo = Math.min(...ys) - 10;
    const yHi = Math.max(...ys) + 10;
    const picked = [];
    const box = new THREE.Box3();
    scene.traverse((o) => {
      if (!o.isMesh || invisible(o)) return;
      box.setFromObject(o);
      if (box.min.y > yHi || box.max.y < yLo) return;
      picked.push(o);
    });
    const ground = chunkForRays(picked);

    const ray = new THREE.Raycaster();
    ray.far = 500;
    const down = new THREE.Vector3(0, -1, 0);
    const p = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const wa = new THREE.Vector3();
    const wb = new THREE.Vector3();
    const wd = new THREE.Vector3();

    const PIT_MATS = new Set(trackSpec.pitMaterials || []);
    // The racing band deliberately excludes the pit lane's own material.
    // Motor Speedway lists Material.107 as a road material - it is, for most
    // of the lap, as the inner apron - but along the pit straight it is the
    // pit lane, and a racing band that walks through it never finds an edge.
    const ROAD = new Set((trackSpec.roadMaterials || []).filter((m) => !PIT_MATS.has(m)));
    const ANY_ROAD = new Set([...(trackSpec.roadMaterials || []), ...PIT_MATS]);
    /** Topmost-nearest surface at (s, n): height and material. */
    const hitAt = (st, n, expect) => {
      track.position(st, n, p);
      origin.set(p.x, expect + 80, p.z);
      ray.set(origin, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) return null;
      let best = null;
      for (const h of hits) {
        if (best === null || Math.abs(h.point.y - expect) < Math.abs(best.point.y - expect)) best = h;
      }
      if (Math.abs(best.point.y - expect) > 14) return null;
      const m = Array.isArray(best.object.material) ? best.object.material[0] : best.object.material;
      return { y: best.point.y, material: m ? m.name : '' };
    };

    const SCAN = trackSpec.pitScan ?? 120;     // how far inboard to look, metres
    const STEP = 0.5;
    const MIN_PIT = trackSpec.pitMinWidth ?? 6; // narrower than this is a verge
    // Has to exceed the scan step, or it always passes: the racing band ends
    // one sample before the pit band begins, so the raw gap is exactly STEP
    // wherever the two are adjacent - which is every metre of the apron.
    const MIN_GAP = trackSpec.pitMinGap ?? 4.0;
    // Materials that only ever appear behind a pit lane - the boxes.
    const BOX_MATS = new Set(trackSpec.pitBoxMaterials || []);
    // Last resort: take width alone as the test. Only safe because
    // check_pits.mjs then has to agree the result is on road, clear of
    // walls, and joined to the racing line at both ends.
    const BY_WIDTH = trackSpec.pitByWidth === true;
    const N = track.count;

    // --- 1. Per lap station, find the racing band and the next band inboard.
    const bands = [];
    for (let i = 0; i < N; i++) {
      const st = track.sample(i * track.step, {});
      const inner = track.limit(st, -1);        // inside edge of the corridor
      // Walk inboard classifying road / not-road. Heights carry so the ray
      // follows the banking down rather than dropping onto the flat apron.
      let prevY = track.data.y[i];
      const road = [];
      for (let d = 0; d <= SCAN; d += STEP) {
        const n = inner - d;
        const h = hitAt(st, n, prevY);
        const near = h !== null && Math.abs(h.y - prevY) < 1.5;
        const ok = near && ROAD.has(h.material);
        void ANY_ROAD;
        if (near) prevY = h.y;
        road.push({ n, ok, pit: near && PIT_MATS.has(h.material),
                    mat: h ? h.material : null, y: h ? h.y : null });
      }
      // The racing band always starts at road[0] - that is the corridor's own
      // inside edge - and ends at the first sample that is not road.
      let r = 0;
      while (r < road.length && road[r].ok) r++;
      const racingTo = r === 0 ? inner : road[r - 1].n;

      let a, b;
      if (PIT_MATS.size) {
        // A named pit lane, taken only where it is *separated* from the racing
        // surface. This is the trap CLAUDE.md records: Motor Speedway's
        // Material.107 is the pit lane along the front straight and the inner
        // apron everywhere else, in the same material, so asking "where is
        // 107" matches the entire lap and produced a 4.8 km pit road. What
        // makes it a pit lane is the wall - Material.108, which is not a road
        // material and so ends the racing band above. Beyond the racing band
        // it is a pit lane; adjacent to it, it is apron.
        a = road.findIndex((x, k) => k >= r && x.pit);
        if (a < 0) { a = 0; b = -1; } else {
          b = a;
          while (b + 1 < road.length && road[b + 1].pit) b++;
        }
      } else {
        // Unnamed, so it is found by shape: skip the gap after the racing
        // band and take the next band. Yoyleland's is 80 m of grass away.
        let k = r;
        while (k < road.length && !road[k].ok) k++;
        a = k;
        while (k < road.length && road[k].ok) k++;
        b = k - 1;
      }
      const gap = a <= b ? racingTo - road[a].n : Infinity;
      const width = a <= b ? road[a].n - road[b].n : 0;
      // What lies immediately inboard of the band. On Motor Speedway the
      // radial order outward from the infield is Material.100 (pit boxes),
      // 107 (pit lane), 108 (the wall), 105 (the racing surface) - so pit
      // boxes inboard of the band is what tells the pit lane from the apron
      // it shares a material with, and it is the only thing that does: the
      // apron is the same material, level with the road, and runs the whole
      // lap. Width alone finds the back straight too.
      const beyond = b >= 0 && b + 1 < road.length ? road[b + 1] : null;
      const boxed = !BOX_MATS.size
        || (beyond !== null && beyond.mat !== null && BOX_MATS.has(beyond.mat));

      // Is there a *wall* between the racing surface and this band?
      //
      // This is what separates a pit lane from the apron it shares a material
      // with, and it cannot be seen from above: a pit wall is vertical, so a
      // downward raycast passes straight over it and the two surfaces look
      // continuous. Only a ray fired along the road at bumper height finds it
      // - the same test that stops the corridor walk in refine_track.mjs.
      let walled = false;
      if (a <= b && gap < 40) {
        let py = road[Math.max(0, a - 1)].y ?? track.data.y[i];
        for (let n2 = racingTo; n2 > road[a].n - 1e-6; n2 -= 0.25) {
          const c = Math.max(n2 - 0.25, road[a].n);
          const hy = hitAt(st, c, py);
          const cy = hy ? hy.y : py;
          track.position(st, n2, wa); wa.y = py + 0.5;
          track.position(st, c, wb); wb.y = cy + 0.5;
          py = cy;
          wd.copy(wb).sub(wa);
          const span = wd.length();
          if (span < 1e-6) continue;
          ray.set(wa, wd.normalize());
          ray.far = span;
          const blocked = ray.intersectObjects(ground, false).some((x) => x.distance > 0.05);
          ray.far = 500;
          if (blocked) { walled = true; break; }
        }
      }
      bands.push({
        i,
        merged: gap === 0 || (a <= b && gap <= STEP * 1.5),
        racingTo,
        // A real separator, not just the next sample along: that is what
        // tells a pit lane from the apron it shares a material with.
        // Separated either by a wall you can see from the side, or by a
        // stretch of something that is not road at all.
        // Where pit boxes identify the lane, that is the whole test: a pit
        // lane runs *alongside* the racing surface, so there is nothing to
        // find a gap across, and the wall between them is a 0.5 m ray away
        // from a vertical face - too fragile to hang a circuit on. Without
        // boxes to go on, separation is all there is, which is how
        // Yoyleland's 80 m of grass is found.
        hasPit: a <= b && width >= MIN_PIT && boxed
                && (BOX_MATS.size > 0 || BY_WIDTH || walled
                    || (gap >= MIN_GAP && gap < Infinity)),
        walled, boxed,
        // Boxes go against the far side of a named lane, where they are.
        named: PIT_MATS.size > 0,
        pitOut: a <= b ? road[a].n : null,      // outboard edge (nearer the track)
        pitIn: a <= b ? road[b].n : null,       // inboard edge (the pit wall)
        pitY: a <= b ? road[a].y : null,
        gap,
        width,
      });
    }

    // --- 2. The pit stretch is the longest run of stations that have one.
    let best = null, run = null;
    for (let i = 0; i < 2 * N; i++) {
      const bnd = bands[i % N];
      if (bnd.hasPit) {
        if (!run) run = { from: i, to: i };
        else run.to = i;
        if (!best || run.to - run.from > best.to - best.from) best = { ...run };
      } else run = null;
      if (i >= N && (!run || run.from >= N)) break;
    }
    if (!best || best.to - best.from < 10) {
      return { error: 'no pit road found - check pitMaterials / pitScan',
               diag: bands.reduce((acc, x) => {
                 if (x.walled) acc.walled++;
                 if (x.width >= MIN_PIT) acc.wide++;
                 if (x.boxed) acc.boxed++;
                 if (x.hasPit) acc.hasPit++;
                 return acc;
               }, { walled: 0, wide: 0, boxed: 0, hasPit: 0 }) };
    }

    // --- 3. Build the ribbon: taper, core, taper.
    //
    // The tapers are what make entry and exit invisible. Over them the pit
    // ribbon starts life *on the racing surface's inside lane* and sweeps
    // inboard to meet the measured band, so the two ribbons overlap in space
    // wherever a handover is allowed and nothing has to teleport.
    // Smooth the measured band before anything is built from it.
    //
    // `pitOut`/`pitIn` come from a 0.5 m raycast scan and jump station to
    // station; fed straight into a centreline they become 2.2 degrees of yaw
    // wobble per station with peaks over 30, against a ride-quality bar of
    // 0.1 - which is a car that visibly shakes all the way down the pit lane.
    // The circuit's own centreline is low-passed for exactly this reason.
    const smoothBand = (get, set, half, passes) => {
      for (let q = 0; q < passes; q++) {
        const src = bands.map(get);
        for (let i = best.from; i <= best.to; i++) {
          let sum = 0, n2 = 0;
          for (let d2 = -half; d2 <= half; d2++) {
            const v = src[((i + d2) % N + N) % N];
            if (v === null || v === undefined) continue;
            sum += v; n2++;
          }
          if (n2) set(bands[((i % N) + N) % N], sum / n2);
        }
      }
    };
    smoothBand((b) => b.pitOut, (b, v) => { b.pitOut = v; }, 5, 3);
    smoothBand((b) => b.pitIn, (b, v) => { b.pitIn = v; }, 5, 3);
    smoothBand((b) => b.width, (b, v) => { b.width = v; }, 5, 3);

    const TAPER = trackSpec.pitTaper ?? 70;             // metres of lap
    const taperSt = Math.max(4, Math.round(TAPER / track.step));
    const MARGIN = 1.6;                                 // Track.limit's own margin
    const lo = best.from - taperSt;
    const hi = best.to + taperSt;
    const smoothstep = (t) => t * t * (3 - 2 * t);

    const raw = [];
    for (let j = lo; j <= hi; j++) {
      const i = ((j % N) + N) % N;
      const st = track.sample(i * track.step, {});
      const bnd = bands[i];
      const core = bands[Math.min(Math.max(j, best.from), best.to) % N];
      const pitMid = (core.pitOut + core.pitIn) / 2;
      const pitHalf = Math.max(2.0, core.width / 2 - MARGIN);
      // Just inside the racing surface: where a car peels off, and rejoins.
      const lane = track.limit(st, -1) + 1.2;
      let n, half;
      if (j < best.from) {
        const t = smoothstep((j - lo) / taperSt);
        n = lane + (pitMid - lane) * t;
        half = 2.2 + (pitHalf - 2.2) * t;
      } else if (j > best.to) {
        const t = smoothstep((hi - j) / taperSt);
        n = lane + (pitMid - lane) * t;
        half = 2.2 + (pitHalf - 2.2) * t;
      } else {
        n = pitMid;
        half = pitHalf;
      }
      // XZ from the centreline; Y always from a raycast, never from the data.
      track.position(st, n, p);
      const h = hitAt(st, n, bnd.pitY ?? track.data.y[i]);
      // `lapU` is the *unwrapped* lap distance for this station. It has to be
      // monotonic across the resample below, and these pit roads run through
      // the start/finish - a wrapped value jumps a whole lap mid-ribbon.
      raw.push({ x: p.x, z: p.z, y: h ? h.y : track.data.y[i], n, half,
                 lapU: j * track.step, lapS: i * track.step, j });
    }

    // --- 4. Resample to even arc length, and derive tangents and normals.
    let total = 0;
    const cum = [0];
    for (let k = 1; k < raw.length; k++) {
      total += Math.hypot(raw[k].x - raw[k - 1].x, raw[k].z - raw[k - 1].z);
      cum.push(total);
    }
    const STATIONS = Math.max(60, Math.round(total / 2.5));
    const stationStep = total / (STATIONS - 1);
    const out = { x: [], z: [], y: [], tx: [], tz: [], ox: [], oz: [],
                  outW: [], inW: [], bank: [] };
    const at = (dist) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < dist) k++;
      const span = cum[k] - cum[k - 1] || 1;
      const t = (dist - cum[k - 1]) / span;
      const a = raw[k - 1], b = raw[k];
      return {
        x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
        y: a.y + (b.y - a.y) * t, half: a.half + (b.half - a.half) * t,
        lapU: a.lapU + (b.lapU - a.lapU) * t, n: a.n + (b.n - a.n) * t,
      };
    };
    const pts = [];
    for (let k = 0; k < STATIONS; k++) pts.push(at(k * stationStep));

    // Low-pass the ribbon's *lateral offset*, then rebuild the line from it.
    //
    // Not the world positions. A filter on x and z cuts corners, and the only
    // corner here is the entry taper - which is exactly where the ribbon has
    // to stay on the road. Smoothing world space took Palm Mile's taper off
    // the pit lane and through 170 samples of apron and 53 obstructions.
    //
    // The offset is the thing that is actually noisy: it comes from a 0.5 m
    // raycast scan. Rebuilding `x`/`z` from the circuit's own smooth centreline
    // at the smoothed offset cannot leave the line the ribbon is meant to
    // follow, however hard it is filtered.
    //
    // The ends are *not* pinned. They were, and forcing the last station back
    // to its raw offset put a kink in the final segment - 21 degrees of yaw in
    // one station at the pit exit, which is precisely the shake this filter
    // exists to remove. The offset there tracks the corridor's inside edge,
    // which itself varies station to station, so the raw value is not a
    // landmark worth preserving: what matters is that the end still overlaps
    // the racing line, and `check_pits` allows six metres for that against a
    // few centimetres of movement here.
    {
      const smooth1 = (arr, half) => arr.map((_, k) => {
        let sum = 0, n2 = 0;
        for (let d2 = -half; d2 <= half; d2++) {
          const kk = k + d2;
          if (kk < 0 || kk >= arr.length) continue;
          sum += arr[kk]; n2++;
        }
        return sum / n2;
      });
      let v = pts.map((q) => q.n);
      let w = pts.map((q) => q.half);
      for (let q = 0; q < 4; q++) { v = smooth1(v, 4); w = smooth1(w, 4); }
      const stw = {};
      for (let k = 0; k < pts.length; k++) {
        pts[k].n = v[k];
        // The half-width feeds `limit`, so a jittery one is a jittery corridor
        // and the car is clamped in and out of it every few metres.
        pts[k].half = w[k];
        track.sample(pts[k].lapU, stw);
        track.position(stw, pts[k].n, p);
        pts[k].x = p.x;
        pts[k].z = p.z;
      }
    }

    // Headings, smoothed *separately* from the positions.
    //
    // Where a car sits and which way it points are different requirements: the
    // position has to stay on the asphalt, and the heading has to be smooth or
    // the car visibly jolts. Filtering them together forces a compromise that
    // fails both - a filter strong enough to settle the heading pulls the line
    // off the road through the entry taper.
    //
    // So the line is left where it is and the tangent field is low-passed on
    // its own and renormalised. The two disagree by a fraction of a degree,
    // which on a 4.4 m car is invisible; a ten-degree step between stations is
    // not, and that is what this removes.
    const rawT = [];
    for (let k = 0; k < STATIONS; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(STATIONS - 1, k + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const m = Math.hypot(tx, tz) || 1;
      rawT.push([tx / m, tz / m]);
    }
    let smT = rawT;
    for (let q = 0; q < 4; q++) {
      smT = smT.map((_, k) => {
        let sx = 0, sz = 0;
        for (let d2 = -4; d2 <= 4; d2++) {
          const kk = k + d2;
          if (kk < 0 || kk >= smT.length) continue;
          sx += smT[kk][0]; sz += smT[kk][1];
        }
        const m2 = Math.hypot(sx, sz) || 1;
        return [sx / m2, sz / m2];
      });
    }

    for (let k = 0; k < STATIONS; k++) {
      const tx = smT[k][0], tz = smT[k][1];
      // Outward, on the driver's right. With Y up, (t x o).y = tz*ox - tx*oz
      // must be negative for an anticlockwise lap - the same convention the
      // circuit uses, and getting it backwards sends the pit lane the wrong
      // way round. o = (-tz, tx) gives exactly -1.
      out.x.push(+pts[k].x.toFixed(3));
      out.z.push(+pts[k].z.toFixed(3));
      out.y.push(+pts[k].y.toFixed(3));
      out.tx.push(+tx.toFixed(5));
      out.tz.push(+tz.toFixed(5));
      out.ox.push(+(-tz).toFixed(5));
      out.oz.push(+tx.toFixed(5));
      out.outW.push(+pts[k].half.toFixed(2));
      out.inW.push(+pts[k].half.toFixed(2));
      out.bank.push(0);
    }

    // --- 5. Heights and cross-slope, measured on the finished ribbon.
    const surfaceOn = (k, off, expect) => {
      const px = out.x[k] + out.ox[k] * off;
      const pz = out.z[k] + out.oz[k] * off;
      origin.set(px, expect + 80, pz);
      ray.set(origin, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) return null;
      let bestH = null;
      for (const h of hits) {
        if (bestH === null || Math.abs(h.point.y - expect) < Math.abs(bestH - expect)) {
          bestH = h.point.y;
        }
      }
      return Math.abs(bestH - expect) > 6 ? null : bestH;
    };
    for (let k = 0; k < STATIONS; k++) {
      const y0 = surfaceOn(k, 0, out.y[k]);
      if (y0 !== null) out.y[k] = +y0.toFixed(3);
      const w = out.outW[k];
      const a = surfaceOn(k, -w, out.y[k]);
      const b = surfaceOn(k, w, out.y[k]);
      if (a !== null && b !== null && w > 0.1) {
        out.bank[k] = +Math.atan((b - a) / (2 * w)).toFixed(5);
      }
    }
    // The same three-pass smoothing the circuit gets: a raycast of a faceted
    // mesh is noisy, and unfiltered it is knee-high steps at racing speed.
    const smooth = (arr, halfW, passes) => {
      let v = arr;
      for (let q = 0; q < passes; q++) {
        v = v.map((_, k) => {
          let sum = 0, n2 = 0;
          for (let d2 = -halfW; d2 <= halfW; d2++) {
            const kk = k + d2;
            if (kk < 0 || kk >= v.length) continue;
            sum += v[kk]; n2++;
          }
          return sum / n2;
        });
      }
      return v;
    };
    out.y = smooth(out.y, 4, 3).map((v) => +v.toFixed(3));
    out.bank = smooth(out.bank, 4, 3).map((v) => +v.toFixed(5));

    // --- 6. Where it joins the lap, and the boxes.
    const entryS = track.wrap(lo * track.step);
    const exitS = track.wrap(hi * track.step);
    let lapSpan = exitS - entryS;
    if (lapSpan <= 0) lapSpan += track.lapLength;

    // One box per car, evenly spaced down the middle of the pit road, held
    // clear of both tapers so nobody is asked to stop on the way in.
    const boxCount = trackSpec.pitBoxes ?? 7;
    const boxLo = total * 0.30, boxHi = total * 0.80;
    const boxes = [];
    for (let k = 0; k < boxCount; k++) {
      const d = boxLo + ((boxHi - boxLo) * k) / Math.max(1, boxCount - 1);
      const idx = Math.min(STATIONS - 1, Math.round(d / stationStep));
      // Against the wall, on the inboard side, leaving the lane clear to pass.
      boxes.push({ d: +d.toFixed(2), n: +(-Math.max(0, out.inW[idx] - 1.4)).toFixed(2) });
    }

    return {
      bands: null, from: best.from, to: best.to, count: N, step: track.step,
      lapLength: track.lapLength,
      probe: {
        offset: (bands[Math.floor((best.from + best.to) / 2) % N].pitOut
               + bands[Math.floor((best.from + best.to) / 2) % N].pitIn) / 2,
        width: bands[Math.floor((best.from + best.to) / 2) % N].width,
        gap: bands[Math.floor((best.from + best.to) / 2) % N].gap,
        qualified: bands.filter((x) => x.hasPit).length,
      },
      pit: {
        entryS: +entryS.toFixed(3), exitS: +exitS.toFixed(3),
        lapSpan: +lapSpan.toFixed(3),
        length: +total.toFixed(3), stationStep: +stationStep.toFixed(6),
        // 30 m/s - about 110 km/h. Higher than a real pit road, deliberately:
        // these lanes are 500-816 m long and a five-year-old should not spend
        // most of a lap at walking pace. `pitSpeed` in tracks.json overrides
        // it per circuit.
        speedLimit: trackSpec.pitSpeed ?? 30,
        boxes,
        ...out,
      },
    };
  }, spec);

  if (result.error) {
    console.log('  ' + result.error);
    if (result.diag) console.log('  stations: ' + JSON.stringify(result.diag));
    process.exitCode = 1; continue;
  }
  const { from, to, step, lapLength, probe, pit } = result;
  console.log(`  ${probe.qualified} stations qualify as pit lane`);
  console.log(`  band over ${to - from + 1} stations, s = ${(from * step).toFixed(0)} .. ` +
              `${(to * step).toFixed(0)} m (lap ${lapLength.toFixed(0)} m)`);
  console.log(`  at its deepest: n = ${probe.offset.toFixed(1)}, ` +
              `${probe.width.toFixed(1)} m wide, ${probe.gap.toFixed(1)} m off the racing surface`);
  console.log(`  ribbon: ${pit.x.length} stations, ${pit.length.toFixed(0)} m long, ` +
              `entry s=${pit.entryS.toFixed(0)} exit s=${pit.exitS.toFixed(0)} ` +
              `(replaces ${pit.lapSpan.toFixed(0)} m of lap)`);
  console.log(`  half-width ${Math.min(...pit.outW).toFixed(1)}..${Math.max(...pit.outW).toFixed(1)} m, ` +
              `height ${Math.min(...pit.y).toFixed(2)}..${Math.max(...pit.y).toFixed(2)} m, ` +
              `${pit.boxes.length} boxes`);
  // The chord is shorter than the arc it replaces - that is the point of a
  // mapped progress in PitRoad, and worth seeing.
  console.log(`  chord is ${(100 * pit.length / pit.lapSpan - 100).toFixed(1)}% ` +
              `${pit.length < pit.lapSpan ? 'shorter' : 'longer'} than the lap it bypasses`);

  const file = join(ROOT, 'assets', spec.data);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.pit = pit;
  writeFileSync(file, JSON.stringify(data));
  console.log(`  wrote assets/${spec.data}`);
}

await browser.close();
server.kill();
