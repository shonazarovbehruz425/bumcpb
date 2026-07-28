import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') {
    return 'Nano Banana 2';
  }
  if (available[requested]) return requested;
  return null;
}

function selectRatio(requested) {
  const ratios = get('ratios', []);
  if (!requested || ratios.includes(requested)) {
    return requested || '16:9';
  }
  return null;
}

// Infer an aspect ratio from the prompt text (keyword based).
function inferRatioFromPrompt(prompt) {
  const p = (prompt || '').toLowerCase();
  if (/\b(9:16|vertical|portrait|phone|wallpaper|story|stories|reel|reels|tiktok|shorts)\b/.test(p)) return '9:16';
  if (/\b(16:9|landscape|wide|widescreen|banner|cinematic|desktop|panorama)\b/.test(p)) return '16:9';
  if (/\b(1:1|square|avatar|profile|icon|logo|sticker)\b/.test(p)) return '1:1';
  if (/\b(4:3)\b/.test(p)) return '4:3';
  if (/\b(3:4)\b/.test(p)) return '3:4';
  return null;
}

// Map ratio -> Flow settings tab id suffix (from UI discovery).
const RATIO_TRIGGER = {
  '16:9': '-trigger-LANDSCAPE',
  '4:3':  '-trigger-LANDSCAPE_4_3',
  '1:1':  '-trigger-SQUARE',
  '3:4':  '-trigger-PORTRAIT_3_4',
  '9:16': '-trigger-PORTRAIT',
};

// Open the generation settings popover (model / ratio / count).
async function openSettingsPopover(page) {
  const trigger = page.locator('button:has-text("crop_")').first();
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click().catch(() => {});
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function clickTabBySuffix(page, suffix, exactEnd) {
  const sel = exactEnd
    ? `button[role="tab"][id$="${suffix}"]`
    : `button[role="tab"][id*="${suffix}"]`;
  const el = page.locator(sel).first();
  if (await el.isVisible().catch(() => false)) {
    await el.click().catch(() => {});
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

// Configure Image mode, aspect ratio, and image count in the settings popover.
async function configureGeneration(page, { ratio, count, model }) {
  const opened = await openSettingsPopover(page);
  if (!opened) {
    logger.warn('Could not open settings popover — using current Flow settings');
    return;
  }
  // Image mode (not video)
  await clickTabBySuffix(page, '-trigger-IMAGE', false);

  // Aspect ratio
  const suffix = RATIO_TRIGGER[ratio];
  if (suffix) {
    const exactEnd = (suffix === '-trigger-LANDSCAPE' || suffix === '-trigger-PORTRAIT');
    const ok = await clickTabBySuffix(page, suffix, exactEnd);
    logger.info('Ratio tab set', { ratio, ok });
  }

  // Image count
  const cnt = Math.min(Math.max(parseInt(count || 1, 10), 1), 4);
  const okCount = await clickTabBySuffix(page, `-trigger-${cnt}`, true);
  logger.info('Image count set', { count: cnt, ok: okCount });

  // Optional model selection
  if (model && model !== 'auto') {
    try {
      const dd = page.locator('button:has-text("arrow_drop_down")')
        .filter({ hasText: /Nano|Banana|Imagen|Veo|Omni/ }).first();
      if (await dd.isVisible().catch(() => false)) {
        const current = (await dd.textContent().catch(() => '')) || '';
        if (!current.includes(model)) {
          await dd.click().catch(() => {});
          await page.waitForTimeout(700);
          const opt = page.locator('[role="menuitem"], [role="option"], button')
            .filter({ hasText: model }).first();
          if (await opt.isVisible().catch(() => false)) {
            await opt.click().catch(() => {});
            await page.waitForTimeout(600);
            logger.info('Model selected in UI', { model });
          } else {
            await page.keyboard.press('Escape').catch(() => {});
          }
        }
      }
    } catch (e) {
      logger.warn('Model selection failed', { error: e.message });
    }
  }

  // Close the popover
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
}

// Detect a credit/quota EXHAUSTION message on the page (specific phrases only,
// to avoid false positives from a normal credits counter).
async function detectCreditError(page) {
  const txt = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
  return /limite atteinte|limit reached|insufficient|plus de cr[ée]dit|out of credits?|no credits? (left|remaining)|quota exceeded|cr[ée]dits? [ée]puis|vous n'avez plus/.test(txt);
}

export async function handleGenerateImage(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    auto_confirm: autoConfirm,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    useTool: args.use_tool,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    // STEP 2: Model selection (config-level, before UI interaction)
    const model = selectModel(args.model);
    if (!model) {
      const available = Object.keys(get('imageModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using model', { model });

    // 🛡️ SAFETY: Verify model is an IMAGE model, NOT a video model
    const imageModels = get('imageModels', {});
    const videoModels = get('videoModels', {});
    if (!imageModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 BLOCAGE SÉCURITÉ: "${model}" est un modèle VIDÉO, pas IMAGE. ` +
        `Utiliser flow_generate_video pour les vidéos. Modèles image: ${Object.keys(imageModels).join(', ')}`);
    }
    if (videoModels[model]) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 BLOCAGE SÉCURITÉ: "${model}" est aussi un modèle VIDÉO. ` +
        `Refus de générer pour éviter des crédits vidéo. Modèles image: ${Object.keys(imageModels).join(', ')}`);
    }

    // STEP 3: Ratio selection — explicit arg wins, else infer from prompt, else default
    const ratios = get('ratios', []);
    let ratio = (args.ratio && ratios.includes(args.ratio)) ? args.ratio : null;
    if (!ratio) ratio = inferRatioFromPrompt(args.prompt);
    if (!ratio || !ratios.includes(ratio)) ratio = ratios.includes('1:1') ? '1:1' : (ratios[0] || '1:1');
    logger.info('Ratio chosen', { ratio, explicit: args.ratio || null });

    // STEP 4: Verify the model selector confirms IMAGE mode (NOT video)
    // Flow's bottom toolbar is always present in a project with a model selector.
    // No "Image/Video" mode tabs exist — the generation mode is determined by
    // which model is selected (e.g. "Nano Banana 2" = image, "Omni Flash" = video).
    const modelFromUI = await page.evaluate(() => {
      const modelBtn = Array.from(document.querySelectorAll('button'))
        .find(b => {
          const text = b.textContent || '';
          return (text.includes('Nano') || text.includes('Banana') ||
                  text.includes('Omni') || text.includes('Veo') ||
                  text.includes('Imagen')) && b.offsetParent !== null;
        });
      return modelBtn ? modelBtn.textContent.trim().replace(/\s+/g, ' ').substring(0, 80) : null;
    }).catch(() => null);

    if (modelFromUI) {
      logger.info('Model selector shows:', { modelFromUI });
      const videoModelNames = ['Omni Flash', 'Veo', 'Omni'];
      const isVideoModel = videoModelNames.some(v => modelFromUI.includes(v));
      if (isVideoModel) {
        await takeScreenshot(page, 'video-model-detected');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `🚨 BLOCAGE SÉCURITÉ: Le modèle "${modelFromUI}" est un modèle VIDÉO. ` +
          `Refus de générer pour éviter des crédits vidéo payants. ` +
          `Utilise flow_generate_video pour les vidéos.`);
      }
      logger.info('✅ Model selector confirms image mode');
    } else {
      logger.warn('Could not read model selector — assuming image mode from config');
    }

    // Also verify the generate button exists (confirms the toolbar is active)
    const hasGenerateBtn = await page.locator(
      'button:has-text("arrow_forward"), button:has-text("Créer")'
    ).first().isVisible().catch(() => false);
    if (!hasGenerateBtn) {
      logger.warn('Generate button not visible on project page');
    }

    // STEP 4.5: Configure Image mode, aspect ratio, and image count (=1 unless overridden)
    await configureGeneration(page, { ratio, count: args.quantity || 1, model: args.model });

    // STEP 5: Find the prompt input (contenteditable div at bottom toolbar)
    let promptInput = null;

    const promptCandidates = [
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        logger.info('Found prompt input on page');
        break;
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Expected [contenteditable] or textarea.'
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // STEP 6: Fill the prompt — robustly clear any previous/leftover text first
    await promptInput.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await promptInput.fill('').catch(() => {});
    await page.waitForTimeout(200);
    // Verify the field is actually empty; if not, clear again.
    const leftover = (await promptInput.textContent().catch(() => '')) || '';
    if (leftover.trim()) {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(150);
    }
    await promptInput.type(args.prompt, { delay: 15 });
    logger.info('Prompt filled', { promptLength: args.prompt.length });
    await page.waitForTimeout(500);

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: '✅ Prompt, modèle et ratio sont prêts. Aucun crédit consommé. ' +
          'Pour générer et consommer des crédits, rappelle avec auto_confirm=true.',
        model_used: model,
        ratio,
        prompt: args.prompt,
        account: get('expectedAccount'),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // 🛡️ SAFETY: Pre-generation screenshot verification
    logger.info('⚠️ auto_confirm=true — vérifications de sécurité avant clic Generate');
    const preGenScreenshot = await takeScreenshot(page, 'pre-generate-verification');

    // STEP 8: Find generate button
    const generateBtnLocator = page.locator(
      'button:has-text("arrow_forward"), ' +
      'button:has-text("Generate")'
    ).first();
    const generateBtnVisible = await generateBtnLocator.isVisible().catch(() => false);
    if (!generateBtnVisible) {
      await takeScreenshot(page, 'no-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
    }

    const isDisabled = await generateBtnLocator.isDisabled().catch(() => false);
    if (isDisabled) {
      await takeScreenshot(page, 'generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }

    // STEP 9: Prepare output directory
    const outputDir = args.output_folder || prepareDownload('image', model, job.id).dir;
    if (args.output_folder) {
      if (!fs.existsSync(args.output_folder)) {
        fs.mkdirSync(args.output_folder, { recursive: true });
      }
    }

    // Snapshot images already present so we only return NEWLY generated ones
    // (the project is reused, so old images remain in the DOM).
    const beforeUuids = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const uuids = [];
      imgs.forEach(img => {
        const src = img.src || '';
        const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (match && img.width > 100) uuids.push(match[1]);
      });
      return [...new Set(uuids)];
    }).catch(() => []);

    // STEP 10: Click generate ⚠️ CRÉDITS SERONT CONSOMMÉS
    logger.info('⚠️⚠️⚠️ Cliquant Generate — des crédits vont être consommés');
    await generateBtnLocator.click();

    // STEP 11: Handle two possible generation flows:
    //   A) Agent-mediated: Agent asks "Accepter?" before generating (when switching modes)
    //   B) Direct: generation starts immediately (most common)
    // Try Agent first (short wait), fall through to direct if not detected

    let flowMode = 'direct';
    logger.info('Checking for Agent confirmation dialog (5s window)...');
    const acceptTimeoutMs = get('agentResponseTimeoutMs', 5000);
    const acceptStart = Date.now();

    while (Date.now() - acceptStart < acceptTimeoutMs) {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes('Accepter') || pageText.includes('Approve')) {
        logger.info('Agent confirmation dialog detected — switching to Agent flow');
        const acceptBtn = page.locator('button').filter({ hasText: /Accepter|Approve/ }).first();
        await acceptBtn.click();
        logger.info('Generation confirmed via Agent');
        flowMode = 'agent';
        break;
      }
      await page.waitForTimeout(500);
    }

    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for images to appear in the DOM
    logger.info('Waiting for generated images...');
    let generatedImageUuids = [];
    const genTimeoutMs = get('generationTimeoutMs', 120000);
    const genStart = Date.now();

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(2000);

      // Credit/quota exhausted → signal caller to try another model.
      if (await detectCreditError(page)) {
        await takeScreenshot(page, 'credit-exhausted');
        throw new FlowError(ErrorCodes.GOOGLE_LIMIT_REACHED,
          `Credit/quota exhausted for model "${model}".`);
      }

      const imageUuids = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const uuids = [];
        imgs.forEach(img => {
          const src = img.src || '';
          const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
          if (match && img.width > 100) {
            uuids.push(match[1]);
          }
        });
        return [...new Set(uuids)];
      });

      const freshUuids = imageUuids.filter((u) => !beforeUuids.includes(u));
      if (freshUuids.length > 0) {
        generatedImageUuids = freshUuids;
        logger.info('New generated images detected in DOM', { count: freshUuids.length });
        break;
      }

      const hasDownload = await page.locator(
        'text=Télécharger, text=download, [aria-label*="download"]'
      ).first().isVisible().catch(() => false);
      if (hasDownload) {
        logger.info('Download button appeared after generation');
        break;
      }

      if ((Date.now() - genStart) % 30000 === 0) {
        logger.info('Still waiting for images...', { elapsed: Date.now() - genStart });
        await takeScreenshot(page, `gen-wait-${Math.round((Date.now() - genStart) / 1000)}s`);
      }
    }

    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }

    // STEP 13: Download generated images via authenticated session
    logger.info('Downloading generated images', { count: generatedImageUuids.length });
    const downloadedFiles = [];

    for (const uuid of generatedImageUuids) {
      try {
        // Fetch via the authenticated request context WITHOUT navigating the
        // page away from the project (keeps Chrome ready for the next job).
        const response = await page.request.get(
          `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`,
          { timeout: 15000 }
        );

        if (response && response.ok()) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.startsWith('image/')) {
            const buffer = await response.body();
            const ext = contentType === 'image/png' ? '.png' : '.jpg';
            const destPath = path.join(outputDir, `flow_${uuid.substring(0, 8)}_${job.id}${ext}`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            logger.info('Image downloaded', { uuid, size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Failed to download image', { uuid, error: err.message });
      }
    }

    if (downloadedFiles.length === 0) {
      await takeScreenshot(page, 'download-failed');
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Failed to download any generated images via the authenticated session');
    }

    saveMetadata(job.id, {
      type: 'image',
      model,
      ratio,
      auto_confirm: true,
      quantity: args.quantity || 1,
      prompt: args.prompt,
      files: downloadedFiles,
      jobId: job.id,
      imageUuids: generatedImageUuids,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      prompt: args.prompt,
      files: downloadedFiles,
      image_count: downloadedFiles.length,
      credits_consumed: true,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'generate-image-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
