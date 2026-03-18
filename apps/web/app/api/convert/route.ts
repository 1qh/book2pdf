import archiver from "archiver"
import { PassThrough, Readable } from "node:stream"
import { NextRequest } from "next/server"

import {
  InputError,
  buildFailureText,
  buildZipName,
  convertOnePreparedBook,
  preflightBooks,
  type ConversionFailure,
} from "@/lib/hmu-converter"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const OPTIONS = {
  timeoutMs: 45_000,
  retries: 4,
  maxUrls: 8,
  maxPagesPerBook: 650,
  maxTotalPages: 2200,
}

function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
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
  const abortSignal = request.signal

  let urlsText = ""
  try {
    urlsText = await getUrlsText(request)
    if (urlsText.trim().length === 0) {
      throw new InputError("No URLs provided.")
    }
  } catch (error) {
    if (error instanceof InputError) {
      return plainResponse(400, error.message)
    }
    return plainResponse(400, "Invalid request body.")
  }

  let prepared: Awaited<ReturnType<typeof preflightBooks>>
  try {
    prepared = await preflightBooks(urlsText, {
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
  archive.on("error", (error: Error) => {
    output.destroy(error)
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
    },
  })
}
