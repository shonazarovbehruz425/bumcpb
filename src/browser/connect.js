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
    if (contexts.length > 0) {
      context = contexts[0];
    } else {
      context = await browser.newContext();
    }

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
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);
  const profileName = options.profileName || get('chromeProfile', 'Profile 3');
  const profileSource = options.profileSource || resolveProfileSource(get('chromeUserDataDir'), profileName);

  if (isConnected && page) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }

  if (!fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `Chrome not found at ${chromePath}`);
  }

  const tempDir = makeTempProfileDir();
  fs.mkdirSync(tempDir, { recursive: true });

  const localStateSrc = path.join(path.dirname(profileSource), 'Local State');
  if (fs.existsSync(profileSource)) {
    fs.cpSync(profileSource, path.join(tempDir, profileName), { recursive: true });
  }
  if (fs.existsSync(localStateSrc)) {
    fs.cpSync(localStateSrc, path.join(tempDir, 'Local State'));
  } else {
    fs.writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));
  }

  logger.info('Temp profile created with cookies', { tempDir });

  // FIRST: Try to connect to existing Chrome (e.g. opened manually via VNC)
  // Retry up to 3 times with delays in case Chrome CDP server is still initializing
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(`Attempting to connect to existing Chrome on CDP (attempt ${attempt}/3)`, { cdpPort });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        context = contexts[0];
        const pages = context.pages();
        page = pages.length > 0 ? pages[0] : await context.newPage();
      } else {
        context = await browser.newContext();
        page = await context.newPage();
      }
      isConnected = true;
      logger.info('✅ Connected to existing Chrome successfully', { 
        attempt,
        contexts: browser.contexts().length,
        pages: context.pages().length,
        currentUrl: await page.url().catch(() => 'unknown')
      });
      return { browser, context, page };
    } catch (e) {
      logger.warn(`Connection attempt ${attempt}/3 failed`, { error: e.message });
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
      } else {
        logger.info('All connection attempts failed, will launch new Chrome', { error: e.message });
      }
    }
  }

  const realUserDataDir = profileSource ? path.dirname(profileSource) : tempDir;
  try {
    const lockPath = path.join(realUserDataDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {}

  logger.info('Launching persistent Chrome via Playwright', { chromePath, cdpPort, headless, realUserDataDir, profileName });

  const launchArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--profile-directory=${profileName}`,
    '--password-store=basic',
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'
  ];

  context = await chromium.launchPersistentContext(realUserDataDir, {
    executablePath: chromePath,
    headless: headless,
    args: launchArgs,
    viewport: { width: 1920, height: 1080 }
  });
  page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  isConnected = true;
  global.__chromeTempDir = tempDir;

  logger.info('Chrome persistent context launched successfully');
  return { browser: context, context, page };
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
