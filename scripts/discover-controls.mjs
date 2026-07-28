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

  const info = await page.evaluate(() => {
    const visible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length);
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);

    const buttons = [];
    document.querySelectorAll('button, [role="button"], [role="tab"], [role="combobox"], [role="menuitem"]').forEach((b) => {
      if (!visible(b)) return;
      buttons.push({
        tag: b.tagName.toLowerCase(),
        role: b.getAttribute('role') || '',
        id: (b.id || '').substring(0, 50),
        aria: clean(b.getAttribute('aria-label')),
        text: clean(b.textContent),
      });
    });

    // Anything that looks like a ratio (contains ":") or a small number 1-4
    const ratioish = [];
    document.querySelectorAll('*').forEach((el) => {
      if (!visible(el) || el.children.length > 0) return;
      const t = (el.textContent || '').trim();
      if (/^(16:9|9:16|1:1|4:3|3:4)$/.test(t) || /^[1-4]$/.test(t)) {
        ratioish.push({ tag: el.tagName.toLowerCase(), text: t, aria: clean(el.getAttribute('aria-label')) });
      }
    });

    return { url: location.href, buttonCount: buttons.length, buttons, ratioish };
  }).catch((e) => ({ error: e.message }));

  console.log('==================== FLOW CONTROLS ====================');
  console.log(JSON.stringify(info, null, 2));
  console.log('=======================================================');

  try { await takeScreenshot(getPage(), 'discover-controls'); console.log('Screenshot saved under screenshots/'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
