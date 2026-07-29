#!/usr/bin/env node
// Discover Flow's "add media / reference image" UI so we can upload a reference
// for image-to-image. Non-destructive (opens the add dialog, dumps controls).
// Run: node scripts/discover-addmedia.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);

async function dump(page, label) {
  const d = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);
    const vis = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
    const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((i) => ({
      accept: i.accept || '', multiple: i.multiple, name: i.name || '', id: clean(i.id), visible: vis(i),
    }));
    const dialogButtons = [...document.querySelectorAll('[role="dialog"] button, [role="menu"] [role="menuitem"], [role="dialog"] [role="tab"]')]
      .filter((b) => vis(b)).map((b) => ({ text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')) })).slice(0, 25);
    const anyButtonsWithAdd = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => vis(b) && /Ajouter|Importer|Télécharger un|Upload|Référence|Image/i.test(b.textContent || ''))
      .map((b) => ({ text: clean(b.textContent), id: clean(b.id) })).slice(0, 20);
    return { fileInputsTotal: document.querySelectorAll('input[type="file"]').length, fileInputs, dialogButtons, anyButtonsWithAdd };
  }).catch((e) => ({ error: e.message }));
  console.log(`\n----- ${label} -----`);
  console.log(JSON.stringify(d, null, 2));
}

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3500);

  await dump(page, 'BEFORE (project page)');

  // Click "Ajouter un contenu multimédia" (the add_2 / add button).
  const addBtn = page.locator('button:has-text("Ajouter un contenu"), button:has-text("add_2"), [aria-label*="Ajouter un contenu"]').first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click().catch(() => {});
    console.log('\n[add] clicked "Ajouter un contenu multimédia"');
    await page.waitForTimeout(2000);
  } else {
    console.log('\n[add] add button not found — dumping composer area buttons');
  }
  await dump(page, 'AFTER add click');

  // Also: hover the composer to reveal an inline "add reference" control.
  try {
    const composer = page.locator('[contenteditable="true"], textarea').first();
    if (await composer.isVisible().catch(() => false)) { await composer.click().catch(() => {}); await page.waitForTimeout(1000); }
  } catch {}
  await dump(page, 'AFTER composer focus');

  try { await takeScreenshot(getPage(), 'discover-addmedia'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
