#!/usr/bin/env node
// HTTP API with a CONCURRENT job queue for Google Flow image generation.
// Features: multi API-key, audit log, webhooks, job cancel/retry, priority queue,
// batch grouping, retention cleanup, /stats, extended /health, session alerts,
// optional S3/R2 upload, self-maintenance (Chrome recycle, temp cleanup, CDP health),
// safe per-image trash cleanup. Dependency-free core (Node 18+); S3 is lazy/optional.
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
import { trashImages, emptyTrash } from '../src/tools/flow-cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'flow.config.json');
const JOBS_FILE = path.join(PROJECT_ROOT, 'outputs', 'jobs.json');
const AUDIT_FILE = path.join(PROJECT_ROOT, 'outputs', 'audit.log');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'outputs', 'images');

const PORT = get('apiPort', 8080);
const CONCURRENCY = get('concurrency', 3);
const JOB_TIMEOUT_MS = get('jobTimeoutMs', 240000);
const CDP_PORT = get('cdpPort', 9222);
const RECYCLE_EVERY = get('recycleEveryGenerations', 40);
const MIN_AVAIL_MB = get('minAvailableMemMB', 300);
const CLEAR_EVERY = get('clearEveryGenerations', 10);
const ENABLE_CLEANUP = get('enableTrashCleanup', false);
const AUDIT_ENABLED = get('auditLog', true);
const RETENTION_DAYS = get('retentionDays', 7);
const ALERT_WEBHOOK = get('alertWebhookUrl', '');
const DEFAULT_WEBHOOK = get('defaultWebhookUrl', '');
const S3CFG = get('s3', null);

// ---- API keys (single legacy key + optional list of {key,name}) ----
let SINGLE_KEY = get('apiKey');
if (!SINGLE_KEY) {
  SINGLE_KEY = crypto.randomBytes(16).toString('hex');
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); c.apiKey = SINGLE_KEY; fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n'); } catch {}
  console.log(`[api] Generated API key: ${SINGLE_KEY}`);
}
const KEY_LIST = (get('apiKeys', []) || []).map((k) => (typeof k === 'string' ? { key: k, name: 'client' } : k));
const ALL_KEYS = new Map([[SINGLE_KEY, 'default'], ...KEY_LIST.map((k) => [k.key, k.name || 'client'])]);
function keyName(req) { return ALL_KEYS.get(req.headers['x-api-key']); }
function authorized(req) { return ALL_KEYS.has(req.headers['x-api-key']); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Job store ----------
const jobs = new Map();
const queue = [];
const inFlight = new Map();
let ready = false;
let pumpRunning = false;
let lastRetention = 0;
const stats = { done: 0, failed: 0, totalMs: 0 };

function loadJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const j of arr) jobs.set(j.id, j);
    for (const j of arr) if (j.status === 'queued' || j.status === 'processing') { j.status = 'queued'; queue.push(j.id); }
  } catch {}
}
function saveJobs() {
  try { fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true }); fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2)); } catch {}
}

// ---------- Audit (lightweight, async append; never blocks the loop) ----------
function audit(entry) {
  if (!AUDIT_ENABLED) return;
  try {
    fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true }, () => {
      fs.appendFile(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});
    });
  } catch {}
}

// ---------- Webhook + alerts (fire-and-forget) ----------
function postJson(url, body) {
  if (!url) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
function fireWebhook(job) {
  const url = job.callbackUrl || DEFAULT_WEBHOOK;
  if (url) postJson(url, publicJob(job, job.host));
}
let lastAlertAt = 0;
function alertAdmin(text) {
  const now = Date.now();
  if (now - lastAlertAt < 60000) return; // throttle 1/min
  lastAlertAt = now;
  console.error('[api] ALERT:', text);
  if (ALERT_WEBHOOK) postJson(ALERT_WEBHOOK, { text: `[flow-api] ${text}` });
}

// ---------- S3 / R2 (optional, lazy import so no hard dependency) ----------
let s3client = null;
async function uploadToS3(relPath) {
  if (!S3CFG || !S3CFG.bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    if (!s3client) s3client = new S3Client({ region: S3CFG.region || 'auto', endpoint: S3CFG.endpoint, credentials: { accessKeyId: S3CFG.accessKeyId, secretAccessKey: S3CFG.secretAccessKey } });
    const key = relPath.replace(/^outputs\//, '');
    const body = fs.readFileSync(path.join(PROJECT_ROOT, relPath));
    const ext = path.extname(relPath).toLowerCase();
    await s3client.send(new PutObjectCommand({ Bucket: S3CFG.bucket, Key: key, Body: body, ContentType: ext === '.png' ? 'image/png' : 'image/jpeg' }));
    return (S3CFG.publicBaseUrl || '').replace(/\/$/, '') + '/' + key;
  } catch (e) { console.warn('[api] S3 upload skipped:', e.message); return null; }
}

// ---------- Browser lifecycle ----------
async function ensureBrowser() {
  if (ready && isBrowserConnected()) { try { getPage(); return; } catch { ready = false; } }
  console.log('[api] Launching persistent Chrome...');
  const { page } = await launchChromeDirect({ headless: true });
  const nav = await navigateToFlow(page);
  attachResultListener(page);
  ready = true;
  if (nav && nav.authenticated === false) alertAdmin('Google session appears logged out / verification required. Re-login via VNC.');
  console.log('[api] Chrome ready and on Google Flow.');
}
async function resetBrowser() { ready = false; resetResultListener(); try { await closeBrowser(); } catch {} }
function availableMemMB() {
  try { const s = fs.readFileSync('/proc/meminfo', 'utf8'); const m = s.match(/MemAvailable:\s+(\d+)\s+kB/); if (m) return Math.round(parseInt(m[1], 10) / 1024); } catch {}
  return Math.round(os.freemem() / 1048576);
}
function cleanTempProfiles() {
  try {
    const tmp = os.tmpdir(); const current = global.__chromeTempDir || '';
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('chrome-kiara-cdp-')) continue;
      const full = path.join(tmp, name); if (full === current) continue;
      try { if (Date.now() - fs.statSync(full).mtimeMs > 5 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}
async function cdpHealthy() { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return r.ok; } catch { return false; } }
function shouldRecycleChrome() {
  if (!ready) return false;
  if (genCount - lastRecycleGen >= RECYCLE_EVERY) return true;
  if (availableMemMB() < MIN_AVAIL_MB) return true;
  return false;
}
let genCount = 0, lastRecycleGen = 0, lastClearGen = 0;

// ---------- Retention: delete old images + prune old jobs ----------
function runRetention() {
  if (RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  try {
    if (fs.existsSync(IMAGES_DIR)) for (const f of fs.readdirSync(IMAGES_DIR)) {
      const p = path.join(IMAGES_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch {}
    }
  } catch {}
  let pruned = 0;
  for (const [id, j] of [...jobs]) {
    if ((j.finishedAt || j.createdAt || 0) < cutoff && j.status !== 'queued' && j.status !== 'processing') { jobs.delete(id); pruned++; }
  }
  if (pruned) saveJobs();
}

// ---------- Concurrent pump ----------
function enqueue(job) {
  jobs.set(job.id, job);
  let i = queue.length;
  while (i > 0 && (jobs.get(queue[i - 1])?.priority || 0) < (job.priority || 0)) i--;
  queue.splice(i, 0, job.id);
  saveJobs();
  setImmediate(pump);
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    while (queue.length > 0 || inFlight.size > 0) {
      if (inFlight.size === 0) {
        if (ENABLE_CLEANUP && ready && genCount - lastClearGen >= CLEAR_EVERY) {
          try { const r = await trashImages(); console.log('[api] Moved images to trash', r); } catch {}
          lastClearGen = genCount;
        }
        if (shouldRecycleChrome()) {
          console.log(`[api] Recycling Chrome (gen ${genCount}, availMB ${availableMemMB()})`);
          await resetBrowser(); lastRecycleGen = genCount;
        }
      }

      while (inFlight.size < CONCURRENCY && queue.length > 0) {
        const id = queue.shift();
        const job = jobs.get(id);
        if (!job || job.status === 'cancelled') continue;
        try {
          await ensureBrowser();
          job.status = 'processing'; job.startedAt = Date.now();
          const { ratio } = await submitPrompt({ prompt: job.prompt, ratio: job.ratio, model: job.model, reference: job.reference });
          job.ratio = ratio; job.submittedAt = Date.now();
          inFlight.set(id, job); saveJobs();
          console.log(`[api] Submitted ${id}: "${job.prompt}" (inFlight ${inFlight.size}, queued ${queue.length})`);
        } catch (e) {
          job.status = 'failed'; job.error = e.message; job.finishedAt = Date.now();
          stats.failed++; saveJobs(); fireWebhook(job);
          console.error(`[api] Submit failed ${id}: ${e.message}`);
          if (!isBrowserConnected()) await resetBrowser();
        }
        await sleep(1500);
      }

      for (const [id, job] of [...inFlight]) {
        const r = takeResultForPrompt(job.prompt);
        if (r) {
          try {
            const file = await downloadResult(r, id);
            const s3url = await uploadToS3(file);
            job.images = [{ file, s3Url: s3url || undefined }];
            job.aspectRatio = r.aspectRatio; job.status = 'done'; job.finishedAt = Date.now();
            stats.done++; stats.totalMs += (job.finishedAt - (job.startedAt || job.finishedAt));
            genCount++;
            console.log(`[api] Done ${id}`);
          } catch (e) {
            job.status = 'failed'; job.error = e.message; job.finishedAt = Date.now(); stats.failed++;
          }
          inFlight.delete(id); saveJobs(); fireWebhook(job);
        } else if (Date.now() - job.submittedAt > JOB_TIMEOUT_MS) {
          job.status = 'failed'; job.error = 'timeout'; job.finishedAt = Date.now(); stats.failed++;
          inFlight.delete(id); saveJobs(); fireWebhook(job);
          console.error(`[api] Timeout ${id}`);
        }
      }
      await sleep(1500);
    }
    if (ENABLE_CLEANUP && ready) {
      try { await trashImages(); await emptyTrash(); lastClearGen = genCount; console.log('[api] Final cleanup done.'); }
      catch (e) { console.warn('[api] final cleanup failed:', e.message); }
    }
  } finally {
    pumpRunning = false;
    if (queue.length > 0) setImmediate(pump);
  }
}

// ---------- HTTP helpers ----------
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); }
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 5e6) req.destroy(); }); req.on('end', () => r(d)); }); }
function imageUrls(im, host) { return { file: im.file, url: im.s3Url || `http://${host}/${im.file}`, ...(im.s3Url ? { s3Url: im.s3Url } : {}) }; }
function publicJob(job, host) { return { ...job, host: undefined, callbackUrl: undefined, images: (job.images || []).map((im) => imageUrls(im, host || job.host || `localhost:${PORT}`)) }; }
function makeJob(body, host) {
  return {
    id: crypto.randomUUID(),
    batchId: body.batchId || null,
    prompt: (body.prompt || '').trim(),
    ratio: body.ratio || null,
    model: body.model || null,
    reference: body.reference || null,
    priority: parseInt(body.priority || 0, 10) || 0,
    callbackUrl: body.webhook || body.callbackUrl || null,
    host, status: 'queued', images: [], error: null,
    createdAt: Date.now(), startedAt: null, submittedAt: null, finishedAt: null,
  };
}
function serveOutput(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\//, ''));
  if (!rel.startsWith('outputs/') || rel.includes('..')) return json(res, 403, { error: 'forbidden' });
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(path.join(PROJECT_ROOT, 'outputs')) || !fs.existsSync(abs)) return json(res, 404, { error: 'not_found' });
  const ext = path.extname(abs).toLowerCase();
  const type = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
  const buf = fs.readFileSync(abs); res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length }); res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  const urlPath = (req.url || '/').split('?')[0];

  // Public GETs
  if (req.method === 'GET' && urlPath === '/health') {
    const healthy = ready && await cdpHealthy();
    return json(res, 200, { ok: true, chromeReady: ready, cdpHealthy: healthy, account: get('expectedAccount'), queue: { pending: queue.length, inFlight: inFlight.size, concurrency: CONCURRENCY } });
  }
  if (req.method === 'GET' && urlPath === '/queue') return json(res, 200, { pending: queue.length, inFlight: inFlight.size, concurrency: CONCURRENCY, total: jobs.size });
  if (req.method === 'GET' && urlPath === '/stats') {
    const avg = stats.done ? Math.round(stats.totalMs / stats.done) : 0;
    const total = stats.done + stats.failed;
    return json(res, 200, { generated: stats.done, failed: stats.failed, pending: queue.length, inFlight: inFlight.size, avgMs: avg, successRate: total ? +(stats.done / total).toFixed(3) : 1, creditsUsed: stats.done });
  }
  if (req.method === 'GET' && urlPath.startsWith('/outputs/')) return serveOutput(res, urlPath);
  if (req.method === 'GET' && urlPath.startsWith('/batch/')) {
    const bid = urlPath.slice('/batch/'.length);
    const list = [...jobs.values()].filter((j) => j.batchId === bid);
    if (!list.length) return json(res, 404, { error: 'not_found' });
    const by = (s) => list.filter((j) => j.status === s).length;
    return json(res, 200, { batchId: bid, total: list.length, done: by('done'), failed: by('failed'), processing: by('processing'), queued: by('queued'), jobs: list.map((j) => publicJob(j, host)) });
  }
  if (req.method === 'GET' && urlPath.startsWith('/jobs/')) {
    const job = jobs.get(urlPath.slice('/jobs/'.length));
    if (!job) return json(res, 404, { error: 'not_found' });
    return json(res, 200, publicJob(job, host));
  }
  if (req.method === 'GET' && urlPath === '/jobs') {
    const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
      .map((j) => ({ id: j.id, prompt: j.prompt, status: j.status, batchId: j.batchId, images: (j.images || []).length }));
    return json(res, 200, { jobs: list });
  }

  // Protected
  if (!authorized(req)) {
    if (['POST', 'DELETE'].includes(req.method)) return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/jobs/')) {
    const id = urlPath.slice('/jobs/'.length);
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'not_found' });
    if (job.status === 'queued') {
      const idx = queue.indexOf(id); if (idx >= 0) queue.splice(idx, 1);
      job.status = 'cancelled'; job.finishedAt = Date.now(); saveJobs();
      audit({ action: 'cancel', key: keyName(req), ip, jobId: id });
      return json(res, 200, { id, status: 'cancelled' });
    }
    return json(res, 409, { error: 'not_cancellable', status: job.status, message: 'Only queued jobs can be cancelled.' });
  }

  if (req.method === 'POST' && urlPath.match(/^\/jobs\/[^/]+\/retry$/)) {
    const id = urlPath.split('/')[2];
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'not_found' });
    if (job.status !== 'failed' && job.status !== 'cancelled') return json(res, 409, { error: 'not_retryable', status: job.status });
    job.status = 'queued'; job.error = null; job.images = []; job.startedAt = null; job.finishedAt = null; job.host = host;
    enqueue(job);
    audit({ action: 'retry', key: keyName(req), ip, jobId: id });
    return json(res, 202, { id, status: 'queued' });
  }

  if (req.method === 'POST' && (urlPath === '/generate' || urlPath === '/batch')) {
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }

    if (urlPath === '/generate') {
      if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: 'missing_prompt' });
      const job = makeJob(body, host); enqueue(job);
      audit({ action: 'generate', key: keyName(req), ip, jobId: job.id, prompt: job.prompt });
      return json(res, 202, { jobId: job.id, status: 'queued' });
    }

    let items = [];
    if (Array.isArray(body.items)) items = body.items;
    else if (Array.isArray(body.prompts)) items = body.prompts.map((p) => ({ ...body, prompt: p }));
    else return json(res, 400, { error: 'missing_items', message: 'Provide "prompts": [..] or "items": [{prompt,..}]' });

    const batchId = crypto.randomUUID();
    const created = [];
    for (const it of items) {
      const prompt = (typeof it === 'string' ? it : it.prompt || '').trim();
      if (!prompt) continue;
      const job = makeJob({ ...body, ...(typeof it === 'object' ? it : {}), prompt, batchId }, host);
      enqueue(job); created.push(job.id);
    }
    audit({ action: 'batch', key: keyName(req), ip, batchId, count: created.length });
    return json(res, 202, { batchId, jobIds: created, count: created.length, pending: queue.length });
  }

  return json(res, 404, { error: 'not_found' });
});

loadJobs();
server.listen(PORT, () => {
  console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[api] Keys: ${ALL_KEYS.size} | Concurrency: ${CONCURRENCY} | Cleanup: ${ENABLE_CLEANUP} | Audit: ${AUDIT_ENABLED} | Retention: ${RETENTION_DAYS}d | S3: ${!!(S3CFG && S3CFG.bucket)}`);
  ensureBrowser().catch((e) => console.error('[api] warmup failed:', e.message));
  if (queue.length) setImmediate(pump);
});

// Periodic maintenance: temp cleanup, idle CDP health check, retention.
setInterval(async () => {
  cleanTempProfiles();
  if (Date.now() - lastRetention > 3600000) { lastRetention = Date.now(); runRetention(); }
  if (!pumpRunning && inFlight.size === 0 && ready) {
    if (!(await cdpHealthy())) { console.log('[api] CDP unresponsive while idle — resetting Chrome.'); await resetBrowser(); alertAdmin('CDP was unresponsive; Chrome was reset.'); }
  }
}, 60000);
