import { handleGenerateImage } from './generate-image.js';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Generate an image with resilience:
 *  - If a model runs out of credits (GOOGLE_LIMIT_REACHED) -> switch to the next model.
 *  - On other errors -> refresh the page and retry the SAME prompt once.
 *  - Tries every configured model before giving up.
 *
 * @param {object} args      Same args as handleGenerateImage (prompt, ratio, model, ...)
 * @param {object} [hooks]   { onModelSwitch(model), onRetry(model) }
 */
export async function generateWithFallback(args, hooks = {}) {
  const configured = get('imageModels', {});
  const modelNames = Object.keys(configured);
  const preferred = (args.model && configured[args.model]) ? args.model : (modelNames[0] || 'Nano Banana 2');
  const order = [preferred, ...modelNames.filter((m) => m !== preferred)];

  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    if (i > 0 && hooks.onModelSwitch) { try { hooks.onModelSwitch(model); } catch {} }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await handleGenerateImage({ ...args, model });
      } catch (e) {
        lastErr = e;
        const isCredit = e.code === 'GOOGLE_LIMIT_REACHED';
        logger.warn('Generation attempt failed', { model, attempt, code: e.code, error: e.message });

        if (isCredit) break; // don't retry same model — move to next model

        // Non-credit error: refresh the page and retry the same model once.
        if (attempt === 0) {
          if (hooks.onRetry) { try { hooks.onRetry(model); } catch {} }
          try {
            const page = getPage();
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await page.waitForTimeout(3000);
          } catch {}
        }
      }
    }
  }
  throw lastErr || new Error('Generation failed for all models');
}
