# Integration Guide — Flow Image API (async queue)

Generate Google Flow images from any project. Jobs are **queued** and processed
**up to 3 in parallel** (configurable via `concurrency`). Each job produces
**1 image**, matched to its exact prompt via Flow's internal API (100% reliable
correlation, even under concurrency). Track each job by its `jobId`.

Base URL: `http://<VPS_IP>:8080`
Auth (POST only): header `x-api-key: <your-api-key>`

## Flow
1. **Submit** a prompt (or many) → get a `jobId` (or list of `jobId`s) instantly.
2. **Poll** `GET /jobs/{id}` until `status` is `done` (or `failed`).
3. Read `images[].url` from the finished job.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/health` | `{ "ok": true }` |
| GET  | `/queue`  | `{ pending, working, total }` |
| POST | `/generate` | Submit one prompt → `{ jobId, status, position }` |
| POST | `/batch` | Submit many prompts → `{ jobIds: [...] }` |
| GET  | `/jobs/{id}` | Job status + `images[].url` |
| GET  | `/jobs` | Recent jobs (summary) |
| GET  | `/outputs/...` | Serves the image files |

### POST /generate
```json
{
  "prompt": "a red sports car, cinematic",
  "ratio": "16:9",          // optional; if omitted, inferred from the prompt
  "model": "Nano Banana 2"  // optional; auto-selected
}
```
Response `202`:
```json
{ "jobId": "e3b0...", "status": "queued" }
```
Each job produces **1 image**.

### POST /batch  (bulk, e.g. 180 prompts)
```json
{ "prompts": ["prompt 1", "prompt 2", "... up to N ..."] }
```
or per-item settings:
```json
{ "items": [ { "prompt": "a", "ratio": "9:16" }, { "prompt": "b", "ratio": "16:9" } ] }
```
Response `202`:
```json
{ "jobIds": ["id1", "id2", "..."], "count": 180, "pending": 180 }
```

### GET /jobs/{id}
```json
{
  "id": "e3b0...",
  "prompt": "a red sports car, cinematic",
  "status": "done",              // queued | processing | done | failed
  "model": "Nano Banana 2",
  "ratio": "16:9",
  "aspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
  "images": [
    { "file": "outputs/images/flow_aaa.jpg", "url": "http://<VPS_IP>:8080/outputs/images/flow_aaa.jpg" }
  ],
  "error": null
}
```

## Example — submit 180 prompts, then collect results (JavaScript)
```js
const BASE = 'http://<VPS_IP>:8080';
const KEY  = 'YOUR_KEY';

// 1) Submit a batch
const prompts = [/* 180 strings */];
const submit = await fetch(`${BASE}/batch`, {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompts }),
}).then(r => r.json());

// 2) Poll each job until done
async function waitFor(jobId) {
  while (true) {
    const job = await fetch(`${BASE}/jobs/${jobId}`).then(r => r.json());
    if (job.status === 'done')   return job.images.map(i => i.url);
    if (job.status === 'failed') throw new Error(job.error);
    await new Promise(r => setTimeout(r, 5000)); // poll every 5s
  }
}

for (const id of submit.jobIds) {
  const urls = await waitFor(id);
  console.log(id, urls);   // 1 image URL, matched to that prompt's job
}
```

### Python
```python
import requests, time
BASE, KEY = 'http://<VPS_IP>:8080', 'YOUR_KEY'

ids = requests.post(f'{BASE}/batch', headers={'x-api-key': KEY},
                    json={'prompts': prompts}).json()['jobIds']

def wait_for(job_id):
    while True:
        job = requests.get(f'{BASE}/jobs/{job_id}').json()
        if job['status'] == 'done':   return [i['url'] for i in job['images']]
        if job['status'] == 'failed': raise RuntimeError(job['error'])
        time.sleep(5)

for jid in ids:
    print(jid, wait_for(jid))
```

## Notes
- **Concurrency**: up to `concurrency` prompts (default **3**) generate in parallel; set `"concurrency"` in `config/flow.config.json`. 180 prompts ≈ (180 / 3) × ~40–60s.
- **Exact correlation**: each image is matched to its prompt via Flow's internal API response (not order/DOM), so results are always correct even in parallel.
- **1 image per prompt** (Flow generate count is fixed at 1).
- **Ratio** auto-inferred from the prompt when omitted; explicit `ratio` wins.
- **Timeout**: a job that produces no result within `jobTimeoutMs` (default 240s) is marked `failed`.
- Jobs and results survive an API restart (stored in `outputs/jobs.json`).
- Keep your `x-api-key` secret.

## Server management (VPS)
```
pm2 status                 # is flow-api online
pm2 logs flow-api          # logs / progress
pm2 restart flow-api       # after: git pull
```


---

## Advanced features

### Auth — multiple API keys
Config `config/flow.config.json`:
```json
{ "apiKey": "<default-key>", "apiKeys": [ { "key": "abc123", "name": "client-a" }, "plainkey2" ] }
```
Any listed key is accepted in `x-api-key`. Revoke a client by removing its entry + restart.

### Webhooks (no polling needed)
Add `"webhook": "https://your-app/callback"` to a `/generate` or `/batch` request (or set global `defaultWebhookUrl` in config). When a job finishes (`done`/`failed`), the API POSTs the full job JSON (with image URLs) to that URL.

### Priority queue
Add `"priority": 10` (higher = sooner). Default 0.

### Cancel a queued job
```
DELETE /jobs/{id}     (header x-api-key)   → { status: "cancelled" }   (only while "queued")
```

### Retry a failed/cancelled job
```
POST /jobs/{id}/retry (header x-api-key)   → { status: "queued" }
```

### Batch progress
```
GET /batch/{batchId}  → { total, done, failed, processing, queued, jobs: [...] }
```
`batchId` is returned by `POST /batch`.

### Stats & health
```
GET /stats   → { generated, failed, pending, inFlight, avgMs, successRate, creditsUsed }
GET /health  → { ok, chromeReady, cdpHealthy, account, queue }
```

### Reference image (image-to-image) ✅
Add `"reference": "https://.../img.jpg"` (or an array of up to 3 URLs) to a `/generate` or `/batch` request. The API downloads the reference(s), uploads them into Flow, and generates using them as ingredients:
```json
{ "prompt": "transform into a watercolor painting", "reference": "https://example.com/photo.jpg" }
```

### Optional cloud storage (S3 / Cloudflare R2)
Requires `npm i @aws-sdk/client-s3` on the server + config:
```json
{ "s3": { "endpoint": "https://<r2>.r2.cloudflarestorage.com", "region": "auto", "bucket": "flow", "accessKeyId": "...", "secretAccessKey": "...", "publicBaseUrl": "https://cdn.example.com" } }
```
When set, each image is uploaded and `images[].url` becomes the public CDN URL (falls back to local serving if upload fails).

### Housekeeping (automatic)
- **Audit log**: every request appended to `outputs/audit.log` (async, non-blocking). Disable with `"auditLog": false`.
- **Retention**: images + finished jobs older than `retentionDays` (default 7) are auto-deleted hourly.
- **Session alerts**: if Google logs out / needs verification, the API POSTs to `alertWebhookUrl` (if set) and logs it.
- **Self-maintenance**: Chrome recycled by memory/generation count, orphan temp profiles cleaned, idle CDP health checked.

### Config keys summary
`apiPort, apiKey, apiKeys[], concurrency, jobTimeoutMs, cdpPort, recycleEveryGenerations, minAvailableMemMB, clearEveryGenerations, enableTrashCleanup, auditLog, retentionDays, alertWebhookUrl, defaultWebhookUrl, s3{}`


---

## Integration features (v2)

### Per-request options (`/generate` and `/batch` items)
```json
{
  "prompt": "a stickman running",
  "count": 3,                 // 1-4 images for this prompt (default 1)
  "ratio": "1:1",             // supported: 16:9,4:3,1:1,3:4,9:16 (aliases like 4:5→3:4 auto-mapped)
  "width": 1920, "height": 1080,  // OR "size":"1920x1080" — exact pixels (needs sharp)
  "style": "stickman",        // named preset from config.stylePresets, appended to the prompt
  "reference": "https://...", // image-to-image (URL)
  "referenceId": "abc",       // reuse a pre-registered reference (see /references)
  "externalId": "frame_042",  // your own id — echoed back in every response
  "idempotencyKey": "k-042",  // dedupe: same key never generates twice
  "priority": 10,             // higher = sooner
  "webhook": "https://..."    // per-request callback
}
```

### Job response now includes
`externalId, stage, seed, count, images[], creditsUsed, cost, reproduction:{model,ratio,seed}, code`.
- **stage**: `queued → submitting → rendering → downloading → uploading → done`.
- **seed** + **reproduction**: to reproduce the exact frame later.
- **code**: e.g. `content_rejected`, `timeout` on failures.

### New endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/jobs/status` | Bulk status: `{ "ids": [...] }` → statuses of many jobs in ONE call |
| POST | `/references` | `{ "url": "..." }` → `{ referenceId }` (upload once, reuse many times) |
| DELETE | `/batch/{batchId}` | Cancel all still-queued jobs in a batch |
| DELETE | `/jobs/{id}` | Cancel one queued job |
| POST | `/jobs/{id}/retry` | Retry a failed/cancelled job |
| GET | `/stats` | includes `images`, `creditsUsed`, `cost` |

### Reliability / ops
- **Idempotency**: `idempotencyKey` prevents duplicate (paid) generations on retries.
- **Backpressure**: when the queue is full (`maxQueue`, default 1000) the API returns `429` + `Retry-After` so your client can slow down.
- **Per-key quota**: `apiKeys: [{ "key": "...", "name": "pro-user", "dailyLimit": 500 }]` → over limit returns `429`.
- **HMAC webhooks**: set `"webhookSecret"`; each webhook POST includes `X-Signature: sha256=<hmac>` — verify it to reject spoofed callbacks.
- **Content moderation**: rejected prompts fail with `code: "content_rejected"`.
- **Cost**: set `"costPerImage"` in config; responses report `creditsUsed` and `cost`.

### Config additions
`maxQueue, costPerImage, stylePresets{name:promptSuffix}, webhookSecret, apiKeys[].dailyLimit`

### Seed (returned) ⚠️
The actual generation seed is **returned** in `seed` / `reproduction.seed` (for tracking/analytics). **Setting** an input seed is not supported: request interception is unreliable over the CDP-attached browser. For consistent characters/style, use a fixed **reference image** (`reference` / `referenceId`).

### Exact pixel sizes ✅ (requires `sharp` on the server)
`"width": 1920, "height": 1080` (or `"size": "1920x1080"`). Flow renders the nearest aspect ratio, then the server crops/resizes to the exact pixels (`fit: cover`). Install once: `npm i sharp`.

### Real credits / cost ✅
Image generation in Flow is **free (0 credits)** — credits apply to video. The API reads Flow's live `/v1/credits` balance (refreshed periodically) and exposes it via `GET /stats` (`creditsRemaining`, `creditsSpent`, `realCreditsPerImage`) and `GET /health` (`creditsRemaining`) — useful for monitoring/quota and future video support.

### Still not available (depend on Flow tools)
- **Upscale / inpainting**: Flow has these tools but they need separate UI wiring — not implemented yet.
