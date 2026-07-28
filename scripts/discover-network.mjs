#!/usr/bin/env node
// Capture Flow's internal generation API calls to learn how a PROMPT maps to
// generated media IDs (for reliable correlation under concurrency).
// Generates ONE image with a unique marker prompt (⚠️ consumes 1 credit).
// Saves full capture to outputs/net-capture.json.
// Run: node scripts/discover-network.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'outputs', 'net-capture.json');
const MARKER = 'NETCAP7Q2';
const PROMPT = `${MARKER} a tiny single red cube on white background`;

const captured = [];

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/trpc|generate|media|image|batch|runImage|fx\/api/i.test(url)) return;
      const req = resp.request();
      const method = req.method();
      const postData = (req.postData() || '').slice(0, 4000);
      const ct = (resp.headers()['content-type'] || '');
      let body = '';
      if (ct.includes('json') || ct.includes('text')) body = (await resp.text().catch(() => '')).slice(0, 6000);
      captured.push({ method, status: resp.status(), url: url.slice(0, 220), postData, body });
    } catch {}
  });

  console.log('[netcap] Generating marker prompt (1 credit)...');
  try {
    await handleGenerateImage({
      prompt: PROMPT,
      ratio: '1:1',
      auto_confirm: true,
      project_name: 'API',
      campaign: 'api',
    });
  } catch (e) {
    console.error('[netcap] generation error (capture still saved):', e.message);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));

  // Print only the interesting entries: those referencing the marker or a uuid.
  const uuidRe = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-/;
  const interesting = captured.filter((c) =>
    (c.postData && c.postData.includes(MARKER)) ||
    (c.body && (c.body.includes(MARKER) || uuidRe.test(c.body))) && c.method === 'POST'
  );

  console.log('==================== NET CAPTURE (interesting) ====================');
  for (const c of interesting.slice(0, 12)) {
    console.log('\n--- ' + c.method + ' ' + c.status + ' ' + c.url);
    if (c.postData) console.log('REQ : ' + c.postData.slice(0, 700));
    if (c.body) console.log('RESP: ' + c.body.slice(0, 1200));
  }
  console.log('\n[netcap] Total captured: ' + captured.length + '. Full file: outputs/net-capture.json');
  console.log('===================================================================');

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
