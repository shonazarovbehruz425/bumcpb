#!/usr/bin/env node
// Discover the controls for (a) moving a generated image to trash and
// (b) emptying the trash. Non-destructive: only lists buttons/menu items.
// Run: node scripts/discover-trash.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3500);

  // (A) Buttons around the first few generated images (per-image actions).
  const cards = await page.evaluate((cleanStr) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);
    const imgs = [...document.querySelectorAll('img')].filter(
      (i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80
    );
    const out = [];
    imgs.slice(0, 3).forEach((img) => {
      let el = img, found = null;
      for (let i = 0; i < 9 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.querySelectorAll('button,[role="button"],[role="menuitem"]').length) { found = el; break; }
      }
      const btns = found
        ? [...found.querySelectorAll('button,[role="button"],[role="menuitem"]')].map((b) => ({
            text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), id: clean(b.id),
          }))
        : [];
      out.push({ src: (img.src || '').substring(0, 70), buttons: btns.slice(0, 14) });
    });
    return out;
  });

  // Try opening the first image's "more options" (three-dot) to reveal a menu.
  let menuItems = [];
  try {
    const firstImg = page.locator('img').filter({ has: page.locator('xpath=.') }).first();
    // Hover the first media image's card, then click a nearby more_vert button.
    const moreBtn = page.locator('button:has-text("more_vert"), [aria-label*="options"], [aria-label*="Options"]').first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      menuItems = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);
        return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="dialog"] button')]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')) }))
          .slice(0, 20);
      });
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch {}

  // (B) Navigate to the Corbeille (trash) and dump its buttons.
  let trashButtons = [];
  try {
    const trashNav = page.locator('button:has-text("corbeille"), [aria-label*="corbeille"], [aria-label*="Corbeille"]').first();
    if (await trashNav.isVisible().catch(() => false)) {
      await trashNav.click().catch(() => {});
      await page.waitForTimeout(2500);
      trashButtons = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);
        return [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
          .filter((b) => b.offsetParent !== null)
          .map((b) => ({ text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), id: clean(b.id) }))
          .slice(0, 40);
      });
    }
  } catch {}

  console.log('==================== IMAGE CARD BUTTONS ====================');
  console.log(JSON.stringify(cards, null, 2));
  console.log('==================== IMAGE "MORE" MENU ====================');
  console.log(JSON.stringify(menuItems, null, 2));
  console.log('==================== TRASH PAGE BUTTONS ====================');
  console.log(JSON.stringify(trashButtons, null, 2));
  console.log('===========================================================');

  try { await takeScreenshot(getPage(), 'discover-trash'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
