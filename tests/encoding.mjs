// Validates the recording technique used by offscreen.js: a hidden-doc-safe
// canvas.captureStream(0) + track.requestFrame() pump feeding a VP9 MediaRecorder
// at low bitrate. Produces a real .webm, then verifies it with ffmpeg.
// Run: xvfb-run -a node tests/encoding.mjs
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FFMPEG = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else      { fail++; console.error(`FAIL  ${name}`); }
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));

const result = await page.evaluate(async () => {
  const FPS = 8, W = 640, H = 360, BITRATE = 600_000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t));

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);

  // Pump ~2s of frames the same way the offscreen engine does.
  let i = 0;
  await new Promise(done => {
    const timer = setInterval(() => {
      ctx.fillStyle = `hsl(${(i * 12) % 360},70%,50%)`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = '40px sans-serif';
      ctx.fillText('frame ' + i, 30, 180);
      track.requestFrame();
      if (++i >= FPS * 2) { clearInterval(timer); done(); }
    }, Math.round(1000 / FPS));
  });

  await new Promise(done => { rec.onstop = done; rec.stop(); });
  const blob = new Blob(chunks, { type: mime });

  // Play the recorded blob back through Chromium's real VP9 decoder — the
  // faithful "regular video player" check.
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.src = url; v.muted = true;
  document.body.appendChild(v);
  await new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('video decode error')), { once: true });
  });
  await v.play();
  const advanced = await new Promise(res => {
    const h = () => { if (v.currentTime > 0.1) { v.removeEventListener('timeupdate', h); res(true); } };
    v.addEventListener('timeupdate', h);
    setTimeout(() => res(v.currentTime > 0.1), 3000);
  });

  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
  return { mime, b64: btoa(bin), size: bytes.length,
           playW: v.videoWidth, playH: v.videoHeight, advanced };
});

await browser.close();

check('a VP9/VP8 webm mime was chosen', /webm/.test(result.mime));
check('produced non-empty output', result.size > 0);

// Authoritative playability: Chromium's real decoder rendered the file.
check('plays back with correct dimensions', result.playW === 640 && result.playH === 360);
check('playback position advances', result.advanced === true);

const dir  = mkdtempSync(resolve(tmpdir(), 'pf-enc-'));
const file = resolve(dir, 'clip.webm');
writeFileSync(file, Buffer.from(result.b64, 'base64'));
console.log(`  …wrote ${result.size} bytes (${result.mime}) to ${file}`);

// ffmpeg here is a stripped Playwright build (VP8 decoder only, no VP9 decode),
// so we only assert what it CAN do: demux the container and identify the stream.
let info = '';
try { execFileSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); }
catch (e) { info = e.stderr?.toString() ?? ''; }
check('ffmpeg recognizes a Matroska/WebM container', /matroska|webm/i.test(info));
check('ffmpeg reports a VP9/VP8 video stream', /Video:\s*vp9|Video:\s*vp8/i.test(info));

// Sanity on compression: 2s @600kbps should be well under a few hundred KB.
check('output is small (< 400 KB for 2s)', result.size < 400_000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
