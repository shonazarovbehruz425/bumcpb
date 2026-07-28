#!/usr/bin/env node
// Inspect the prompt composer on the (currently empty) project to find the
// right selector for the input. Run: node scripts/discover-composer.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { campaign: 'api' });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 80);
    const vis = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);

    const textareas = [...document.querySelectorAll('textarea')].map((t) => ({
      placeholder: clean(t.placeholder), aria: clean(t.getAttribute('aria-label')), visible: vis(t),
    }));
    const editables = [...document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].map((e) => ({
      aria: clean(e.getAttribute('aria-label')), role: e.getAttribute('role') || '', text: clean(e.textContent), visible: vis(e),
    }));
    const inputs = [...document.querySelectorAll('input')].map((i) => ({
      type: i.type, placeholder: clean(i.placeholder), aria: clean(i.getAttribute('aria-label')), visible: vis(i),
    }));
    const keyButtons = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => vis(b))
      .map((b) => clean(b.textContent))
      .filter((t) => /crop_|arrow_forward|Créer|Generate|Nano|Banana|Imagen|Décri|idée|idea/i.test(t))
      .slice(0, 20);

    // Any element with an idea/prompt-like placeholder attribute
    const placeholders = [...document.querySelectorAll('[placeholder]')]
      .map((e) => clean(e.getAttribute('placeholder')))
      .filter(Boolean).slice(0, 20);

    return { url: location.href, textareas, editables, inputs, keyButtons, placeholders };
  }).catch((e) => ({ error: e.message }));

  console.log('==================== COMPOSER INSPECT ====================');
  console.log(JSON.stringify(info, null, 2));
  console.log('==========================================================');
  try { await takeScreenshot(getPage(), 'discover-composer'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
