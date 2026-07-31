#!/usr/bin/env node
// Flow image generation API with concurrent queue + rich integration features.
// See INTEGRATION.md for full docs.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { get } from '../src/utils/config.js';
import { launchChromeDirect, closeBrowser, getPage, isBrowserConnected } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { attachResultListener, resetResultListener, submitPrompt, takeResultsForPrompt, downloadResult, getCredits, refreshCredits } from '../src/tools/flow-batch.js';
import { trashImages, emptyTrash } from '../src/tools/flow-cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'flow.config.json');
const JOBS_FILE = path.join(PROJECT_ROOT, 'outputs', 'jobs.json');
const REFS_FILE = path.join(PROJECT_ROOT, 'outputs', 'refs.json');
const AUDIT_FILE = path.join(PROJECT_ROOT, 'outputs', 'audit.log');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'outputs', 'images');
const REF_DIR = path.join(PROJECT_ROOT, 'outputs', 'refs');

const PORT = get('apiPort', 8080);
const CONCURRENCY = get('concurrency', 3);
const JOB_TIMEOUT_MS = get('jobTimeoutMs', 240000);
const CDP_PORT = get('cdpPort', 9222);
const RECYCLE_EVERY = get('recycleEveryGenerations', 40);
const MIN_AVAIL_MB = get('minAvailableMemMB', 150);
const CLEAR_EVERY = get('clearEveryGenerations', 10);
const ENABLE_CLEANUP = get('enableTrashCleanup', false);
const AUDIT_ENABLED = get('auditLog', true);
const RETENTION_DAYS = get('retentionDays', 7);
const ALERT_WEBHOOK = get('alertWebhookUrl', '');
const DEFAULT_WEBHOOK = get('defaultWebhookUrl', '');
const WEBHOOK_SECRET = get('webhookSecret', '');
const S3CFG = get('s3', null);
const MAX_QUEUE = get('maxQueue', 1000);
const COST_PER_IMAGE = get('costPerImage', 0);
const STYLE_PRESETS = get('stylePresets', {});
const SUPPORTED_RATIOS = get('ratios', ['16:9', '4:3', '1:1', '3:4', '9:16']);
const RATIO_ALIASES = { '4:5': '3:4', '5:4': '4:3', '2:3': '3:4', '3:2': '4:3', '21:9': '16:9', '1080p': '16:9', '1920x1080': '16:9' };

let SINGLE_KEY = get('apiKey');
if (!SINGLE_KEY) {
  SINGLE_KEY = crypto.randomBytes(16).toString('hex');
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); c.apiKey = SINGLE_KEY; fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n'); } catch {}
  console.log(`[api] Generated API key: ${SINGLE_KEY}`);
}
const KEY_LIST = (get('apiKeys', []) || []).map((k) => (typeof k === 'string' ? { key: k, name: 'client' } : k));
const KEY_INFO = new Map([[SINGLE_KEY, { name: 'default', dailyLimit: 0 }], ...KEY_LIST.map((k) => [k.key, { name: k.name || 'client', dailyLimit: k.dailyLimit || 0, createdAt: k.createdAt || null }])]);
function keyInfo(req) { return KEY_INFO.get(req.headers['x-api-key']); }
function authorized(req) { return KEY_INFO.has(req.headers['x-api-key']); }

function saveDynamicKeys() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const list = [];
    for (const [k, info] of KEY_INFO.entries()) {
      if (k !== SINGLE_KEY) list.push({ key: k, name: info.name, dailyLimit: info.dailyLimit || 0, createdAt: info.createdAt || Date.now() });
    }
    c.apiKeys = list;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
  } catch (e) {
    console.error('[api] failed to save dynamic keys:', e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Stores ----------
const jobs = new Map();
const queue = [];
const inFlight = new Map();
const idemMap = new Map();       // idempotencyKey -> jobId
const refCache = new Map();      // referenceId -> local file path
const keyUsage = new Map();      // key -> { day, count }
let ready = false, pumpRunning = false, lastRetention = 0;
let genCount = 0, lastRecycleGen = 0, lastClearGen = 0;
const stats = { done: 0, failed: 0, images: 0, totalMs: 0 };

function loadJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const j of arr) { jobs.set(j.id, j); if (j.idempotencyKey) idemMap.set(j.idempotencyKey, j.id); }
    for (const j of arr) if (j.status === 'queued' || j.status === 'processing') { j.status = 'queued'; queue.push(j.id); }
  } catch {}
}
function saveJobs() { try { fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true }); fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2)); } catch {} }

// Persist the reference library (referenceId -> local file) so registered
// characters/ingredients survive an API restart (Characters panel durability).
function saveRefs() {
  try {
    const obj = {}; for (const [id, p] of refCache) obj[id] = path.relative(PROJECT_ROOT, p);
    fs.mkdirSync(path.dirname(REFS_FILE), { recursive: true }); fs.writeFileSync(REFS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}
function loadRefs() {
  try {
    const obj = JSON.parse(fs.readFileSync(REFS_FILE, 'utf-8'));
    for (const [id, rel] of Object.entries(obj)) { const abs = path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel); if (fs.existsSync(abs)) refCache.set(id, abs); }
  } catch {}
}

function audit(entry) {
  if (!AUDIT_ENABLED) return;
  try { fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true }, () => { fs.appendFile(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {}); }); } catch {}
}

// ---------- Webhooks + alerts ----------
function postJson(url, body) {
  if (!url) return;
  const payload = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  fetch(url, { method: 'POST', headers, body: payload }).catch(() => {});
}
function fireWebhook(job) {
  const url = job.callbackUrl || DEFAULT_WEBHOOK;
  if (!url) return;
  const pj = publicJob(job, job.host);
  const firstImg = pj.images && pj.images[0] ? (pj.images[0].s3Url || pj.images[0].url) : null;
  postJson(url, { ok: job.status === 'done', jobId: job.id, status: job.status, imageUrl: firstImg, images: pj.images, error: job.error, ...pj });
}
let lastAlertAt = 0;
function alertAdmin(text) { const now = Date.now(); if (now - lastAlertAt < 60000) return; lastAlertAt = now; console.error('[api] ALERT:', text); if (ALERT_WEBHOOK) postJson(ALERT_WEBHOOK, { text: `[flow-api] ${text}` }); }

// ---------- S3 / R2 ----------
let s3client = null;
async function uploadToS3(relPath) {
  if (!S3CFG || !S3CFG.bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    if (!s3client) s3client = new S3Client({ region: S3CFG.region || 'auto', endpoint: S3CFG.endpoint, credentials: { accessKeyId: S3CFG.accessKeyId, secretAccessKey: S3CFG.secretAccessKey } });
    const prefix = (S3CFG.prefix || '').replace(/^\/+|\/+$/g, '');
    const key = (prefix ? prefix + '/' : '') + relPath.replace(/^outputs\//, '');
    const ext = path.extname(relPath).toLowerCase();
    await s3client.send(new PutObjectCommand({ Bucket: S3CFG.bucket, Key: key, Body: fs.readFileSync(path.join(PROJECT_ROOT, relPath)), ContentType: ext === '.png' ? 'image/png' : 'image/jpeg' }));
    return (S3CFG.publicBaseUrl || '').replace(/\/$/, '') + '/' + key;
  } catch (e) { console.warn('[api] S3 upload skipped:', e.message); return null; }
}

// Upload a job's images to R2 in the background, then fire its webhook.
// Keeps the generation pipeline fast (no waiting for uploads).
function finalizeUploads(job) {
  if (!(S3CFG && S3CFG.bucket)) { fireWebhook(job); return; }
  (async () => {
    for (const img of job.images) { if (!img.s3Url) { const u = await uploadToS3(img.file); if (u) img.s3Url = u; } }
    saveJobs(); fireWebhook(job);
  })().catch(() => { fireWebhook(job); });
}

// ---------- Browser lifecycle + maintenance ----------
let ensuring = null;
async function ensureBrowser() {
  if (ready && isBrowserConnected()) { try { getPage(); return; } catch { ready = false; } }
  if (ensuring) return ensuring; // prevent concurrent double-launch
  ensuring = (async () => {
    console.log('[api] Launching persistent Chrome (Account Pool Active)...');
    const profile2Exists = fs.existsSync('/home/beka/.config/google-chrome-acc2');
    const { page } = await launchChromeDirect({
      headless: get('headless', false),
      profileSource: profile2Exists ? '/home/beka/.config/google-chrome-acc2' : undefined
    });
    const nav = await navigateToFlow(page);
    attachResultListener(page);
    ready = true;
    if (nav && nav.authenticated === false) alertAdmin('Google session logged out / verification required. Re-login via VNC.');
    console.log('[api] Chrome ready and on Google Flow.');
  })().finally(() => { ensuring = null; });
  return ensuring;
}
async function resetBrowser() { ready = false; resetResultListener(); try { await closeBrowser(); } catch {} }
function availableMemMB() { try { const s = fs.readFileSync('/proc/meminfo', 'utf8'); const m = s.match(/MemAvailable:\s+(\d+)\s+kB/); if (m) return Math.round(parseInt(m[1], 10) / 1024); } catch {} return Math.round(os.freemem() / 1048576); }
function cleanTempProfiles() {
  try { const tmp = os.tmpdir(); const cur = global.__chromeTempDir || '';
    for (const n of fs.readdirSync(tmp)) { if (!n.startsWith('chrome-kiara-cdp-')) continue; const f = path.join(tmp, n); if (f === cur) continue; try { if (Date.now() - fs.statSync(f).mtimeMs > 5 * 60 * 1000) fs.rmSync(f, { recursive: true, force: true }); } catch {} }
  } catch {}
}
async function cdpHealthy() { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return r.ok; } catch { return false; } }
function shouldRecycleChrome() { if (!ready) return false; if (genCount - lastRecycleGen >= RECYCLE_EVERY) return true; if (availableMemMB() < MIN_AVAIL_MB) return true; return false; }
function runRetention() {
  if (RETENTION_DAYS <= 0) return; const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  try { if (fs.existsSync(IMAGES_DIR)) for (const f of fs.readdirSync(IMAGES_DIR)) { const p = path.join(IMAGES_DIR, f); try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch {} } } catch {}
  let pruned = 0; for (const [id, j] of [...jobs]) if ((j.finishedAt || j.createdAt || 0) < cutoff && j.status !== 'queued' && j.status !== 'processing') { jobs.delete(id); pruned++; } if (pruned) saveJobs();
}

// ---------- Helpers ----------
const RATIO_VALUES = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '3:4': 3 / 4, '9:16': 9 / 16 };
function nearestRatio(aspect) {
  let best = null, bd = Infinity;
  for (const r of SUPPORTED_RATIOS) { const v = RATIO_VALUES[r]; if (v == null) continue; const d = Math.abs(v - aspect); if (d < bd) { bd = d; best = r; } }
  return best || '1:1';
}
function normalizeRatio(r) { if (!r) return null; if (SUPPORTED_RATIOS.includes(r)) return r; if (RATIO_ALIASES[r] && SUPPORTED_RATIOS.includes(RATIO_ALIASES[r])) return RATIO_ALIASES[r]; return null; }

// Resize/crop a saved image to exact pixel dimensions (needs `sharp`).
async function resizeImage(relPath, w, h) {
  try {
    const sharp = (await import('sharp')).default;
    const abs = path.join(PROJECT_ROOT, relPath);
    const buf = await sharp(abs).resize(w, h, { fit: 'cover', position: 'centre' }).toBuffer();
    fs.writeFileSync(abs, buf);
    return true;
  } catch (e) { console.warn('[api] resize skipped (run `npm i sharp`?):', e.message); return false; }
}
function applyStyle(prompt, style) { const p = style && STYLE_PRESETS[style]; return p ? `${prompt}, ${p}` : prompt; }

function makeJob(body, host) {
  const style = body.style || null;
  const rawPrompt = (body.prompt || '').trim();
  // Exact pixel size support: width/height or "size":"1920x1080".
  let width = parseInt(body.width || 0, 10) || null;
  let height = parseInt(body.height || 0, 10) || null;
  if ((!width || !height) && body.size && /^\d+\s*[x×]\s*\d+$/i.test(body.size)) {
    const [w, h] = body.size.split(/[x×]/i).map((s) => parseInt(s.trim(), 10)); width = w; height = h;
  }
  // If exact pixels requested without an explicit ratio, pick the nearest Flow ratio.
  let ratio = normalizeRatio(body.ratio);
  if (!ratio && width && height) ratio = nearestRatio(width / height);
  return {
    width, height,
    id: crypto.randomUUID(),
    batchId: body.batchId || null,
    externalId: body.externalId || body.clientRef || null,
    idempotencyKey: body.idempotencyKey || null,
    prompt: applyStyle(rawPrompt, style),
    originalPrompt: rawPrompt,
    style,
    ratio: ratio || null,
    model: body.model || null,
    reference: body.reference || null,
    referenceId: body.referenceId || null,
    requestedSeed: (body.seed !== undefined && body.seed !== null && body.seed !== '') ? parseInt(body.seed, 10) : null,
    count: Math.min(Math.max(parseInt(body.count || 1, 10), 1), 4),
    priority: parseInt(body.priority || 0, 10) || 0,
    callbackUrl: body.webhookUrl || body.webhook || body.callbackUrl || null,
    host, status: 'queued', stage: 'queued', images: [], seed: null, error: null, code: null,
    createdAt: Date.now(), startedAt: null, submittedAt: null, finishedAt: null,
  };
}

function imageUrls(im, host) { return { file: im.file, url: im.s3Url || `http://${host}/${im.file}`, ...(im.s3Url ? { s3Url: im.s3Url } : {}) }; }
function publicJob(job, host) {
  const h = host || job.host || `localhost:${PORT}`;
  return {
    id: job.id, batchId: job.batchId, externalId: job.externalId,
    prompt: job.originalPrompt || job.prompt, style: job.style,
    status: job.status, stage: job.stage, code: job.code || undefined,
    model: job.model, ratio: job.ratio, aspectRatio: job.aspectRatio, seed: job.seed,
    width: job.width || undefined, height: job.height || undefined,
    count: job.count, images: (job.images || []).map((im) => imageUrls(im, h)),
    creditsUsed: (job.images || []).length, cost: (job.images || []).length * COST_PER_IMAGE,
    reproduction: { model: job.model, ratio: job.ratio, seed: job.seed },
    error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt,
  };
}

// Calculate dynamic concurrency based on free memory and CPU load
function dynamicConcurrency() {
  const memMB = availableMemMB();
  const load = (os.loadavg && os.loadavg()[0]) || 0;
  if (memMB < 300 || load > 6.0) return 1;
  if (memMB > 1200 && load < 2.5) return Math.min(CONCURRENCY + 1, 5);
  return CONCURRENCY;
}

// Self-Healing helper: reset and re-launch Chrome if un-healthy or stuck
async function selfHealBrowser(reason) {
  console.warn(`[api] Self-healing triggered: ${reason}`);
  try { await resetBrowser(); } catch {}
  try {
    await ensureBrowser();
    console.log('[api] Self-healing completed: Chrome re-launched cleanly.');
    return true;
  } catch (e) {
    console.error('[api] Self-healing failed:', e.message);
    alertAdmin(`Self-healing failed: ${e.message}`);
    return false;
  }
}

// Smart Cache: find previously completed identical job
function findSmartCache(job) {
  const p = (job.prompt || '').trim();
  if (!p) return null;
  for (const ex of jobs.values()) {
    if (ex.status === 'done' && (ex.images || []).length >= job.count && ex.prompt === p) {
      if (ex.ratio === job.ratio && ex.model === job.model && ex.width === job.width && ex.height === job.height) {
        const valid = ex.images.every((im) => im.s3Url || (im.file && fs.existsSync(path.join(PROJECT_ROOT, im.file))));
        if (valid) return ex;
      }
    }
  }
  return null;
}

// ---------- Queue ----------
function enqueue(job) {
  jobs.set(job.id, job);
  if (job.idempotencyKey) idemMap.set(job.idempotencyKey, job.id);
  let i = queue.length; while (i > 0 && (jobs.get(queue[i - 1])?.priority || 0) < (job.priority || 0)) i--;
  queue.splice(i, 0, job.id);
  saveJobs(); setImmediate(pump);
}

async function pump() {
  if (pumpRunning) return; pumpRunning = true;
  try {
    while (queue.length > 0 || inFlight.size > 0) {
      if (inFlight.size === 0) {
        if (ENABLE_CLEANUP && ready && genCount - lastClearGen >= CLEAR_EVERY) { try { const r = await trashImages(); console.log('[api] Moved images to trash', r); } catch {} lastClearGen = genCount; }
        if (shouldRecycleChrome()) { console.log(`[api] Recycling Chrome (gen ${genCount}, availMB ${availableMemMB()})`); await resetBrowser(); lastRecycleGen = genCount; }
      }
      const activeLimit = dynamicConcurrency();
      while (inFlight.size < activeLimit && queue.length > 0) {
        const id = queue.shift(); const job = jobs.get(id);
        if (!job || job.status === 'cancelled') continue;
        try {
          await ensureBrowser();
          job.status = 'processing'; job.stage = 'submitting'; job.startedAt = Date.now();
          const refInput = job.referenceId && refCache.get(job.referenceId) ? refCache.get(job.referenceId) : job.reference;
          await Promise.race([
            submitPrompt({ prompt: job.prompt, ratio: job.ratio, model: job.model, reference: refInput, count: job.count, seed: job.requestedSeed }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('submit_timeout')), 90000)),
          ]);
          job.stage = 'rendering'; job.submittedAt = Date.now();
          inFlight.set(id, job); saveJobs();
          console.log(`[api] Submitted ${id}: "${job.prompt}" x${job.count} (inFlight ${inFlight.size}, queued ${queue.length}, limit ${activeLimit})`);
        } catch (e) {
          job.status = 'failed'; job.finishedAt = Date.now();
          job.error = e.message; job.code = /content_rejected/i.test(e.message) ? 'content_rejected' : 'error';
          stats.failed++; saveJobs(); fireWebhook(job);
          console.error(`[api] Submit failed ${id}: ${e.message}`);
          // Self-healing: Reset and re-launch Chrome on hang/disconnect
          if (/submit_timeout/.test(e.message) || !isBrowserConnected()) {
            await selfHealBrowser(`Submit failed for ${id}: ${e.message}`);
          }
        }
        await sleep(1500);
      }
      for (const [id, job] of [...inFlight]) {
        const need = job.count - job.images.length;
        const results = need > 0 ? takeResultsForPrompt(job.prompt, need) : [];
        for (const r of results) {
          try {
            job.stage = 'downloading'; const file = await downloadResult(r, id);
            if (job.width && job.height) { job.stage = 'resizing'; await resizeImage(file, job.width, job.height); }
            job.images.push({ file }); // R2 upload happens in the background (finalizeUploads)
            if (job.seed == null && r.seed != null) job.seed = r.seed;
            if (r.aspectRatio) job.aspectRatio = r.aspectRatio;
          } catch (e) { console.warn(`[api] download err ${id}: ${e.message}`); }
        }
        if (job.images.length >= job.count) {
          job.status = 'done'; job.stage = 'done'; job.finishedAt = Date.now();
          stats.done++; stats.images += job.images.length; stats.totalMs += (job.finishedAt - (job.startedAt || job.finishedAt));
          genCount++; inFlight.delete(id); saveJobs(); finalizeUploads(job); console.log(`[api] Done ${id} (${job.images.length} img)`);
        } else if (Date.now() - job.submittedAt > JOB_TIMEOUT_MS) {
          if (job.images.length > 0) { job.status = 'done'; job.stage = 'done'; stats.done++; stats.images += job.images.length; }
          else { job.status = 'failed'; job.error = 'timeout'; job.code = 'timeout'; stats.failed++; }
          job.finishedAt = Date.now(); genCount++; inFlight.delete(id); saveJobs(); finalizeUploads(job); console.error(`[api] Timeout ${id}`);
        }
      }
      await sleep(1500);
    }
    if (ENABLE_CLEANUP && ready) { try { await trashImages(); await emptyTrash(); lastClearGen = genCount; console.log('[api] Final cleanup done.'); } catch (e) { console.warn('[api] final cleanup failed:', e.message); } }
  } finally { pumpRunning = false; if (queue.length > 0) setImmediate(pump); }
}

// ---------- HTTP ----------
function json(res, code, obj, extraHeaders) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...(extraHeaders || {}) }); res.end(b); }
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 8e6) req.destroy(); }); req.on('end', () => r(d)); }); }
function serveOutput(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\//, '')); if (!rel.startsWith('outputs/') || rel.includes('..')) return json(res, 403, { error: 'forbidden' });
  const abs = path.resolve(PROJECT_ROOT, rel); if (!abs.startsWith(path.join(PROJECT_ROOT, 'outputs')) || !fs.existsSync(abs)) return json(res, 404, { error: 'not_found' });
  const ext = path.extname(abs).toLowerCase(); const type = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
  const buf = fs.readFileSync(abs); res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length }); res.end(buf);
}
function checkQuota(req) {
  const info = keyInfo(req); if (!info || !info.dailyLimit) return true;
  const key = req.headers['x-api-key']; const today = new Date().toISOString().slice(0, 10);
  const u = keyUsage.get(key) || { day: today, count: 0 }; if (u.day !== today) { u.day = today; u.count = 0; }
  if (u.count >= info.dailyLimit) { keyUsage.set(key, u); return false; }
  u.count++; keyUsage.set(key, u); return true;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  const urlPath = (req.url || '/').split('?')[0];

  const rawHost = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  let hostIp = rawHost.split(':')[0];
  if (hostIp === 'localhost' || hostIp === '127.0.0.1' || hostIp === '::1') {
    hostIp = '3.90.189.246';
  }
  const publicUrl = `http://${hostIp}:${PORT}`;
  const serverIp = hostIp;

  if (req.method === 'GET' && urlPath === '/health') {
    const healthy = ready && await cdpHealthy();
    return json(res, 200, {
      ok: true,
      serverIp,
      publicUrl,
      chromeReady: ready,
      cdpHealthy: healthy,
      account: get('expectedAccount'),
      creditsRemaining: getCredits().remaining,
      queue: { pending: queue.length, inFlight: inFlight.size, concurrency: CONCURRENCY }
    });
  }
  if (req.method === 'GET' && urlPath === '/ip') {
    return json(res, 200, {
      ip: serverIp,
      url: publicUrl
    });
  }
  if (req.method === 'GET' && urlPath === '/queue') return json(res, 200, { pending: queue.length, inFlight: inFlight.size, concurrency: CONCURRENCY, total: jobs.size, maxQueue: MAX_QUEUE });
  if (req.method === 'GET' && urlPath === '/stats') {
    const avg = stats.done ? Math.round(stats.totalMs / stats.done) : 0; const total = stats.done + stats.failed;
    const cr = getCredits();
    const realPerImage = (cr.spent != null && stats.images > 0) ? +(cr.spent / stats.images).toFixed(3) : null;
    return json(res, 200, {
      generated: stats.done, images: stats.images, failed: stats.failed, pending: queue.length, inFlight: inFlight.size,
      avgMs: avg, successRate: total ? +(stats.done / total).toFixed(3) : 1,
      creditsRemaining: cr.remaining, creditsSpent: cr.spent, realCreditsPerImage: realPerImage,
      cost: +(stats.images * COST_PER_IMAGE).toFixed(4),
    });
  }
  if (req.method === 'GET' && urlPath === '/billing') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const info = keyInfo(req);
    const key = req.headers['x-api-key'];
    const today = new Date().toISOString().slice(0, 10);
    const u = keyUsage.get(key) || { day: today, count: 0 };
    if (u.day !== today) { u.day = today; u.count = 0; }
    let totalImages = 0;
    for (const j of jobs.values()) if (j.status === 'done') totalImages += (j.images || []).length;
    return json(res, 200, {
      keyName: info?.name || 'client',
      dailyLimit: info?.dailyLimit || 0,
      todayUsed: u.count,
      remainingQuota: info?.dailyLimit ? Math.max(0, info.dailyLimit - u.count) : 'unlimited',
      totalImages,
      costPerImage: COST_PER_IMAGE,
      totalCost: +(totalImages * COST_PER_IMAGE).toFixed(4),
    });
  }

  // ---------- Admin Dynamic API Keys Management ----------
  if (req.method === 'GET' && urlPath === '/admin/keys') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const today = new Date().toISOString().slice(0, 10);
    const list = [];
    for (const [k, info] of KEY_INFO.entries()) {
      const u = keyUsage.get(k) || { day: today, count: 0 };
      const todayUsed = u.day === today ? u.count : 0;
      let totalImages = 0;
      for (const j of jobs.values()) if (j.status === 'done' && j.apiKey === k) totalImages += (j.images || []).length;
      list.push({
        key: k,
        name: info.name || 'client',
        dailyLimit: info.dailyLimit || 0,
        todayUsed,
        totalImages,
        isMaster: k === SINGLE_KEY,
        createdAt: info.createdAt || null
      });
    }
    return json(res, 200, { keys: list, total: list.length });
  }

  if (req.method === 'POST' && urlPath === '/admin/keys') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const name = (body.name || 'client').trim();
    const dailyLimit = parseInt(body.dailyLimit || 0, 10) || 0;
    const newKey = (body.key || crypto.randomBytes(16).toString('hex')).trim();
    const info = { name, dailyLimit, createdAt: Date.now() };
    KEY_INFO.set(newKey, info);
    saveDynamicKeys();
    audit({ action: 'create_api_key', key: keyInfo(req)?.name, ip, newKeyName: name, newKey: newKey.slice(0, 8) + '...' });
    return json(res, 201, { key: newKey, name, dailyLimit, createdAt: info.createdAt });
  }

  if (req.method === 'DELETE' && urlPath.startsWith('/admin/keys/')) {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const targetKey = decodeURIComponent(urlPath.slice('/admin/keys/'.length)).trim();
    if (!KEY_INFO.has(targetKey)) return json(res, 404, { error: 'key_not_found' });
    if (targetKey === SINGLE_KEY) return json(res, 403, { error: 'cannot_delete_master_key' });
    const info = KEY_INFO.get(targetKey);
    KEY_INFO.delete(targetKey);
    saveDynamicKeys();
    audit({ action: 'revoke_api_key', key: keyInfo(req)?.name, ip, revokedKeyName: info.name });
    return json(res, 200, { key: targetKey, name: info.name, status: 'revoked' });
  }

  if (req.method === 'GET' && urlPath.startsWith('/outputs/')) return serveOutput(res, urlPath);
  if (req.method === 'GET' && urlPath.startsWith('/batch/')) { const bid = urlPath.slice('/batch/'.length); const list = [...jobs.values()].filter((j) => j.batchId === bid); if (!list.length) return json(res, 404, { error: 'not_found' }); const by = (s) => list.filter((j) => j.status === s).length; return json(res, 200, { batchId: bid, total: list.length, done: by('done'), failed: by('failed'), processing: by('processing'), queued: by('queued'), cancelled: by('cancelled'), jobs: list.map((j) => publicJob(j, host)) }); }
  if (req.method === 'GET' && urlPath.startsWith('/jobs/')) { const job = jobs.get(urlPath.slice('/jobs/'.length)); if (!job) return json(res, 404, { error: 'not_found' }); return json(res, 200, publicJob(job, host)); }
  if (req.method === 'GET' && urlPath === '/jobs') { const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((j) => ({ id: j.id, externalId: j.externalId, prompt: j.originalPrompt || j.prompt, status: j.status, stage: j.stage, images: (j.images || []).length })); return json(res, 200, { jobs: list }); }

  // Protected
  if (['POST', 'DELETE'].includes(req.method) && !authorized(req)) return json(res, 401, { error: 'unauthorized' });

  // Bulk status
  if (req.method === 'POST' && urlPath === '/jobs/status') {
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const ids = body.ids || []; return json(res, 200, { jobs: ids.map((id) => { const j = jobs.get(id); return j ? { id, status: j.status, stage: j.stage, images: (j.images || []).map((im) => imageUrls(im, host)), externalId: j.externalId, seed: j.seed, error: j.error, code: j.code } : { id, status: 'not_found' }; }) });
  }
  // Register a reusable reference
  if (req.method === 'POST' && urlPath === '/references') {
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!body.url) return json(res, 400, { error: 'missing_url' });
    try { const resp = await fetch(body.url); if (!resp.ok) return json(res, 400, { error: 'fetch_failed' }); const buf = Buffer.from(await resp.arrayBuffer()); fs.mkdirSync(REF_DIR, { recursive: true }); const id = crypto.randomUUID(); const ext = (resp.headers.get('content-type') || '').includes('png') ? '.png' : '.jpg'; const p = path.join(REF_DIR, id + ext); fs.writeFileSync(p, buf); refCache.set(id, p); saveRefs(); return json(res, 201, { referenceId: id }); } catch (e) { return json(res, 500, { error: 'reference_failed', message: e.message }); }
  }
  // Batch cancel
  if (req.method === 'DELETE' && urlPath.startsWith('/batch/')) {
    const bid = urlPath.slice('/batch/'.length); let n = 0;
    for (const j of jobs.values()) if (j.batchId === bid && j.status === 'queued') { const i = queue.indexOf(j.id); if (i >= 0) queue.splice(i, 1); j.status = 'cancelled'; j.finishedAt = Date.now(); n++; }
    saveJobs(); audit({ action: 'batch_cancel', key: keyInfo(req)?.name, ip, batchId: bid, cancelled: n });
    return json(res, 200, { batchId: bid, cancelled: n });
  }
  if (req.method === 'DELETE' && urlPath.startsWith('/jobs/')) {
    const id = urlPath.slice('/jobs/'.length); const job = jobs.get(id); if (!job) return json(res, 404, { error: 'not_found' });
    if (job.status === 'queued') { const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1); job.status = 'cancelled'; job.finishedAt = Date.now(); saveJobs(); audit({ action: 'cancel', key: keyInfo(req)?.name, ip, jobId: id }); return json(res, 200, { id, status: 'cancelled' }); }
    return json(res, 409, { error: 'not_cancellable', status: job.status });
  }
  if (req.method === 'POST' && urlPath.match(/^\/jobs\/[^/]+\/retry$/)) {
    const id = urlPath.split('/')[2]; const job = jobs.get(id); if (!job) return json(res, 404, { error: 'not_found' });
    if (job.status !== 'failed' && job.status !== 'cancelled') return json(res, 409, { error: 'not_retryable', status: job.status });
    job.status = 'queued'; job.stage = 'queued'; job.error = null; job.code = null; job.images = []; job.seed = null; job.startedAt = null; job.finishedAt = null; job.host = host; enqueue(job);
    audit({ action: 'retry', key: keyInfo(req)?.name, ip, jobId: id }); return json(res, 202, { id, status: 'queued' });
  }

  if (req.method === 'POST' && (urlPath === '/generate' || urlPath === '/generate-sync' || urlPath === '/batch')) {
    if (!checkQuota(req)) return json(res, 429, { error: 'quota_exceeded' }, { 'Retry-After': '3600' });
    if (queue.length >= MAX_QUEUE) return json(res, 429, { error: 'busy', message: 'Queue full' }, { 'Retry-After': '30' });
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }

    if (urlPath === '/generate-sync') {
      if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: 'missing_prompt' });
      const job = makeJob(body, host);
      const skipCache = body.skipCache === true || body.skipCache === 'true';

      if (!skipCache) {
        const cacheHit = findSmartCache(job);
        if (cacheHit) {
          job.status = 'done'; job.stage = 'done'; job.images = JSON.parse(JSON.stringify(cacheHit.images));
          job.seed = cacheHit.seed; job.finishedAt = Date.now();
          jobs.set(job.id, job); if (job.idempotencyKey) idemMap.set(job.idempotencyKey, job.id);
          saveJobs(); audit({ action: 'generate_sync_cache_hit', key: keyInfo(req)?.name, ip, jobId: job.id, prompt: job.prompt });
          const pj = publicJob(job, host);
          const firstImg = pj.images && pj.images[0] ? (pj.images[0].s3Url || pj.images[0].url) : null;
          return json(res, 200, { ok: true, cached: true, jobId: job.id, imageUrl: firstImg, images: pj.images, reproduction: job.reproduction });
        }
      }

      enqueue(job);
      audit({ action: 'generate_sync', key: keyInfo(req)?.name, ip, jobId: job.id, prompt: job.prompt });

      // Synchronously poll job completion up to 60 seconds
      const startTime = Date.now();
      while (Date.now() - startTime < 60000) {
        const current = jobs.get(job.id);
        if (current && (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled')) {
          if (current.status === 'done') {
            const pj = publicJob(current, host);
            const firstImg = pj.images && pj.images[0] ? (pj.images[0].s3Url || pj.images[0].url) : null;
            return json(res, 200, {
              ok: true,
              cached: false,
              jobId: current.id,
              imageUrl: firstImg,
              images: pj.images,
              seed: current.seed,
              reproduction: current.reproduction
            });
          } else {
            return json(res, 500, {
              ok: false,
              jobId: current.id,
              status: current.status,
              error: current.error || 'generation_failed'
            });
          }
        }
        await sleep(800);
      }

      // Timeout after 60s
      return json(res, 500, { ok: false, jobId: job.id, error: 'timeout_exceeded_60s' });
    }

    if (urlPath === '/generate') {
      if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: 'missing_prompt' });
      if (body.idempotencyKey && idemMap.has(body.idempotencyKey)) { const ex = jobs.get(idemMap.get(body.idempotencyKey)); if (ex) return json(res, 200, { jobId: ex.id, status: ex.status, idempotent: true }); }
      const job = makeJob(body, host);
      const cacheHit = findSmartCache(job);
      if (cacheHit) {
        job.status = 'done'; job.stage = 'done'; job.images = JSON.parse(JSON.stringify(cacheHit.images));
        job.seed = cacheHit.seed; job.finishedAt = Date.now();
        jobs.set(job.id, job); if (job.idempotencyKey) idemMap.set(job.idempotencyKey, job.id);
        saveJobs(); audit({ action: 'generate_cache_hit', key: keyInfo(req)?.name, ip, jobId: job.id, prompt: job.prompt });
        return json(res, 200, { jobId: job.id, status: 'done', stage: 'done', cached: true, externalId: job.externalId, ...publicJob(job, host) });
      }
      enqueue(job);
      audit({ action: 'generate', key: keyInfo(req)?.name, ip, jobId: job.id, prompt: job.prompt });
      return json(res, 202, { jobId: job.id, status: 'queued', externalId: job.externalId });
    }

    let items = []; if (Array.isArray(body.items)) items = body.items; else if (Array.isArray(body.prompts)) items = body.prompts.map((p) => ({ ...body, prompt: p })); else return json(res, 400, { error: 'missing_items' });
    const batchId = crypto.randomUUID(); const created = [];
    for (const it of items) {
      const io = typeof it === 'object' ? it : { prompt: it };
      const prompt = (io.prompt || '').trim(); if (!prompt) continue;
      if (io.idempotencyKey && idemMap.has(io.idempotencyKey)) { created.push({ jobId: idemMap.get(io.idempotencyKey), idempotent: true }); continue; }
      const job = makeJob({ ...body, ...io, prompt, batchId }, host);
      const cacheHit = findSmartCache(job);
      if (cacheHit) {
        job.status = 'done'; job.stage = 'done'; job.images = JSON.parse(JSON.stringify(cacheHit.images));
        job.seed = cacheHit.seed; job.finishedAt = Date.now();
        jobs.set(job.id, job); if (job.idempotencyKey) idemMap.set(job.idempotencyKey, job.id);
        saveJobs(); created.push({ jobId: job.id, status: 'done', cached: true, externalId: job.externalId });
        continue;
      }
      enqueue(job); created.push({ jobId: job.id, externalId: job.externalId });
    }
    audit({ action: 'batch', key: keyInfo(req)?.name, ip, batchId, count: created.length });
    return json(res, 202, { batchId, jobs: created, jobIds: created.map((c) => c.jobId), count: created.length, pending: queue.length });
  }

  return json(res, 404, { error: 'not_found' });
});

// Auto-Cleanup Cron (Disk Shield): Clean files older than 24 hours to protect disk space
function runDiskShield() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  const dirs = [IMAGES_DIR, REF_DIR, os.tmpdir()];
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.startsWith('flow_') || f.startsWith('flow-ref-') || f.startsWith('chrome-kiara-cdp-')) {
          const fp = path.join(d, f);
          try {
            if (fs.statSync(fp).mtimeMs < cutoff) {
              fs.rmSync(fp, { recursive: true, force: true });
              removed++;
            }
          } catch {}
        }
      }
    } catch {}
  }
  if (removed > 0) console.log(`[api] Disk Shield: Cleaned ${removed} old temp/image files.`);
}

loadJobs();
loadRefs();
server.listen(PORT, () => {
  console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[api] Keys: ${KEY_INFO.size} | Concurrency: ${CONCURRENCY} | Cleanup: ${ENABLE_CLEANUP} | S3: ${!!(S3CFG && S3CFG.bucket)} | Webhook-HMAC: ${!!WEBHOOK_SECRET}`);
  ensureBrowser().catch((e) => console.error('[api] warmup failed:', e.message));
  if (queue.length) setImmediate(pump);
});

// Periodic background maintenance: Session Heartbeat, Disk Shield & Pre-warmed Pool
setInterval(async () => {
  cleanTempProfiles();
  if (Date.now() - lastRetention > 3600000) { lastRetention = Date.now(); runRetention(); runDiskShield(); }
  if (!pumpRunning && inFlight.size === 0 && ready) {
    if (!(await cdpHealthy())) { console.log('[api] CDP unresponsive while idle — resetting Chrome.'); await resetBrowser(); alertAdmin('CDP was unresponsive; Chrome reset.'); }
    else {
      try {
        const page = getPage();
        await page.evaluate(() => document.title);
        await refreshCredits();
      } catch (e) {
        console.warn('[api] Session heartbeat ping failed, self-healing...');
        await selfHealBrowser('Session heartbeat ping failed');
      }
    }
  } else if (!ready && !ensuring) {
    // Pre-warmed pool background auto-recovery
    ensureBrowser().catch(() => {});
  }
}, 60000);
