#!/usr/bin/env node
// Inspect the generation REQUEST payload (is there a "seed" field we can set?)
// and look for any credits/cost API. Generates 1 marker image (⚠️ 1 credit).
// Saves full request to outputs/request-capture.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'outputs', 'request-capture.json');
const MARKER = 'SEEDPROBE9';
const cap = { generateRequest: null, generateResponse: null, creditEndpoints: [] };

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const req = resp.request();
      if (/flowMedia:batchGenerateImages/.test(url) && req.method() === 'POST') {
        cap.generateRequest = req.postData() || '';
        cap.generateResponse = (await resp.text().catch(() => '')).slice(0, 4000);
      }
      if (/credit|quota|balance|usage|billing|entitlement|subscription/i.test(url)) {
        const body = (await resp.text().catch(() => '')).slice(0, 800);
        cap.creditEndpoints.push({ url: url.slice(0, 160), method: req.method(), body });
      }
    } catch {}
  });

  console.log('[probe] generating marker image (1 credit)...');
  try {
    await handleGenerateImage({ prompt: `${MARKER} a small grey circle`, ratio: '1:1', auto_confirm: true, project_name: 'API', campaign: 'api' });
  } catch (e) { console.error('[probe] gen error:', e.message); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(cap, null, 2));

  const reqStr = cap.generateRequest || '';
  console.log('\n==================== GENERATION REQUEST ====================');
  console.log('length:', reqStr.length);
  console.log('contains "seed"?', /seed/i.test(reqStr));
  // Print a window around "seed" if present
  const si = reqStr.search(/seed/i);
  if (si >= 0) console.log('...seed context:', reqStr.slice(Math.max(0, si - 60), si + 120));
  // Print the non-recaptcha tail of the request (where params usually are)
  console.log('request tail (last 900 chars):', reqStr.slice(-900));
  console.log('\n==================== CREDIT / COST ENDPOINTS ====================');
  console.log(JSON.stringify(cap.creditEndpoints.slice(0, 8), null, 2));
  console.log('\n[probe] full request saved to outputs/request-capture.json');
  console.log('================================================================');

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
