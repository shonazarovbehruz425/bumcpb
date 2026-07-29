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

    // Find the composer (prompt input) and walk UP a few levels to its toolbar row.
    const composer = document.querySelector('[contenteditable="true"], textarea');
    let root = composer;
    for (let k = 0; k < 5 && root; k++) root = root.parentElement;

    const scope = root || document.body;
    // Thumbnails inside the composer area that are NOT generated media / profile.
    const thumbs = [...scope.querySelectorAll('img')]
      .filter((i) => vis(i) && !/googleusercontent\.com\/a\/|media\.getMediaUrlRedirect\?name=/.test(i.src || ''))
      .map((i) => {
        let el = i, chip = null, btns = [];
        for (let k = 0; k < 5 && el; k++) {
          el = el.parentElement; if (!el) break;
          const b = [...el.querySelectorAll('button,[role="button"]')];
          if (b.length && b.length <= 4) { chip = el; btns = b; break; }
        }
        return {
          srcHead: (i.src || '').slice(0, 45), w: i.width, h: i.height, alt: clean(i.alt),
          chipCls: chip ? clean(chip.className) : null,
          chipBtns: btns.map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), cls: clean(b.className) })),
        };
      }).slice(0, 12);

    // Buttons inside the composer area whose icon looks like a chip-remove (close/×).
    const composerRemoveBtns = [...scope.querySelectorAll('button,[role="button"]')]
      .filter((b) => vis(b) && /^close|✕|×|clear$|cancel/i.test(clean(b.textContent)) )
      .map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), cls: clean(b.className) }))
      .slice(0, 15);

    return { composerFound: !!composer, thumbCandidates: thumbs, composerRemoveBtns };
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

  // STEP 1: open the "Ajouter un contenu multimédia" menu (the reference/add entry).
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

  // STEP 2: upload the test image via whichever file input accepts images.
  const tmp = await makeTestImage();
  try {
    const inputs = page.locator('input[type="file"]');
    const n = await inputs.count();
    let uploaded = false;
    for (let i = 0; i < n; i++) {
      const acc = await inputs.nth(i).getAttribute('accept').catch(() => '') || '';
      if (/image|\*/.test(acc) || acc === '') {
        await inputs.nth(i).setInputFiles(tmp).catch(() => {});
        console.log(`\n[ref] setInputFiles on input #${i} (accept="${acc}")`);
        uploaded = true; break;
      }
    }
    if (!uploaded && n > 0) { await inputs.first().setInputFiles(tmp).catch(() => {}); console.log('\n[ref] setInputFiles on first input (fallback)'); }
    await page.waitForTimeout(8000);
  } catch (e) { console.log('[ref] upload error:', e.message); }

  const after = await dumpChips(page, 'AFTER upload');

  // STEP 3: if a chip with a button appeared, try its button and re-check.
  try {
    const chip = (after.thumbCandidates || []).find((t) => t.chipBtns && t.chipBtns.length);
    if (chip) {
      console.log(`\n[ref] chip detected (cls="${chip.chipCls}") with btns:`, JSON.stringify(chip.chipBtns));
      // Try clicking a button whose icon is "close"-like within that chip via a hover+click.
      const before = await page.locator('img').count();
      const btn = page.locator('button:has-text("close"), [role="button"]:has-text("close")').last();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(1500);
        const now = await page.locator('img').count();
        console.log(`[ref] clicked composer 'close' button: imgs ${before} -> ${now}`);
      } else { console.log('[ref] no composer close button visible to test'); }
    } else {
      console.log('\n[ref] NO reference chip appeared after upload — upload path may differ.');
    }
  } catch (e) { console.log('[ref] remove test error:', e.message); }

  await dumpChips(page, 'AFTER remove attempt');

  try { await takeScreenshot(getPage(), 'discover-ref-clear'); } catch {}
  try { fs.rmSync(tmp, { force: true }); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
