#!/usr/bin/env node
// Targeted, READABLE board capture: filter to a sport tab and screenshot the
// viewport only (not a 36k-tall fullPage), so game rows are legible for design
// review. Env: ACE_BASE_URL, ACE_STORAGE_STATE, ACE_SCREENSHOT_OUT, ACE_TAB,
// ACE_VISUAL_EMAIL/PASSWORD (fallback re-auth), ACE_VIEWPORT_HEIGHT.
import { env, launchBrowser, newDashboardPage, assertDashboard, login, mkdirForFile, DEFAULT_BASE_URL, DEFAULT_EMAIL, DEFAULT_STORAGE_STATE } from './lib.mjs';

const baseURL = env('ACE_BASE_URL', DEFAULT_BASE_URL);
const email = env('ACE_VISUAL_EMAIL', DEFAULT_EMAIL);
const password = env('ACE_VISUAL_PASSWORD');
const storageState = env('ACE_STORAGE_STATE', DEFAULT_STORAGE_STATE);
const out = env('ACE_SCREENSHOT_OUT', 'artifacts/board-rows.png');
const tab = env('ACE_TAB', 'Soccer');
const targetPath = env('ACE_PATH', '');   // e.g. /dashboard/game/<id> — skips tab logic

await mkdirForFile(out);
const browser = await launchBrowser();
const { context, page } = await newDashboardPage(browser, storageState);

await page.goto(`${baseURL}/dashboard`, { waitUntil: 'load', timeout: 30_000 });
try {
  await assertDashboard(page);
} catch (error) {
  if (!password) throw error;
  await login(page, baseURL, email, password);
  await context.storageState({ path: storageState });
}

if (targetPath) {
  // Direct page capture (e.g. a game research page).
  await page.goto(`${baseURL}${targetPath}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2500);
} else {
  // Board: filter to the requested sport tab so rows render from the top.
  try {
    await page.getByRole('button', { name: new RegExp(`\\b${tab}\\b`, 'i') }).first().click({ timeout: 8_000 });
    await page.waitForTimeout(1000);
  } catch (e) {
    console.warn(`tab "${tab}" click skipped: ${e.message}`);
  }
  // Next dev serves CSS via JS and can flash unstyled. Reload so CSS caches +
  // applies, wait for network idle, confirm stylesheets present before capture.
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByRole('button', { name: new RegExp(`\\b${tab}\\b`, 'i') }).first().click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(2500);
}
const diag = await page.evaluate(() => ({
  sheets: document.styleSheets.length,
  bodyBg: getComputedStyle(document.body).backgroundImage.slice(0, 40),
  rules: [...document.styleSheets].reduce((n, s) => { try { return n + (s.cssRules?.length || 0); } catch { return n; } }, 0),
}));

await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log(JSON.stringify({ ok: true, out, tab, url: page.url(), styleDiag: diag }, null, 2));
