# GenAPI Node.js integration (Kling v2.6 Pro)

This project uses GenAPI model **kling-video-2-6** to generate a **5-second** video from a photo.

## Endpoint
GenAPI model page shows the network endpoint:

- Base: `https://api.gen-api.ru`
- Create job: `POST /api/v1/networks/kling-video-2-6`

## Required headers
- `Authorization: Bearer <YOUR_TOKEN>`
- `Content-Type: application/json`
- `Accept: application/json`

## Example (axios)

```js
import axios from "axios";

const api = axios.create({
  baseURL: "https://api.gen-api.ru",
  headers: {
    Authorization: `Bearer ${process.env.GENAPI_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  timeout: 90000,
});

const payload = {
  image_url: "https://example.com/photo.jpg",
  prompt: "Make a natural gentle smile. Subtle facial motion only. Keep identity and lighting consistent. 5 seconds.",
  negative_prompt: "blurry, artifacts, low quality, deformed",
  duration: 5,
  callback_url: "https://your-domain.com/api/v1/genapi/webhook?secret=...&jobId=..."
};

const r = await api.post("/api/v1/networks/kling-video-2-6", payload);
console.log(r.data); // { request_id: "...", status: "processing" ... }
```

## Status polling

Many GenAPI network endpoints provide request status by:
`GET /api/v1/requests/{request_id}`

Status values:
- `processing`
- `success`
- `failed`

On `success` response usually contains a video url: `result_url` (sometimes `video_url`).

If your GenAPI returns a different status path, set in `.env`:

```
GENAPI_STATUS_PATH=/api/v1/requests/{id}
```

## Recommended: callback webhook
To avoid long polling, supply `callback_url`. GenAPI will call it when generation finishes.

Webhook in this backend:
`POST /api/v1/genapi/webhook?secret=...&jobId=...`

Payload should include:
- `status` = `success` or `failed`
- `result_url` (or `video_url`) on success
