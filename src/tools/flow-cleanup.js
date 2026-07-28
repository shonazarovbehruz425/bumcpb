// Keep the Flow project light: move all generated media to trash, then empty it.
// Correlation/download happen at generation time, so clearing afterward is safe.
import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';

async function clickIfVisible(loc) {
  if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return true; }
  return false;
}

async function countMedia(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')]
    .filter((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80).length)
    .catch(() => -1);
}

// Move all media in the current project to the trash (bulk "Supprimer").
export async function clearProjectMedia() {
  const page = getPage();
  const before = await countMedia(page);
  if (before <= 0) return { cleared: 0 };

  const more = page.locator('button:has-text("more_vert")').first();
  if (!(await clickIfVisible(more))) { logger.warn('cleanup: options menu not found'); return { cleared: 0 }; }
  await page.waitForTimeout(800);

  const del = page.locator('[role="menuitem"]:has-text("Supprimer"), button:has-text("Supprimer")')
    .filter({ hasNotText: 'corbeille' }).first();
  if (!(await clickIfVisible(del))) { await page.keyboard.press('Escape').catch(() => {}); return { cleared: 0 }; }
  await page.waitForTimeout(1000);

  const confirm = page.locator(
    '[role="dialog"] button:has-text("Supprimer"), [role="alertdialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer")'
  ).first();
  await clickIfVisible(confirm);
  await page.waitForTimeout(2000);

  const after = await countMedia(page);
  logger.info('Project media cleared', { before, after });
  return { cleared: before - Math.max(after, 0), before, after };
}

// Permanently empty the trash ("Tout supprimer"), then return to the media view.
export async function emptyTrash() {
  const page = getPage();
  await page.keyboard.press('Escape').catch(() => {}); // ensure no menu open

  // Navigate directly to the trash view (reliable, avoids the sidebar button).
  const base = page.url().replace(/\/trash.*$/, '').replace(/[?#].*$/, '');
  try {
    await page.goto(base + '/trash', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  } catch {}

  const emptyBtn = page.locator('button:has-text("Tout supprimer")').first();
  if (await clickIfVisible(emptyBtn)) {
    await page.waitForTimeout(1000);
    const confirm = page.locator(
      '[role="dialog"] button:has-text("Supprimer"), [role="alertdialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer"), [role="dialog"] button:has-text("Tout supprimer")'
    ).last();
    await clickIfVisible(confirm);
    await page.waitForTimeout(2000);
    logger.info('Trash emptied');
  } else {
    logger.warn('cleanup: "Tout supprimer" not found on trash page (trash may already be empty)');
  }

  // Return to the project media view.
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
  } catch {}
  return true;
}

// Full cleanup: clear media + empty trash.
export async function cleanupProject() {
  try {
    const r = await clearProjectMedia();
    await emptyTrash();
    return r;
  } catch (e) {
    logger.warn('cleanup failed', { error: e.message });
    return { cleared: 0, error: e.message };
  }
}
