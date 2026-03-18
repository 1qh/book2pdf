// ==UserScript==
// @name         HMU FullBookReader Batch to ZIP (Client-side)
// @namespace    https://github.com/1qh/book2pdf
// @version      1.1.0
// @description  Convert multiple FullBookReader links to PDFs and download one ZIP on the user device.
// @match        https://thuvien.hmu.edu.vn/pages/cms/FullBookReader.aspx*
// @grant        GM_registerMenuCommand
// @connect      thuvien.hmu.edu.vn
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(() => {
  "use strict"

  const MAX_URLS = 8
  const RETRIES = 3
  const REQUEST_TIMEOUT_MS = 30000

  const notify = (message, type = "info") => {
    const bg = type === "error" ? "#dc2626" : type === "success" ? "#16a34a" : "#111827"
    const el = document.createElement("div")
    el.textContent = message
    el.style.position = "fixed"
    el.style.top = "12px"
    el.style.right = "12px"
    el.style.zIndex = "2147483647"
    el.style.padding = "10px 12px"
    el.style.borderRadius = "8px"
    el.style.color = "#fff"
    el.style.background = bg
    el.style.font = "500 13px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"
    el.style.boxShadow = "0 8px 20px rgba(0,0,0,0.2)"
    document.body.appendChild(el)
    setTimeout(() => {
      el.remove()
    }, 2800)
  }

  const qsIgnoreCase = (params, key) => {
    const target = String(key).toLowerCase()
    for (const [name, value] of params.entries()) {
      if (String(name).toLowerCase() === target) {
        return value
      }
    }
    return null
  }

  const sanitizeName = (value) => {
    const cleaned = String(value).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "")
    return cleaned || "book"
  }

  const deriveBookId = (imageBasePath) => {
    const parts = String(imageBasePath)
      .split("/")
      .filter((part) => part.length > 0)

    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]?.toLowerCase() === "books" && parts[index + 1]) {
        return sanitizeName(parts[index + 1])
      }
    }

    if (parts.length >= 2 && parts[parts.length - 2]) {
      return sanitizeName(parts[parts.length - 2])
    }

    return sanitizeName(parts[parts.length - 1] || "book")
  }

  const parseInputUrls = (raw) => {
    const lines = String(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))

    const dedup = []
    const seen = new Set()

    for (const line of lines) {
      if (!seen.has(line)) {
        seen.add(line)
        dedup.push(line)
      }
    }

    return dedup
  }

  const validateReaderUrl = (text) => {
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return "Invalid URL"
    }

    if (parsed.origin !== "https://thuvien.hmu.edu.vn") {
      return "Only thuvien.hmu.edu.vn is supported"
    }

    if (!parsed.pathname.toLowerCase().includes("/pages/cms/fullbookreader.aspx")) {
      return "Must be FullBookReader.aspx link"
    }

    if (!qsIgnoreCase(parsed.searchParams, "url")) {
      return "Missing Url parameter"
    }

    return null
  }

  const delay = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })

  const fetchWithTimeout = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        credentials: "include",
        cache: "no-store",
      })
    } finally {
      clearTimeout(timer)
    }
  }

  const isJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

  const isPng = (bytes) =>
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a

  const normalizeToAbsolute = (value, siteBase) => {
    if (!value) {
      return value
    }
    if (/^https?:\/\//i.test(value)) {
      return value
    }
    if (value.startsWith("/")) {
      return `${siteBase}${value}`
    }
    return `${siteBase}/${value}`
  }

  const parseDiscovery = (html, siteBase) => {
    const totalMatch = html.match(/br\.numLeafs\s*=\s*(\d+)/)
    const leafMatch = html.match(/var\s+leafStr\s*=\s*'([0]+)'/)
    const varTemplate = html.match(
      /var\s+url\s*=\s*['"]([^'"]+)['"]\s*\+\s*leafStr\.replace\(\s*re\s*,\s*imgStr\s*\)\s*\+\s*['"]([^'"]*)['"]/i
    )
    const returnTemplate = html.match(
      /return\s+['"]([^'"]+)['"]\s*\+\s*leafStr\.replace\(\s*re\s*,\s*imgStr\s*\)\s*\+\s*['"]([^'"]*)['"]/i
    )

    const template = varTemplate || returnTemplate

    let pagePrefix = null
    let pageSuffix = null
    let ext = null

    if (template?.[1] !== undefined && template?.[2] !== undefined) {
      pagePrefix = normalizeToAbsolute(template[1], siteBase)
      pageSuffix = template[2]
      const extMatch = pageSuffix.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/)
      ext = extMatch?.[1]?.toLowerCase() || null
    }

    let pageOffset = 0
    if (/imgStr\s*=\s*index\s*\.toString\(\)/i.test(html)) {
      pageOffset = -1
    }

    const totalPages = totalMatch?.[1] ? Number.parseInt(totalMatch[1], 10) : null
    const padWidth = leafMatch?.[1] ? leafMatch[1].length : null

    return {
      totalPages,
      padWidth,
      pagePrefix,
      pageSuffix,
      ext,
      pageOffset,
    }
  }

  const buildImageUrl = (spec, pageNumber) => {
    const numericPage = pageNumber + spec.pageOffset
    if (numericPage < 0) {
      throw new Error("Invalid page index")
    }

    const token = spec.padWidth > 0 ? String(numericPage).padStart(spec.padWidth, "0") : String(numericPage)

    if (spec.pagePrefix && spec.pageSuffix !== null) {
      return `${spec.pagePrefix}${token}${spec.pageSuffix}`
    }

    const base = String(spec.imageBasePath || "").replace(/\/+$/, "")
    if (/^https?:\/\//i.test(base)) {
      return `${base}/${token}.${spec.ext}`
    }
    if (base.startsWith("/")) {
      return `${spec.siteBase}${base}/${token}.${spec.ext}`
    }
    return `${spec.siteBase}/${base}/${token}.${spec.ext}`
  }

  const probePattern = async (baseSpec) => {
    const extCandidates = Array.from(new Set([baseSpec.ext, "jpg", "jpeg", "png"].filter(Boolean)))
    const padCandidates = Array.from(new Set([baseSpec.padWidth, 6, 5, 4, 3, 2, 1, 0].filter((v) => v !== null)))
    const offsetCandidates = Array.from(new Set([baseSpec.pageOffset, 0, -1]))

    const candidateSpecs = []

    if (baseSpec.pagePrefix && baseSpec.pageSuffix !== null) {
      for (const pageOffset of offsetCandidates) {
        for (const padWidth of padCandidates) {
          candidateSpecs.push({
            ...baseSpec,
            pageOffset,
            padWidth,
          })
        }
      }
    }

    for (const ext of extCandidates) {
      for (const pageOffset of offsetCandidates) {
        for (const padWidth of padCandidates) {
          candidateSpecs.push({
            ...baseSpec,
            ext,
            pageOffset,
            padWidth,
            pagePrefix: null,
            pageSuffix: null,
          })
        }
      }
    }

    for (const spec of candidateSpecs) {
      try {
        const response = await fetchWithTimeout(buildImageUrl(spec, 1))
        if (!response.ok) {
          continue
        }

        const bytes = new Uint8Array(await response.arrayBuffer())
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        const isImageType = contentType.startsWith("image/")

        if (bytes.length > 0 && (isImageType || isJpeg(bytes) || isPng(bytes))) {
          return spec
        }
      } catch {
      }
    }

    throw new Error("Cannot determine image URL pattern for this book")
  }

  const parseSpec = async (readerUrl) => {
    const parsed = new URL(readerUrl)
    const queryImageBasePath = decodeURIComponent(qsIgnoreCase(parsed.searchParams, "url") || "").trim()
    const queryTotalPages = Number.parseInt((qsIgnoreCase(parsed.searchParams, "totalpage") || "").trim(), 10)
    const queryExt = ((qsIgnoreCase(parsed.searchParams, "ext") || "jpg").trim().toLowerCase().replace(/^\./, "") || "jpg")
    const siteBase = `${parsed.protocol}//${parsed.host}`

    let html = ""
    try {
      const response = await fetchWithTimeout(readerUrl)
      if (response.ok) {
        html = await response.text()
      }
    } catch {
    }

    const discovered = html ? parseDiscovery(html, siteBase) : null

    const totalPages =
      discovered?.totalPages && Number.isFinite(discovered.totalPages) && discovered.totalPages > 0
        ? discovered.totalPages
        : Number.isFinite(queryTotalPages) && queryTotalPages > 0
          ? queryTotalPages
          : 0

    if (!totalPages) {
      throw new Error("Invalid TotalPage")
    }

    const imageBasePath = queryImageBasePath
    const pagePrefix = discovered?.pagePrefix || null
    const pageSuffix = discovered?.pageSuffix || null

    if (!imageBasePath && !pagePrefix) {
      throw new Error("Missing Url parameter")
    }

    const baseSpec = {
      readerUrl,
      siteBase,
      imageBasePath,
      totalPages,
      ext: discovered?.ext || queryExt,
      padWidth: discovered?.padWidth ?? 6,
      pageOffset: discovered?.pageOffset ?? 0,
      pagePrefix,
      pageSuffix,
      bookId: deriveBookId(imageBasePath || pagePrefix || readerUrl),
    }

    return probePattern(baseSpec)
  }

  const downloadPageWithRetry = async (spec, pageNumber) => {
    let lastError = new Error("Page download failed")

    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        const response = await fetchWithTimeout(buildImageUrl(spec, pageNumber))

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!bytes.length) {
          throw new Error("Empty image payload")
        }

        return bytes
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < RETRIES) {
          await delay(Math.min(1200 * attempt, 4000))
        }
      }
    }

    throw lastError
  }

  const embedImage = async (pdfDoc, bytes) => {
    if (isJpeg(bytes)) {
      return pdfDoc.embedJpg(bytes)
    }
    if (isPng(bytes)) {
      return pdfDoc.embedPng(bytes)
    }
    throw new Error("Unsupported image bytes")
  }

  const convertBookToPdf = async (spec, onProgress) => {
    const pdfDoc = await PDFLib.PDFDocument.create()
    const failedPages = []
    let successPages = 0

    for (let page = 1; page <= spec.totalPages; page += 1) {
      try {
        const bytes = await downloadPageWithRetry(spec, page)
        const image = await embedImage(pdfDoc, bytes)
        const pdfPage = pdfDoc.addPage([image.width, image.height])
        pdfPage.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        })
        successPages += 1
      } catch {
        failedPages.push(page)
      }

      onProgress(page, spec.totalPages)
    }

    if (successPages === 0) {
      throw new Error("No pages could be downloaded")
    }

    return {
      pdfBytes: await pdfDoc.save(),
      failedPages,
      successPages,
    }
  }

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const nowStamp = () => {
    const d = new Date()
    const yyyy = String(d.getFullYear())
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const dd = String(d.getDate()).padStart(2, "0")
    const hh = String(d.getHours()).padStart(2, "0")
    const min = String(d.getMinutes()).padStart(2, "0")
    const sec = String(d.getSeconds()).padStart(2, "0")
    return `${yyyy}${mm}${dd}_${hh}${min}${sec}`
  }

  const createModal = () => {
    const overlay = document.createElement("div")
    overlay.style.position = "fixed"
    overlay.style.inset = "0"
    overlay.style.background = "rgba(15,23,42,0.45)"
    overlay.style.zIndex = "2147483646"
    overlay.style.display = "grid"
    overlay.style.placeItems = "center"

    const panel = document.createElement("div")
    panel.style.width = "min(760px, calc(100vw - 24px))"
    panel.style.background = "#ffffff"
    panel.style.border = "1px solid #e5e7eb"
    panel.style.borderRadius = "12px"
    panel.style.padding = "14px"
    panel.style.boxShadow = "0 18px 40px rgba(0,0,0,0.2)"
    panel.style.fontFamily = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"

    const title = document.createElement("div")
    title.textContent = "Batch convert to ZIP"
    title.style.fontWeight = "600"
    title.style.fontSize = "16px"
    title.style.marginBottom = "8px"

    const hint = document.createElement("div")
    hint.textContent = "Paste one FullBookReader URL per line."
    hint.style.color = "#4b5563"
    hint.style.fontSize = "13px"
    hint.style.marginBottom = "8px"

    const textarea = document.createElement("textarea")
    textarea.rows = 10
    textarea.style.width = "100%"
    textarea.style.padding = "10px"
    textarea.style.border = "1px solid #d1d5db"
    textarea.style.borderRadius = "8px"
    textarea.style.fontFamily = "ui-monospace,SFMono-Regular,Menlo,monospace"
    textarea.style.fontSize = "12px"
    textarea.value = window.location.href

    const status = document.createElement("div")
    status.style.marginTop = "8px"
    status.style.fontSize = "13px"
    status.style.color = "#111827"
    status.textContent = "Ready"

    const progressWrap = document.createElement("div")
    progressWrap.style.marginTop = "8px"
    progressWrap.style.height = "8px"
    progressWrap.style.background = "#e5e7eb"
    progressWrap.style.borderRadius = "999px"
    progressWrap.style.overflow = "hidden"

    const progressBar = document.createElement("div")
    progressBar.style.height = "100%"
    progressBar.style.width = "0%"
    progressBar.style.background = "#2563eb"
    progressBar.style.transition = "width 0.12s ease"
    progressWrap.appendChild(progressBar)

    const row = document.createElement("div")
    row.style.display = "flex"
    row.style.justifyContent = "space-between"
    row.style.alignItems = "center"
    row.style.gap = "8px"
    row.style.marginTop = "10px"

    const limit = document.createElement("div")
    limit.style.fontSize = "12px"
    limit.style.color = "#6b7280"
    limit.textContent = `Max ${MAX_URLS} URLs / run`

    const buttons = document.createElement("div")
    buttons.style.display = "flex"
    buttons.style.gap = "8px"

    const closeButton = document.createElement("button")
    closeButton.type = "button"
    closeButton.textContent = "Close"
    closeButton.style.border = "1px solid #d1d5db"
    closeButton.style.background = "#fff"
    closeButton.style.color = "#111827"
    closeButton.style.borderRadius = "8px"
    closeButton.style.padding = "8px 12px"
    closeButton.style.cursor = "pointer"

    const runButton = document.createElement("button")
    runButton.type = "button"
    runButton.textContent = "Convert"
    runButton.style.border = "0"
    runButton.style.background = "#111827"
    runButton.style.color = "#fff"
    runButton.style.borderRadius = "8px"
    runButton.style.padding = "8px 12px"
    runButton.style.cursor = "pointer"

    buttons.appendChild(closeButton)
    buttons.appendChild(runButton)
    row.appendChild(limit)
    row.appendChild(buttons)

    panel.appendChild(title)
    panel.appendChild(hint)
    panel.appendChild(textarea)
    panel.appendChild(status)
    panel.appendChild(progressWrap)
    panel.appendChild(row)
    overlay.appendChild(panel)

    const setBusy = (busy) => {
      textarea.disabled = busy
      runButton.disabled = busy
      closeButton.disabled = busy
      runButton.style.opacity = busy ? "0.7" : "1"
    }

    const setStatus = (text) => {
      status.textContent = text
    }

    const setProgress = (percent) => {
      const value = Math.max(0, Math.min(100, percent))
      progressBar.style.width = `${value.toFixed(1)}%`
    }

    closeButton.addEventListener("click", () => {
      overlay.remove()
    })

    runButton.addEventListener("click", async () => {
      const urls = parseInputUrls(textarea.value)

      if (urls.length === 0) {
        notify("Paste at least one URL", "error")
        return
      }

      if (urls.length > MAX_URLS) {
        notify(`Too many URLs (max ${MAX_URLS})`, "error")
        return
      }

      const invalidRows = []
      for (let i = 0; i < urls.length; i += 1) {
        const reason = validateReaderUrl(urls[i])
        if (reason) {
          invalidRows.push(`Line ${i + 1}: ${reason}`)
        }
      }

      if (invalidRows.length > 0) {
        notify(invalidRows.slice(0, 2).join(" | "), "error")
        return
      }

      setBusy(true)
      setProgress(0)

      try {
        const zip = new JSZip()
        const failures = []
        const totalBooks = urls.length
        let convertedBooks = 0

        for (let index = 0; index < urls.length; index += 1) {
          const readerUrl = urls[index]
          setStatus(`Preparing ${index + 1}/${totalBooks}`)

          try {
            const spec = await parseSpec(readerUrl)
            setStatus(`Converting ${spec.bookId} (${spec.totalPages} pages)`)

            const result = await convertBookToPdf(spec, (page, totalPages) => {
              const localProgress = page / Math.max(1, totalPages)
              const overallProgress = ((index + localProgress) / totalBooks) * 100
              setProgress(overallProgress)
              setStatus(`Converting ${spec.bookId} page ${page}/${totalPages}`)
            })

            zip.file(`${spec.bookId}.pdf`, result.pdfBytes)
            convertedBooks += 1

            if (result.failedPages.length > 0) {
              failures.push(
                `${readerUrl}\n  -> Partial PDF. Missing pages: ${result.failedPages.slice(0, 30).join(",")}${result.failedPages.length > 30 ? "..." : ""}`
              )
            }

            setProgress(((index + 1) / totalBooks) * 100)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`${readerUrl}\n  -> ${message}`)
          }
        }

        if (convertedBooks === 0) {
          throw new Error("No PDFs were generated")
        }

        if (failures.length > 0) {
          zip.file("errors.txt", `${failures.join("\n\n")}\n`)
        }

        setStatus("Compressing ZIP...")
        const zipBlob = await zip.generateAsync(
          {
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
          },
          (meta) => {
            setProgress(meta.percent)
          }
        )

        downloadBlob(zipBlob, `hmu_pdfs_${nowStamp()}.zip`)
        notify("ZIP download started", "success")
        setStatus("Done")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(message, "error")
        setStatus("Failed")
      } finally {
        setBusy(false)
      }
    })

    document.body.appendChild(overlay)
  }

  const mountQuickButton = () => {
    if (document.getElementById("hmu-batch-pdf-btn")) {
      return
    }

    const button = document.createElement("button")
    button.id = "hmu-batch-pdf-btn"
    button.type = "button"
    button.textContent = "Batch to ZIP"
    button.style.position = "fixed"
    button.style.bottom = "14px"
    button.style.right = "14px"
    button.style.zIndex = "2147483645"
    button.style.padding = "10px 12px"
    button.style.border = "0"
    button.style.borderRadius = "999px"
    button.style.background = "#111827"
    button.style.color = "#fff"
    button.style.cursor = "pointer"
    button.style.font = "600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"
    button.style.boxShadow = "0 8px 20px rgba(0,0,0,0.2)"
    button.addEventListener("click", createModal)
    document.body.appendChild(button)
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("HMU Batch to ZIP", createModal)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountQuickButton)
  } else {
    mountQuickButton()
  }
})()
