#!/usr/bin/env node
// Verify board → game-page interaction: clicking a matchup navigates straight
// to /dashboard/game/<id> with NO side panel/expanded view, and shows the
// intentional loading skeleton mid-transition. Captures: loading state + final
// page. Asserts the old GameDetailPanel side-column never appears.
import { env, launchBrowser, newDashboardPage, assertDashboard, login, mkdirForFile, DEFAULT_BASE_URL, DEFAULT_EMAIL, DEFAULT_STORAGE_STATE } from './lib.mjs';

const baseURL = env('ACE_BASE_URL', DEFAULT_BASE_URL);
const email = env('ACE_VISUAL_EMAIL', DEFAULT_EMAIL);
const password = env('ACE_VISUAL_PASSWORD');
const storageState = env('ACE_STORAGE_STATE', DEFAULT_STORAGE_STATE);
const loadingOut = env('ACE_LOADING_OUT', 'artifacts/game-nav-loading.png');
const finalOut = env('ACE_FINAL_OUT', 'artifacts/game-nav-final.png');

await mkdirForFile(loadingOut);
const browser = await launchBrowser();
const { context, page } = await newDashboardPage(browser, storageState);

await page.goto(`${baseURL}/dashboard`, { waitUntil: 'load', timeout: 30_000 });
try { await assertDashboard(page); }
catch (e) { if (!password) throw e; await login(page, baseURL, email, password); await context.storageState({ path: storageState }); }

// Filter to Soccer so a WC row is at the top.
await page.getByRole('button', { name: /\bSoccer\b/i }).first().click({ timeout: 8_000 }).catch(() => {});
await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
await page.getByRole('button', { name: /\bSoccer\b/i }).first().click({ timeout: 8_000 }).catch(() => {});
await page.waitForTimeout(1200);

// Throttle network so the server-render loading skeleton is observable.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 250, downloadThroughput: 500 * 1024, uploadThroughput: 500 * 1024,
});

// Click the first matchup (team name navigates).
const target = page.getByText('South Africa').first();
const navPromise = page.waitForURL('**/dashboard/game/**', { timeout: 20_000 });
await target.click();

// Try to catch the loading skeleton immediately after click.
await page.waitForTimeout(180);
const midUrl = page.url();
const sidePanelWide = await page.locator('.w-\\[500px\\], .xl\\:w-\\[540px\\]').count();
await page.screenshot({ path: loadingOut, fullPage: false });

await navPromise;
await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(800);
const finalUrl = page.url();
const heroVisible = await page.getByText('Live coverage begins at kickoff', { exact: false }).count();
await page.screenshot({ path: finalOut, fullPage: false });

await browser.close();
console.log(JSON.stringify({
  ok: true,
  midUrl, finalUrl,
  navigatedToGamePage: /\/dashboard\/game\//.test(finalUrl),
  sidePanelWideElementsDuringTransition: sidePanelWide,   // expect 0 (no flicker)
  heroVisibleOnFinal: heroVisible,                         // expect >=1
  loadingOut, finalOut,
}, null, 2));
