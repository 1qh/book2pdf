# book2pdf

Monorepo with two conversion paths:

- Client-side userscript on HMU origin (recommended for scale)
- Server API on Vercel with rate limiting

## Option 1: Client-side userscript (recommended)

No extension-store publisher account is needed.

1. Install Tampermonkey in your browser.
2. Open and install:

```text
https://raw.githubusercontent.com/1qh/book2pdf/main/tools/hmu-book2pdf.user.js
```

3. Open any `FullBookReader.aspx` page on `thuvien.hmu.edu.vn`.
4. Click `Batch to ZIP`.
5. Paste one reader URL per line and run conversion.

This path runs on user devices, so Vercel compute cost stays low.

## Option 2: Cloud API

Endpoint:

```text
POST /api/convert
```

Behavior:

- Accepts a `urls` string payload (JSON or form-data)
- Returns one ZIP with generated PDFs
- Includes `errors.txt` when some books fail
- Applies in-memory rate limit per client IP
- Supports optional S3 ZIP cache

Config via environment variables:

- `API_RATE_LIMIT_MAX` (default `2`)
- `API_RATE_LIMIT_WINDOW_MS` (default `600000` = 10 minutes)
- `S3_CACHE_ENABLED` (`true` to enable)
- `S3_BUCKET`
- `S3_REGION` (default `us-east-1`)
- `S3_ENDPOINT` (for S3-compatible providers)
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_PREFIX` (default `book2pdf-cache`)
- `S3_CACHE_MAX_BYTES` (default `209715200`)

Copy env template:

```bash
cp apps/web/.env.example apps/web/.env.local
```

## Local development

```bash
bun install
bun run dev
```

## Validation

```bash
bun run typecheck
bun run build
```
