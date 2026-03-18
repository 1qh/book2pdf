#!/usr/bin/env python3
"""Convert HMU FullBookReader links to PDFs.

This script:
1) Parses `FullBookReader.aspx` URLs.
2) Downloads all page JPG files directly.
3) Builds one PDF per link (no third-party Python packages needed).

The generated PDF writer supports JPEG inputs (`ext=jpg` or `ext=jpeg`).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib import error, parse, request


USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HMUBook2PDF/1.0"
JPEG_SOI = b"\xff\xd8"
JPEG_SIG = b"\xff\xd8\xff"


@dataclass
class BookSpec:
    reader_url: str
    site_base: str
    image_base_path: str
    total_pages: int
    ext: str
    pad_width: int
    book_id: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download HMU FullBookReader links and create PDFs."
    )
    parser.add_argument("urls", nargs="*", help="One or more FullBookReader URLs")
    parser.add_argument(
        "-f",
        "--urls-file",
        help="Text file with one FullBookReader URL per line",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        default="output_pdfs",
        help="Directory for generated PDFs (default: output_pdfs)",
    )
    parser.add_argument(
        "-w",
        "--work-dir",
        default="book2pdf_work",
        help="Directory for downloaded images / resume cache (default: book2pdf_work)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Concurrent download workers (default: 8)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout seconds (default: 30)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Retries per page download (default: 3)",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        help="Only process first N pages (useful for testing)",
    )
    parser.add_argument(
        "--skip-existing-pdf",
        action="store_true",
        help="Skip a book if output PDF already exists",
    )
    return parser.parse_args()


def read_urls_from_file(file_path: Path) -> List[str]:
    urls: List[str] = []
    for line in file_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        urls.append(text)
    return urls


def sanitize_name(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._-")
    return cleaned or "book"


def derive_book_id(image_base_path: str) -> str:
    parts = [segment for segment in image_base_path.split("/") if segment]
    if not parts:
        return "book"
    for idx, value in enumerate(parts):
        if value.lower() == "books" and idx + 1 < len(parts):
            return sanitize_name(parts[idx + 1])
    if len(parts) >= 2:
        return sanitize_name(parts[-2])
    return sanitize_name(parts[-1])


def request_bytes(url: str, timeout: int, referer: Optional[str] = None) -> bytes:
    headers: Dict[str, str] = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    req = request.Request(url=url, headers=headers)
    with request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def request_starts_with_image(
    url: str, timeout: int, referer: Optional[str] = None
) -> bool:
    headers: Dict[str, str] = {"User-Agent": USER_AGENT}
    if referer:
        headers["Referer"] = referer
    req = request.Request(url=url, headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "").lower()
            prefix = resp.read(3)
            if prefix.startswith(JPEG_SIG):
                return True
            return content_type.startswith("image/")
    except Exception:
        return False


def fetch_reader_html(url: str, timeout: int) -> str:
    data = request_bytes(url, timeout=timeout)
    return data.decode("utf-8", errors="ignore")


def parse_reader_meta_from_html(html: str) -> Tuple[Optional[int], Optional[int]]:
    pages_match = re.search(r"br\.numLeafs\s*=\s*(\d+)", html)
    leaf_match = re.search(r"var\s+leafStr\s*=\s*'([0]+)'", html)

    total_pages = int(pages_match.group(1)) if pages_match else None
    pad_width = len(leaf_match.group(1)) if leaf_match else None
    return total_pages, pad_width


def build_image_url(spec: BookSpec, page: int) -> str:
    if page < 1:
        raise ValueError("Page numbers start at 1")
    if spec.pad_width > 0:
        page_token = f"{page:0{spec.pad_width}d}"
    else:
        page_token = str(page)
    path = f"{spec.image_base_path.rstrip('/')}/{page_token}.{spec.ext}"
    if path.startswith("/"):
        return f"{spec.site_base}{path}"
    return f"{spec.site_base}/{path}"


def parse_book_spec(reader_url: str, timeout: int) -> BookSpec:
    parsed = parse.urlsplit(reader_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid URL: {reader_url}")

    site_base = f"{parsed.scheme}://{parsed.netloc}"
    params = {k.lower(): v for k, v in parse.parse_qs(parsed.query).items()}

    raw_image_path = parse.unquote(params.get("url", [""])[0]).strip()
    raw_pages = params.get("totalpage", [""])[0].strip()
    ext = params.get("ext", ["jpg"])[0].strip().lower().lstrip(".") or "jpg"

    html_total_pages: Optional[int] = None
    html_pad_width: Optional[int] = None

    if not raw_image_path or not raw_pages:
        html = fetch_reader_html(reader_url, timeout=timeout)
        html_total_pages, html_pad_width = parse_reader_meta_from_html(html)

    total_pages = int(raw_pages) if raw_pages.isdigit() else (html_total_pages or 0)
    if total_pages < 1:
        raise ValueError(
            "Cannot determine total pages. Ensure URL has TotalPage=... or reader page is accessible."
        )

    if not raw_image_path:
        raise ValueError("Cannot determine image base path from URL parameter 'Url'.")

    book_id = derive_book_id(raw_image_path)
    candidate_pad_widths: List[int] = []
    if html_pad_width is not None:
        candidate_pad_widths.append(html_pad_width)
    candidate_pad_widths.extend([6, 5, 4, 3, 2, 1, 0])

    seen = set()
    unique_candidates = []
    for value in candidate_pad_widths:
        if value in seen:
            continue
        seen.add(value)
        unique_candidates.append(value)

    probe_spec = BookSpec(
        reader_url=reader_url,
        site_base=site_base,
        image_base_path=raw_image_path,
        total_pages=total_pages,
        ext=ext,
        pad_width=0,
        book_id=book_id,
    )

    picked_pad: Optional[int] = None
    for width in unique_candidates:
        probe_spec.pad_width = width
        probe_url = build_image_url(probe_spec, page=1)
        if request_starts_with_image(probe_url, timeout=timeout, referer=reader_url):
            picked_pad = width
            break

    if picked_pad is None:
        raise RuntimeError(
            "Unable to find a valid page image pattern. Check if the link is still accessible."
        )

    return BookSpec(
        reader_url=reader_url,
        site_base=site_base,
        image_base_path=raw_image_path,
        total_pages=total_pages,
        ext=ext,
        pad_width=picked_pad,
        book_id=book_id,
    )


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def download_page(
    spec: BookSpec,
    page: int,
    output_file: Path,
    timeout: int,
    retries: int,
) -> None:
    if output_file.exists() and output_file.stat().st_size > 0:
        return

    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            url = build_image_url(spec, page)
            data = request_bytes(url, timeout=timeout, referer=spec.reader_url)
            if spec.ext in {"jpg", "jpeg"} and not data.startswith(JPEG_SOI):
                raise RuntimeError(f"Page {page} is not a valid JPEG stream")

            temp_file = output_file.with_suffix(output_file.suffix + ".part")
            with temp_file.open("wb") as handle:
                handle.write(data)
            os.replace(temp_file, output_file)
            return
        except Exception as exc:  # noqa: PERF203 - retry loop is intentional.
            last_error = exc
            if attempt < retries:
                time.sleep(min(1.5 * attempt, 4.0))

    raise RuntimeError(f"Failed page {page}: {last_error}")


def parse_jpeg_dimensions(jpeg_data: bytes) -> Tuple[int, int, int]:
    if len(jpeg_data) < 4 or not jpeg_data.startswith(JPEG_SOI):
        raise ValueError("Invalid JPEG data")

    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }

    idx = 2
    data_len = len(jpeg_data)

    while idx + 1 < data_len:
        if jpeg_data[idx] != 0xFF:
            idx += 1
            continue

        while idx < data_len and jpeg_data[idx] == 0xFF:
            idx += 1
        if idx >= data_len:
            break

        marker = jpeg_data[idx]
        idx += 1

        if marker in (0xD8, 0xD9):
            continue

        if idx + 1 >= data_len:
            break

        segment_len = (jpeg_data[idx] << 8) + jpeg_data[idx + 1]
        idx += 2

        if segment_len < 2 or idx + segment_len - 2 > data_len:
            break

        if marker in sof_markers:
            if segment_len < 8:
                break
            height = (jpeg_data[idx + 1] << 8) + jpeg_data[idx + 2]
            width = (jpeg_data[idx + 3] << 8) + jpeg_data[idx + 4]
            components = jpeg_data[idx + 5]
            return width, height, components

        idx += segment_len - 2

    raise ValueError("Could not read JPEG dimensions")


def write_pdf_from_jpegs(image_files: Sequence[Path], output_pdf: Path) -> None:
    if not image_files:
        raise ValueError("No images to convert")

    total_objects = 2 + len(image_files) * 3
    offsets = [0] * (total_objects + 1)
    page_object_ids: List[int] = []

    for index in range(len(image_files)):
        image_obj = 3 + index * 3
        page_obj = image_obj + 2
        page_object_ids.append(page_obj)

    def write_obj(handle, obj_id: int, content: bytes) -> None:
        offsets[obj_id] = handle.tell()
        handle.write(f"{obj_id} 0 obj\n".encode("ascii"))
        handle.write(content)
        handle.write(b"\nendobj\n")

    with output_pdf.open("wb") as pdf:
        pdf.write(b"%PDF-1.4\n")
        pdf.write(b"%\xe2\xe3\xcf\xd3\n")

        kids = " ".join(f"{obj_id} 0 R" for obj_id in page_object_ids)
        write_obj(pdf, 1, b"<< /Type /Catalog /Pages 2 0 R >>")
        write_obj(
            pdf,
            2,
            f"<< /Type /Pages /Count {len(image_files)} /Kids [ {kids} ] >>".encode(
                "ascii"
            ),
        )

        for index, img_path in enumerate(image_files):
            image_obj = 3 + index * 3
            content_obj = image_obj + 1
            page_obj = image_obj + 2

            jpeg_data = img_path.read_bytes()
            width, height, components = parse_jpeg_dimensions(jpeg_data)

            if components == 1:
                colorspace = "/DeviceGray"
                decode_suffix = ""
            elif components == 3:
                colorspace = "/DeviceRGB"
                decode_suffix = ""
            elif components == 4:
                colorspace = "/DeviceCMYK"
                decode_suffix = " /Decode [1 0 1 0 1 0 1 0]"
            else:
                raise ValueError(
                    f"Unsupported JPEG color components ({components}) in {img_path}"
                )

            image_dict = (
                f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                f"/ColorSpace {colorspace}{decode_suffix} "
                f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg_data)} >>\n"
                "stream\n"
            ).encode("ascii")
            image_stream = image_dict + jpeg_data + b"\nendstream"
            write_obj(pdf, image_obj, image_stream)

            draw_cmd = f"q\n{width} 0 0 {height} 0 0 cm\n/Im0 Do\nQ\n".encode("ascii")
            content_stream = (
                f"<< /Length {len(draw_cmd)} >>\nstream\n".encode("ascii")
                + draw_cmd
                + b"endstream"
            )
            write_obj(pdf, content_obj, content_stream)

            page_dict = (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
                f"/Resources << /XObject << /Im0 {image_obj} 0 R >> >> "
                f"/Contents {content_obj} 0 R >>"
            ).encode("ascii")
            write_obj(pdf, page_obj, page_dict)

        xref_start = pdf.tell()
        pdf.write(f"xref\n0 {total_objects + 1}\n".encode("ascii"))
        pdf.write(b"0000000000 65535 f \n")
        for obj_id in range(1, total_objects + 1):
            pdf.write(f"{offsets[obj_id]:010d} 00000 n \n".encode("ascii"))
        pdf.write(
            (
                f"trailer\n<< /Size {total_objects + 1} /Root 1 0 R >>\n"
                f"startxref\n{xref_start}\n%%EOF\n"
            ).encode("ascii")
        )


def convert_one_book(
    reader_url: str,
    output_dir: Path,
    work_dir: Path,
    workers: int,
    timeout: int,
    retries: int,
    max_pages: Optional[int],
    skip_existing_pdf: bool,
) -> Path:
    spec = parse_book_spec(reader_url, timeout=timeout)
    if spec.ext not in {"jpg", "jpeg"}:
        raise ValueError(
            f"Unsupported image extension '{spec.ext}'. This script currently supports JPG/JPEG only."
        )

    pages_to_fetch = spec.total_pages
    if max_pages is not None:
        pages_to_fetch = max(1, min(spec.total_pages, max_pages))

    book_work_dir = work_dir / spec.book_id
    images_dir = book_work_dir / "images"
    ensure_dir(images_dir)
    ensure_dir(output_dir)

    out_pdf = output_dir / f"{spec.book_id}.pdf"
    if skip_existing_pdf and out_pdf.exists() and out_pdf.stat().st_size > 0:
        print(f"[skip] {spec.book_id}: PDF already exists -> {out_pdf}")
        return out_pdf

    print(
        f"[book] {spec.book_id} | pages={pages_to_fetch}/{spec.total_pages} | ext={spec.ext} | pad={spec.pad_width}"
    )

    page_numbers = list(range(1, pages_to_fetch + 1))
    files: Dict[int, Path] = {
        page: images_dir / f"{page:06d}.{spec.ext}" for page in page_numbers
    }

    pending_pages = [page for page in page_numbers if not files[page].exists()]
    if pending_pages:
        print(f"  downloading {len(pending_pages)} page(s) with {workers} workers...")
        completed = 0
        completed_lock = threading.Lock()

        def wrapped_download(page_number: int) -> int:
            download_page(
                spec=spec,
                page=page_number,
                output_file=files[page_number],
                timeout=timeout,
                retries=retries,
            )
            return page_number

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {
                pool.submit(wrapped_download, page): page for page in pending_pages
            }
            for future in concurrent.futures.as_completed(future_map):
                page = future_map[future]
                try:
                    _ = future.result()
                except Exception as exc:
                    for f in future_map:
                        f.cancel()
                    raise RuntimeError(
                        f"Download failed at page {page}: {exc}"
                    ) from exc

                with completed_lock:
                    completed += 1
                    if (
                        completed == len(pending_pages)
                        or completed % max(1, len(pending_pages) // 20) == 0
                    ):
                        print(f"  progress: {completed}/{len(pending_pages)}")
    else:
        print("  all pages already in cache, skipping downloads")

    ordered_files = [files[page] for page in page_numbers]
    print(f"  writing PDF -> {out_pdf}")
    write_pdf_from_jpegs(ordered_files, out_pdf)
    print(f"[done] {out_pdf}")
    return out_pdf


def collect_urls(cli_urls: Sequence[str], urls_file: Optional[str]) -> List[str]:
    urls: List[str] = []
    for value in cli_urls:
        text = value.strip()
        if text:
            urls.append(text)

    if urls_file:
        file_urls = read_urls_from_file(Path(urls_file))
        urls.extend(file_urls)

    deduped: List[str] = []
    seen = set()
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def main() -> int:
    args = parse_args()
    urls = collect_urls(args.urls, args.urls_file)

    if not urls:
        print("No URLs provided. Use positional URLs or --urls-file.", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    work_dir = Path(args.work_dir)
    ensure_dir(output_dir)
    ensure_dir(work_dir)

    failures: List[Tuple[str, str]] = []
    for idx, url in enumerate(urls, start=1):
        print(f"\n=== [{idx}/{len(urls)}] Processing ===")
        print(url)
        try:
            convert_one_book(
                reader_url=url,
                output_dir=output_dir,
                work_dir=work_dir,
                workers=max(1, args.workers),
                timeout=max(5, args.timeout),
                retries=max(1, args.retries),
                max_pages=args.max_pages,
                skip_existing_pdf=args.skip_existing_pdf,
            )
        except Exception as exc:
            message = str(exc)
            print(f"[error] {message}", file=sys.stderr)
            failures.append((url, message))

    if failures:
        print("\nSome books failed:", file=sys.stderr)
        for url, message in failures:
            print(f"- {url}\n  -> {message}", file=sys.stderr)
        return 1

    print("\nAll books converted successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
