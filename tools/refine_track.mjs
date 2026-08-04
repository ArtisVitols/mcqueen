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
    const picked = [];
    const box = new THREE.Box3();
    scene.traverse((o) => {
      if (!o.isMesh || invisible(o)) return;
      box.setFromObject(o);
      if (box.min.y > yHi || box.max.y < yLo) return;
      picked.push(o);
    });
    // Yoyleland's fence, grandstands and concrete each ring the whole circuit,
    // so their bounding boxes reject nothing and every one of the ~400,000
    // rays below scans all 400k triangles. Chunking them into a grid of tight
    // boxes is the difference between a minute and most of a day.
    const ground = chunkForRays(picked);

    const ray = new THREE.Raycaster();
    ray.far = 400;
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const p = new THREE.Vector3();
    const a = new THREE.Vector3();
    const bpt = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const nrm = new THREE.Vector3();

    /**
     * The surface at (s, n): the hit nearest `expect`, with the material that
     * was hit. The material is what lets the edge walk tell asphalt from the
     * grass beside it - see `edge()`.
     */
    const hitAt = (st, n, expect) => {
      track.position(st, n, p);
      origin.set(p.x, expect + 60, p.z);
      ray.set(origin, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) return null;
      let best = null;
      for (const h of hits) {
        const d = Math.abs(h.point.y - expect);
        if (best === null || d < Math.abs(best.point.y - expect)) best = h;
      }
      if (Math.abs(best.point.y - expect) > 12) return null;
      const m = Array.isArray(best.object.material) ? best.object.material[0]
                                                    : best.object.material;
      return { y: best.point.y, material: m ? m.name : '' };
    };

    /** Surface height at (s, n), picking the hit nearest `expect`. */
    const surfaceAt = (st, n, expect) => {
      const h = hitAt(st, n, expect);
      return h === null ? null : h.y;
    };

    if (!ground.length) throw new Error('no ground meshes in the height band');
    // Widest half-road we will model. Track.limit() then takes 1.6 m off each
    // side for the car's own width, leaving about 5 m of usable lane either
    // way - enough for the field to race without the corridor spilling onto
    // the apron.
    // Per-track, because it is not one number: the two short circuits are
    // modelled at 1:15 with an 18 m road, while Yoyleland is a genuinely wide
    // superspeedway whose inside apron is racing surface. Capping it at the
    // short-track figure is what used to trim its road wrongly, and is why it
    // came through the other extraction route in the first place.
    const MAX_HALF = trackSpec.maxHalf ?? 6.5;
    const MIN_HALF = 1.8;       // never collapse the corridor entirely
    // `widen` turns on both of the changes Yoyleland needs, and turns them on
    // *only* for the track that asked. Motor Speedway and Palm Mile verify
    // clean today off widths that extract_oval's road mask produced; re-deriving
    // a working circuit is how regressions ship here, and a trial run bore that
    // out - the material stop alone took Palm's narrowest point from 12.0 m to
    // 8.05 m, because its pit lane is deliberately *not* in roadMaterials and
    // the corridor legitimately runs up to it.
    const widen = trackSpec.widen === true;
    // Anything not on this list ends the road. Without it the walk strolls
    // across grass that happens to sit level with the asphalt, which is exactly
    // what borders Yoyleland's inside line.
    const ROAD = new Set(widen ? (trackSpec.roadMaterials || []) : []);
    const STEP_TOL = 0.20;      // metres of height change allowed per 0.25 m step
    const BUMPER = 0.5;         // height the sideways barrier ray is fired at
    // Where the cross-section is sampled, as fractions of the half-width.
    // How many heights are measured across the road, as fractions of the
    // half-width. Per-track, because the interpolation between them has to
    // stay inside the bumper clearance of the *real* surface: five samples is
    // 4.5 m apart on a 1:15 circuit and fine, but 5 m apart across Yoyleland's
    // 22 m of 18-degree banking, where the chord cuts far enough below a
    // faceted deck that the final sweep read the road itself as a wall at 237
    // stations and pinched a third of the lap to the minimum width.
    const PROF_N = trackSpec.profileSamples ?? 5;
    const PROF_FRACTIONS = Array.from({ length: PROF_N },
      (_, i) => -1 + (2 * i) / (PROF_N - 1));
    const N = track.count;
    // Widths come from extract_oval.py's road mask, only capped here: walking
    // outwards by raycast happily wanders onto the apron, which would let the
    // AI put a wheel somewhere that is not road.
    const out = { y: new Array(N), bank: new Array(N),
                  outW: new Array(N), inW: new Array(N), profile: [] };
    const rawOut = new Array(N);
    const rawIn = new Array(N);
    let expect = ys[0];
    let misses = 0;

    for (let i = 0; i < N; i++) {
      const st = track.sample(i * track.step, {});
      // Seed the guess from the stored height for *this* station, not from the
      // previous station's answer. A running value is only as good as its worst
      // sample: one ray that slips onto the flat apron under Yoyleland's
      // banking hands 0.01 m to the next station as its prior, and the whole
      // rest of the lap follows it off the road. The stored heights are a
      // coarse prior - that is what this script exists to replace - but a
      // coarse prior per station beats a precise one that can be poisoned.
      const yc = surfaceAt(st, 0, data0.y[i]) ?? surfaceAt(st, 0, expect);
      if (yc === null) { misses++; out.y[i] = data0.y[i]; } else { out.y[i] = yc; expect = yc; }

      // Walk out to the real edge of the road: stop at a step down, at a hole,
      // or at anything standing in the way. The road mask alone is too
      // generous - it ran Palm Mile's corridor to the lip of a 0.7 m drop the
      // bodywork then hung over, and put Motor Speedway's outside lane through
      // the pit wall.
      const edge = (sign) => {
        let last = 1.0;
        let prevY = out.y[i];
        let duff = 0;
        for (let d = 0.5; d <= MAX_HALF; d += 0.25) {
          const s = hitAt(st, sign * d, prevY);
          const bad = s === null                          // no surface at all
            || Math.abs(s.y - prevY) > STEP_TOL           // a step or a drop
            || (ROAD.size && !ROAD.has(s.material));      // or simply not road
          if (bad) {
            // One duff sample is a seam, not an edge. These circuits are built
            // from separate meshes for the asphalt and its painted lines, and
            // a ray dropped exactly on a join slips between them and lands on
            // the flat apron a metre below. Read as a step, that stopped the
            // walk two metres from the centreline at a third of Yoyleland's
            // stations. A real edge is still an edge two samples later; the
            // most this can skip over is half a metre.
            if (++duff <= 2) continue;
            break;
          }
          duff = 0;
          const h = s.y;
          // Anything standing between the last sample and this one, at bumper
          // height, is a wall. The ray follows the surface so it does not
          // simply hit the banking climbing away from it.
          //
          // Height comes from the raycast, never from track.position(): the
          // loaded data still holds the overhead extraction's surface, which
          // on Palm Mile sits up to a metre under the road. Fired off that,
          // the ray runs *inside* the asphalt and reports the start straight
          // as walled off, which collapsed its corridor to the minimum.
          track.position(st, sign * (d - 0.25), a);
          a.y = prevY + BUMPER;
          track.position(st, sign * d, bpt);
          bpt.y = h + BUMPER;
          dir.copy(bpt).sub(a);
          const span = dir.length();
          if (span > 1e-6) {
            ray.set(a, dir.normalize());
            ray.far = span;
            const blocked = ray.intersectObjects(ground, false)
              .some((x) => x.distance > 0.05);
            ray.far = 400;
            if (blocked) break;
          }
          last = d;
          prevY = h;
        }
        return Math.max(MIN_HALF, last);
      };
      // Two directions, and the stored widths always win one of them.
      //
      // Normally the walk may only *narrow*: the stored widths came from
      // extract_oval's road mask, which is trustworthy, and a raycast walk
      // left to itself wanders onto the apron.
      //
      // `widen` lets it only *widen*, and is for Yoyleland, whose widths came
      // from the overhead extraction and are several metres tighter than the
      // asphalt at some stations. It is one-way for the same reason the other
      // is: this mesh is a fan build whose asphalt, painted lines and finish
      // line are separate meshes with hairline seams between them, and a walk
      // that believes every sample gets truncated at a seam. Letting it cut
      // pinched 169 stations below 12 m on a road that is uniformly 16 to 22.
      // So the committed corridor is the floor, and all this can do is find
      // the road either side of it that nobody was using.
      out.outW[i] = widen ? Math.max(data0.outW[i], edge(1))
                          : Math.min(data0.outW[i], edge(1));
      out.inW[i] = widen ? Math.max(data0.inW[i], edge(-1))
                         : Math.min(data0.inW[i], edge(-1));
      rawOut[i] = out.outW[i];
      rawIn[i] = out.inW[i];

      // Measure the cross-section rather than fitting a plane to it. These
      // roads are banked and low-poly, so the surface curves between facets;
      // forcing one slope through it left cars hovering at the edges however
      // the fit was weighted, and trimming the road back to where a plane did
      // fit just made the circuit too narrow to race on.
      //
      // Walk outward from the centreline in both directions, carrying the last
      // height as the guess for the next - the same walk `edge()` does, and
      // for the same reason. Starting at one edge with the *centreline's*
      // height as the guess is fatal on a steeply banked road: at Yoyleland's
      // 18 degrees the deck at the inside edge is 2.5 m below the centre, so
      // the flat apron underneath it is nearer to the guess and the ray locks
      // onto that. It reported the whole superspeedway as flat, and then the
      // final sweep found a "wall" at 1132 of 1200 stations - which is the
      // real banking, rising through a corridor that had been told it was
      // level.
      const half = Math.min(out.outW[i], out.inW[i]);
      const offs = PROF_FRACTIONS.map((f) => f * half);
      const mid = PROF_FRACTIONS.indexOf(0);
      const rel = new Array(offs.length).fill(0);
      // A sample that jumps more than the banking possibly could over one
      // spacing is the apron showing through a seam, not the road. Hold the
      // last height instead; the along-lap smoothing below erases an isolated
      // one, and a real change of slope shows up at every station in a row.
      const spacing = offs.length > 1 ? Math.abs(offs[1] - offs[0]) : 1;
      const jump = Math.max(0.5, spacing * 0.7);      // ~35 degrees
      for (const dir of [1, -1]) {
        let prev = 0;
        for (let k = mid + dir; k >= 0 && k < offs.length; k += dir) {
          const h = surfaceAt(st, offs[k], out.y[i] + prev);
          const r = h === null ? prev : h - out.y[i];
          rel[k] = Math.abs(r - prev) > jump ? prev : r;
          prev = rel[k];
        }
      }
      out.profile.push({ offs, rel });

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
    // Measured over the middle half of the road, whatever the sample count -
    // the pair nearest +/- half a half-width, not fixed indices 1 and 3.
    const near = (want) => PROF_FRACTIONS
      .reduce((best, f, k) => (Math.abs(f - want) < Math.abs(PROF_FRACTIONS[best] - want) ? k : best), 0);
    const kLo = near(-0.5), kHi = near(0.5);
    out.bank = out.profile.map((_, i) => {
      const lo = cols[kLo][i], hi = cols[kHi][i];
      const span = profOffsets[kHi] - profOffsets[kLo];
      return span > 1e-9 ? Math.atan((hi - lo) / span) : 0;
    });
    // Smooth for a clean edge, but never wider than measured: smoothing alone
    // bulges the corridor back over a wall at the few stations either side of
    // it, which is enough for a car to clip through.
    out.outW = smooth(out.outW, 8, 2).map((v, i) => Math.min(v, rawOut[i]));
    out.inW = smooth(out.inW, 8, 2).map((v, i) => Math.min(v, rawIn[i]));

    // Final sweep: drive a ray the whole way across the finished corridor at
    // bumper height, exactly as check_barriers.mjs does, and pull the edge in
    // behind anything it hits.
    //
    // Walking outwards from the centreline is not enough on its own. Motor
    // Speedway's pit wall stands on the road with the asphalt continuing level
    // underneath it and through the gap at the pit entry, so at a handful of
    // stations the outward walk stepped over the wall's footing and carried on
    // to the pit lane beyond. This pass tests the corridor the game will
    // actually hand to the cars, so what it clears is what they can reach.
    const EDGE = 1.6;           // Track.limit's margin for the car's own width
    const CLEAR = 0.1;          // keep the limit this far short of the wall
    //
    // Every height here comes from a downward raycast, exactly as `edge()`
    // does - not from the model just fitted, and not from `track`, whose
    // heights are the overhead extraction's and sit up to a metre under Palm
    // Mile's road.
    //
    // Using the fitted model was the previous approach and it is subtly wrong:
    // the profile is a chord of a dozen points across a faceted, banked road,
    // so wherever it sits a few centimetres low the bumper ray runs *inside
    // the asphalt* and the road reports itself as a wall. On Yoyleland that
    // invented 102 walls, and because `minWindow` spreads each cut over nine
    // stations it pinched a third of the lap to the minimum width. Whether the
    // model matches the road is a real question, but it is verify_track's
    // question - this pass is only looking for things standing on it.
    //
    // Only X and Z are taken from `track.position`, and those do not depend on
    // any height.
    // Swept outward from the centreline in both directions, never inward from
    // an edge. Same reason the profile is measured that way: on an 18-degree
    // bank the deck at the inside edge is 2.5 m below the centreline, so a
    // sweep seeded there with the centre's height locks onto the flat apron
    // underneath - and then the real banking, rising back through the ray,
    // reads as a wall at essentially every station.
    const wall = (i) => {
      const st = track.sample(i * track.step, {});
      const lo = -(out.inW[i] - EDGE);
      const hi = out.outW[i] - EDGE;
      if (hi <= lo) return null;
      for (const way of [1, -1]) {
        const stop = way > 0 ? hi : lo;
        if (way > 0 ? stop <= 0 : stop >= 0) continue;
        let prevY = out.y[i];
        for (let n = 0; way > 0 ? n < stop - 1e-6 : n > stop + 1e-6; n += way * 0.25) {
          const b = way > 0 ? Math.min(n + 0.25, stop) : Math.max(n - 0.25, stop);
          const by = surfaceAt(st, b, prevY) ?? prevY;
          track.position(st, n, a);
          a.y = prevY + BUMPER;
          track.position(st, b, bpt);
          bpt.y = by + BUMPER;
          prevY = by;
          dir.copy(bpt).sub(a);
          const span = dir.length();
          if (span < 1e-6) continue;
          ray.set(a, dir.normalize());
          ray.far = span;
          const hit = ray.intersectObjects(ground, false).some((x) => x.distance > 0.05);
          ray.far = 400;
          if (hit) return n;
        }
      }
      return null;
    };
    let trimmed = 0;
    const cutOut = out.outW.slice();
    const cutIn = out.inW.slice();
    for (let i = 0; i < N; i++) {
      const nb = wall(i);
      if (nb === null) continue;
      trimmed++;
      if (nb >= 0) cutOut[i] = Math.max(MIN_HALF, Math.min(cutOut[i], nb + EDGE - CLEAR));
      else cutIn[i] = Math.max(MIN_HALF, Math.min(cutIn[i], -nb + EDGE - CLEAR));
    }
    // Spread each cut over its neighbours so the edge tapers instead of
    // notching in and out around a wall that is only caught at some stations.
    const minWindow = (arr, w) => arr.map((_, i) => {
      let m = Infinity;
      for (let k = -w; k <= w; k++) m = Math.min(m, arr[(i + k + N) % N]);
      return m;
    });
    out.outW = minWindow(cutOut, 4);
    out.inW = minWindow(cutIn, 4);
    if (widen) {
      // The sweep may take back what the walk added, but it may not cut into
      // the corridor the circuit already shipped and races on. A phantom wall
      // here would otherwise pinch nine stations at a stroke.
      out.outW = out.outW.map((v, i) => Math.max(v, data0.outW[i]));
      out.inW = out.inW.map((v, i) => Math.max(v, data0.inW[i]));
    }
    out.trimmed = trimmed;

    const deg = out.bank.map((b) => b * 180 / Math.PI);
    return {
      misses, trimmed: out.trimmed,
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
  console.log(`  stations trimmed behind a wall: ${result.trimmed}`);
  console.log(`  height  ${before.yMin.toFixed(2)}..${before.yMax.toFixed(2)} m  ->  ` +
              `${s.yMin.toFixed(2)}..${s.yMax.toFixed(2)} m`);
  console.log(`  bank    ${s.bankMin.toFixed(1)}..${s.bankMax.toFixed(1)} deg`);
  const w = data.outW.map((v, i) => v + data.inW[i]);
  console.log(`  width   ${Math.min(...w).toFixed(1)}..${Math.max(...w).toFixed(1)} m (from extraction)`);
  console.log(`  rewrote assets/${spec.data}`);
}

await browser.close();
server.kill();
