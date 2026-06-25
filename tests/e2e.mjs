// End-to-end test: loads the unpacked extension in Chromium and drives the real
// options page, background worker, content script, and fill flow.
// Run: xvfb-run -a node tests/e2e.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = resolve(__dirname, '..');
const CHROME    = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else      { fail++; console.error(`FAIL  ${name}`); }
};

const userDataDir = mkdtempSync(resolve(tmpdir(), 'pf-e2e-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME,
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-sandbox',
  ],
});

try {
  // ── find the extension ID via its service worker ──
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('background service worker loaded', Boolean(extId));

  const optionsUrl = `chrome-extension://${extId}/options/options.html`;

  // ── 1. create vault ──
  const page = await ctx.newPage();
  await page.goto(optionsUrl);
  await page.waitForSelector('#mp1', { timeout: 10000 });
  await page.fill('#mp1', 'masterpw123');
  await page.fill('#mp2', 'masterpw123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.lock-bar', { timeout: 10000 });
  check('vault created and unlocked', await page.isVisible('.lock-bar'));

  // ── 2. add a credential ──
  await page.click('button:has-text("+ Add")');
  await page.waitForSelector('#entry-form-card');
  const card = page.locator('#entry-form-card');
  await card.locator('input[type="url"]').fill('https://example.com/login');
  await card.locator('input[type="text"]').first().fill('Example');           // title
  await card.locator('input[type="text"]').nth(1).fill('alice@example.com');  // username
  await card.locator('input[type="password"]').fill('hunter2pass');
  await card.locator('button[type="submit"]').click();
  await page.waitForSelector('.entry-item', { timeout: 10000 });
  check('credential appears in list', (await page.locator('.entry-item').count()) === 1);

  // ── 3. generator produces a strong password ──
  await page.click('button:has-text("+ Add")');
  await page.waitForSelector('#entry-form-card button:has-text("Generate")');
  await page.click('#entry-form-card button:has-text("Generate")');
  const genPw = await page.locator('#entry-form-card .pw-row input').inputValue();
  check('generator filled a 20-char password', genPw.length === 20);

  // ── 4. persistence across lock / unlock ──
  await page.click('button:has-text("Lock vault")');
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[type="password"]', 'masterpw123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.entry-item', { timeout: 10000 });
  check('entry persists after lock/unlock', (await page.locator('.entry-item').count()) === 1);

  // ── 5. wrong password is rejected ──
  await page.click('button:has-text("Lock vault")');
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[type="password"]', 'WRONGpassword');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.error', { timeout: 10000 });
  check('wrong password shows error', await page.isVisible('.error'));
  // unlock properly again for later steps
  await page.fill('input[type="password"]', 'masterpw123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.entry-item', { timeout: 10000 });

  // ── 6. content-script icon injection + fill on a real login form ──
  // Serve a page whose hostname is example.com (for domain matching) via routing.
  const login2 = await ctx.newPage();
  await login2.route('https://example.com/login', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><form>
        <input id="u" type="text" name="username" />
        <input id="p" type="password" name="password" />
        <button type="submit">Sign in</button>
      </form></body></html>`,
    }));
  await login2.goto('https://example.com/login');

  // The fill icon is a fixed-position shadow host [data-pf]; wait for it.
  await login2.waitForSelector('[data-pf]', { timeout: 10000 });
  check('fill icon injected on login page', await login2.locator('[data-pf]').count() >= 1);

  // Click the icon (inside shadow DOM), then the credential in the dropdown.
  await login2.locator('[data-pf]').first().locator('button').click();
  await login2.waitForSelector('[data-pf-dd]', { timeout: 10000 });
  const item = login2.locator('[data-pf-dd]').locator('.item').first();
  await item.waitFor({ timeout: 10000 });
  await item.click();

  await login2.waitForFunction(
    () => document.querySelector('#p')?.value === 'hunter2pass',
    { timeout: 10000 });
  const filledUser = await login2.locator('#u').inputValue();
  const filledPass = await login2.locator('#p').inputValue();
  check('username field filled', filledUser === 'alice@example.com');
  check('password field filled', filledPass === 'hunter2pass');

  // ── 7. change master password (rotates salt + key), then unlock with new one ──
  await page.bringToFront();
  const cp = page.locator('form:has(input[placeholder="Current password"])');
  await cp.locator('input[placeholder="Current password"]').fill('masterpw123');
  await cp.locator('input[placeholder="New password"]').fill('newmaster456');
  await cp.locator('input[placeholder="Confirm new password"]').fill('newmaster456');
  await cp.locator('button:has-text("Change password")').click();
  await page.waitForSelector('text=Master password changed', { timeout: 10000 });

  await page.click('button:has-text("Lock vault")');
  await page.waitForSelector('input[type="password"]');
  // old password must now fail
  await page.fill('input[type="password"]', 'masterpw123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.error', { timeout: 10000 });
  check('old password rejected after change', await page.isVisible('.error'));
  // new password must work and the entry must still be there
  await page.fill('input[type="password"]', 'newmaster456');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.entry-item', { timeout: 10000 });
  check('new password unlocks with entry intact', (await page.locator('.entry-item').count()) === 1);

} catch (err) {
  fail++;
  console.error('EXCEPTION:', err.stack || err.message);
} finally {
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
