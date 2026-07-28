# Integration Guide — Flow Image API (async queue)

Generate Google Flow images from any project. Jobs are **queued** and processed
**one at a time** (single Google account / Chrome). Each job produces up to
`quantity` images (default **3**), tagged to its prompt via a `jobId`.

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
  "ratio": "16:9",     // optional; if omitted, inferred from the prompt
  "model": "Nano Banana 2", // optional; auto-selected + falls back if out of credits
  "quantity": 3        // optional; images per prompt (1-4, default 3)
}
```
Response `202`:
```json
{ "jobId": "e3b0...", "status": "queued", "position": 1, "quantity": 3 }
```

### POST /batch  (bulk, e.g. 180 prompts)
```json
{ "prompts": ["prompt 1", "prompt 2", "... up to N ..."], "quantity": 3 }
```
or per-item settings:
```json
{ "items": [ { "prompt": "a", "ratio": "9:16" }, { "prompt": "b", "quantity": 4 } ] }
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
  "quantity": 3,
  "images": [
    { "file": "outputs/images/flow_aaa.jpg", "url": "http://<VPS_IP>:8080/outputs/images/flow_aaa.jpg" },
    { "file": "outputs/images/flow_bbb.jpg", "url": "http://<VPS_IP>:8080/outputs/images/flow_bbb.jpg" },
    { "file": "outputs/images/flow_ccc.jpg", "url": "http://<VPS_IP>:8080/outputs/images/flow_ccc.jpg" }
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
  body: JSON.stringify({ prompts, quantity: 3 }),
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
  console.log(id, urls);   // 3 image URLs, matched to that prompt's job
}
```

### Python
```python
import requests, time
BASE, KEY = 'http://<VPS_IP>:8080', 'YOUR_KEY'

ids = requests.post(f'{BASE}/batch', headers={'x-api-key': KEY},
                    json={'prompts': prompts, 'quantity': 3}).json()['jobIds']

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
- **Processing is sequential**: one prompt at a time (single Google account / Chrome; running many in parallel would trigger bot-detection and exhaust RAM). 180 prompts × 3 images ≈ several hours total.
- **Ratio** auto-inferred from the prompt when omitted; explicit `ratio` wins.
- **Model fallback**: out-of-credit model → next available model, automatically.
- **Auto-retry**: transient errors refresh the page and retry the same prompt.
- Jobs and results survive an API restart (stored in `outputs/jobs.json`).
- Keep your `x-api-key` secret.

## Server management (VPS)
```
pm2 status                 # is flow-api online
pm2 logs flow-api          # logs / progress
pm2 restart flow-api       # after: git pull
```
