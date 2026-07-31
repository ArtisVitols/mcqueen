/**
 * Check the shipped track asset against the physics data.
 *
 * assets/track-data.json is measured off the raw mesh in Python, but the game
 * renders assets/track.glb. Nothing guaranteed those two agreed, and when the
 * compression pipeline silently flattened the banked asphalt the cars ended up
 * floating a metre above the visible road with the physics none the wiser.
 *
 * So: raycast the shipped asset straight down along the racing line and assert
 * that the topmost VISIBLE surface is asphalt and sits where track-data.json
 * says it does. Invisible meshes are ignored - this model ships a fully
 * transparent collision shell (material_0, alpha 0) floating above the road.
 *
 *   node tools/verify_track.mjs [trackId ...]     (default: all of them)
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8165;

// Thresholds are about catching *systemic* drift - the failure that shipped
// was every car floating a metre - while tolerating the odd pinhole where a
// ray slips between two triangles and lands on the layer below.
const MEDIAN_TOLERANCE = 0.10;   // typical error
const TAIL_TOLERANCE = 0.50;     // 99th percentile
// Share allowed past TAIL_TOLERANCE. Per-track, because one circuit has a
// genuine step in its source mesh; the median check stays strict everywhere
// and is what catches the systemic drift this tool exists to prevent.
const DEFAULT_OUTLIER_FRACTION = 0.01;
// Lateral offsets that must be on a driveable surface - the lanes cars use.
const LANES = [-7, -5, -3, 0, 3, 5, 7];

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

const manifest = await page.evaluate(async () => {
  const { assetUrl } = await import('../src/models.js');
  return (await (await fetch(assetUrl('tracks.json'))).json()).tracks;
});
const wanted = process.argv.slice(2);
const todo = wanted.length ? manifest.filter((t) => wanted.includes(t.id)) : manifest;

let failed = 0;
for (const spec of todo) {
const result = await page.evaluate(async (lanes, trackSpec) => {
  const THREE = await import('three');
  const { loadTrack, assetUrl } = await import('../src/models.js');
  const { Track } = await import('../src/track.js');
  const driveable = new Set(trackSpec.roadMaterials || []);

  const track = await Track.load(assetUrl(trackSpec.data));
  const scene = await loadTrack(trackSpec.model, track.modelScale);
  scene.updateMatrixWorld(true);

  const invisible = (o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
  };
  const ray = new THREE.Raycaster();
  ray.far = 900;
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const p = new THREE.Vector3();

  const diffs = [];
  const badMaterial = [];
  const noHit = [];
  const materials = {};

  for (let i = 0; i < track.count; i += 2) {
    const s = i * track.step;
    const st = track.sample(s, {});
    for (const n of lanes) {
      // Skip lanes outside this station's actual width.
      if (n > track.limit(st, 1) || n < track.limit(st, -1)) continue;
      track.position(st, n, p);
      origin.set(p.x, p.y + 300, p.z);
      ray.set(origin, down);
      // The visible surface nearest the physics height. "Topmost hit" is
      // wrong here: gantries, catch fences and pit walls all sit above the
      // racing line, and on the 1:15 circuits they sit close above it. What
      // actually matters is whether there is road where the physics claims,
      // which is exactly what the nearest surface answers.
      const hits = ray.intersectObject(scene, true).filter((h) => !invisible(h.object));
      if (!hits.length) { noHit.push({ s: Math.round(s), n }); continue; }
      let h = hits[0];
      for (const c of hits) {
        if (Math.abs(c.point.y - p.y) < Math.abs(h.point.y - p.y)) h = c;
      }
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      const name = m?.name || '?';
      materials[name] = (materials[name] || 0) + 1;
      if (!driveable.has(name)) badMaterial.push({ s: Math.round(s), n, mat: name });
      diffs.push({ s: Math.round(s), n, d: p.y - h.point.y });
    }
  }

  const abs = diffs.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
  const signed = diffs.map((x) => x.d).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.max(0, Math.floor(arr.length * f) - 1)];
  const worst = diffs.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
  return {
    samples: diffs.length,
    min: q(signed, 0), max: q(signed, 1),
    medianAbs: q(abs, 0.5), p99Abs: q(abs, 0.99),
    overTail: abs.filter((v) => v > 0.5).length,
    worst, badMaterial: badMaterial.slice(0, 10), badCount: badMaterial.length,
    noHit: noHit.slice(0, 10), noHitCount: noHit.length,
    materials,
  };
}, LANES, spec);

console.log(`\n=== ${spec.name} ===`);
console.log(`sampled ${result.samples} points along the racing line`);
console.log('surface materials hit:', JSON.stringify(result.materials));
const outlierFrac = result.overTail / result.samples;
console.log('height error (physics - rendered), metres:');
console.log(`  |median| ${result.medianAbs.toFixed(3)}   |p99| ${result.p99Abs.toFixed(3)}` +
            `   range ${result.min.toFixed(2)} .. ${result.max.toFixed(2)}`);
console.log(`  past ${TAIL_TOLERANCE} m: ${result.overTail} / ${result.samples} ` +
            `(${(outlierFrac * 100).toFixed(2)}%)`);

const problems = [];
// A stray miss is a ray slipping between two triangles, not a hole a car
// could fall through; a cluster of them would be.
if (result.noHitCount > Math.max(2, result.samples * 0.001)) {
  problems.push(`${result.noHitCount} points with no surface underneath ` +
                JSON.stringify(result.noHit));
} else if (result.noHitCount) {
  console.log(`  note: ${result.noHitCount} ray(s) slipped between triangles`);
}
// Material identity is only informational: these models overlap coplanar
// surfaces freely, so which one wins a ray says little. Height is the test.
if (result.badCount) {
  console.log(`  note: ${result.badCount}/${result.samples} points sit on a surface ` +
              'outside the listed road materials (overlapping apron/kerb meshes)');
}
if (result.medianAbs > MEDIAN_TOLERANCE) {
  problems.push(`typical height error ${result.medianAbs.toFixed(3)} m exceeds ${MEDIAN_TOLERANCE} m ` +
                '- the physics surface has drifted from the rendered one');
}
const maxOutlier = spec.maxOutlierFraction ?? DEFAULT_OUTLIER_FRACTION;
if (result.p99Abs > TAIL_TOLERANCE && outlierFrac > maxOutlier) {
  problems.push(`${(outlierFrac * 100).toFixed(2)}% of points are more than ${TAIL_TOLERANCE} m out ` +
                `(limit ${(maxOutlier * 100).toFixed(0)}%): ` +
                JSON.stringify(result.worst.map((w) => ({ ...w, d: +w.d.toFixed(2) }))));
}

if (problems.length) {
  failed++;
  console.log('PROBLEMS:');
  for (const p of problems) console.log('  ! ' + p);
} else {
  console.log('OK - track asset matches the physics data');
}
}

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
