#!/usr/bin/env node
// HTTP API with an async JOB QUEUE for Google Flow image generation.
// - Jobs are processed ONE AT A TIME (single Google account / Chrome).
// - Each job generates up to `quantity` images (default 3), tagged to its prompt.
// - Submit jobs, then poll their status to collect the resulting image URLs.
// Dependency-free (Node 18+ built-in http).
//
// Config (config/flow.config.json):
//   "apiPort": 8080          (optional)
//   "apiKey":  "<secret>"    (auto-generated on first run if missing)
//
// Endpoints:
//   GET  /health                       -> { ok: true }
//   GET  /queue                        -> { pending, working, total }
//   POST /generate  {prompt, ratio?, model?, quantity?}      -> { jobId, status, position }
//   POST /batch     {prompts:[...]} or {items:[{prompt,...}]} -> { jobIds: [...] }
//   GET  /jobs/:id                     -> full job (status, images[].url, error)
//   GET  /jobs                         -> recent jobs (summary)
//   GET  /outputs/...                  -> serves generated image files
//
// Header for POST: x-api-key: <apiKey>
// Run: node scripts/api-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { get } from '../src/utils/config.js';
import { launchChromeDirect, closeBrowser, getPage, isBrowserConnected } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { generateWithFallback } from '../src/tools/generate-robust.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'flow.config.json');
const JOBS_FILE = path.join(PROJECT_ROOT, 'outputs', 'jobs.json');

const PORT = get('apiPort', 8080);
const DEFAULT_QUANTITY = get('defaultQuantity', 3);
const JOB_TIMEOUT_MS = get('jobTimeoutMs', 240000);

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

// ---------- Job store + queue ----------
const jobs = new Map();      // id -> job
const queue = [];            // pending job ids
let working = false;
let ready = false;

function loadJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const j of arr) jobs.set(j.id, j);
    // Re-queue jobs that never finished.
    for (const j of arr) if (j.status === 'queued' || j.status === 'processing') { j.status = 'queued'; queue.push(j.id); }
  } catch {}
}
function saveJobs() {
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
  } catch {}
}

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

function enqueue(job) {
  jobs.set(job.id, job);
  queue.push(job.id);
  saveJobs();
  setImmediate(processNext);
  return queue.length;
}

async function processNext() {
  if (working) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return setImmediate(processNext);

  working = true;
  job.status = 'processing';
  job.startedAt = Date.now();
  saveJobs();
  console.log(`[api] Processing job ${id}: "${job.prompt}" (queue left: ${queue.length})`);

  try {
    await ensureBrowser();
    const genPromise = generateWithFallback({
      prompt: job.prompt,
      ratio: job.ratio,
      model: job.model,
      quantity: job.quantity,
      auto_confirm: true,
      project_name: 'API',
      campaign: 'api',
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('generation_timeout')), JOB_TIMEOUT_MS)
    );
    const result = await Promise.race([genPromise, timeoutPromise]);

    job.images = (result.files || []).map((f) => ({ file: f.replace(/\\/g, '/') }));
    job.model = result.model_used || job.model;
    job.ratio = result.ratio || job.ratio;
    job.status = 'done';
    job.finishedAt = Date.now();
    console.log(`[api] Job ${id} done: ${job.images.length} image(s).`);
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    job.finishedAt = Date.now();
    ready = false;
    try { await closeBrowser(); } catch {}
    console.error(`[api] Job ${id} failed: ${e.message}`);
  } finally {
    saveJobs();
    working = false;
    setImmediate(processNext);
  }
}

// ---------- HTTP helpers ----------
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
function withUrls(job, host) {
  const images = (job.images || []).map((im) => ({ file: im.file, url: `http://${host}/${im.file}` }));
  return { ...job, images };
}
function makeJob(body) {
  return {
    id: crypto.randomUUID(),
    prompt: (body.prompt || '').trim(),
    ratio: body.ratio || null,          // null => auto-inferred from prompt
    model: body.model || null,          // null => auto + fallback
    quantity: Math.min(Math.max(parseInt(body.quantity || DEFAULT_QUANTITY, 10), 1), 4),
    status: 'queued',
    images: [],
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
}

function serveOutput(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\//, ''));
  if (!rel.startsWith('outputs/') || rel.includes('..')) return json(res, 403, { error: 'forbidden' });
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(path.join(PROJECT_ROOT, 'outputs')) || !fs.existsSync(abs)) return json(res, 404, { error: 'not_found' });
  const ext = path.extname(abs).toLowerCase();
  const type = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
  const buf = fs.readFileSync(abs);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const urlPath = (req.url || '/').split('?')[0];

  // Public GETs
  if (req.method === 'GET' && urlPath === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && urlPath === '/queue') {
    return json(res, 200, { pending: queue.length, working, total: jobs.size });
  }
  if (req.method === 'GET' && urlPath.startsWith('/outputs/')) return serveOutput(res, urlPath);
  if (req.method === 'GET' && urlPath.startsWith('/jobs/')) {
    const id = urlPath.slice('/jobs/'.length);
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'not_found' });
    return json(res, 200, withUrls(job, host));
  }
  if (req.method === 'GET' && urlPath === '/jobs') {
    const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
      .map((j) => ({ id: j.id, prompt: j.prompt, status: j.status, images: (j.images || []).length }));
    return json(res, 200, { jobs: list });
  }

  // Protected POSTs
  if (req.method === 'POST' && (urlPath === '/generate' || urlPath === '/batch')) {
    if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return json(res, 400, { error: 'invalid_json' }); }

    if (urlPath === '/generate') {
      if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: 'missing_prompt' });
      const job = makeJob(body);
      const position = enqueue(job);
      return json(res, 202, { jobId: job.id, status: 'queued', position, quantity: job.quantity });
    }

    // /batch
    let items = [];
    if (Array.isArray(body.items)) items = body.items;
    else if (Array.isArray(body.prompts)) items = body.prompts.map((p) => ({ ...body, prompt: p }));
    else return json(res, 400, { error: 'missing_items', message: 'Provide "prompts": [..] or "items": [{prompt,..}]' });

    const created = [];
    for (const it of items) {
      const prompt = (typeof it === 'string' ? it : it.prompt || '').trim();
      if (!prompt) continue;
      const job = makeJob({ ...body, ...(typeof it === 'object' ? it : {}), prompt });
      enqueue(job);
      created.push(job.id);
    }
    return json(res, 202, { jobIds: created, count: created.length, pending: queue.length });
  }

  return json(res, 404, { error: 'not_found' });
});

loadJobs();
server.listen(PORT, () => {
  console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[api] API key: ${API_KEY}`);
  console.log(`[api] Default quantity: ${DEFAULT_QUANTITY} images/prompt. Jobs process sequentially.`);
  ensureBrowser().catch((e) => console.error('[api] warmup failed:', e.message));
  if (queue.length) setImmediate(processNext);
});
