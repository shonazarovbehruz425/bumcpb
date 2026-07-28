#!/usr/bin/env node
// One-off REAL image generation test (⚠️ consumes credits).
// Connects headless with your logged-in profile, opens/creates a project,
// fills the prompt, clicks Generate, waits, and downloads the image.
//
// Usage: node scripts/test-generate.mjs "your prompt here"
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

const prompt = process.argv.slice(2).join(' ') || 'a cute robot holding a banana, studio lighting, high detail';

async function main() {
  console.log('[test-gen] Connecting (headless)...');
  const { page } = await launchChromeDirect({ headless: true });

  console.log('[test-gen] Opening Google Flow...');
  await navigateToFlow(page);

  console.log(`[test-gen] Generating image for prompt: "${prompt}"`);
  console.log('[test-gen] (this may take 30-90s and WILL consume credits)');

  const result = await handleGenerateImage({
    prompt,
    model: 'Nano Banana 2',
    ratio: '1:1',
    auto_confirm: true,
    project_name: 'Test',
    campaign: 'test',
  });

  console.log('');
  console.log('==================== RESULT ====================');
  console.log(JSON.stringify(result, null, 2));
  console.log('================================================');
  if (result.files && result.files.length) {
    console.log(`\n✅ Image(s) saved on the VPS at:\n  ${result.files.join('\n  ')}`);
  }

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\n[test-gen] ERROR:', e.message);
  try { await takeScreenshot(getPage(), 'test-gen-error'); console.error('[test-gen] Saved screenshot: screenshots/'); } catch {}
  try { await closeBrowser(); } catch {}
  process.exit(1);
});
