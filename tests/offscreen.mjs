// Integration test for the offscreen recording engine (offscreen.js) exactly as
// shipped. We cannot grant real tabCapture in automation (needs a toolbar
// gesture), so we patch ONLY navigator.mediaDevices.getUserMedia — test-side, via
// addInitScript — to feed offscreen.js a synthetic canvas stream in place of a
// tab stream. Everything else (canvas pump, single continuous MediaRecorder
// across a source switch, stop -> chrome.downloads) runs unmodified.
//
// Run: xvfb-run -a node tests/offscreen.mjs
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const EXT = resolve(import.meta.dirname, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const RESULTS = process.env.PF_RESULTS || resolve(EXT, 'tests', '.offscreen-results.txt');
writeFileSync(RESULTS, 'STARTED\n');

let pass = 0, fail = 0;
const out = line => { console.log(line); appendFileSync(RESULTS, line + '\n'); };
const check = (name, cond) => {
  if (cond) { pass++; out(`  ok  ${name}`); }
  else      { fail++; out(`FAIL  ${name}`); }
};

let ctx;
try {
  ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'pf-off-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // Spy on chrome.downloads from the service worker.
  await sw.evaluate(() => {
    self.__downloads = [];
    chrome.downloads.onCreated.addListener(d => self.__downloads.push({ url: d.url, filename: d.filename }));
  });

  // Open offscreen.html as an extension page, with getUserMedia patched to a
  // synthetic 640x360 stream and URL.createObjectURL spied to capture the blob.
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const cx = canvas.getContext('2d');
    let n = 0;
    setInterval(() => { cx.fillStyle = `hsl(${(n++ * 7) % 360},70%,50%)`; cx.fillRect(0, 0, 640, 360); }, 50);
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);

    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.__lastBlob = blob; return realCreate(blob); };
  });
  await page.goto(`chrome-extension://${extId}/offscreen/offscreen.html`);

  const send = (payload) => sw.evaluate(p => new Promise(r =>
    chrome.runtime.sendMessage({ target: 'offscreen', ...p }, resp => r(resp))), payload);

  const sid = 'test-session';
  const filename = 'PasswordFiller/test-session.webm';

  const startRes = await send({ cmd: 'start', sessionId: sid, streamId: 'fake-1', filename });
  check('start acknowledged', startRes?.ok === true);

  await page.waitForTimeout(1200);                       // record segment 1
  const switchRes = await send({ cmd: 'switch', sessionId: sid, streamId: 'fake-2' });
  check('switch acknowledged', switchRes?.ok === true);

  await page.waitForTimeout(1200);                       // record segment 2 (same recorder)
  const stopRes = await send({ cmd: 'stop', sessionId: sid });
  check('stop acknowledged (download did not throw)', stopRes?.ok === true);

  // A download was requested.
  const dls = await sw.evaluate(() => self.__downloads);
  check('chrome.downloads.download was called', dls.length === 1);
  check('download used a blob: URL', /^blob:/.test(dls[0]?.url || ''));

  // The captured blob is a single, playable WebM spanning the switch.
  const playback = await page.evaluate(async () => {
    const blob = window.__lastBlob;
    if (!blob) return { error: 'no blob captured' };
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.src = url; v.muted = true;
    document.body.appendChild(v);
    await new Promise((res, rej) => {
      v.addEventListener('loadeddata', res, { once: true });
      v.addEventListener('error', () => rej(new Error('decode error')), { once: true });
    });
    await v.play();
    const advanced = await new Promise(res => {
      const h = () => { if (v.currentTime > 0.1) { v.removeEventListener('timeupdate', h); res(true); } };
      v.addEventListener('timeupdate', h);
      setTimeout(() => res(v.currentTime > 0.1), 3000);
    });
    return { size: blob.size, type: blob.type, w: v.videoWidth, h: v.videoHeight, advanced };
  });

  check('blob is a webm', /webm/.test(playback.type || ''));
  check('blob is non-empty', playback.size > 0);
  check('recording plays back (real decoder)', playback.advanced === true);
  check('canvas size preserved (640x360)', playback.w === 640 && playback.h === 360);

} catch (err) {
  fail++;
  out('EXCEPTION: ' + (err.stack || err.message));
} finally {
  if (ctx) await ctx.close();
}

out(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
