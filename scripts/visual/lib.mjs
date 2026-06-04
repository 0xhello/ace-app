import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

export const DEFAULT_BASE_URL = 'http://localhost:3000';
export const DEFAULT_EMAIL = 'visual-test@ace.local';
export const DEFAULT_STORAGE_STATE = '.auth/ace-dashboard.json';
export const DEFAULT_SCREENSHOT_OUT = 'artifacts/dashboard-current.png';

export function env(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function requireEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function isLocalBaseUrl(baseURL) {
  try {
    const host = new URL(baseURL).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export async function mkdirForFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function launchBrowser() {
  const channel = env('ACE_PLAYWRIGHT_CHANNEL', 'chrome');
  try {
    return await chromium.launch({ channel, headless: true });
  } catch (error) {
    if (channel !== 'chromium') {
      console.warn(`Could not launch Playwright channel '${channel}', falling back to bundled chromium. Original error: ${error.message}`);
      return chromium.launch({ headless: true });
    }
    throw error;
  }
}

export async function newDashboardPage(browser, storageState) {
  const contextOptions = {
    viewport: { width: Number(env('ACE_VIEWPORT_WIDTH', '1440')), height: Number(env('ACE_VIEWPORT_HEIGHT', '1100')) },
    deviceScaleFactor: Number(env('ACE_DEVICE_SCALE_FACTOR', '1')),
  };
  if (storageState && await fileExists(storageState)) {
    contextOptions.storageState = storageState;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(Number(env('ACE_PLAYWRIGHT_TIMEOUT_MS', '20000')));
  return { context, page };
}

export async function login(page, baseURL, email, password) {
  await page.goto(`${baseURL}/login`, { waitUntil: 'load', timeout: 30_000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  // Dispatch through the DOM so this survives occasional Playwright click/hydration timing weirdness.
  await page.locator('button[type="submit"]').evaluate((el) => el.click());
  await page.waitForURL(/\/dashboard(?:\/.*)?$/, { timeout: 20_000 }).catch(() => null);
  if (!page.url().includes('/dashboard')) {
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'load', timeout: 30_000 });
  }
  await assertDashboard(page);
}

export async function assertDashboard(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(Number(env('ACE_DASHBOARD_SETTLE_MS', '2500')));
  const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  if (page.url().includes('/login') || /Sign in/i.test(bodyText.slice(0, 800))) {
    throw new Error(`Dashboard auth failed; still on login. url=${page.url()}`);
  }
  if (!/Board|Tracked|Settings|Ask ACE|Signal Feed/i.test(bodyText)) {
    throw new Error(`Dashboard did not look ready. url=${page.url()} body=${bodyText.slice(0, 300)}`);
  }
}

export function runPython(script) {
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `python exited ${result.status}`);
  }
  return result.stdout.trim();
}
