// Concurrent generation primitives using Flow's internal API for reliable
// prompt <-> image correlation (captured from flowMedia:batchGenerateImages).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { configureGeneration, inferRatioFromPrompt } from './generate-image.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'outputs', 'images');

let listenerAttached = false;
const resultBuffer = []; // { name, prompt, fifeUrl, aspectRatio, ts }

// Attach a one-time response listener that records every generated image
// together with the exact prompt it was generated from.
export function attachResultListener(page) {
  if (listenerAttached) return;
  listenerAttached = true;
  page.on('response', async (resp) => {
    try {
      if (!/flowMedia:batchGenerateImages/.test(resp.url())) return;
      const json = await resp.json().catch(() => null);
      if (!json || !Array.isArray(json.media)) return;
      for (const m of json.media) {
        const gi = m.image && m.image.generatedImage;
        if (!gi) continue;
        resultBuffer.push({
          name: m.name,
          prompt: gi.prompt || '',
          fifeUrl: gi.fifeUrl || '',
          aspectRatio: gi.aspectRatio || '',
          ts: Date.now(),
        });
      }
      logger.info('Captured generation result(s)', { count: json.media.length });
    } catch {}
  });
}

// Call when the browser/page is replaced so we re-attach next time.
export function resetResultListener() {
  listenerAttached = false;
  resultBuffer.length = 0;
}

// Take (and remove) one buffered result matching the given prompt (FIFO).
export function takeResultForPrompt(prompt) {
  const idx = resultBuffer.findIndex((r) => r.prompt === prompt);
  if (idx === -1) return null;
  return resultBuffer.splice(idx, 1)[0];
}

// Type a prompt and click Generate WITHOUT waiting for the image.
// Returns the ratio actually used.
// Wait until the generation composer (prompt input) is actually present.
async function waitForComposer(page, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await page.locator('[contenteditable="true"], textarea').first().isVisible().catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

export async function submitPrompt({ prompt, ratio, model }) {
  const page = getPage();
  await ensureProjectInContext(page, { campaign: 'api' });

  // Wait for the composer to load; if missing, reload the project once and wait again.
  let composerReady = await waitForComposer(page, 30000);
  if (!composerReady) {
    logger.warn('Composer not ready — reloading project once');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    composerReady = await waitForComposer(page, 30000);
  }
  if (!composerReady) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Generation composer (prompt input) not available');
  }

  const ratios = get('ratios', []);
  let r = (ratio && ratios.includes(ratio)) ? ratio : inferRatioFromPrompt(prompt);
  if (!r || !ratios.includes(r)) r = ratios.includes('1:1') ? '1:1' : (ratios[0] || '1:1');

  await configureGeneration(page, { ratio: r, count: 1, model });

  // Find the prompt input
  let input = null;
  for (const c of [page.locator('[contenteditable="true"]').first(), page.locator('textarea').first()]) {
    if (await c.isVisible().catch(() => false)) { input = c; break; }
  }
  if (!input) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Prompt input not found');

  // Robustly clear any leftover text, then type
  await input.click();
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await input.fill('').catch(() => {});
  await page.waitForTimeout(150);
  await input.type(prompt, { delay: 10 });
  await page.waitForTimeout(300);

  const genBtn = page.locator('button:has-text("arrow_forward"), button:has-text("Generate")').first();
  if (!(await genBtn.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
  }
  if (await genBtn.isDisabled().catch(() => false)) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button disabled');
  }
  await genBtn.click();

  // Handle a possible Agent "Accepter/Approve" confirmation (short window)
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/Accepter|Approve/.test(txt)) {
      await page.locator('button').filter({ hasText: /Accepter|Approve/ }).first().click().catch(() => {});
      break;
    }
    await page.waitForTimeout(400);
  }
  return { ratio: r };
}

// Download a captured result to outputs/images and return the relative path.
export async function downloadResult(result, jobId) {
  const page = getPage();
  const url = result.fifeUrl ||
    `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${result.name}`;
  const resp = await page.request.get(url, { timeout: 20000 });
  if (!resp.ok()) throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed (${resp.status()})`);
  const buf = await resp.body();
  const ct = resp.headers()['content-type'] || '';
  const ext = ct.includes('png') ? '.png' : '.jpg';
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const rel = path.join('outputs', 'images', `flow_${(result.name || 'img').slice(0, 8)}_${jobId}${ext}`);
  fs.writeFileSync(path.join(PROJECT_ROOT, rel), buf);
  return rel.replace(/\\/g, '/');
}
