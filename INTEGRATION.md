# Integration Guide — Flow Image API

Generate Google Flow images from any project via a simple HTTP call.

## Endpoint

```
POST http://<VPS_IP>:8080/generate
```

**Headers**
- `x-api-key: <your-api-key>`  (from `config/flow.config.json` → `apiKey`)
- `Content-Type: application/json`

**Body**
```json
{
  "prompt": "a red sports car, cinematic",
  "model": "Nano Banana 2",      // optional: auto-selected; auto-falls back to another model if credits run out
  "ratio": "1:1",                // optional: 16:9 | 4:3 | 1:1 | 3:4 | 9:16. If omitted, inferred from the prompt
  "quantity": 1,                 // optional: number of images (default 1)
  "include_base64": false         // optional: true to also get the image as base64
}
```

Behavior:
- **Ratio** is auto-inferred from the prompt when not provided (e.g. "phone wallpaper" → 9:16, "cinematic/landscape" → 16:9, "square/avatar" → 1:1). An explicit `ratio` always wins.
- **Quantity** defaults to **1** image per request.
- **Model fallback**: if the chosen model is out of credits, the API automatically retries with the next available model.
- **Auto-retry**: on a transient error, the page is refreshed and the same prompt is retried.

**Response**
```json
{
  "status": "success",
  "prompt": "a red sports car, cinematic",
  "model": "Nano Banana 2",
  "ratio": "1:1",
  "images": [
    {
      "file": "outputs/images/flow_xxx.jpg",
      "url": "http://<VPS_IP>:8080/outputs/images/flow_xxx.jpg",
      "base64": "..."   // only if include_base64=true
    }
  ]
}
```

Other endpoints:
- `GET /health` → `{ "ok": true }`
- `GET /outputs/...` → serves the generated image files (no key needed).

## Examples

### JavaScript / Node / browser
```js
const res = await fetch('http://<VPS_IP>:8080/generate', {
  method: 'POST',
  headers: { 'x-api-key': 'YOUR_KEY', 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'a red sports car, cinematic' }),
});
const data = await res.json();
console.log(data.images[0].url);
```

### Python
```python
import requests
r = requests.post(
    'http://<VPS_IP>:8080/generate',
    headers={'x-api-key': 'YOUR_KEY'},
    json={'prompt': 'a red sports car, cinematic'},
)
print(r.json()['images'][0]['url'])
```

### PHP
```php
$ch = curl_init('http://<VPS_IP>:8080/generate');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['x-api-key: YOUR_KEY', 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['prompt' => 'a red sports car, cinematic']),
]);
$data = json_decode(curl_exec($ch), true);
echo $data['images'][0]['url'];
```

### PowerShell (Windows)
```powershell
$body = '{"prompt":"a red sports car, cinematic"}'
Invoke-RestMethod -Uri http://<VPS_IP>:8080/generate -Method Post `
  -Headers @{'x-api-key'='YOUR_KEY'} -ContentType 'application/json' -Body $body
```

## Notes
- One generation at a time. If busy, the API returns HTTP `429`.
- Each generation consumes Google Flow credits.
- Generation takes ~30–90 seconds.
- Keep your `x-api-key` secret. Anyone with the key + the open port can generate.

## Server management (on the VPS)
```
pm2 status                 # check it is online
pm2 logs flow-api          # view logs
pm2 restart flow-api       # restart after code changes (git pull first)
pm2 stop flow-api          # stop
```
