#!/usr/bin/env node
import { DEFAULT_BASE_URL, DEFAULT_EMAIL, DEFAULT_STORAGE_STATE, env, launchBrowser, login, mkdirForFile, requireEnv } from './lib.mjs';

const baseURL = env('ACE_BASE_URL', DEFAULT_BASE_URL);
const email = env('ACE_VISUAL_EMAIL', DEFAULT_EMAIL);
const password = requireEnv('ACE_VISUAL_PASSWORD');
const storageState = env('ACE_STORAGE_STATE', DEFAULT_STORAGE_STATE);

await mkdirForFile(storageState);
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(Number(env('ACE_PLAYWRIGHT_TIMEOUT_MS', '20000')));
await login(page, baseURL, email, password);
await context.storageState({ path: storageState });
await browser.close();
console.log(JSON.stringify({ ok: true, baseURL, email, storageState }, null, 2));
