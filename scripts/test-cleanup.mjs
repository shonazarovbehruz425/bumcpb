#!/usr/bin/env node
// Test the project cleanup (clear media + empty trash) safely.
// Run: node scripts/test-cleanup.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { cleanupProject } from '../src/tools/flow-cleanup.js';

async function count(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')]
    .filter((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80).length).catch(() => -1);
}

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3000);

  console.log('URL before      :', page.url());
  console.log('Images before   :', await count(page));

  const r = await cleanupProject();
  console.log('Cleanup result  :', JSON.stringify(r));

  await page.waitForTimeout(2000);
  console.log('URL after       :', page.url());
  console.log('Images after    :', await count(page));
  console.log('Project intact  :', page.url().includes('/project/'));

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
