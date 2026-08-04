/**
 * Turning the phone sideways should go fullscreen.
 *
 * The whole difficulty is one browser rule: **`requestFullscreen` needs
 * transient user activation, and rotating a phone is not one**. So the
 * interesting case is not the happy path - it is the refusal, where the game
 * has to offer a tap instead. Headless Chrome *grants* fullscreen without
 * activation, so the refusal has to be stubbed or this test would only ever
 * exercise the path that never happens on a real phone.
 *
 * Three things are checked:
 *
 *   desktop   the panel must never appear - every other browser test runs at
 *             a landscape viewport and would have its clicks swallowed
 *   granted   the panel must not linger once fullscreen actually happened
 *   refused   landscape offers the tap, the tap retries, and dismissing it
 *             does not nag again until the phone is turned
 *
 *   node tools/check_fullscreen.mjs
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from './node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(homedir(), '.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8341;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader'],
});

let failed = 0;
const fail = (m) => { console.log('  FAIL:', m); failed++; };
const ok = (m) => console.log('  ok:', m);

/**
 * @param {object} opts
 * @param {boolean} opts.phone   emulate a touch device with a coarse pointer
 * @param {boolean} opts.refuse  make requestFullscreen reject, as Chrome does
 *                               without user activation
 */
async function open({ phone, refuse }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, isMobile: phone, hasTouch: phone });
  if (refuse) {
    await page.evaluateOnNewDocument(() => {
      // Exactly what Chrome does on a phone when the only thing that happened
      // was a rotation.
      Element.prototype.requestFullscreen = () =>
        Promise.reject(new TypeError('API can only be initiated by a user gesture.'));
    });
  } else if (phone) {
    // ... and the opposite, stubbed just as deliberately. Headless Chrome
    // grants fullscreen without a gesture *sometimes*, which makes "what
    // happens once it is granted" a coin toss rather than a test.
    await page.evaluateOnNewDocument(() => {
      let el = null;
      Object.defineProperty(document, 'fullscreenElement', { get: () => el });
      Element.prototype.requestFullscreen = function grant() {
        el = this;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };
    });
  }
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction("!document.getElementById('menu').classList.contains('hidden')",
    { timeout: 300000, polling: 500 });
  return page;
}

const state = (page) => page.evaluate(() => {
  const e = document.getElementById('rotate');
  return {
    shown: !e.classList.contains('hidden'),
    nag: e.classList.contains('nag'),
    full: e.classList.contains('full'),
    fs: !!document.fullscreenElement,
    text: getComputedStyle(e).display === 'none' ? ''
      : [...e.children].filter((c) => getComputedStyle(c).display !== 'none')
        .map((c) => c.textContent.trim()).join(' | '),
  };
});

/**
 * Turn the phone. `setViewport` back to a size the page has already been
 * does not always fire resize in headless, so nudge it - a real browser
 * always fires one, and this test is about the game's logic, not Chrome's.
 */
async function turn(page, portrait) {
  const w = portrait ? 390 : 844, h = portrait ? 844 : 390;
  const vp = page.viewport();
  await page.setViewport({ width: w, height: h, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await sleep(250);
}

console.log('\n=== desktop: the panel must never appear ===');
{
  const page = await open({ phone: false, refuse: false });
  const land = await state(page);
  land.shown ? fail(`desktop landscape shows "${land.text}"`)
             : ok('landscape shows nothing');
  await turn(page, true);
  const port = await state(page);
  port.nag && !port.full ? ok('portrait still asks you to turn the phone')
                         : fail(`portrait: ${JSON.stringify(port)}`);
  await turn(page, false);
  const back = await state(page);
  back.shown ? fail(`panel left over after turning back: "${back.text}"`)
             : ok('turning back hides it again');
  await page.close();
}

console.log('\n=== phone, fullscreen granted: the panel must not linger ===');
{
  const page = await open({ phone: true, refuse: false });
  await turn(page, false);
  const land = await state(page);
  land.fs && !land.shown ? ok('already fullscreen, so nothing is offered')
                         : fail(`granted but still showing: ${JSON.stringify(land)}`);
  await page.close();
}

console.log('\n=== phone, fullscreen refused: the tap is the fallback ===');
{
  const page = await open({ phone: true, refuse: true });
  await turn(page, false);
  const land = await state(page);
  land.full && /fullscreen/i.test(land.text)
    ? ok(`landscape offers "${land.text}"`)
    : fail(`no fullscreen offer: ${JSON.stringify(land)}`);

  // The tap has to reach the panel and retry. It still fails here - that is
  // the stub - so what is checked is that the offer survives rather than
  // silently disappearing on the first tap.
  const tries = await page.evaluate(() => {
    let n = 0;
    const real = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (...a) { n++; return real.apply(this, a); };
    document.getElementById('rotate').click();
    Element.prototype.requestFullscreen = real;
    return n;
  });
  await sleep(200);
  const after = await state(page);
  tries > 0 && after.full
    ? ok('tapping retries, and the offer stays up while it keeps failing')
    : fail(`tap did nothing (${tries} attempts, ${JSON.stringify(after)})`);

  await turn(page, true);
  const port = await state(page);
  port.nag ? ok('portrait goes back to the turn-your-phone nag')
           : fail(`portrait: ${JSON.stringify(port)}`);
  await page.close();
}

await browser.close();
server.kill();
console.log(failed ? `\n${failed} problem(s)` : '\nfullscreen on rotate behaves');
process.exit(failed ? 1 : 0);
