#!/usr/bin/env node
// Discover (a) how a reference "ingredient" actually attaches to the composer,
// and (b) how to CLEAR/REMOVE it — so a job's references never leak into the
// next job on the shared persistent composer.
// Non-destructive. Run with the API stopped:
//   pm2 stop flow-api; pkill -9 -f chrome; rm -rf /tmp/chrome-kiara-cdp-*
//   node scripts/discover-ref-clear.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);

async function makeTestImage() {
  const tmp = path.join(os.tmpdir(), `flow-ref-discover-${Date.now()}.png`);
  try {
    const sharp = (await import('sharp')).default;
    const buf = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 210, g: 60, b: 60 } } }).png().toBuffer();
    fs.writeFileSync(tmp, buf);
  } catch {
    // Fallback: tiny 2x2 red PNG.
    fs.writeFileSync(tmp, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAX0wP9Fq0zHwAAAABJRU5ErkJggg==', 'base64'));
  }
  return tmp;
}

// Dump the file inputs currently in the DOM.
async function dumpInputs(page, label) {
  const d = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);
    return [...document.querySelectorAll('input[type="file"]')].map((i, idx) => ({
      idx, accept: i.accept || '', multiple: i.multiple, name: i.name || '', id: clean(i.id),
      visible: i.offsetParent !== null,
    }));
  }).catch(() => []);
  console.log(`\n----- file inputs @ ${label}: ${d.length} -----`);
  console.log(JSON.stringify(d, null, 2));
  return d;
}

// Look for reference thumbnails near the composer + any remove/close control,
// AND log the composer subtree so we can see the real chip structure.
async function dumpChips(page, label) {
  const d = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);
    const vis = (el) => el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));

    // Scan the WHOLE document for ALL image elements, background images, svgs, and buttons.
    const allImgs = [...document.querySelectorAll('img, [style*="background-image"], canvas, svg')]
      .filter(vis)
      .map((i) => {
        const style = window.getComputedStyle(i);
        const bg = style.backgroundImage || '';
        const src = i.src || i.getAttribute('src') || bg;
        const rect = i.getBoundingClientRect();
        let el = i, chip = null, btns = [];
        for (let k = 0; k < 6 && el; k++) {
          el = el.parentElement; if (!el) break;
          const b = [...el.querySelectorAll('button,[role="button"]')];
          if (b.length && b.length <= 6) { chip = el; btns = b; break; }
        }
        return {
          tag: i.tagName,
          srcHead: clean(src),
          rect: `${Math.round(rect.width)}x${Math.round(rect.height)} @ (${Math.round(rect.left)},${Math.round(rect.top)})`,
          alt: clean(i.alt || i.getAttribute('aria-label')),
          chipCls: chip ? clean(chip.className) : null,
          chipBtns: btns.map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), cls: clean(b.className) })),
        };
      }).slice(0, 25);

    // All buttons near composer area or prompt container
    const composer = document.querySelector('[contenteditable="true"], textarea');
    let composerContainerBtns = [];
    if (composer) {
      let p = composer;
      for (let k = 0; k < 5 && p; k++) {
        p = p.parentElement;
      }
      if (p) {
        composerContainerBtns = [...p.querySelectorAll('button, [role="button"]')].map((b) => ({
          text: clean(b.textContent),
          aria: clean(b.getAttribute('aria-label')),
          cls: clean(b.className),
        }));
      }
    }

    // Any open dialog + its buttons
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(vis).map((dg) => ({
      heading: clean(dg.querySelector('h1,h2,h3,[role="heading"]')?.textContent),
      buttons: [...dg.querySelectorAll('button,[role="button"]')].filter(vis).map((b) => clean(b.textContent)).slice(0, 15),
    }));

    // Global buttons whose icon is a chip-remove (close/×).
    const removeBtns = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => vis(b) && /^close$|^close[A-Z]|✕|×|^clear$|delete|supprimer|remove/i.test(clean(b.textContent) + ' ' + clean(b.getAttribute('aria-label'))))
      .map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), cls: clean(b.className) }))
      .slice(0, 15);

    return { composerFound: !!composer, totalImgs: document.querySelectorAll('img').length, allImgs, composerContainerBtns, dialogs, removeBtns };
  }).catch((e) => ({ error: e.message }));
  console.log(`\n==================== CHIPS @ ${label} ====================`);
  console.log(JSON.stringify(d, null, 2));
  return d;
}

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3500);

  await dumpInputs(page, 'BEFORE');
  await dumpChips(page, 'BEFORE');

  // STEP 1: open the "Ajouter un contenu multimédia" menu.
  const addBtn = page.locator('button:has-text("Ajouter un contenu"), button:has-text("add_2"), [aria-label*="Ajouter un contenu"]').first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click().catch(() => {});
    console.log('\n[ref] clicked "Ajouter un contenu multimédia"');
    await page.waitForTimeout(1500);
    const menu = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);
      return [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="dialog"] button')]
        .filter((b) => b.offsetParent !== null).map((b) => ({ text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')) })).slice(0, 25);
    }).catch(() => []);
    console.log('[ref] add-media menu items:', JSON.stringify(menu, null, 2));
  } else {
    console.log('\n[ref] "Ajouter un contenu" button NOT found');
  }
  await dumpInputs(page, 'AFTER add-menu open');

  // STEP 2: click "Importer l'élément multimédia" and upload test image via filechooser or input.
  const tmp = await makeTestImage();
  try {
    const importItem = page.locator('[role="menuitem"]:has-text("Importer"), button:has-text("Importer")').first();
    let uploaded = false;

    if (await importItem.isVisible().catch(() => false)) {
      console.log('[ref] clicking "Importer" menu item with filechooser listener...');
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
        importItem.click().catch(() => {}),
      ]);
      if (fileChooser) {
        await fileChooser.setFiles(tmp);
        console.log('[ref] uploaded via fileChooser event');
        uploaded = true;
      } else {
        console.log('[ref] fileChooser event timeout, falling back to setInputFiles');
      }
    }

    if (!uploaded) {
      const inputs = page.locator('input[type="file"]');
      const n = await inputs.count();
      for (let i = 0; i < n; i++) {
        const acc = await inputs.nth(i).getAttribute('accept').catch(() => '') || '';
        if (/image|\*/.test(acc) || acc === '') {
          await inputs.nth(i).setInputFiles(tmp).catch(() => {});
          console.log(`\n[ref] setInputFiles on input #${i} (accept="${acc}")`);
          uploaded = true; break;
        }
      }
      if (!uploaded && n > 0) { await inputs.first().setInputFiles(tmp).catch(() => {}); console.log('\n[ref] setInputFiles on first input (fallback)'); }
    }
    await page.waitForTimeout(2000);

    // Check for "Notification" consent dialog ("J'accepte") and click it if present
    const acceptBtn = page.locator('button:has-text("J\'accepte"), button:has-text("Accepter"), button:has-text("Approve"), [role="dialog"] button:has-text("J\'accepte")').first();
    if (await acceptBtn.isVisible().catch(() => false)) {
      console.log('\n[ref] Notification consent dialog detected! Clicking "J\'accepte"...');
      await acceptBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    await page.waitForTimeout(5000);
  } catch (e) { console.log('[ref] upload error:', e.message); }

  const after = await dumpChips(page, 'AFTER upload');

  // STEP 3: Hover over the uploaded media card and inspect action buttons / context menu
  console.log('\n[ref] Hovering over imported media card to inspect ingredient attachment buttons...');
  try {
    const mediaCard = page.locator('img[src*="media.getMediaUrlRedirect"]').first();
    if (await mediaCard.isVisible().catch(() => false)) {
      await mediaCard.hover().catch(() => {});
      await page.waitForTimeout(1000);
      
      const cardOptions = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 70);
        const vis = (el) => el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
        
        return [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
          .filter(vis)
          .map((b) => ({ text: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), cls: clean(b.className) }))
          .slice(0, 30);
      });
      console.log('[ref] Buttons visible on media card hover:', JSON.stringify(cardOptions, null, 2));

      // Try clicking any attach button (e.g. "+", "Ingrédient", "Référence", "Utiliser") or three-dots menu
      const attachBtn = page.locator('button:has-text("Ingrédient"), button:has-text("Référence"), button[aria-label*="référence"], button[aria-label*="ingrédient"]').first();
      if (await attachBtn.isVisible().catch(() => false)) {
        console.log('[ref] Found reference attach button! Clicking it...');
        await attachBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        console.log('[ref] Clicking media card directly...');
        await mediaCard.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
  } catch (e) { console.log('[ref] card hover error:', e.message); }

  await dumpChips(page, 'AFTER card click');

  // STEP 4: Click the discovered chip remove buttons to verify ingredient clearing
  console.log('\n[ref] Testing chip clearing by clicking chip remove buttons...');
  try {
    const chipRemoveBtns = page.locator('[class*="sc-cd6d3ed7"] button, [class*="sc-e0376cc9"], button[aria-label*="Supprimer"], button[aria-label*="Remove"]');
    const cnt = await chipRemoveBtns.count();
    console.log(`[ref] Found ${cnt} chip remove buttons`);
    for (let i = 0; i < cnt; i++) {
      console.log(`[ref] Clicking chip remove button #${i}...`);
      await chipRemoveBtns.first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch (e) { console.log('[ref] chip remove test error:', e.message); }

  await dumpChips(page, 'AFTER chip clear test');

  try { await takeScreenshot(getPage(), 'discover-ref-clear'); } catch {}
  try { fs.rmSync(tmp, { force: true }); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
