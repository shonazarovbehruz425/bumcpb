#!/usr/bin/env node
// Capture the API calls Flow makes when (1) moving an image to trash ("Supprimer")
// and (2) emptying the trash ("Tout supprimer"). Performs these on EXISTING images
// (test data). Saves capture to outputs/delete-capture.json.
// Run: node scripts/discover-delete-net.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'outputs', 'delete-capture.json');
const captured = [];

function record(tag, page) {
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/googleapis|trpc|flowMedia|media|trash|delete|batch/i.test(url)) return;
      const req = resp.request();
      if (req.method() !== 'POST') return;
      const postData = (req.postData() || '').slice(0, 2500);
      const ct = resp.headers()['content-type'] || '';
      let body = '';
      if (ct.includes('json') || ct.includes('text')) body = (await resp.text().catch(() => '')).slice(0, 1500);
      captured.push({ tag: tag(), method: req.method(), status: resp.status(), url: url.slice(0, 220), postData, body });
    } catch {}
  });
}

let phase = 'init';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3000);
  record(() => phase, page);

  // (1) Move first image to trash via its three-dot menu -> "Supprimer".
  phase = 'move_to_trash';
  try {
    const more = page.locator('button:has-text("more_vert")').first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await page.waitForTimeout(1000);
      const del = page.locator('[role="menuitem"]:has-text("Supprimer"), button:has-text("Supprimer")')
        .filter({ hasNotText: 'corbeille' }).first();
      if (await del.isVisible().catch(() => false)) {
        await del.click().catch(() => {});
        console.log('[del] Clicked Supprimer on first image');
      } else console.log('[del] Supprimer menu item not found');
      await page.waitForTimeout(3000);
    } else console.log('[del] more_vert not found');
  } catch (e) { console.log('[del] move error', e.message); }

  // (2) Go to Corbeille and click "Tout supprimer" (+ confirm if asked).
  phase = 'empty_trash';
  try {
    const trashNav = page.locator('button:has-text("corbeille")').first();
    if (await trashNav.isVisible().catch(() => false)) {
      await trashNav.click().catch(() => {});
      await page.waitForTimeout(2500);
      const emptyBtn = page.locator('button:has-text("Tout supprimer")').first();
      if (await emptyBtn.isVisible().catch(() => false)) {
        await emptyBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
        // Possible confirmation dialog
        const confirm = page.locator('[role="dialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer"), button:has-text("Tout supprimer")').last();
        if (await confirm.isVisible().catch(() => false)) { await confirm.click().catch(() => {}); console.log('[del] Confirmed empty trash'); }
        console.log('[del] Clicked Tout supprimer');
        await page.waitForTimeout(3000);
      } else console.log('[del] Tout supprimer not found');
    } else console.log('[del] corbeille nav not found');
  } catch (e) { console.log('[del] empty error', e.message); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));

  console.log('==================== DELETE / TRASH API CALLS ====================');
  for (const c of captured.slice(-14)) {
    console.log(`\n[${c.tag}] ${c.method} ${c.status} ${c.url}`);
    if (c.postData) console.log('REQ : ' + c.postData.slice(0, 500));
    if (c.body) console.log('RESP: ' + c.body.slice(0, 300));
  }
  console.log('\nTotal captured: ' + captured.length + '. Full: outputs/delete-capture.json');
  console.log('==================================================================');

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
