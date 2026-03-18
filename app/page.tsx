"use client";

import { FormEvent, useState } from "react";

export default function HomePage() {
  const [urls, setUrls] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("");

  function onSubmit(_: FormEvent<HTMLFormElement>): void {
    setIsSubmitting(true);
    setStatus("Started. Keep this tab open until the ZIP download is complete.");
  }

  function onTextChange(value: string): void {
    setUrls(value);
    if (isSubmitting) {
      setIsSubmitting(false);
      setStatus("");
    }
  }

  return (
    <main className="page-wrap">
      <section className="panel">
        <h1>HMU FullBookReader to ZIP(PDF)</h1>
        <p>
          Paste one URL per line and click once. The server converts each book and your browser downloads a ZIP file.
        </p>

        <form className="form-grid" method="post" action="/api/convert" target="download-target" onSubmit={onSubmit}>
          <textarea
            name="urls"
            value={urls}
            onChange={(event) => onTextChange(event.target.value)}
            spellCheck={false}
            placeholder="Paste one FullBookReader URL per line"
            required
          />

          <div className="action-row">
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Preparing download..." : "Convert and Download ZIP"}
            </button>
            <span>Limits: up to 8 URLs/request, up to 2200 pages total.</span>
          </div>

          <div className="status">{status}</div>
        </form>

        <iframe name="download-target" className="download-frame" title="download" />
      </section>
    </main>
  );
}
