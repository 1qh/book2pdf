#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import List, Optional, Sequence, Tuple
from urllib.parse import parse_qs
from zipfile import ZIP_DEFLATED, ZipFile

from hmu_book_to_pdf import convert_one_book, ensure_dir


MAX_BODY_BYTES = 1_000_000
MAX_URLS = 30


@dataclass(frozen=True)
class AppConfig:
    host: str
    port: int
    jobs_dir: Path
    workers: int
    timeout: int
    retries: int


def parse_cli_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run HMU Book Reader to PDF web app.")
    parser.add_argument(
        "--host", default="0.0.0.0", help="Host bind (default: 0.0.0.0)"
    )
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    parser.add_argument(
        "--jobs-dir",
        default="web_jobs",
        help="Temporary workspace for conversion jobs (default: web_jobs)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=10,
        help="Page download workers per book (default: 10)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=45,
        help="HTTP timeout seconds for image download (default: 45)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=4,
        help="Retries per page download (default: 4)",
    )
    return parser.parse_args()


def parse_urls_text(raw_text: str) -> List[str]:
    urls: List[str] = []
    for line in raw_text.splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        urls.append(value)

    deduped: List[str] = []
    seen = set()
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def pick_download_filename(header_value: Optional[str]) -> str:
    if not header_value:
        return "hmu_pdfs.zip"
    match = re.search(r'filename="?([^";]+)"?', header_value)
    if not match:
        return "hmu_pdfs.zip"
    name = match.group(1).strip()
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._-")
    return f"{safe}.zip" if not safe.endswith(".zip") else safe


def html_page(config: AppConfig) -> str:
    default_urls = "\n".join(
        [
            "https://thuvien.hmu.edu.vn/pages/cms/FullBookReader.aspx?Url=/pages/cms/TempDir/books/202512231114-5ad4e2e3-d8b7-43a7-a95f-dab8dcbed86d//FullPreview&TotalPage=405&ext=jpg#page/1/mode/2up",
            "https://thuvien.hmu.edu.vn/pages/cms/FullBookReader.aspx?Url=/pages/cms/TempDir/books/202112301045-89d5183d-8c6a-4960-80e1-6d99e2302006//FullPreview&TotalPage=551&ext=jpg#page/1/mode/2up",
        ]
    )
    escaped_defaults = html.escape(default_urls)
    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>HMU Book Reader to PDF</title>
  <style>
    :root {{
      --bg: #f4f1ea;
      --ink: #17212b;
      --card: #fffaf2;
      --line: #dbcdb5;
      --accent: #12664f;
      --accent-2: #0f4f3f;
      --muted: #6f6a61;
      --danger: #8a2b2b;
      --font: "Avenir Next", "Segoe UI", sans-serif;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: var(--font);
      color: var(--ink);
      background:
        radial-gradient(circle at 15% 10%, #fff7e6 0%, transparent 35%),
        radial-gradient(circle at 85% 20%, #e5f4ef 0%, transparent 40%),
        var(--bg);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px 16px;
    }}
    .panel {{
      width: min(920px, 100%);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 14px 38px rgba(23, 33, 43, 0.08);
    }}
    h1 {{ margin: 0 0 8px; font-size: 1.6rem; letter-spacing: 0.2px; }}
    p {{ margin: 0 0 14px; color: var(--muted); line-height: 1.45; }}
    .grid {{ display: grid; gap: 10px; }}
    textarea {{
      width: 100%;
      min-height: 270px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 12px;
      font: 500 14px/1.4 Menlo, Consolas, monospace;
      color: #1f2430;
      padding: 12px;
      background: #fff;
    }}
    .controls {{
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }}
    button {{
      border: 0;
      border-radius: 10px;
      padding: 11px 16px;
      font: 700 14px var(--font);
      color: #f7f6f4;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      cursor: pointer;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }}
    button:hover {{ transform: translateY(-1px); }}
    button:disabled {{ opacity: 0.6; cursor: wait; transform: none; }}
    .status {{ font-size: 0.95rem; color: var(--ink); min-height: 1.35rem; }}
    .status.error {{ color: var(--danger); }}
    .meta {{ font-size: 0.86rem; color: var(--muted); }}
    @media (max-width: 680px) {{
      .panel {{ padding: 14px; border-radius: 12px; }}
      h1 {{ font-size: 1.35rem; }}
      textarea {{ min-height: 220px; }}
    }}
  </style>
</head>
<body>
  <main class=\"panel\">
    <h1>HMU FullBookReader to ZIP(PDF)</h1>
    <p>Paste one URL per line, click once, and wait for a ZIP file that contains all generated PDFs.</p>
    <form id=\"convert-form\" class=\"grid\">
      <textarea name=\"urls\" required spellcheck=\"false\" placeholder=\"One FullBookReader URL per line\">{escaped_defaults}</textarea>
      <div class=\"controls\">
        <button id=\"convert-btn\" type=\"submit\">Convert and Download ZIP</button>
        <span class=\"meta\">Limit: {MAX_URLS} links/request, workers={config.workers}, timeout={config.timeout}s.</span>
      </div>
      <div id=\"status\" class=\"status\"></div>
    </form>
  </main>
  <script>
    const form = document.getElementById('convert-form');
    const button = document.getElementById('convert-btn');
    const statusEl = document.getElementById('status');

    function setStatus(message, isError) {{
      statusEl.textContent = message;
      statusEl.className = isError ? 'status error' : 'status';
    }}

    function filenameFromDisposition(value) {{
      if (!value) return 'hmu_pdfs.zip';
      const m = value.match(/filename=\"?([^\";]+)\"?/i);
      return m ? m[1] : 'hmu_pdfs.zip';
    }}

    form.addEventListener('submit', async (event) => {{
      event.preventDefault();
      button.disabled = true;
      setStatus('Converting books... this can take several minutes for large lists.', false);

      try {{
        const params = new URLSearchParams(new FormData(form));
        const response = await fetch('/convert', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }},
          body: params.toString()
        }});

        if (!response.ok) {{
          const text = await response.text();
          throw new Error(text || 'Conversion failed');
        }}

        const blob = await response.blob();
        const filename = filenameFromDisposition(response.headers.get('Content-Disposition'));
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setStatus('Done. ZIP download started.', false);
      }} catch (err) {{
        setStatus(err && err.message ? err.message : 'Conversion failed', true);
      }} finally {{
        button.disabled = false;
      }}
    }});
  </script>
</body>
</html>
"""


def build_zip_for_urls(
    urls: Sequence[str],
    jobs_dir: Path,
    workers: int,
    timeout: int,
    retries: int,
) -> Tuple[Path, Path]:
    ensure_dir(jobs_dir)
    job_dir = Path(tempfile.mkdtemp(prefix="job_", dir=str(jobs_dir)))
    output_dir = job_dir / "output_pdfs"
    work_dir = job_dir / "work"
    ensure_dir(output_dir)
    ensure_dir(work_dir)

    failures: List[Tuple[str, str]] = []
    generated: List[Path] = []

    for url in urls:
        try:
            pdf_path = convert_one_book(
                reader_url=url,
                output_dir=output_dir,
                work_dir=work_dir,
                workers=max(1, workers),
                timeout=max(5, timeout),
                retries=max(1, retries),
                max_pages=None,
                skip_existing_pdf=False,
            )
            generated.append(pdf_path)
        except Exception as exc:
            failures.append((url, str(exc)))

    if not generated:
        details = "\n".join(f"- {url}\n  -> {msg}" for url, msg in failures)
        raise RuntimeError(f"No PDFs were generated.\n{details}")

    zip_path = job_dir / "hmu_pdfs.zip"
    with ZipFile(zip_path, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        for pdf in generated:
            archive.write(pdf, arcname=pdf.name)
        if failures:
            lines = ["Some URLs failed to convert.", ""]
            for url, msg in failures:
                lines.append(url)
                lines.append(f"  -> {msg}")
            archive.writestr("errors.txt", "\n".join(lines) + "\n")

    return zip_path, job_dir


class AppHandler(BaseHTTPRequestHandler):
    config: AppConfig

    server_version = "HMUBook2PDFWeb/1.0"

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/":
            self.respond_text(HTTPStatus.NOT_FOUND, "Not found")
            return

        content = html_page(self.config).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/convert":
            self.respond_text(HTTPStatus.NOT_FOUND, "Not found")
            return

        content_length_raw = self.headers.get("Content-Length", "")
        if not content_length_raw.isdigit():
            self.respond_text(HTTPStatus.BAD_REQUEST, "Missing Content-Length")
            return

        content_length = int(content_length_raw)
        if content_length < 1:
            self.respond_text(HTTPStatus.BAD_REQUEST, "Empty request body")
            return
        if content_length > MAX_BODY_BYTES:
            self.respond_text(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"Request too large (limit {MAX_BODY_BYTES} bytes)",
            )
            return

        raw_body = self.rfile.read(content_length)
        data = parse_qs(
            raw_body.decode("utf-8", errors="replace"), keep_blank_values=True
        )
        raw_urls = data.get("urls", [""])[0]
        urls = parse_urls_text(raw_urls)

        if not urls:
            self.respond_text(HTTPStatus.BAD_REQUEST, "No URLs provided")
            return
        if len(urls) > MAX_URLS:
            self.respond_text(
                HTTPStatus.BAD_REQUEST,
                f"Too many URLs ({len(urls)}). Limit is {MAX_URLS}.",
            )
            return

        zip_path: Optional[Path] = None
        job_dir: Optional[Path] = None
        try:
            zip_path, job_dir = build_zip_for_urls(
                urls=urls,
                jobs_dir=self.config.jobs_dir,
                workers=self.config.workers,
                timeout=self.config.timeout,
                retries=self.config.retries,
            )
            filename = f"hmu_pdfs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
            file_size = zip_path.stat().st_size

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header(
                "Content-Disposition", f'attachment; filename="{filename}"'
            )
            self.send_header("Content-Length", str(file_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            with zip_path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            self.wfile.flush()
        except BrokenPipeError:
            return
        except Exception as exc:
            self.respond_text(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
        finally:
            if job_dir:
                shutil.rmtree(job_dir, ignore_errors=True)

    def log_message(self, format: str, *args: object) -> None:
        return

    def respond_text(self, status: HTTPStatus, text: str) -> None:
        payload = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def build_config(args: argparse.Namespace) -> AppConfig:
    jobs_dir = Path(args.jobs_dir).resolve()
    ensure_dir(jobs_dir)
    return AppConfig(
        host=args.host,
        port=max(1, int(args.port)),
        jobs_dir=jobs_dir,
        workers=max(1, int(args.workers)),
        timeout=max(5, int(args.timeout)),
        retries=max(1, int(args.retries)),
    )


def main() -> int:
    args = parse_cli_args()
    config = build_config(args)
    AppHandler.config = config

    httpd = ThreadingHTTPServer((config.host, config.port), AppHandler)
    print(f"Server started at http://{config.host}:{config.port}")
    print(
        f"jobs_dir={config.jobs_dir} workers={config.workers} timeout={config.timeout}s retries={config.retries}"
    )

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
