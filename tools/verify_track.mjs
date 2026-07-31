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
 *   node tools/verify_track.mjs
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
const MAX_OUTLIER_FRACTION = 0.01;  // share allowed past TAIL_TOLERANCE
// Lateral offsets that must be on a driveable surface - the lanes cars use.
const LANES = [-7, -5, -3, 0, 3, 5, 7];
const DRIVEABLE = /^(Asphalt|Finish_Line|material$)/;

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

const result = await page.evaluate(async (lanes, driveableSrc) => {
  const THREE = await import('three');
  const { loadTrack, assetUrl } = await import('../src/models.js');
  const { Track } = await import('../src/track.js');
  const driveable = new RegExp(driveableSrc);

  const scene = await loadTrack();
  scene.updateMatrixWorld(true);
  const track = await Track.load(assetUrl('track-data.json'));

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
      // Topmost visible hit that is not overhead scenery. The start/finish
      // gantry and the catch fence both sit above the racing line, so "first
      // hit going down" is not the road.
      const hits = ray.intersectObject(scene, true)
        .filter((h) => !invisible(h.object) && h.point.y <= p.y + 2.0);
      if (!hits.length) { noHit.push({ s: Math.round(s), n }); continue; }
      const h = hits[0];
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      const name = m?.name || '?';
      materials[name] = (materials[name] || 0) + 1;
      if (!driveable.test(name)) badMaterial.push({ s: Math.round(s), n, mat: name });
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
}, LANES, DRIVEABLE.source);

console.log(`sampled ${result.samples} points along the racing line`);
console.log('surface materials hit:', JSON.stringify(result.materials));
const outlierFrac = result.overTail / result.samples;
console.log('height error (physics - rendered), metres:');
console.log(`  |median| ${result.medianAbs.toFixed(3)}   |p99| ${result.p99Abs.toFixed(3)}` +
            `   range ${result.min.toFixed(2)} .. ${result.max.toFixed(2)}`);
console.log(`  past ${TAIL_TOLERANCE} m: ${result.overTail} / ${result.samples} ` +
            `(${(outlierFrac * 100).toFixed(2)}%)`);

const problems = [];
if (result.noHitCount) {
  problems.push(`${result.noHitCount} points with no surface underneath ` +
                JSON.stringify(result.noHit));
}
if (result.badCount) {
  problems.push(`${result.badCount} points where the top surface is not driveable ` +
                JSON.stringify(result.badMaterial));
}
if (result.medianAbs > MEDIAN_TOLERANCE) {
  problems.push(`typical height error ${result.medianAbs.toFixed(3)} m exceeds ${MEDIAN_TOLERANCE} m ` +
                '- the physics surface has drifted from the rendered one');
}
if (result.p99Abs > TAIL_TOLERANCE && outlierFrac > MAX_OUTLIER_FRACTION) {
  problems.push(`${(outlierFrac * 100).toFixed(2)}% of points are more than ${TAIL_TOLERANCE} m out: ` +
                JSON.stringify(result.worst.map((w) => ({ ...w, d: +w.d.toFixed(2) }))));
}

await browser.close();
server.kill();

if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  ! ' + p);
  process.exit(1);
}
console.log('\ntrack asset matches the physics data');
