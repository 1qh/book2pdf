import { PDFDocument } from "pdf-lib"

const USER_AGENT = "Mozilla/5.0 (HMUBook2PDFNext/1.0)"

interface BookSpec {
  readerUrl: string
  siteBase: string
  imageBasePath: string
  pagePrefix: string | null
  pageSuffix: string | null
  pageOffset: number
  totalPages: number
  ext: string
  padWidth: number
  bookId: string
}

export type PreparedBook = BookSpec

export interface ConverterOptions {
  timeoutMs: number
  retries: number
  maxUrls: number
  maxPagesPerBook: number
  maxTotalPages: number
  abortSignal?: AbortSignal
}

export interface ConversionFailure {
  url: string
  message: string
}

export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InputError"
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request was aborted.")
  }
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "")
  return cleaned.length > 0 ? cleaned : "book"
}

function deriveBookId(imageBasePath: string): string {
  const parts = imageBasePath.split("/").filter((part) => part.length > 0)
  if (parts.length === 0) {
    return "book"
  }
  for (let index = 0; index < parts.length; index += 1) {
    const value = parts[index]
    const nextValue = parts[index + 1]
    if (value?.toLowerCase() === "books" && nextValue) {
      return sanitizeName(nextValue)
    }
  }
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2]
    if (secondLast) {
      return sanitizeName(secondLast)
    }
  }
  return sanitizeName(parts[parts.length - 1] ?? "book")
}

function normalizeToAbsolute(value: string, siteBase: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  if (value.startsWith("/")) {
    return `${siteBase}${value}`
  }
  return `${siteBase}/${value}`
}

function getParamIgnoreCase(searchParams: URLSearchParams, key: string): string | null {
  const wanted = key.toLowerCase()
  for (const [name, value] of searchParams.entries()) {
    if (name.toLowerCase() === wanted) {
      return value
    }
  }
  return null
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
}

function buildImageUrl(spec: BookSpec, pageNumber: number): string {
  const numericPage = pageNumber + spec.pageOffset
  if (numericPage < 0) {
    throw new Error("Invalid page index")
  }

  const token = spec.padWidth > 0 ? String(numericPage).padStart(spec.padWidth, "0") : String(numericPage)

  if (spec.pagePrefix && spec.pageSuffix !== null) {
    return `${spec.pagePrefix}${token}${spec.pageSuffix}`
  }

  const base = spec.imageBasePath.replace(/\/+$/, "")
  if (/^https?:\/\//i.test(base)) {
    return `${base}/${token}.${spec.ext}`
  }
  if (base.startsWith("/")) {
    return `${spec.siteBase}${base}/${token}.${spec.ext}`
  }
  return `${spec.siteBase}/${base}/${token}.${spec.ext}`
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort()
  }, timeoutMs)

  const abortController = new AbortController()
  const relayTimeoutAbort = () => abortController.abort()
  const relayExternalAbort = () => abortController.abort()

  timeoutController.signal.addEventListener("abort", relayTimeoutAbort)
  externalSignal?.addEventListener("abort", relayExternalAbort)

  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: abortController.signal,
    })
  } finally {
    clearTimeout(timeoutId)
    timeoutController.signal.removeEventListener("abort", relayTimeoutAbort)
    externalSignal?.removeEventListener("abort", relayExternalAbort)
  }
}

function parseDiscoveryFromHtml(
  html: string,
  siteBase: string
): {
  totalPages: number | null
  padWidth: number | null
  pagePrefix: string | null
  pageSuffix: string | null
  ext: string | null
  pageOffset: number
} {
  const pagesMatch = html.match(/br\.numLeafs\s*=\s*(\d+)/)
  const padMatch = html.match(/var\s+leafStr\s*=\s*'([0]+)'/)
  const varTemplate = html.match(
    /var\s+url\s*=\s*['"]([^'"]+)['"]\s*\+\s*leafStr\.replace\(\s*re\s*,\s*imgStr\s*\)\s*\+\s*['"]([^'"]*)['"]/i
  )
  const returnTemplate = html.match(
    /return\s+['"]([^'"]+)['"]\s*\+\s*leafStr\.replace\(\s*re\s*,\s*imgStr\s*\)\s*\+\s*['"]([^'"]*)['"]/i
  )

  const template = varTemplate || returnTemplate
  let pagePrefix: string | null = null
  let pageSuffix: string | null = null
  let ext: string | null = null

  if (template?.[1] !== undefined && template?.[2] !== undefined) {
    pagePrefix = normalizeToAbsolute(template[1], siteBase)
    pageSuffix = template[2]
    const extMatch = pageSuffix.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/)
    ext = extMatch?.[1]?.toLowerCase() ?? null
  }

  const totalPages = pagesMatch?.[1] ? Number.parseInt(pagesMatch[1], 10) : null
  const padWidth = padMatch?.[1] ? padMatch[1].length : null
  const pageOffset = /imgStr\s*=\s*index\s*\.toString\(\)/i.test(html) ? -1 : 0

  return {
    totalPages,
    padWidth,
    pagePrefix,
    pageSuffix,
    ext,
    pageOffset,
  }
}

async function fetchReaderHtml(readerUrl: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(
    readerUrl,
    {
      headers: {
        "user-agent": USER_AGENT,
      },
    },
    timeoutMs,
    abortSignal
  )

  if (!response.ok) {
    throw new InputError(`Reader request failed with HTTP ${response.status}.`)
  }

  return response.text()
}

async function looksLikeImage(
  imageUrl: string,
  refererUrl: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      imageUrl,
      {
        headers: {
          "user-agent": USER_AGENT,
          referer: refererUrl,
        },
      },
      timeoutMs,
      abortSignal
    )
    if (!response.ok) {
      return false
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (isJpeg(bytes) || isPng(bytes)) {
      return true
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    return contentType.startsWith("image/")
  } catch {
    return false
  }
}

async function parseBookSpec(url: string, options: ConverterOptions): Promise<BookSpec> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InputError(`Invalid URL: ${url}`)
  }

  const siteBase = `${parsed.protocol}//${parsed.host}`
  const rawImagePath = decodeURIComponent(getParamIgnoreCase(parsed.searchParams, "url") ?? "").trim()
  const rawPages = (getParamIgnoreCase(parsed.searchParams, "totalpage") ?? "").trim()
  const rawExt = (getParamIgnoreCase(parsed.searchParams, "ext") ?? "jpg").trim().toLowerCase()
  const ext = rawExt.replace(/^\./, "") || "jpg"

  let discovered: ReturnType<typeof parseDiscoveryFromHtml> | null = null
  try {
    const html = await fetchReaderHtml(url, options.timeoutMs, options.abortSignal)
    discovered = parseDiscoveryFromHtml(html, siteBase)
  } catch {
  }

  const queryTotalPages = Number.parseInt(rawPages, 10)
  const totalPages =
    discovered?.totalPages && Number.isFinite(discovered.totalPages) && discovered.totalPages > 0
      ? discovered.totalPages
      : Number.isFinite(queryTotalPages) && queryTotalPages > 0
        ? queryTotalPages
        : 0

  if (!Number.isFinite(totalPages) || totalPages < 1) {
    throw new InputError(`Cannot determine TotalPage for URL: ${url}`)
  }

  const pagePrefix = discovered?.pagePrefix ?? null
  const pageSuffix = discovered?.pageSuffix ?? null

  if (rawImagePath.length === 0 && !pagePrefix) {
    throw new InputError("Missing Url=... query parameter.")
  }

  const baseSpec: BookSpec = {
    readerUrl: url,
    siteBase,
    imageBasePath: rawImagePath,
    pagePrefix,
    pageSuffix,
    pageOffset: discovered?.pageOffset ?? 0,
    totalPages,
    ext: discovered?.ext ?? ext,
    padWidth: discovered?.padWidth ?? 6,
    bookId: deriveBookId(rawImagePath || pagePrefix || url),
  }

  const extCandidates = Array.from(new Set([baseSpec.ext, "jpg", "jpeg", "png"].filter((value) => value.length > 0)))
  const padCandidates = Array.from(
    new Set([baseSpec.padWidth, 6, 5, 4, 3, 2, 1, 0].filter((value) => Number.isInteger(value) && value >= 0))
  )
  const offsetCandidates = Array.from(new Set([baseSpec.pageOffset, 0, -1]))
  const probePages = [1, 2]
  const candidateSpecs: BookSpec[] = []

  if (baseSpec.pagePrefix && baseSpec.pageSuffix !== null) {
    for (const offset of offsetCandidates) {
      for (const padWidth of padCandidates) {
        candidateSpecs.push({
          ...baseSpec,
          pageOffset: offset,
          padWidth,
        })
      }
    }
  }

  if (baseSpec.imageBasePath.length > 0) {
    for (const candidateExt of extCandidates) {
      for (const offset of offsetCandidates) {
        for (const padWidth of padCandidates) {
          candidateSpecs.push({
            ...baseSpec,
            ext: candidateExt,
            pageOffset: offset,
            padWidth,
            pagePrefix: null,
            pageSuffix: null,
          })
        }
      }
    }
  }

  for (const candidate of candidateSpecs) {
    ensureNotAborted(options.abortSignal)
    for (const probePage of probePages) {
      try {
        const probeUrl = buildImageUrl(candidate, probePage)
        if (await looksLikeImage(probeUrl, url, options.timeoutMs, options.abortSignal)) {
          return candidate
        }
      } catch {
      }
    }
  }

  throw new InputError(`Could not resolve image page pattern for URL: ${url}`)
}

async function downloadPage(spec: BookSpec, pageNumber: number, options: ConverterOptions): Promise<Uint8Array> {
  const url = buildImageUrl(spec, pageNumber)
  const attempts = Math.max(1, options.retries)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ensureNotAborted(options.abortSignal)
    try {
      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            "user-agent": USER_AGENT,
            referer: spec.readerUrl,
          },
        },
        options.timeoutMs,
        options.abortSignal
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const bytes = new Uint8Array(await response.arrayBuffer())
      if ((spec.ext === "jpg" || spec.ext === "jpeg") && !isJpeg(bytes)) {
        throw new Error("Invalid JPEG payload")
      }
      if (spec.ext === "png" && !isPng(bytes)) {
        throw new Error("Invalid PNG payload")
      }
      return bytes
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`Page ${pageNumber} failed: ${toErrorMessage(error)}`)
      }
      await sleep(Math.min(1500 * attempt, 4000))
    }
  }

  throw new Error(`Page ${pageNumber} failed.`)
}

async function convertSpecToPdf(spec: BookSpec, options: ConverterOptions): Promise<Uint8Array> {
  if (spec.ext !== "jpg" && spec.ext !== "jpeg" && spec.ext !== "png") {
    throw new InputError(`Unsupported ext=${spec.ext}. Only jpg/jpeg/png are supported.`)
  }

  const pdfDoc = await PDFDocument.create()

  for (let page = 1; page <= spec.totalPages; page += 1) {
    ensureNotAborted(options.abortSignal)
    const imageBytes = await downloadPage(spec, page, options)
    const image = isPng(imageBytes) ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes)
    const pdfPage = pdfDoc.addPage([image.width, image.height])
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    })
  }

  return pdfDoc.save()
}

export function parseUrlsText(rawText: string, maxUrls: number): string[] {
  const values: string[] = []
  const seen = new Set<string>()

  for (const line of rawText.split(/\r?\n/)) {
    const value = line.trim()
    if (value.length === 0 || value.startsWith("#")) {
      continue
    }
    if (!seen.has(value)) {
      seen.add(value)
      values.push(value)
    }
  }

  if (values.length === 0) {
    throw new InputError("No URLs provided.")
  }
  if (values.length > maxUrls) {
    throw new InputError(`Too many URLs (${values.length}). Limit is ${maxUrls}.`)
  }
  return values
}

export function buildFailureText(failures: ConversionFailure[]): string {
  const lines: string[] = ["Some URLs failed to convert.", ""]
  for (const item of failures) {
    lines.push(item.url)
    lines.push(`  -> ${item.message}`)
  }
  return `${lines.join("\n")}\n`
}

export function buildZipName(date: Date): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  const sec = String(date.getSeconds()).padStart(2, "0")
  return `hmu_pdfs_${yyyy}${mm}${dd}_${hh}${min}${sec}.zip`
}

export async function preflightBooks(
  rawText: string,
  options: ConverterOptions
): Promise<{ books: Array<{ url: string; bookId: string; totalPages: number }>; specs: PreparedBook[] }> {
  const urls = parseUrlsText(rawText, options.maxUrls)
  const specs: BookSpec[] = []
  let pageTotal = 0

  for (const url of urls) {
    ensureNotAborted(options.abortSignal)
    const spec = await parseBookSpec(url, options)

    if (spec.totalPages > options.maxPagesPerBook) {
      throw new InputError(
        `Book ${spec.bookId} has ${spec.totalPages} pages, above maxPagesPerBook=${options.maxPagesPerBook}.`
      )
    }

    pageTotal += spec.totalPages
    if (pageTotal > options.maxTotalPages) {
      throw new InputError(
        `Total pages ${pageTotal} exceed maxTotalPages=${options.maxTotalPages}. Split into smaller batches.`
      )
    }

    specs.push(spec)
  }

  return {
    books: specs.map((spec) => ({
      url: spec.readerUrl,
      bookId: spec.bookId,
      totalPages: spec.totalPages,
    })),
    specs,
  }
}

export async function convertOnePreparedBook(
  spec: PreparedBook,
  options: ConverterOptions
): Promise<{ bookId: string; pdfBytes: Uint8Array }> {
  const pdfBytes = await convertSpecToPdf(spec, options)
  return {
    bookId: spec.bookId,
    pdfBytes,
  }
}
