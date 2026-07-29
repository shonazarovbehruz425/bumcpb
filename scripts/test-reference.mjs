#!/usr/bin/env node
// Test image-to-image: upload a reference image URL + prompt, then generate.
// Usage: node scripts/test-reference.mjs "<referenceImageUrl>" "<prompt>"
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { attachResultListener, submitPrompt, takeResultForPrompt, downloadResult } from '../src/tools/flow-batch.js';

const reference = process.argv[2] || 'https://picsum.photos/600';
const prompt = process.argv.slice(3).join(' ') || 'transform this into a watercolor painting, soft pastel colors';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  attachResultListener(page);

  console.log(`[test-ref] reference: ${reference}`);
  console.log(`[test-ref] prompt   : ${prompt}`);
  console.log('[test-ref] uploading reference + submitting (⚠️ 1 credit)...');
  await submitPrompt({ prompt, reference });

  // Poll for the result (matched by prompt) up to 150s.
  const end = Date.now() + 150000;
  let result = null;
  while (Date.now() < end) {
    result = takeResultForPrompt(prompt);
    if (result) break;
    await page.waitForTimeout(3000);
  }

  if (!result) { console.error('[test-ref] no result captured (timeout)'); await closeBrowser(); process.exit(1); }

  const file = await downloadResult(result, 'reftest');
  console.log('\n==================== RESULT ====================');
  console.log('prompt  :', result.prompt);
  console.log('name    :', result.name);
  console.log('ratio   :', result.aspectRatio);
  console.log('file    :', file);
  console.log('================================================');
  console.log('\n✅ Image-to-image produced an image. Open the file to check the reference influenced it.');

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('[test-ref] ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
