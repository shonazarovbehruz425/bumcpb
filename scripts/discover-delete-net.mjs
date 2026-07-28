#!/usr/bin/env node
// Capture the API calls Flow makes when moving an image to trash and emptying it.
// Broad capture of aisandbox-pa POSTs; handles confirmation dialogs.
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
let phase = 'init';

async function countImages(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')]
    .filter((i) => /media\.getMediaUrlRedirect\?name=|flow-content/.test(i.src || '') && i.width > 80).length).catch(() => -1);
}

async function clickIfVisible(loc) {
  if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return true; }
  return false;
}

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(3000);

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/aisandbox-pa\.googleapis\.com/.test(url)) return;
      if (/batchLogFrontendEvents/.test(url)) return; // ignore telemetry
      const req = resp.request();
      if (req.method() !== 'POST') return;
      const postData = (req.postData() || '').slice(0, 2000);
      const body = (await resp.text().catch(() => '')).slice(0, 1200);
      captured.push({ phase, status: resp.status(), url: url.slice(0, 200), postData, body });
    } catch {}
  });

  const before = await countImages(page);
  console.log('[del] images before:', before);

  // (1) Move first image to trash.
  phase = 'move_to_trash';
  const more = page.locator('button:has-text("more_vert")').first();
  if (await clickIfVisible(more)) {
    await page.waitForTimeout(900);
    const del = page.locator('[role="menuitem"]:has-text("Supprimer"), button:has-text("Supprimer")').filter({ hasNotText: 'corbeille' }).first();
    await clickIfVisible(del);
    await page.waitForTimeout(1200);
    // confirmation dialog?
    const confirm = page.locator('[role="dialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer"), [role="alertdialog"] button:has-text("Supprimer")').first();
    if (await clickIfVisible(confirm)) console.log('[del] confirmed move');
    await page.waitForTimeout(3000);
  } else console.log('[del] more_vert not found');
  console.log('[del] images after move:', await countImages(page));

  // (2) Empty trash.
  phase = 'empty_trash';
  const trashNav = page.locator('button:has-text("corbeille")').first();
  if (await clickIfVisible(trashNav)) {
    await page.waitForTimeout(2500);
    const emptyBtn = page.locator('button:has-text("Tout supprimer")').first();
    if (await clickIfVisible(emptyBtn)) {
      await page.waitForTimeout(1200);
      const confirm = page.locator('[role="dialog"] button:has-text("Supprimer"), [role="dialog"] button:has-text("Confirmer"), [role="alertdialog"] button, button:has-text("Tout supprimer")').last();
      if (await clickIfVisible(confirm)) console.log('[del] confirmed empty');
      await page.waitForTimeout(3000);
    } else console.log('[del] Tout supprimer not found');
  } else console.log('[del] corbeille nav not found');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));

  console.log('==================== DELETE / TRASH API ====================');
  for (const c of captured) {
    console.log(`\n[${c.phase}] ${c.status} ${c.url}`);
    if (c.postData) console.log('REQ : ' + c.postData.slice(0, 600));
    if (c.body) console.log('RESP: ' + c.body.slice(0, 250));
  }
  console.log('\nTotal: ' + captured.length + '. Full: outputs/delete-capture.json');
  console.log('============================================================');

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
