"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { Button } from "@/components/ui";

// pdf.js needs its worker script as a separate asset — this `new URL(..., import.meta.url)` form
// is what lets Next's bundler emit and resolve that asset correctly for both dev and the
// standalone production build, rather than pointing at a CDN or hand-copying the file into public/.
// pdf-lib's PDFDocument.save() returns a Uint8Array typed as Uint8Array<ArrayBufferLike> — Blob
// only accepts a plain ArrayBuffer-backed view, so this copies out a fresh ArrayBuffer to satisfy
// that (SharedArrayBuffer, which ArrayBufferLike also covers, could never actually appear here).
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function loadPdfJs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  return pdfjsLib;
}

export function DocumentEditor({ documentId }: { documentId: string }) {
  const [docName, setDocName] = useState("");
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mergeInputRef = useRef<HTMLInputElement>(null);

  const renderThumbnails = useCallback(async (doc: PDFDocument) => {
    setRendering(true);
    try {
      const bytes = await doc.save();
      const pdfjsLib = await loadPdfJs();
      const rendered = await pdfjsLib.getDocument({ data: bytes }).promise;
      const urls: string[] = [];
      for (let i = 1; i <= rendered.numPages; i++) {
        const page = await rendered.getPage(i);
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        await page.render({ canvasContext: context, viewport, canvas }).promise;
        urls.push(canvas.toDataURL());
      }
      setThumbnails(urls);
    } finally {
      setRendering(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [metaResponse, contentResponse] = await Promise.all([
          fetch(`/api/backend/documents/${documentId}`),
          fetch(`/api/documents/${documentId}/content`),
        ]);
        if (!metaResponse.ok || !contentResponse.ok) throw new Error("Could not load that document.");
        const meta = await metaResponse.json();
        const bytes = await contentResponse.arrayBuffer();
        const doc = await PDFDocument.load(bytes);
        if (cancelled) return;
        setDocName(meta.name);
        setPdfDoc(doc);
        await renderThumbnails(doc);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load that document.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [documentId, renderThumbnails]);

  async function withDoc(mutate: (doc: PDFDocument) => void | Promise<void>) {
    if (!pdfDoc) return;
    await mutate(pdfDoc);
    setDirty(true);
    await renderThumbnails(pdfDoc);
  }

  function rotatePage(index: number, delta: number) {
    withDoc((doc) => {
      const page = doc.getPage(index);
      page.setRotation(degrees(page.getRotation().angle + delta));
    });
  }

  function deletePage(index: number) {
    if (thumbnails.length <= 1) {
      alert("A document needs at least one page.");
      return;
    }
    withDoc((doc) => doc.removePage(index));
  }

  function movePage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= thumbnails.length) return;
    withDoc((doc) => {
      const page = doc.getPage(index);
      doc.removePage(index);
      doc.insertPage(target, page);
    });
  }

  async function addWatermark() {
    const text = window.prompt("Watermark text");
    if (!text) return;
    await withDoc(async (doc) => {
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        page.drawText(text, {
          x: width / 2 - (text.length * 12) / 2,
          y: height / 2,
          size: 48,
          font,
          color: rgb(0.7, 0.7, 0.7),
          opacity: 0.35,
          rotate: degrees(45),
        });
      }
    });
  }

  async function mergeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const bytes = await file.arrayBuffer();
    await withDoc(async (doc) => {
      const otherDoc = await PDFDocument.load(bytes);
      const copiedPages = await doc.copyPages(otherDoc, otherDoc.getPageIndices());
      copiedPages.forEach((page) => doc.addPage(page));
    });
  }

  async function save() {
    if (!pdfDoc) return;
    setSaving(true);
    setError(null);
    try {
      const bytes = await pdfDoc.save();
      const form = new FormData();
      form.append("file", new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), `${docName || "document"}.pdf`);
      const response = await fetch(`/api/documents/${documentId}/content`, { method: "PUT", body: form });
      if (!response.ok) throw new Error("Could not save your changes.");
      await fetch(`/api/backend/documents/${documentId}/page-count`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pdfDoc.getPageCount()),
      });
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your changes.");
    } finally {
      setSaving(false);
    }
  }

  async function download() {
    if (!pdfDoc) return;
    const bytes = await pdfDoc.save();
    const blob = new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docName || "document"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p className="text-sm text-slate">Loading…</p>;
  if (error && !pdfDoc) return <p className="text-sm text-brass">{error}</p>;

  return (
    <>
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div>
          <Link href="/documents" className="mb-1 block text-xs text-slate no-underline hover:text-signal-dim">
            ← Back to documents
          </Link>
          <h1 className="text-xl">{docName}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={addWatermark}>
            Add watermark
          </Button>
          <Button variant="secondary" onClick={() => mergeInputRef.current?.click()}>
            Merge PDF…
          </Button>
          <input ref={mergeInputRef} type="file" accept="application/pdf" className="hidden" onChange={mergeFile} />
          <Button variant="secondary" onClick={download}>
            Download
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-brass">{error}</p>}
      {rendering && <p className="mb-4 text-xs text-slate">Rendering…</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {thumbnails.map((src, index) => (
          <div key={index} className="group relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs from a canvas render, not an optimizable remote image */}
            <img src={src} alt={`Page ${index + 1}`} className="pdf-page w-full rounded" />
            <div className="mono absolute left-1 top-1 rounded bg-ink/70 px-1.5 py-0.5 text-[10px] text-paper">{index + 1}</div>
            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-ink/70 p-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button className="mono text-xs text-paper hover:text-signal" title="Rotate left" onClick={() => rotatePage(index, -90)}>
                ⟲
              </button>
              <button className="mono text-xs text-paper hover:text-signal" title="Rotate right" onClick={() => rotatePage(index, 90)}>
                ⟳
              </button>
              <button className="mono text-xs text-paper hover:text-signal" title="Move earlier" onClick={() => movePage(index, -1)}>
                ←
              </button>
              <button className="mono text-xs text-paper hover:text-signal" title="Move later" onClick={() => movePage(index, 1)}>
                →
              </button>
              <button className="mono text-xs text-paper hover:text-brass" title="Delete page" onClick={() => deletePage(index)}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
