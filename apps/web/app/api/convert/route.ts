import archiver from "archiver"
import { PassThrough, Readable } from "node:stream"
import { NextRequest } from "next/server"

import {
  InputError,
  buildFailureText,
  buildZipName,
  convertOnePreparedBook,
  parseUrlsText,
  preflightBooks,
  type ConversionFailure,
} from "@/lib/hmu-converter"
import {
  buildZipCacheKey,
  isS3CacheAvailable,
  readCachedZip,
  readMemoryCachedZip,
  writeCachedZip,
  writeMemoryCachedZip,
} from "@/lib/s3-cache"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const RATE_LIMIT_MAX = Number.parseInt(process.env.API_RATE_LIMIT_MAX ?? "2", 10)
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.API_RATE_LIMIT_WINDOW_MS ?? `${10 * 60 * 1000}`, 10)

const rateStore = new Map<string, { count: number; resetAt: number }>()

const OPTIONS = {
  timeoutMs: 45_000,
  retries: 4,
  maxUrls: 8,
  maxPagesPerBook: 9999,
  maxTotalPages: 2200,
}

const MAX_CACHE_CAPTURE_BYTES = Number.parseInt(process.env.S3_CACHE_MAX_BYTES ?? `${200 * 1024 * 1024}`, 10)
const inFlightZipCache = new Map<string, Promise<Uint8Array | null>>()

function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

function getClientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  const realIp = request.headers.get("x-real-ip")?.trim()
  return forwarded || realIp || "unknown"
}

function pruneRateStore(now: number): void {
  if (rateStore.size < 2000) {
    return
  }
  for (const [key, value] of rateStore.entries()) {
    if (now >= value.resetAt) {
      rateStore.delete(key)
    }
  }
}

function consumeRateLimit(key: string): {
  allowed: boolean
  remaining: number
  retryAfterSec: number
  limit: number
} {
  const limit = Number.isFinite(RATE_LIMIT_MAX) && RATE_LIMIT_MAX > 0 ? RATE_LIMIT_MAX : 2
  const windowMs = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0 ? RATE_LIMIT_WINDOW_MS : 600000
  const now = Date.now()

  pruneRateStore(now)

  const current = rateStore.get(key)
  if (!current || now >= current.resetAt) {
    const resetAt = now + windowMs
    rateStore.set(key, { count: 1, resetAt })
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfterSec: Math.ceil(windowMs / 1000),
      limit,
    }
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      limit,
    }
  }

  current.count += 1
  rateStore.set(key, current)

  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    limit,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  return arrayBuffer
}

function buildZipResponse(
  bytes: Uint8Array,
  cacheStatus: string,
  rate: { limit: number; remaining: number }
): Response {
  return new Response(toArrayBuffer(bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${buildZipName(new Date())}"`,
      "cache-control": "no-store",
      "x-cache-status": cacheStatus,
      "x-ratelimit-limit": String(rate.limit),
      "x-ratelimit-remaining": String(rate.remaining),
    },
  })
}

async function getUrlsText(request: NextRequest): Promise<string> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase()

  if (contentType.includes("application/json")) {
    const body: unknown = await request.json()
    if (isRecord(body) && typeof body.urls === "string") {
      return body.urls
    }
    return ""
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const formData = await request.formData()
    const value = formData.get("urls")
    return typeof value === "string" ? value : ""
  }

  return request.text()
}

export async function GET(): Promise<Response> {
  return plainResponse(405, "Use POST /api/convert")
}

export async function POST(request: NextRequest): Promise<Response> {
  const abortSignal = request.signal

  let urlsText = ""
  let normalizedUrls: string[] = []
  try {
    urlsText = await getUrlsText(request)
    if (urlsText.trim().length === 0) {
      throw new InputError("No URLs provided.")
    }
    normalizedUrls = parseUrlsText(urlsText, OPTIONS.maxUrls)
  } catch (error) {
    if (error instanceof InputError) {
      return plainResponse(400, error.message)
    }
    return plainResponse(400, "Invalid request body.")
  }

  const key = getClientKey(request)
  const optimisticRate = {
    limit: Number.isFinite(RATE_LIMIT_MAX) && RATE_LIMIT_MAX > 0 ? RATE_LIMIT_MAX : 2,
    remaining: 0,
  }

  const cacheKey = buildZipCacheKey(normalizedUrls)
  const memoryHit = readMemoryCachedZip(cacheKey)
  if (memoryHit && memoryHit.length > 0) {
    return buildZipResponse(memoryHit, "HIT_MEMORY", optimisticRate)
  }

  const inFlight = inFlightZipCache.get(cacheKey)
  if (inFlight) {
    try {
      const pendingBytes = await inFlight
      if (pendingBytes && pendingBytes.length > 0) {
        return buildZipResponse(pendingBytes, "HIT_INFLIGHT", optimisticRate)
      }
    } catch {
    }
  }

  const cacheAvailable = await isS3CacheAvailable()
  if (cacheAvailable) {
    try {
      const cachedZip = await readCachedZip(cacheKey)
      if (cachedZip && cachedZip.length > 0) {
        writeMemoryCachedZip(cacheKey, cachedZip)
        return buildZipResponse(cachedZip, "HIT_S3", optimisticRate)
      }
    } catch {
    }
  }

  const rate = consumeRateLimit(key)

  if (!rate.allowed) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(rate.retryAfterSec),
        "x-ratelimit-limit": String(rate.limit),
        "x-ratelimit-remaining": String(rate.remaining),
      },
    })
  }

  let resolveInFlight: (value: Uint8Array | null) => void = () => {}
  let rejectInFlight: (reason?: unknown) => void = () => {}
  const inFlightPromise = new Promise<Uint8Array | null>((resolve, reject) => {
    resolveInFlight = resolve
    rejectInFlight = reject
  })
  inFlightZipCache.set(cacheKey, inFlightPromise)

  let prepared: Awaited<ReturnType<typeof preflightBooks>>
  try {
    prepared = await preflightBooks(normalizedUrls.join("\n"), {
      ...OPTIONS,
      abortSignal,
    })
  } catch (error) {
    inFlightZipCache.delete(cacheKey)
    rejectInFlight(error)
    if (error instanceof InputError) {
      return plainResponse(400, error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return plainResponse(500, message)
  }

  const archive = archiver("zip", {
    zlib: {
      level: 6,
    },
  })
  const output = new PassThrough()
  archive.pipe(output)

  const captureChunks: Buffer[] = []
  let captureBytes = 0
  let captureDropped = false
  const captureStream = new PassThrough()
  archive.pipe(captureStream)

  captureStream.on("data", (chunk: Buffer) => {
    if (captureDropped) {
      return
    }

    captureBytes += chunk.length
    if (captureBytes > Math.max(1, MAX_CACHE_CAPTURE_BYTES)) {
      captureDropped = true
      captureChunks.length = 0
      return
    }

    captureChunks.push(Buffer.from(chunk))
  })

  captureStream.on("end", () => {
    if (captureDropped || captureChunks.length === 0) {
      resolveInFlight(null)
      inFlightZipCache.delete(cacheKey)
      return
    }

    const merged = Buffer.concat(captureChunks)
    const zipped = new Uint8Array(merged)
    writeMemoryCachedZip(cacheKey, zipped)
    resolveInFlight(zipped)
    inFlightZipCache.delete(cacheKey)
    if (cacheAvailable) {
      void writeCachedZip(cacheKey, zipped).catch(() => {})
    }
  })

  captureStream.on("error", (error) => {
    rejectInFlight(error)
    inFlightZipCache.delete(cacheKey)
  })

  archive.on("error", (error: Error) => {
    output.destroy(error)
    rejectInFlight(error)
    inFlightZipCache.delete(cacheKey)
    captureStream.destroy(error)
  })

  const work = (async (): Promise<void> => {
    const failures: ConversionFailure[] = []
    const completedBooks: string[] = []

    archive.append(
      `Accepted books: ${prepared.books.length}\nTotal pages: ${prepared.books.reduce((sum, item) => sum + item.totalPages, 0)}\n`,
      { name: "_status.txt" }
    )

    for (const spec of prepared.specs) {
      try {
        const result = await convertOnePreparedBook(spec, {
          ...OPTIONS,
          abortSignal,
        })
        archive.append(Buffer.from(result.pdfBytes), {
          name: `${result.bookId}.pdf`,
        })
        completedBooks.push(result.bookId)
      } catch (error) {
        failures.push({
          url: spec.readerUrl,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const summary = {
      accepted: prepared.books.length,
      completed: completedBooks.length,
      failed: failures.length,
      completedBooks,
    }
    archive.append(`${JSON.stringify(summary, null, 2)}\n`, {
      name: "summary.json",
    })

    if (failures.length > 0) {
      archive.append(buildFailureText(failures), {
        name: "errors.txt",
      })
    }

    await archive.finalize()
  })()

  work.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    rejectInFlight(error)
    inFlightZipCache.delete(cacheKey)
    output.destroy(new Error(message))
  })

  return new Response(Readable.toWeb(output) as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${buildZipName(new Date())}"`,
      "cache-control": "no-store",
      "x-hmu-accepted-books": String(prepared.books.length),
      "x-cache-status": cacheAvailable ? "MISS_S3" : "DISABLED",
      "x-ratelimit-limit": String(rate.limit),
      "x-ratelimit-remaining": String(rate.remaining),
    },
  })
}
