import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveChromePath, resolveProfileSource, makeTempProfileDir } from '../utils/paths.js';
import { takeScreenshot } from '../utils/screenshots.js';

let browser = null;
let context = null;
let page = null;
let isConnected = false;

export async function connectToBrowser(options = {}) {
  if (isConnected && page) {
    logger.info('Already connected to browser');
    return { browser, context, page };
  }

  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  try {
    // Try connecting to existing Chrome instance via CDP
    logger.info('Attempting CDP connection', { url: cdpUrl });
    browser = await chromium.connectOverCDP(cdpUrl);
    logger.info('Connected via CDP');

    const contexts = browser.contexts();
    context = contexts[0] || null;

    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
    isConnected = true;
    logger.info('Browser connected successfully');
    return { browser, context, page };
  } catch (err) {
    logger.warn('CDP connection failed, will launch new browser', { error: err.message });
    return await launchNewBrowser(cdpPort, options);
  }
}

async function launchNewBrowser(cdpPort, options = {}) {
  const chromePath = resolveChromePath(options.chromePath || get('chromePath'));
  const profileDir = options.profileDir || path.resolve(import.meta.dirname, '../../chrome-profile-kiara');

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--window-size=1920,1080`,
  ];

  if (get('headless', false)) {
    args.push('--headless=new');
  }

  // Kill any existing Chrome on this debugging port
  try {
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await existing.close();
  } catch (e) {
    // No existing instance, that's fine
  }

  logger.info('Launching Chrome with Kiara profile', {
    chromePath,
    profileDir,
    cdpPort,
  });

  browser = await chromium.launch({
    executablePath: chromePath,
    args,
    headless: false,
  });

  context = browser.contexts()[0] || await browser.newContext();
  page = context.pages()[0] || await context.newPage();
  isConnected = true;

  logger.info('New browser launched successfully');
  return { browser, context, page };
}

/**
 * Launch Chrome DIRECTLY (not via Playwright) to avoid automation detection
 * (navigator.webdriver=false). Creates temp user-data-dir with Profile 3 cookies,
 * launches Chrome via shell, then connects Playwright via CDP.
 */
export async function launchChromeDirect(options = {}) {
  const chromePath = resolveChromePath(options.chromePath || get('chromePath'));
  const headless = options.headless ?? get('headless', false);
  const userDir = options.profileSource || get('chromeUserDataDir') || '/home/beka/.config/google-chrome';

  if (isConnected && page && !page.isClosed()) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  // Auto-clean any stale Singleton locks to prevent "Failed to create ProcessSingleton" aborts
  try {
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const p = path.join(userDir, lock);
      if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true });
    }
  } catch {}

  const args = [
    '--password-store=basic',
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  }

  logger.info('Launching Chrome persistent context directly', { chromePath, userDir, headless });

  context = await chromium.launchPersistentContext(userDir, {
    executablePath: chromePath,
    headless,
    args,
    viewport: { width: 1920, height: 1080 },
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' }
  });

  browser = context.browser() || null;
  const pages = context.pages();
  page = pages.find(p => p.url().includes('labs.google')) || pages[0] || await context.newPage();
  isConnected = true;

  logger.info('Chrome persistent context launched successfully', { url: page.url() });
  return { browser, context, page };
}

export async function closeBrowser() {
  if (global.__chromeTempDir) {
    try { fs.rmSync(global.__chromeTempDir, { recursive: true, force: true }); }
    catch (e) { logger.warn('Temp cleanup failed', { error: e.message }); }
    global.__chromeTempDir = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      logger.warn('Error closing browser', { error: err.message });
    }
  }
  browser = null;
  context = null;
  page = null;
  isConnected = false;
  logger.info('Browser disconnected');
}

export function getPage() {
  if (context) {
    try {
      const pages = context.pages();
      for (const p of pages) {
        if (p.url().includes('labs.google')) return p;
      }
      if (pages.length > 0) return pages[pages.length - 1];
    } catch {}
  }
  if (!page) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'Browser not connected. Call connectToBrowser() first.');
  }
  return page;
}

export function getContext() {
  return context;
}

export function isBrowserConnected() {
  return isConnected;
}

export function setPage(newPage) {
  page = newPage;
}

export function getBrowser() {
  return browser;
}

export function setBrowser(b) {
  browser = b;
}

export function setConnected(connected) {
  isConnected = connected;
}

export function setContext(ctx) {
  context = ctx;
}
