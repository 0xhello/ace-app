#!/usr/bin/env node
import { DEFAULT_BASE_URL, DEFAULT_EMAIL, DEFAULT_SCREENSHOT_OUT, DEFAULT_STORAGE_STATE, assertDashboard, env, fileExists, launchBrowser, login, mkdirForFile, newDashboardPage } from './lib.mjs';

const baseURL = env('ACE_BASE_URL', DEFAULT_BASE_URL);
const email = env('ACE_VISUAL_EMAIL', DEFAULT_EMAIL);
const password = env('ACE_VISUAL_PASSWORD');
const storageState = env('ACE_STORAGE_STATE', DEFAULT_STORAGE_STATE);
const out = env('ACE_SCREENSHOT_OUT', DEFAULT_SCREENSHOT_OUT);

await mkdirForFile(out);
const browser = await launchBrowser();
const { context, page } = await newDashboardPage(browser, storageState);

if (await fileExists(storageState)) {
  await page.goto(`${baseURL}/dashboard`, { waitUntil: 'load', timeout: 30_000 });
  try {
    await assertDashboard(page);
  } catch (error) {
    if (!password) throw error;
    await login(page, baseURL, email, password);
    await context.storageState({ path: storageState });
  }
} else {
  if (!password) {
    throw new Error(`No storage state at ${storageState}. Run npm run visual:auth with ACE_VISUAL_PASSWORD first, or provide ACE_VISUAL_PASSWORD to this command.`);
  }
  await login(page, baseURL, email, password);
  await context.storageState({ path: storageState });
}

await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(JSON.stringify({ ok: true, baseURL, url: page.url(), out, storageState }, null, 2));
