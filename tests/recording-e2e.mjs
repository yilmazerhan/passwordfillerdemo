// Full recording-orchestration E2E. Real tabCapture can't be granted in
// automation (needs a toolbar gesture), so we fake the two un-grantable pieces:
//   - chrome.tabCapture.getMediaStreamId  -> patched in the service worker
//   - the tab MediaStream (getUserMedia)  -> patched via context addInitScript,
//     which also reaches the extension-created offscreen document
// Everything else (session state, badges, multi-tab join, switch, stop-on-last-
// tab-close, offscreen recording, chrome.downloads) runs unmodified.
//
// Run: xvfb-run -a node tests/recording-e2e.mjs
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const EXT = resolve(import.meta.dirname, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const RESULTS = process.env.PF_RESULTS || resolve(EXT, 'tests', '.recording-results.txt');
writeFileSync(RESULTS, 'STARTED\n');

let pass = 0, fail = 0;
const out = line => { console.log(line); appendFileSync(RESULTS, line + '\n'); };
const check = (name, cond) => {
  if (cond) { pass++; out(`  ok  ${name}`); }
  else      { fail++; out(`FAIL  ${name}`); }
};

let ctx;
try {
  ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'pf-rec-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // Real tabCapture can't be granted in automation, and addInitScript doesn't
  // reach the extension-created offscreen document — so the offscreen's actual
  // recording+download is covered by offscreen.mjs. Here we test recorder.js
  // orchestration by stubbing the offscreen transport in the SW: fake the
  // capture gate, skip offscreen creation, and record the start/switch/stop
  // commands recorder.js sends.
  await sw.evaluate(() => {
    chrome.tabCapture.getMediaStreamId = (_opts, cb) => cb('fake-stream-id');
    chrome.offscreen.hasDocument = async () => true;
    self.__cmds = [];
    const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.target === 'offscreen') {
        self.__cmds.push({ cmd: msg.cmd, sessionId: msg.sessionId, filename: msg.filename });
        return Promise.resolve(msg.cmd === 'stop' ? { ok: true, saved: true, name: 'stub' } : { ok: true });
      }
      return realSend(msg, cb);
    };
  });
  const cmds = () => sw.evaluate(() => self.__cmds);

  // The SW cannot sendMessage to itself, so drive the worker from an extension
  // page (options.html runs in an extension context with chrome.runtime).
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/options/options.html`);
  const sendMsg = (payload) => helper.evaluate(p => new Promise(r =>
    chrome.runtime.sendMessage(p, resp => r(resp))), payload);

  const routeForm = (page, path) => page.route(`https://example.com${path}`, r =>
    r.fulfill({ contentType: 'text/html', body: '<form><input type=text><input type=password></form>' }));
  const tabIdOf = page => sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url());
  const status  = tabId => sendMsg({ type: 'recordStatus', tabId });
  const badge   = tabId => sw.evaluate(t => chrome.action.getBadgeText({ tabId: t }), tabId);

  // ── Tab A: start recording (simulates a popup fill with its gesture) ──
  const a = await ctx.newPage();
  await routeForm(a, '/login');
  await a.goto('https://example.com/login');
  const aId = await tabIdOf(a);

  const startRes = await sendMsg({ type: 'recordStart', tabId: aId });
  check('recordStart succeeded', startRes?.ok === true);
  if (!startRes?.ok) out('   startRes = ' + JSON.stringify(startRes));

  const startCmd = (await cmds()).find(c => c.cmd === 'start');
  check('start command sent to offscreen', Boolean(startCmd));
  check('filename matches session-<domain>-<stamp>.webm',
    /^session-example\.com-\d{8}-\d{6}\.webm$/.test(startCmd?.filename || ''));
  check('tab A shows recording status', (await status(aId))?.state === 'recording-here');
  check('tab A has recording badge', (await badge(aId)) === '●');

  await a.waitForTimeout(1000);

  // ── Tab B: same site, should join the session ──
  const b = await ctx.newPage();
  await routeForm(b, '/account');
  await b.goto('https://example.com/account');
  const bId = await tabIdOf(b);
  await a.bringToFront();        // keep A as the captured tab for a deterministic check
  await b.waitForTimeout(800);   // let onUpdated(join) + onActivated(A) settle

  check('tab B joined the session (other-tab)', (await status(bId))?.state === 'recording-other-tab');
  check('tab B has recording badge', (await badge(bId)) === '●');

  // ── Activate B: capture should switch to it (single continuous recording) ──
  await b.bringToFront();
  await b.waitForTimeout(800);
  check('capture switched to tab B', (await status(bId))?.state === 'recording-here');
  check('switch command sent to offscreen', (await cmds()).some(c => c.cmd === 'switch'));

  await b.waitForTimeout(600);

  // ── Close A: session continues (B still open), no stop yet ──
  await a.close();
  await helper.waitForTimeout(500);
  check('no stop while a same-site tab remains', !(await cmds()).some(c => c.cmd === 'stop'));

  // ── Close B (last same-site tab): stop is sent (offscreen would then download) ──
  await b.close();
  let stopCmd = null;
  for (let i = 0; i < 25; i++) {
    stopCmd = (await cmds()).find(c => c.cmd === 'stop');
    if (stopCmd) break;
    await helper.waitForTimeout(300);
  }
  check('stop sent after last same-site tab closed', Boolean(stopCmd));
  check('stop targets the same session as start', stopCmd?.sessionId === startCmd?.sessionId);

} catch (err) {
  fail++;
  out('EXCEPTION: ' + (err.stack || err.message));
} finally {
  if (ctx) await ctx.close();
}

out(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
