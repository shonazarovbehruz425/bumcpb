#!/usr/bin/env node
// Simple HTTP API to generate Google Flow images from ANY project.
// Keeps ONE headless Chrome open (fast) and reuses the Flow project.
// Dependency-free (Node 18+ built-in http).
//
// Config (config/flow.config.json):
//   "apiPort": 8080                 (optional, default 8080)
//   "apiKey":  "<secret>"           (auto-generated on first run if missing)
//
// Endpoints:
//   GET  /health                          -> { ok: true }
//   POST /generate   header: x-api-key     body: { "prompt": "...", "model"?, "ratio"? }
//        -> { status, prompt, model, ratio, images: [ { file, url, base64 } ] }
//   GET  /outputs/...  (serves generated image files)
//
// Run: node scripts/api-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { get } from '../src/utils/config.js';
import { launchChromeDirect, closeBrowser, getPage, isBrowserConnected } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'flow.config.json');

const PORT = get('apiPort', 8080);
let API_KEY = get('apiKey');
if (!API_KEY) {
  API_KEY = crypto.randomBytes(16).toString('hex');
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    c.apiKey = API_KEY;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
  } catch {}
  console.log(`[api] Generated API key: ${API_KEY}`);
}

let busy = false;
let ready = false;

async function ensureBrowser() {
  if (ready && isBrowserConnected()) {
    try { getPage(); return; } catch { ready = false; }
  }
  console.log('[api] Launching persistent Chrome...');
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  ready = true;
  console.log('[api] Chrome ready and on Google Flow.');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

async function handleGenerate(req, res, host) {
  if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'unauthorized' });
  if (busy) return json(res, 429, { error: 'busy', message: 'Another generation is in progress.' });

  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch { return json(res, 400, { error: 'invalid_json' }); }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'missing_prompt' });

  busy = true;
  try {
    await ensureBrowser();
    const genPromise = handleGenerateImage({
      prompt,
      model: body.model || 'Nano Banana 2',
      ratio: body.ratio || '1:1',
      auto_confirm: true,
      project_name: body.project_name || 'API',
      campaign: body.campaign || 'api',
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('generation_timeout')), 180000)
    );
    const result = await Promise.race([genPromise, timeoutPromise]);

    const wantB64 = body.include_base64 === true;
    const images = (result.files || []).map((f) => {
      const rel = f.replace(/\\/g, '/');
      const img = { file: rel, url: `http://${host}/${rel}` };
      if (wantB64) {
        try { img.base64 = fs.readFileSync(path.resolve(PROJECT_ROOT, f)).toString('base64'); } catch {}
      }
      return img;
    });

    return json(res, 200, {
      status: 'success',
      prompt,
      model: result.model_used,
      ratio: result.ratio,
      images,
    });
  } catch (e) {
    ready = false;
    try { await closeBrowser(); } catch {}
    return json(res, 500, { error: 'generation_failed', message: e.message });
  } finally {
    busy = false;
  }
}

function serveOutput(req, res, urlPath) {
  // Only allow files under outputs/
  const rel = decodeURIComponent(urlPath.replace(/^\//, ''));
  if (!rel.startsWith('outputs/') || rel.includes('..')) {
    return json(res, 403, { error: 'forbidden' });
  }
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(path.join(PROJECT_ROOT, 'outputs')) || !fs.existsSync(abs)) {
    return json(res, 404, { error: 'not_found' });
  }
  const ext = path.extname(abs).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
  const buf = fs.readFileSync(abs);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && urlPath === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && urlPath === '/generate') return handleGenerate(req, res, host);
  if (req.method === 'GET' && urlPath.startsWith('/outputs/')) return serveOutput(req, res, urlPath);
  return json(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[api] API key: ${API_KEY}`);
  ensureBrowser().catch((e) => console.error('[api] warmup failed:', e.message));
});
