import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { resolveChromePath, resolveProfileSource } from '../utils/paths.js';
import { launchChromeDirect, setPage, setContext, setConnected, setBrowser, isBrowserConnected } from './connect.js';

const CDP_PORT = get('cdpPort', 9222);
const FLOW_URL = get('flowUrl', 'https://labs.google/fx/fr/tools/flow');

export async function launchKiaraProfile(headless = false) {
  if (isBrowserConnected()) {
    logger.info('Browser already connected, reusing');
    return { success: true, message: 'Already connected' };
  }

  const chromePath = resolveChromePath(get('chromePath'));
  const userDataDir = get('chromeUserDataDir');
  const profileName = get('chromeProfile', 'Profile 3');
  const profileSource = resolveProfileSource(userDataDir, profileName);

  if (!fs.existsSync(profileSource)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS,
      `Chrome profile "${profileName}" not found at ${profileSource}. Make sure the profile exists and is configured with your Google account.`);
  }

  logger.info('Launching Chrome via direct+CDP method (anti-detection)', { profileSource });

  try {
    // Try connecting to existing Chrome instance first
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    logger.info('Found existing Chrome instance, reusing');
    const ctx = existing.contexts()[0];
    const pg = ctx?.pages()[0];
    setBrowser(existing);
    setContext(ctx);
    setConnected(true);
    if (pg) { setPage(pg); return { browser: existing, context: ctx, page: pg }; }
    const newPage = await ctx.newPage();
    setPage(newPage);
    return { browser: existing, context: ctx, page: newPage };
  } catch {
    // Launch Chrome directly (not via Playwright) for anti-detection
    return await launchChromeDirect({
      chromePath,
      cdpPort: CDP_PORT,
      headless,
      profileSource,
      profileName,
    });
  }
}

export async function navigateToFlow(page, toolPage) {
  const targetUrl = toolPage === true
    ? 'https://labs.google/fx/fr/tools/flow'
    : FLOW_URL;

  logger.info('Navigating to Google Flow', { url: targetUrl });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Give the SPA time to hydrate (Flow keeps network busy, so we don't wait for networkidle).
  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });

  if (currentUrl.includes('accounts.google.com')) {
    return { authenticated: false, url: currentUrl,
      message: 'OAuth blocked — Google detects automation. Use Chrome direct+CDP launch method.' };
  }

  return { authenticated: true, url: currentUrl };
}
