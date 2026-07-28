#!/usr/bin/env node
// Discover the PER-IMAGE options menu (hover an image -> its own actions),
// so we can delete a single image (not the whole project).
// Run: node scripts/discover-image-menu.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(4000);

  const imgCount = await page.evaluate(() => [...document.querySelectorAll('img')]
    .filter((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80).length).catch(() => 0);
  console.log('[menu] media images on page:', imgCount);
  if (!imgCount) { console.log('[menu] no images to inspect'); await closeBrowser(); process.exit(0); }

  // Hover the first media image to reveal its card action buttons.
  try {
    const handle = await page.evaluateHandle(() => {
      const img = [...document.querySelectorAll('img')].find((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80);
      return img;
    });
    const box = await handle.asElement().boundingBox().catch(() => null);
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(1200); }
  } catch (e) { console.log('[menu] hover error', e.message); }

  // Dump buttons inside the first image's card (after hover).
  const cardButtons = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 50);
    const img = [...document.querySelectorAll('img')].find((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80);
    if (!img) return [];
    let el = img, found = null;
    for (let i = 0; i < 9 && el; i++) { el = el.parentElement; if (!el) break; if (el.querySelectorAll('button,[role="button"]').length) { found = el; break; } }
    if (!found) return [];
    return [...found.querySelectorAll('button,[role="button"]')].map((b) => ({
      icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), title: clean(b.getAttribute('title')), id: clean(b.id),
    })).slice(0, 15);
  });

  // Try clicking a per-image options button (icon "more_vert" inside the card) and dump the menu.
  let menu = [];
  try {
    // The image's own options button is likely the LAST more_vert on the page
    // (the first ones belong to the top toolbar).
    const moreButtons = page.locator('button:has-text("more_vert")');
    const n = await moreButtons.count();
    if (n > 0) {
      await moreButtons.nth(n - 1).click().catch(() => {}); // last one is likely the image's
      await page.waitForTimeout(1000);
      menu = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 50);
        return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')) })).slice(0, 20);
      });
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (e) { console.log('[menu] menu error', e.message); }

  console.log('==================== CARD BUTTONS (after hover) ====================');
  console.log(JSON.stringify(cardButtons, null, 2));
  console.log('==================== LAST more_vert MENU ====================');
  console.log(JSON.stringify(menu, null, 2));
  console.log('=============================================================');
  try { await takeScreenshot(getPage(), 'discover-image-menu'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
