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
import { buildZipCacheKey, isS3CacheAvailable, readCachedZip, writeCachedZip } from "@/lib/s3-cache"

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
  maxPagesPerBook: 650,
  maxTotalPages: 2200,
}

const MAX_CACHE_CAPTURE_BYTES = Number.parseInt(process.env.S3_CACHE_MAX_BYTES ?? `${200 * 1024 * 1024}`, 10)

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
  const key = getClientKey(request)
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

  const cacheKey = buildZipCacheKey(normalizedUrls)
  const cacheAvailable = await isS3CacheAvailable()
  if (cacheAvailable) {
    try {
      const cachedZip = await readCachedZip(cacheKey)
      if (cachedZip && cachedZip.length > 0) {
        const responseBytes = Uint8Array.from(cachedZip)
        return new Response(responseBytes.buffer, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${buildZipName(new Date())}"`,
            "cache-control": "no-store",
            "x-cache-status": "HIT_S3",
            "x-ratelimit-limit": String(rate.limit),
            "x-ratelimit-remaining": String(rate.remaining),
          },
        })
      }
    } catch {
    }
  }

  let prepared: Awaited<ReturnType<typeof preflightBooks>>
  try {
    prepared = await preflightBooks(normalizedUrls.join("\n"), {
      ...OPTIONS,
      abortSignal,
    })
  } catch (error) {
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
  let captureStream: PassThrough | null = null

  if (cacheAvailable) {
    captureStream = new PassThrough()
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
        return
      }

      const merged = Buffer.concat(captureChunks)
      void writeCachedZip(cacheKey, new Uint8Array(merged)).catch(() => {})
    })
  }

  archive.on("error", (error: Error) => {
    output.destroy(error)
    if (captureStream) {
      captureStream.destroy(error)
    }
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
