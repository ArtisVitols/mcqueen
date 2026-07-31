/**
 * Report what surface is under each lateral offset, at stations round a lap.
 *
 * Answers "is the racing line actually on the road, and how far either side
 * does the road extend" without any guessing from screenshots.
 *
 *   node tools/cross_section.mjs msots [stations]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8206;
const TRACK = process.argv[2] || 'msots';
const N = Number(process.argv[3] || 8);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/smoke.html`, { waitUntil: 'domcontentloaded' });

console.log(await page.evaluate(async (tid, count) => {
  const THREE = await import('three');
  const { loadTrack, assetUrl } = await import('../src/models.js');
  const { Track } = await import('../src/track.js');
  const spec = (await (await fetch(assetUrl('tracks.json'))).json()).tracks.find((t) => t.id === tid);
  const track = await Track.load(assetUrl(spec.data));
  const scene = await loadTrack(spec.model, track.modelScale);
  scene.updateMatrixWorld(true);

  const invisible = (o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    return ms.every((m) => m && (m.opacity === 0 || m.colorWrite === false));
  };
  const ray = new THREE.Raycaster();
  ray.far = 600;
  const down = new THREE.Vector3(0, -1, 0);
  const p = new THREE.Vector3();

  // Short codes so a whole cross-section fits on one line.
  const codes = new Map();
  const codeFor = (name) => {
    if (!codes.has(name)) codes.set(name, String.fromCharCode(97 + codes.size));
    return codes.get(name);
  };

  const lanes = [];
  for (let n = -16; n <= 16; n += 1) lanes.push(n);
  const out = [`${spec.name}: lateral -16 m ... +16 m (0 = centreline, + = outward)`];
  for (let k = 0; k < count; k++) {
    const s = (k / count) * track.lapLength;
    const st = track.sample(s, {});
    let row = '';
    for (const n of lanes) {
      track.position(st, n, p);
      ray.set(new THREE.Vector3(p.x, p.y + 250, p.z), down);
      const hits = ray.intersectObject(scene, true).filter((h) => !invisible(h.object));
      let best = null;
      for (const h of hits) {
        if (!best || Math.abs(h.point.y - p.y) < Math.abs(best.point.y - p.y)) best = h;
      }
      if (!best || Math.abs(best.point.y - p.y) > 2.5) { row += '.'; continue; }
      const m = Array.isArray(best.object.material) ? best.object.material[0] : best.object.material;
      row += codeFor(m?.name || '?');
    }
    const halfIn = track.limit(st, -1).toFixed(1);
    const halfOut = track.limit(st, 1).toFixed(1);
    out.push(`  s=${String(Math.round(s)).padStart(5)}  ${row}   limits ${halfIn} .. ${halfOut}`);
  }
  out.push('  ' + ' '.repeat(9) + '-'.repeat(16) + '0' + '-'.repeat(16));
  out.push('legend: ' + [...codes].map(([n, c]) => `${c}=${n}`).join('  ') + '   . = nothing/too far');
  return out.join('\n');
}, TRACK, N));

await browser.close();
server.kill();
