# HMU Book Reader to PDF

Convert supported `FullBookReader.aspx` links into PDF files.

## Next.js app (Vercel deploy)

This repository now includes a Next.js app that accepts one URL per line and returns one ZIP file containing generated PDFs.

### Local run

```bash
bun install
bun run dev
```

Open:

```text
http://localhost:3000
```

### Vercel deploy

```bash
vercel
```

The endpoint is `POST /api/convert`.

- Bun-only package workflow (`packageManager` + `bun.lock`)
- Runtime: Node.js route handler
- Streaming ZIP response (avoids non-streaming 4.5MB response cap)
- `maxDuration = 300` set in `app/api/convert/route.ts`
- Browser submits a real form POST (not `fetch(...).blob()`), so downloads stream directly
- Safety caps: max 8 URLs/request, max 650 pages/book, max 2200 pages/request

Vercel commands are pinned in `vercel.json` (`bun install --frozen-lockfile`, `bun run build`).

For large jobs, Vercel plan/runtime limits still apply. If conversion takes too long for your plan, run fewer links per request.

## Python web app (local host)

Run:

```bash
python3 web_app.py --host 0.0.0.0 --port 8000
```

Open:

```text
http://localhost:8000
```

Usage in browser:

- Paste one FullBookReader URL per line.
- Click `Convert and Download ZIP`.
- Wait for conversion to finish.
- Your browser downloads one ZIP containing all generated PDFs.

Notes:

- Server-side temporary jobs are stored in `web_jobs/` and cleaned after each request.
- You can tune conversion speed/reliability via:

```bash
python3 web_app.py --workers 10 --timeout 45 --retries 4
```

## What this script does

- Parses each reader link (`Url`, `TotalPage`, `ext`).
- Downloads page images directly from `.../FullPreview/000001.jpg` style URLs.
- Builds one PDF per link without third-party Python packages.
- Keeps downloaded images in a local cache so reruns can resume.

## Usage

Single link:

```bash
python3 hmu_book_to_pdf.py "<FULL_BOOK_READER_URL>"
```

Multiple links from file:

```bash
python3 hmu_book_to_pdf.py --urls-file hmu_links.txt
```

Useful options:

```bash
python3 hmu_book_to_pdf.py --urls-file hmu_links.txt --workers 10 --timeout 30 --retries 3
```

Test first pages only:

```bash
python3 hmu_book_to_pdf.py --urls-file hmu_links.txt --max-pages 5
```

Skip books that already have a PDF:

```bash
python3 hmu_book_to_pdf.py --urls-file hmu_links.txt --skip-existing-pdf
```

## Output

- PDFs: `output_pdfs/<book-id>.pdf`
- Download cache: `book2pdf_work/<book-id>/images/*.jpg`
