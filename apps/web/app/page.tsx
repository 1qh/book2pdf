"use client"

import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Label } from "@workspace/ui/components/label"
import { toast } from "@workspace/ui/components/sonner"
import { Textarea } from "@workspace/ui/components/textarea"

const USERSCRIPT_URL =
  "https://raw.githubusercontent.com/1qh/book2pdf/main/tools/hmu-book2pdf.user.js"
const MAX_LINKS = 8

function getParamIgnoreCase(params: URLSearchParams, name: string): string | null {
  const target = name.toLowerCase()
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === target) {
      return value
    }
  }
  return null
}

function validateLink(urlText: string): string | null {
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    return "Not a valid URL"
  }

  if (!url.pathname.toLowerCase().includes("fullbookreader.aspx")) {
    return "Must be a FullBookReader.aspx link"
  }

  if (!getParamIgnoreCase(url.searchParams, "url")) {
    return "Missing Url parameter"
  }

  return null
}

function parseLinks(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

function getDownloadName(disposition: string | null): string {
  if (!disposition) {
    return "books.zip"
  }
  const match = disposition.match(/filename="?([^";]+)"?/i)
  const fileName = match?.[1]
  return fileName && fileName.length > 0 ? fileName : "books.zip"
}

export default function Page() {
  const [urls, setUrls] = React.useState("")
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const links = parseLinks(urls)

    if (links.length === 0) {
      toast.error("No links provided", {
        description: "Paste at least one source link.",
      })
      return
    }

    if (links.length > MAX_LINKS) {
      toast.error("Too many links", {
        description: `Maximum ${MAX_LINKS} links per batch.`,
      })
      return
    }

    const invalid = links
      .map((link, index) => {
        const reason = validateLink(link)
        return reason ? `Line ${index + 1}: ${reason}` : null
      })
      .filter((value): value is string => value !== null)

    if (invalid.length > 0) {
      toast.error("Invalid links detected", {
        description: invalid.slice(0, 2).join(" | "),
      })
      return
    }

    setIsSubmitting(true)
    const toastId = toast.loading("Submitting conversion batch...")

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ urls }),
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || `Request failed (${response.status})`)
      }

      const blob = await response.blob()
      if (blob.size < 1) {
        throw new Error("Empty download returned from server")
      }

      const fileName = getDownloadName(response.headers.get("content-disposition"))
      const downloadUrl = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = downloadUrl
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(downloadUrl)

      toast.success("Download started", {
        id: toastId,
        description: `${links.length} link(s) submitted.`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Conversion failed"
      toast.error("Conversion failed", {
        id: toastId,
        description: message,
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-4xl items-center px-4 py-10">
      <div className="grid w-full gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Option 1: client-side userscript</CardTitle>
            <CardDescription>Recommended for high traffic and zero server conversion cost.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-1 pl-4">
              <li>Install Tampermonkey.</li>
              <li>Install the userscript from the link below.</li>
              <li>Open HMU FullBookReader and run Batch to ZIP.</li>
            </ol>

            <Button
              type="button"
              onClick={() => {
                window.open(USERSCRIPT_URL, "_blank", "noopener,noreferrer")
              }}
            >
              Install userscript
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Option 2: cloud API</CardTitle>
            <CardDescription>Rate-limited server conversion for users who skip userscript setup.</CardDescription>
          </CardHeader>

          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <Label htmlFor="urls">URLs</Label>
                <Textarea
                  id="urls"
                  name="urls"
                  rows={10}
                  placeholder="One FullBookReader URL per line"
                  value={urls}
                  onChange={(event) => setUrls(event.target.value)}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">Max {MAX_LINKS} links per request.</p>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Converting..." : "Convert with API"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
