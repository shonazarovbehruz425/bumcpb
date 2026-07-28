// Keep the Flow project light by moving generated images to trash ONE BY ONE
// (per-image "Placer dans la corbeille" — never the project-level delete),
// then emptying the trash. Correlation/download happen at generation time,
// so clearing afterwards is safe.
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

// Move up to `max` images to the trash, one at a time, via each image's own menu.
export async function trashImages(max = 100) {
  const page = getPage();
  let removed = 0;

  for (let k = 0; k < max; k++) {
    const count = await countMedia(page);
    if (count <= 0) break;

    // Reset hover state, then hover the first media image.
    await page.mouse.move(5, 5).catch(() => {});
    await page.waitForTimeout(300);
    const box = await page.evaluate(() => {
      const img = [...document.querySelectorAll('img')]
        .find((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80);
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!box) break;
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(900);

    // The hovered image's options button is the last visible "more_vert".
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      const more = page.locator('button:has-text("more_vert")').last();
      if (await more.isVisible().catch(() => false)) {
        await more.click().catch(() => {});
        await page.waitForTimeout(700);
        const item = page.locator('[role="menuitem"]:has-text("Placer dans la corbeille"), button:has-text("Placer dans la corbeille")').first();
        if (await item.isVisible().catch(() => false)) {
          await item.click().catch(() => {});
          opened = true;
        } else {
          await page.keyboard.press('Escape').catch(() => {});
          await page.mouse.move(box.x, box.y);
          await page.waitForTimeout(600);
        }
      } else {
        await page.mouse.move(box.x, box.y);
        await page.waitForTimeout(600);
      }
    }
    if (!opened) { logger.warn('trashImages: could not open per-image menu — stopping', { removed }); break; }

    await page.waitForTimeout(1000);
    const confirm = page.locator('[role="dialog"] button:has-text("Supprimer"), [role="alertdialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer")').first();
    await clickIfVisible(confirm);
    // Wait for the gallery to re-render after removal.
    await page.waitForTimeout(2000);

    removed++;
  }

  logger.info('Images moved to trash', { removed });
  return { removed };
}

// Permanently empty the trash ("Tout supprimer") via the /trash URL, then return.
export async function emptyTrash() {
  const page = getPage();
  await page.keyboard.press('Escape').catch(() => {});
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
    logger.warn('emptyTrash: "Tout supprimer" not found (trash may be empty)');
  }

  try { await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500); } catch {}
  return true;
}

// Full cleanup: trash all images (per-image) + empty trash.
export async function cleanupProject() {
  try {
    const r = await trashImages();
    await emptyTrash();
    return r;
  } catch (e) {
    logger.warn('cleanup failed', { error: e.message });
    return { removed: 0, error: e.message };
  }
}
