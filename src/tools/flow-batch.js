// Concurrent generation primitives using Flow's internal API for reliable
// prompt <-> image correlation (captured from flowMedia:batchGenerateImages).
import fs from 'fs';
import os from 'os';
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
const resultBuffer = []; // { name, prompt, fifeUrl, aspectRatio, seed, ts }
let creditsRemaining = null;
let creditsInitial = null;
let creditsUrl = null;

// Proactively refresh the credit balance (frontend only fetches it on load).
export async function refreshCredits() {
  if (!creditsUrl) return;
  try {
    const page = getPage();
    const r = await page.request.get(creditsUrl, { timeout: 10000 });
    const j = await r.json().catch(() => null);
    if (j && typeof j.credits === 'number') { creditsRemaining = j.credits; if (creditsInitial == null) creditsInitial = j.credits; }
  } catch {}
}

// Latest real credit balance from Flow's /v1/credits endpoint.
export function getCredits() {
  return {
    remaining: creditsRemaining,
    initial: creditsInitial,
    spent: (creditsInitial != null && creditsRemaining != null) ? (creditsInitial - creditsRemaining) : null,
  };
}

// Attach a one-time response listener that records every generated image
// together with the exact prompt it was generated from, and the credit balance.
export function attachResultListener(page) {
  if (listenerAttached) return;
  listenerAttached = true;
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (/\/v1\/credits/.test(url)) {
        creditsUrl = url;
        const j = await resp.json().catch(() => null);
        if (j && typeof j.credits === 'number') { creditsRemaining = j.credits; if (creditsInitial == null) creditsInitial = j.credits; }
        return;
      }
      if (!/flowMedia:batchGenerateImages/.test(url)) return;
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
          seed: (gi.seed !== undefined ? gi.seed : null),
          modelNameType: gi.modelNameType || null,
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

// Take up to n buffered results matching the prompt (for count>1).
export function takeResultsForPrompt(prompt, n = 1) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = resultBuffer.findIndex((r) => r.prompt === prompt);
    if (i === -1) break;
    out.push(resultBuffer.splice(i, 1)[0]);
  }
  return out;
}

// Clear any leftover ingredient reference chips attached to the composer
export async function clearReferences(page) {
  try {
    const chipRemoveBtns = page.locator('[class*="sc-cd6d3ed7"] button, button[class*="sc-e0376cc9"], button[aria-label*="Supprimer"], button[aria-label*="Remove"]');
    const cnt = await chipRemoveBtns.count().catch(() => 0);
    if (cnt > 0) {
      logger.info('Clearing leftover composer reference chips', { count: cnt });
      for (let i = 0; i < cnt; i++) {
        await chipRemoveBtns.first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(300);
    }
  } catch (e) {
    logger.warn('Error clearing composer reference chips', { error: e.message });
  }
}

// Type a prompt and click Generate WITHOUT waiting for the image.
// Returns the ratio actually used.
// Download reference image URL(s) and upload them to Flow's file input so the
// next generation uses them as references (image-to-image / "ingredients").
async function uploadReferences(page, reference) {
  const srcs = (Array.isArray(reference) ? reference : [reference]).filter(Boolean).slice(0, 3);
  const files = [];
  const tempsToClean = [];
  for (const src of srcs) {
    try {
      // Cached local reference file (from a referenceId) — use directly.
      if (typeof src === 'string' && !/^https?:\/\//i.test(src) && fs.existsSync(src)) { files.push(src); continue; }
      const resp = await fetch(src);
      if (!resp.ok) { logger.warn('reference fetch failed', { url: String(src).slice(0, 80), status: resp.status }); continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get('content-type') || '';
      const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
      const tmp = path.join(os.tmpdir(), `flow-ref-${Date.now()}-${files.length}${ext}`);
      fs.writeFileSync(tmp, buf);
      files.push(tmp); tempsToClean.push(tmp);
    } catch (e) { logger.warn('reference download error', { error: e.message }); }
  }
  if (!files.length) return false;

  try {
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(files);
    await page.waitForTimeout(1500);

    // If "Notification" consent dialog appears ("J'accepte"), click it
    const acceptBtn = page.locator('button:has-text("J\'accepte"), button:has-text("Accepter"), [role="dialog"] button:has-text("J\'accepte")').first();
    if (await acceptBtn.isVisible().catch(() => false)) {
      await acceptBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Attach uploaded media to composer if not automatically attached as chip
    const hasChip = await page.locator('[class*="sc-cd6d3ed7"]').first().isVisible().catch(() => false);
    if (!hasChip) {
      const mediaCard = page.locator('img[src*="media.getMediaUrlRedirect"]').first();
      if (await mediaCard.isVisible().catch(() => false)) {
        const attachBtn = page.locator('button:has-text("Ingrédient"), button:has-text("Référence"), button[aria-label*="référence"]').first();
        if (await attachBtn.isVisible().catch(() => false)) {
          await attachBtn.click().catch(() => {});
        } else {
          await mediaCard.click().catch(() => {});
        }
      }
    }

    await page.waitForTimeout(3000);
    logger.info('Reference image(s) uploaded and attached', { count: files.length });
    return true;
  } catch (e) {
    logger.warn('reference upload failed', { error: e.message });
    return false;
  } finally {
    // Only delete temp downloads, not cached reference files.
    for (const f of tempsToClean) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
}

// Read the CURRENT ratio + image count from the toolbar settings button
// (text like "... crop_16_9 x1"), without opening the popover.
async function currentSettings(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /crop_/.test(b.textContent || '') && b.offsetParent !== null);
    if (!btn) return null;
    const t = btn.textContent || '';
    const map = { 'crop_16_9': '16:9', 'crop_9_16': '9:16', 'crop_square': '1:1', 'crop_landscape': '4:3', 'crop_portrait': '3:4' };
    let ratio = null;
    for (const k of Object.keys(map)) { if (t.includes(k)) { ratio = map[k]; break; } }
    const m = t.match(/x(\d)/);
    return { ratio, count: m ? parseInt(m[1], 10) : null };
  }).catch(() => null);
}

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

export async function submitPrompt({ prompt, ratio, model, reference, count, seed }) {
  const page = getPage();
  const desiredCount = Math.min(Math.max(parseInt(count || 1, 10), 1), 4);
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

  // #5: only (re)configure if the current ratio/count don't already match.
  let needConfig = true;
  if (!model) {
    const cur = await currentSettings(page);
    if (cur && cur.ratio === r && cur.count === desiredCount) { needConfig = false; }
  }
  if (needConfig) await configureGeneration(page, { ratio: r, count: desiredCount, model });

  // Clear any existing reference chips from previous jobs to prevent reference leakage.
  await clearReferences(page);

  // Reference image(s) for image-to-image: download then upload via Flow's file input.
  if (reference) {
    await uploadReferences(page, reference);
  }

  // Dismiss any open popover/dialog overlay that could intercept clicks on the composer.
  for (let i = 0; i < 4; i++) {
    const blocked = await page.locator('[data-state="open"][aria-hidden="true"]').first().isVisible().catch(() => false);
    if (!blocked) break;
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(5, 5).catch(() => {});
    await page.waitForTimeout(500);
  }

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
  await input.type(prompt, { delay: 4 });
  await page.waitForTimeout(150);

  const genBtn = page.locator('button:has-text("arrow_forward"), button:has-text("Generate")').first();
  if (!(await genBtn.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
  }
  if (await genBtn.isDisabled().catch(() => false)) {
    throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button disabled');
  }

  // NOTE: input-seed injection via request interception is unreliable over a
  // connectOverCDP-attached browser (page.route can hang), so it is disabled.
  // The actual seed is still captured and returned for reproduction tracking.
  await genBtn.click();

  // Handle a possible Agent "Accepter/Approve" confirmation + detect content rejection.
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/Accepter|Approve/.test(txt)) {
      await page.locator('button').filter({ hasText: /Accepter|Approve/ }).first().click().catch(() => {});
      break;
    }
    if (/enfreint|non autoris|va à l'encontre|policy|not allowed|cannot generate|bloqué|violat/i.test(txt)) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS, 'content_rejected: prompt was rejected by Flow content policy');
    }
    await page.waitForTimeout(300);
  }

  return { ratio: r, count: desiredCount };
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
