#!/usr/bin/env node
// Discover the Flow project toolbar controls (model, ratio, image-count, generate).
// Connects headless, enters a project, dumps interactive controls + a screenshot.
// Run: node scripts/discover-controls.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { name: 'Discover', campaign: 'telegram' });
  await page.waitForTimeout(3000);

  const dump = () => page.evaluate(() => {
    const visible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length);
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);
    const out = [];
    document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="combobox"], [role="menuitem"], ' +
      '[role="menuitemradio"], [role="radio"], [role="option"], [role="switch"], [role="slider"], input'
    ).forEach((b) => {
      if (!visible(b)) return;
      out.push({
        tag: b.tagName.toLowerCase(),
        role: b.getAttribute('role') || '',
        id: (b.id || '').substring(0, 40),
        type: b.getAttribute('type') || '',
        aria: clean(b.getAttribute('aria-label')),
        val: clean(b.value),
        text: clean(b.textContent),
      });
    });
    return out;
  }).catch(() => []);

  const before = await dump();

  // Open the settings popover (the "Nano Banana ... crop_ ... x1" button).
  let opened = false;
  const triggers = [
    page.locator('button:has-text("Nano Banana")').first(),
    page.locator('button:has-text("Banana")').first(),
    page.locator('button:has-text("crop_")').first(),
  ];
  for (const t of triggers) {
    if (await t.isVisible().catch(() => false)) {
      await t.click().catch(() => {});
      opened = true;
      break;
    }
  }
  await page.waitForTimeout(1800);
  const afterSettings = await dump();

  console.log('==================== TOOLBAR (closed) ====================');
  console.log(JSON.stringify(before, null, 2));
  console.log('============ SETTINGS POPOVER (opened=' + opened + ') ============');
  console.log(JSON.stringify(afterSettings, null, 2));
  console.log('==========================================================');

  try { await takeScreenshot(getPage(), 'discover-controls'); console.log('Screenshot saved under screenshots/'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
