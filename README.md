# Warm Memories Backend (Prod fix + GenAPI Kling v2.6 Pro)

Production-ready MVP backend for image→video generation using **GenAPI** model **kling-video-2-6**.
The backend stores generated videos locally in `public/uploads/videos` and serves them via `/uploads/videos/...`.

## Product constraints (fixed)
- Video duration: **5 seconds** (no user choice)
- Emotions: **3 options**
  - `blink` — natural blink
  - `smile` — gentle smile
  - `surprised` — mild surprise
- Plans (tariffs): **1 video** or **3 videos** (prices are placeholders for now)
- Plans + emotions are exposed via `GET /api/v1/plans`.

## Quick start

```bash
npm install
cp .env.example .env
npm run migrate
npm run start
```

Worker (separate terminal):

```bash
npm run worker
```

Swagger UI:
- http://localhost:8080/api-docs

## ENV

Required:
- `JWT_ACCESS_SECRET`
- `SQLITE_FILE`
- `GENAPI_API_KEY`

Recommended:
- `GENAPI_BASE_URL` (default: https://api.gen-api.ru)
- `GENAPI_MODEL_ID` (default: kling-video-2-6)
- `GENAPI_STATUS_PATH` (default: /api/v1/requests/{id}) — if GenAPI uses a different status endpoint
- `APP_PUBLIC_BASE_URL` (default http://localhost:8080) — used to build callback URL
- `GENAPI_CALLBACK_SECRET` — protects webhook

## API overview

### Auth (OTP)
- `POST /api/v1/auth/request-code` → sends code to email
- `POST /api/v1/auth/verify-code` → returns JWT accessToken

### Me
- `GET /api/v1/me` (Bearer) → current user and tokenBalance

### Plans (public)
- `GET /api/v1/plans` → fixed plans + fixed emotions + duration

### Jobs (Bearer)
- `POST /api/v1/jobs` → create job `{ imageUrl, emotionCode }`
- `GET /api/v1/jobs` → list jobs for current user
- `GET /api/v1/jobs/:id` → get job

### GenAPI webhook (internal)
- `POST /api/v1/genapi/webhook?secret=...&jobId=...`
Backend will download `result_url` (or `video_url`) and mark job as `completed`.

## Tests

```bash
npm test
```

## Notes about GenAPI fields
GenAPI responses may use different names for the output url (`result_url`, `video_url`, `url`).
This backend supports all three.


## Payments (YooKassa)

This backend uses YooKassa API to sell video credits (1 or 3 videos).

Create payment (Bearer):
- `POST /api/v1/payments/create` `{ "planId": "one" | "three" }` → `{ confirmationUrl, ykPaymentId }`

YooKassa webhook (configure in YooKassa cabinet for HTTP notifications):
- URL: `https://YOUR_DOMAIN/api/v1/yookassa/webhook`
- Events: `payment.succeeded`, `payment.canceled`

On `payment.succeeded`, backend re-fetches payment from YooKassa API and increments `users.token_balance` by plan videos.


## Uploads (photos)

Upload endpoint (Bearer):
- `POST /api/v1/uploads/photo` (multipart/form-data, field `photo`) → `{ imageUrl }`

Photos are stored in:
- `public/uploads/photos`

Videos are stored in:
- `public/uploads/videos`

Both are served publicly via:
- `/uploads/...`

## Token accounting

- `users.token_balance` is the number of remaining videos.
- Each `POST /api/v1/jobs` **atomically decrements** balance by 1.
- If balance is 0, API returns `402 INSUFFICIENT_TOKENS`.
