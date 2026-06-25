// Verifies the options-page Recordings UI: a saved recording is listed, the
// Download button produces a file download, and Delete removes it.
// Run: xvfb-run -a node tests/recordings-ui.mjs
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const EXT = resolve(import.meta.dirname, '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const RESULTS = process.env.PF_RESULTS || resolve(EXT, 'tests', '.recordings-ui-results.txt');
writeFileSync(RESULTS, 'STARTED\n');

let pass = 0, fail = 0;
const out = line => { console.log(line); appendFileSync(RESULTS, line + '\n'); };
const check = (name, cond) => {
  if (cond) { pass++; out(`  ok  ${name}`); }
  else      { fail++; out(`FAIL  ${name}`); }
};

let ctx;
try {
  ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'pf-rui-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
    acceptDownloads: true,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`);

  // Create the vault so the options page reaches a state that shows Recordings.
  await page.waitForSelector('#mp1');
  await page.fill('#mp1', 'masterpw123');
  await page.fill('#mp2', 'masterpw123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.lock-bar');

  // Seed a recording directly into IndexedDB via the page's own db module.
  await page.evaluate(async () => {
    const db = await import('../lib/recordings-db.js');
    const blob = new Blob([new Uint8Array(2048)], { type: 'video/webm' });
    await db.addRecording(
      { id: 'rec-1', name: 'session-example.com-20260625-101010.webm', domain: 'example.com',
        mime: 'video/webm', size: blob.size, createdAt: Date.now() },
      blob);
  });

  await page.reload();
  await page.waitForSelector('.lock-bar');
  await page.waitForSelector('#rec-list .entry-item', { timeout: 10000 });

  check('recording is listed', (await page.locator('#rec-list .entry-item').count()) === 1);
  check('shows the domain', (await page.locator('#rec-list .entry-title').first().innerText()).includes('example.com'));

  // Download via the ⬇️ button -> Playwright download event.
  const item = page.locator('#rec-list .entry-item').first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    item.locator('button[title="Download"]').click(),
  ]);
  check('download filename matches', download.suggestedFilename() === 'session-example.com-20260625-101010.webm');

  // Delete via the 🗑️ button (accept the confirm dialog).
  page.on('dialog', d => d.accept());
  await item.locator('button[title="Delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#rec-list .entry-item').length === 0, { timeout: 10000 });
  check('recording removed after delete', (await page.locator('#rec-list .entry-item').count()) === 0);

  // Confirm it's gone from IndexedDB too.
  const remaining = await page.evaluate(async () => {
    const db = await import('../lib/recordings-db.js');
    return (await db.listMeta()).length;
  });
  check('IndexedDB has no recordings after delete', remaining === 0);

} catch (err) {
  fail++;
  out('EXCEPTION: ' + (err.stack || err.message));
} finally {
  if (ctx) await ctx.close();
}

out(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
