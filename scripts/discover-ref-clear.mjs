#!/usr/bin/env node
// Discover how to CLEAR/REMOVE reference "ingredient" chips from the composer.
// We need this so a job's references never leak into the next job (shared
// persistent composer). Strategy: upload a tiny test image via the file input,
// wait for the reference chip to appear, then dump the chip element + its
// remove/close button so we can build a reliable "clear references" step.
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

// A minimal valid 2x2 PNG (red) so Flow accepts the upload as a reference.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAX0wP9' +
  'Fq0zHwAAAABJRU5ErkJggg==';

async function dump(page, label) {
  const d = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 60);
    const vis = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);

    // Thumbnail preview images that are NOT generated media (i.e. reference chips):
    // usually blob:/data: src or small size, sitting near the composer.
    const thumbs = [...document.querySelectorAll('img')]
      .filter((i) => vis(i) && i.width > 10 && i.width < 120 &&
        !/media\.getMediaUrlRedirect\?name=/.test(i.src || ''))
      .map((i) => {
        // Walk up to find the chip container + any remove button inside it.
        let el = i, chip = null, removeBtns = [];
        for (let k = 0; k < 6 && el; k++) {
          el = el.parentElement; if (!el) break;
          const btns = [...el.querySelectorAll('button,[role="button"]')];
          if (btns.length) {
            chip = el;
            removeBtns = btns.map((b) => ({
              icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')),
              title: clean(b.getAttribute('title')), cls: clean(b.className), id: clean(b.id),
            }));
            break;
          }
        }
        return {
          srcHead: (i.src || '').slice(0, 40), w: i.width, h: i.height,
          alt: clean(i.alt), chipCls: chip ? clean(chip.className) : null, removeBtns,
        };
      }).slice(0, 12);

    // Any button that looks like a remove/close/clear control.
    const removeLike = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => vis(b) && /close|clear|cancel|delete|remove|supprimer|retirer|enlever|✕|×/i
        .test(((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || ''))))
      .map((b) => ({ icon: clean(b.textContent), aria: clean(b.getAttribute('aria-label')), title: clean(b.getAttribute('title')), cls: clean(b.className) }))
      .slice(0, 20);

    return {
      totalImgs: document.querySelectorAll('img').length,
      thumbCandidates: thumbs, removeLikeButtons: removeLike,
    };
  }).catch((e) => ({ error: e.message }));
  console.log(`\n==================== ${label} ====================`);
  console.log(JSON.stringify(d, null, 2));
}

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3500);

  await dump(page, 'BEFORE upload (baseline — no references)');

  // Write the tiny test image and upload it via Flow's hidden file input.
  const tmp = path.join(os.tmpdir(), `flow-ref-discover-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from(PNG_B64, 'base64'));
  try {
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(tmp);
    console.log('\n[ref] uploaded test image, waiting for chip to attach...');
    await page.waitForTimeout(7000);
  } catch (e) {
    console.log('[ref] upload failed:', e.message);
  }

  await dump(page, 'AFTER upload (reference chip should be present)');

  // Best-effort: try clicking the most likely remove button and see if the
  // chip disappears (helps confirm the correct selector).
  try {
    const before = await page.locator('img').count();
    const candidate = page.locator('button:has-text("close"), button[aria-label*="Supprimer"], button[aria-label*="supprimer"], button[aria-label*="Remove"], button[aria-label*="retirer"]').last();
    if (await candidate.isVisible().catch(() => false)) {
      const label = await candidate.getAttribute('aria-label').catch(() => '') || (await candidate.textContent().catch(() => ''));
      await candidate.click().catch(() => {});
      await page.waitForTimeout(1500);
      const after = await page.locator('img').count();
      console.log(`\n[ref] clicked candidate remove button (label="${(label || '').trim().slice(0, 40)}"): imgs ${before} -> ${after}`);
    } else {
      console.log('\n[ref] no obvious remove button candidate was visible');
    }
  } catch (e) { console.log('[ref] remove attempt error:', e.message); }

  await dump(page, 'AFTER remove attempt');

  try { await takeScreenshot(getPage(), 'discover-ref-clear'); } catch {}
  try { fs.rmSync(tmp, { force: true }); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
