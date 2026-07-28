#!/usr/bin/env node
// HTTP API with a CONCURRENT job queue for Google Flow image generation.
// - Up to `concurrency` (default 3) prompts are generated in parallel.
// - Each generation uses Flow count = 1.
// - Results are matched to their prompt via Flow's internal API response
//   (flowMedia:batchGenerateImages echoes the exact prompt), so correlation
//   is exact even under concurrency.
// Dependency-free HTTP (Node 18+).
//
// Config (config/flow.config.json):
//   "apiPort": 8080, "apiKey": "<secret>", "concurrency": 3
//
// Endpoints:
//   GET  /health | GET /queue
//   POST /generate {prompt, ratio?, model?}        -> { jobId, status }
//   POST /batch    {prompts:[...]} | {items:[...]}  -> { jobIds:[...] }
//   GET  /jobs/:id | GET /jobs | GET /outputs/...
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { get } from '../src/utils/config.js';
import { launchChromeDirect, closeBrowser, getPage, isBrowserConnected } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { attachResultListener, resetResultListener, submitPrompt, takeResultForPrompt, downloadResult } from '../src/tools/flow-batch.js';
import { clearProjectMedia, emptyTrash } from '../src/tools/flow-cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'flow.config.json');
const JOBS_FILE = path.join(PROJECT_ROOT, 'outputs', 'jobs.json');

const PORT = get('apiPort', 8080);
const CONCURRENCY = get('concurrency', 3);
const JOB_TIMEOUT_MS = get('jobTimeoutMs', 240000);
const CDP_PORT = get('cdpPort', 9222);
const RECYCLE_EVERY = get('recycleEveryGenerations', 40); // recycle Chrome after N generations
const MIN_AVAIL_MB = get('minAvailableMemMB', 300);       // recycle if available RAM drops below this
const CLEAR_EVERY = get('clearEveryGenerations', 3);      // move gallery to trash after N generations
const ENABLE_CLEANUP = get('enableTrashCleanup', false);  // DANGEROUS: current impl deletes the project — keep OFF

let genCount = 0;        // total completed generations
let lastRecycleGen = 0;  // genCount at last recycle
let lastClearGen = 0;    // genCount at last gallery clear

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Job store ----------
const jobs = new Map();
const queue = [];             // pending job ids
const inFlight = new Map();   // id -> job (submitted, awaiting result)
let ready = false;
let pumpRunning = false;

function loadJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const j of arr) jobs.set(j.id, j);
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
  attachResultListener(page);
  ready = true;
  console.log('[api] Chrome ready and on Google Flow.');
}

async function resetBrowser() {
  ready = false;
  resetResultListener();
  try { await closeBrowser(); } catch {}
}

// ---------- Self-maintenance ----------
// Available RAM in MB (accurate on Linux via MemAvailable).
function availableMemMB() {
  try {
    const s = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = s.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(parseInt(m[1], 10) / 1024);
  } catch {}
  return Math.round(os.freemem() / 1048576);
}

// (4) Remove orphan Chrome temp profiles left by crashed sessions.
function cleanTempProfiles() {
  try {
    const tmp = os.tmpdir();
    const current = global.__chromeTempDir || '';
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('chrome-kiara-cdp-')) continue;
      const full = path.join(tmp, name);
      if (full === current) continue;
      try {
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age > 5 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// (9) Is the Chrome DevTools endpoint responsive?
async function cdpHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return r.ok;
  } catch { return false; }
}

// (6) Decide whether Chrome should be recycled (only called at a safe, idle point).
function shouldRecycleChrome() {
  if (!ready) return false;
  if (genCount - lastRecycleGen >= RECYCLE_EVERY) return true;
  if (availableMemMB() < MIN_AVAIL_MB) return true;
  return false;
}

// ---------- Concurrent pump ----------
function enqueue(job) {
  jobs.set(job.id, job);
  queue.push(job.id);
  saveJobs();
  setImmediate(pump);
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    while (queue.length > 0 || inFlight.size > 0) {
      // At a safe point (nothing in flight): periodic cleanup + Chrome recycle.
      if (inFlight.size === 0) {
        // Move the accumulated gallery to trash every N generations (keeps DOM light).
        if (ENABLE_CLEANUP && ready && genCount - lastClearGen >= CLEAR_EVERY) {
          try { const r = await clearProjectMedia(); console.log(`[api] Cleared gallery to trash`, r); } catch {}
          lastClearGen = genCount;
        }
        // (6) Recycle Chrome to avoid memory leaks.
        if (shouldRecycleChrome()) {
          console.log(`[api] Recycling Chrome (gen ${genCount}, availMB ${availableMemMB()})`);
          await resetBrowser();
          lastRecycleGen = genCount;
        }
      }

      // Fill up to concurrency (submits are serialized; generations overlap)
      while (inFlight.size < CONCURRENCY && queue.length > 0) {
        const id = queue.shift();
        const job = jobs.get(id);
        if (!job) continue;
        try {
          await ensureBrowser();
          job.status = 'processing';
          job.startedAt = Date.now();
          const { ratio } = await submitPrompt({ prompt: job.prompt, ratio: job.ratio, model: job.model });
          job.ratio = ratio;
          job.submittedAt = Date.now();
          inFlight.set(id, job);
          saveJobs();
          console.log(`[api] Submitted ${id}: "${job.prompt}" (inFlight ${inFlight.size}, queued ${queue.length})`);
        } catch (e) {
          job.status = 'failed';
          job.error = e.message;
          job.finishedAt = Date.now();
          saveJobs();
          console.error(`[api] Submit failed ${id}: ${e.message}`);
          // Only fully reset if Chrome actually died; otherwise the next
          // submitPrompt will reload the project and recover on its own.
          if (!isBrowserConnected()) await resetBrowser();
        }
        await sleep(1500);
      }

      // Collect finished results (matched by exact prompt)
      for (const [id, job] of [...inFlight]) {
        const r = takeResultForPrompt(job.prompt);
        if (r) {
          try {
            const file = await downloadResult(r, id);
            job.images = [{ file }];
            job.aspectRatio = r.aspectRatio;
            job.status = 'done';
            job.finishedAt = Date.now();
            genCount++;
            console.log(`[api] Done ${id}`);
          } catch (e) {
            job.status = 'failed';
            job.error = e.message;
            job.finishedAt = Date.now();
          }
          inFlight.delete(id);
          saveJobs();
        } else if (Date.now() - job.submittedAt > JOB_TIMEOUT_MS) {
          job.status = 'failed';
          job.error = 'timeout';
          job.finishedAt = Date.now();
          inFlight.delete(id);
          saveJobs();
          console.error(`[api] Timeout ${id}`);
        }
      }

      await sleep(1500);
    }
    // All jobs drained → optional cleanup (disabled by default; see ENABLE_CLEANUP).
    if (ENABLE_CLEANUP && ready) {
      try {
        await clearProjectMedia();
        await emptyTrash();
        lastClearGen = genCount;
        console.log('[api] Final cleanup done.');
      } catch (e) { console.warn('[api] final cleanup failed:', e.message); }
    }
  } finally {
    pumpRunning = false;
    if (queue.length > 0) setImmediate(pump);
  }
}

// ---------- HTTP ----------
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
    ratio: body.ratio || null,
    model: body.model || null,
    status: 'queued',
    images: [],
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    submittedAt: null,
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

  if (req.method === 'GET' && urlPath === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && urlPath === '/queue') {
    return json(res, 200, { pending: queue.length, inFlight: inFlight.size, concurrency: CONCURRENCY, total: jobs.size });
  }
  if (req.method === 'GET' && urlPath.startsWith('/outputs/')) return serveOutput(res, urlPath);
  if (req.method === 'GET' && urlPath.startsWith('/jobs/')) {
    const job = jobs.get(urlPath.slice('/jobs/'.length));
    if (!job) return json(res, 404, { error: 'not_found' });
    return json(res, 200, withUrls(job, host));
  }
  if (req.method === 'GET' && urlPath === '/jobs') {
    const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
      .map((j) => ({ id: j.id, prompt: j.prompt, status: j.status, images: (j.images || []).length }));
    return json(res, 200, { jobs: list });
  }

  if (req.method === 'POST' && (urlPath === '/generate' || urlPath === '/batch')) {
    if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch { return json(res, 400, { error: 'invalid_json' }); }

    if (urlPath === '/generate') {
      if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: 'missing_prompt' });
      const job = makeJob(body);
      enqueue(job);
      return json(res, 202, { jobId: job.id, status: 'queued' });
    }

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
  console.log(`[api] Concurrency: ${CONCURRENCY} prompts in parallel; 1 image each; matched by prompt.`);
  ensureBrowser().catch((e) => console.error('[api] warmup failed:', e.message));
  if (queue.length) setImmediate(pump);
});

// (4) + (9) Periodic maintenance: clean orphan temp profiles; when idle,
// verify Chrome is responsive and reset it if not.
setInterval(async () => {
  cleanTempProfiles();
  if (!pumpRunning && inFlight.size === 0 && ready) {
    if (!(await cdpHealthy())) {
      console.log('[api] CDP unresponsive while idle — resetting Chrome.');
      await resetBrowser();
    }
  }
}, 60000);
