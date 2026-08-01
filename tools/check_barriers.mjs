/**
 * Find walls and fences standing inside the driveable corridor, and holes the
 * car can drop a wheel into.
 *
 * Every earlier check raycast straight down, which reports the road *under* a
 * fence and so can never see the fence. This one fires a ray sideways across
 * the corridor at bumper height, which is how a car meets a wall - and it
 * ignores the overhead gantries and catch fencing a downward ray confuses for
 * barriers.
 *
 * The surface scan runs out to the car's full width past the corridor edge,
 * because the clamp holds the car's centre and the bodywork hangs 1.2 m
 * further out.
 *
 *   node tools/check_barriers.mjs [trackId ...]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8231;

const BUMPER = 0.45;        // height the sideways ray is fired at
const OVERHANG = 1.25;      // half a car, past the corridor edge
const DROP = 0.35;          // a step this big between lanes is a hole

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

const ids = process.argv.slice(2);
const manifest = await page.evaluate(async () => {
  const { assetUrl } = await import('../src/models.js');
  return (await (await fetch(assetUrl('tracks.json'))).json()).tracks;
});

let failed = 0;
for (const spec of (ids.length ? manifest.filter((t) => ids.includes(t.id)) : manifest)) {
  const r = await page.evaluate(async (trackSpec, BUMPER, dropH, OVERHANG) => {
    const THREE = await import('three');
    const { loadTrack, assetUrl } = await import('../src/models.js');
    const { Track } = await import('../src/track.js');
    const track = await Track.load(assetUrl(trackSpec.data));
    const scene = await loadTrack(trackSpec.model, track.modelScale, undefined,
      trackSpec.asphalt || []);
    scene.updateMatrixWorld(true);
    const invisible = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
    };
    const ray = new THREE.Raycaster();
    ray.far = 600;
    const down = new THREE.Vector3(0, -1, 0);
    const p = new THREE.Vector3();

    const barriers = [];
    const holes = [];
    const matTop = {};
    const along = new THREE.Vector3();
    const from = new THREE.Vector3();
    const q = new THREE.Vector3();
    const up = new THREE.Vector3();

    for (let i = 0; i < track.count; i += 3) {
      const s = i * track.step;
      const st = track.sample(s, {});
      const lo = track.limit(st, -1);
      const hi = track.limit(st, 1);

      // Step across the corridor firing short rays that follow the surface.
      // A single long horizontal ray is no good on a banked road - it just
      // hits the asphalt as the track climbs away from it.
      for (let n = lo; n < hi - 1e-6; n += 0.5) {
        const b = Math.min(n + 0.5, hi);
        track.position(st, n, from);
        from.addScaledVector(track.normal(st, up, n), BUMPER);
        track.position(st, b, q);
        q.addScaledVector(track.normal(st, up, b), BUMPER);
        along.copy(q).sub(from);
        const span = along.length();
        if (span < 1e-6) continue;
        ray.set(from, along.normalize());
        ray.far = span;
        const hit = ray.intersectObject(scene, true).find((h) => !invisible(h.object));
        if (hit) {
          const m = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
          barriers.push({ s: Math.round(s), n: +n.toFixed(1), mat: m?.name });
          matTop[m?.name] = (matTop[m?.name] || 0) + 1;
          break;
        }
      }
      ray.far = 600;

      // Surface continuity out to where the bodywork actually reaches.
      const lane = [];
      for (let n = lo - OVERHANG; n <= hi + OVERHANG + 1e-6; n += 0.5) {
        track.position(st, n, p);
        ray.set(new THREE.Vector3(p.x, p.y + 250, p.z), down);
        const hits = ray.intersectObject(scene, true).filter((x) => !invisible(x.object));
        if (!hits.length) { lane.push({ n, y: null }); continue; }
        let road = hits[0];
        for (const h of hits) {
          if (Math.abs(h.point.y - p.y) < Math.abs(road.point.y - p.y)) road = h;
        }
        lane.push({ n, y: road.point.y });
      }
      for (let k = 0; k < lane.length; k++) {
        const c = lane[k];
        if (c.y === null) {
          // One isolated miss with solid road either side is a ray slipping
          // through the shared edge of two triangles - Palm Mile has one on
          // the seam between its two asphalt materials. A gap a car can drop
          // into is metres wide, so require the miss to have company.
          const alone = (k === 0 || lane[k - 1].y !== null) &&
                        (k === lane.length - 1 || lane[k + 1].y !== null);
          if (!alone) holes.push({ s: Math.round(s), n: +c.n.toFixed(1), drop: 'none' });
          continue;
        }
        const prev = k > 0 ? lane[k - 1].y : null;
        if (prev !== null && Math.abs(c.y - prev) > dropH) {
          holes.push({ s: Math.round(s), n: +c.n.toFixed(1), drop: +(c.y - prev).toFixed(2) });
        }
      }
    }
    return { name: trackSpec.name, barriers, holes, matTop, stations: Math.ceil(track.count / 3) };
  }, spec, BUMPER, DROP, OVERHANG);

  console.log(`\n=== ${r.name} ===`);
  console.log(`  barriers across the corridor at bumper height: ${r.barriers.length}` +
    (r.barriers.length ? `  ${JSON.stringify(r.matTop)}` : ''));
  if (r.barriers.length) {
    console.log('    e.g. ' + JSON.stringify(r.barriers.slice(0, 6)));
    const ns = r.barriers.map((b) => b.n).sort((a, b) => a - b);
    console.log(`    lateral range ${ns[0]} .. ${ns[ns.length - 1]}`);
    failed++;
  }
  console.log(`  holes / steps under the car's full width: ${r.holes.length}`);
  if (r.holes.length) {
    console.log('    e.g. ' + JSON.stringify(r.holes.slice(0, 6)));
    const ns = r.holes.map((h) => h.n).sort((a, b) => a - b);
    console.log(`    lateral range ${ns[0]} .. ${ns[ns.length - 1]}`);
    failed++;
  }
}

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
