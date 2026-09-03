"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageSizes, PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { Button, Input } from "@/components/ui";
import { loadPdfJs, toArrayBuffer } from "@/lib/pdfClient";
import { AnnotateModal } from "./AnnotateModal";
import { RedactModal } from "./RedactModal";
import { SignModal } from "./SignModal";
import { FillFormModal } from "./FillFormModal";
import { CropModal, ExtractTextModal, MetadataModal, PageNumbersModal, SplitModal, buildAndUpload } from "./ToolModals";

const MAX_HISTORY = 20;

type SimpleModal = "split" | "pageNumbers" | "metadata" | "crop" | "extractText" | "fillForm" | "sign" | null;

export function DocumentEditor({ documentId }: { documentId: string }) {
  const [docName, setDocName] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocument | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mergeInputRef = useRef<HTMLInputElement>(null);

  // Linear undo/redo over whole-document byte snapshots — PDFs from this app are small enough
  // (200MB upload cap, but real usage is far below that) that keeping a bounded number of full
  // copies around is simpler and safer than trying to diff/patch pdf-lib's internal object graph.
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [redoStack, setRedoStack] = useState<Uint8Array[]>([]);
  // Set right before a modal-driven tool (annotate/redact/sign/...) mutates pdfDoc directly, since
  // those tools apply their change deep inside their own component rather than through withDoc —
  // this is the "before" snapshot withDoc would otherwise have taken for us.
  const pendingSnapshot = useRef<Uint8Array | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const thumbRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [activeModal, setActiveModal] = useState<SimpleModal>(null);
  const [annotatePage, setAnnotatePage] = useState<number | null>(null);
  const [redactPage, setRedactPage] = useState<number | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[] | null>(null);
  const [searching, setSearching] = useState(false);

  const renderThumbnails = useCallback(async (doc: PDFDocument) => {
    setRendering(true);
    try {
      const bytes = await doc.save();
      const pdfjsLib = await loadPdfJs();
      const rendered = await pdfjsLib.getDocument({ data: toArrayBuffer(bytes) }).promise;
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
        setFolderId(meta.folderId ?? null);
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

  /** Every direct page-level mutation (rotate, delete, reorder, insert, duplicate, merge, bulk
   *  rotate, watermark) goes through here so undo/redo, the dirty flag, and thumbnail re-rendering
   *  all stay in one place instead of being repeated at each call site. */
  async function withDoc(mutate: (doc: PDFDocument) => void | Promise<void>) {
    if (!pdfDoc) return;
    const snapshot = await pdfDoc.save();
    await mutate(pdfDoc);
    setHistory((prev) => [...prev, snapshot].slice(-MAX_HISTORY));
    setRedoStack([]);
    setDirty(true);
    await renderThumbnails(pdfDoc);
  }

  /** Tool modals (annotate/redact/sign/fill-form/page-numbers/metadata/crop) mutate the shared
   *  pdfDoc themselves before calling back — this pair stands in for withDoc's snapshot-then-mutate
   *  shape for that case: snapshot when the tool opens, commit it to history only if the tool was
   *  actually applied (onToolApplied fires on Apply, never on Cancel). */
  async function beginToolMutation() {
    if (pdfDoc) pendingSnapshot.current = await pdfDoc.save();
  }

  async function onToolApplied() {
    if (pendingSnapshot.current) {
      setHistory((prev) => [...prev, pendingSnapshot.current!].slice(-MAX_HISTORY));
      pendingSnapshot.current = null;
    }
    setRedoStack([]);
    setDirty(true);
    if (pdfDoc) await renderThumbnails(pdfDoc);
  }

  async function openTool(modal: Exclude<SimpleModal, null>) {
    await beginToolMutation();
    setActiveModal(modal);
  }

  async function openAnnotate(index: number) {
    await beginToolMutation();
    setAnnotatePage(index);
  }

  async function openRedact(index: number) {
    await beginToolMutation();
    setRedactPage(index);
  }

  async function undo() {
    if (!pdfDoc || history.length === 0) return;
    const currentBytes = await pdfDoc.save();
    const previous = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, currentBytes]);
    const restored = await PDFDocument.load(previous);
    setPdfDoc(restored);
    setDirty(true);
    await renderThumbnails(restored);
  }

  async function redo() {
    if (!pdfDoc || redoStack.length === 0) return;
    const currentBytes = await pdfDoc.save();
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setHistory((prev) => [...prev, currentBytes]);
    const restored = await PDFDocument.load(next);
    setPdfDoc(restored);
    setDirty(true);
    await renderThumbnails(restored);
  }

  function rotatePage(index: number, delta: number) {
    withDoc((doc) => {
      const page = doc.getPage(index);
      page.setRotation(degrees(page.getRotation().angle + delta));
    });
  }

  function rotateAll(delta: number) {
    withDoc((doc) => {
      for (const page of doc.getPages()) page.setRotation(degrees(page.getRotation().angle + delta));
    });
  }

  function deletePage(index: number) {
    if (thumbnails.length <= 1) {
      alert("A document needs at least one page.");
      return;
    }
    withDoc((doc) => doc.removePage(index));
  }

  function duplicatePage(index: number) {
    withDoc(async (doc) => {
      const [copy] = await doc.copyPages(doc, [index]);
      doc.insertPage(index + 1, copy);
    });
  }

  function insertBlankPage(afterIndex: number) {
    withDoc((doc) => {
      doc.insertPage(afterIndex + 1, PageSizes.A4);
    });
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

  function onDropPage(to: number) {
    if (draggedIndex === null || draggedIndex === to) {
      setDraggedIndex(null);
      return;
    }
    const from = draggedIndex;
    setDraggedIndex(null);
    withDoc((doc) => {
      const page = doc.getPage(from);
      doc.removePage(from);
      doc.insertPage(to, page);
    });
  }

  function toggleSelected(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleSelectMode() {
    setSelectMode((prev) => !prev);
    setSelected(new Set());
  }

  async function extractSelected() {
    if (!pdfDoc || selected.size === 0) return;
    setError(null);
    try {
      const indices = [...selected].sort((a, b) => a - b);
      const baseName = docName.replace(/\.pdf$/i, "");
      const created = await buildAndUpload(pdfDoc, indices, `${baseName} (extract).pdf`, folderId);
      setNotice(`Created "${created.name}" from ${indices.length} selected page${indices.length === 1 ? "" : "s"}.`);
      setSelectMode(false);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not extract the selected pages.");
    }
  }

  function deleteSelected() {
    if (selected.size === 0 || selected.size >= thumbnails.length) return;
    withDoc((doc) => {
      const indices = [...selected].sort((a, b) => b - a);
      for (const index of indices) doc.removePage(index);
    });
    setSelectMode(false);
    setSelected(new Set());
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

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!pdfDoc || !searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const bytes = await pdfDoc.save();
      const pdfjsLib = await loadPdfJs();
      const doc = await pdfjsLib.getDocument({ data: toArrayBuffer(bytes) }).promise;
      const query = searchQuery.trim().toLowerCase();
      const matches: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").toLowerCase();
        if (text.includes(query)) matches.push(i - 1);
      }
      setSearchResults(matches);
    } finally {
      setSearching(false);
    }
  }

  function jumpToPage(index: number) {
    thumbRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  async function printDoc() {
    if (!pdfDoc) return;
    const bytes = await pdfDoc.save();
    const blob = new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }

  if (loading) return <p className="text-sm text-slate">Loading…</p>;
  if (error && !pdfDoc) return <p className="text-sm text-brass">{error}</p>;

  return (
    <>
      <div className="no-print mb-6 border-b border-line pb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/documents" className="mb-1 block text-xs text-slate no-underline hover:text-signal-dim">
              ← Back to documents
            </Link>
            <h1 className="text-xl">{docName}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={undo} disabled={history.length === 0} title="Undo">
              ↶ Undo
            </Button>
            <Button variant="secondary" onClick={redo} disabled={redoStack.length === 0} title="Redo">
              ↷ Redo
            </Button>
            <Button variant="secondary" onClick={printDoc}>
              Print
            </Button>
            <Button variant="secondary" onClick={download}>
              Download
            </Button>
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => openTool("split")}>
            Split…
          </Button>
          <Button variant="secondary" onClick={() => mergeInputRef.current?.click()}>
            Merge PDF…
          </Button>
          <input ref={mergeInputRef} type="file" accept="application/pdf" className="hidden" onChange={mergeFile} />
          <Button variant="secondary" onClick={() => openTool("fillForm")}>
            Fill form…
          </Button>
          <Button variant="secondary" onClick={() => openTool("sign")}>
            Sign…
          </Button>
          <Button variant="secondary" onClick={addWatermark}>
            Watermark…
          </Button>
          <Button variant="secondary" onClick={() => openTool("pageNumbers")}>
            Page numbers…
          </Button>
          <Button variant="secondary" onClick={() => openTool("crop")}>
            Crop…
          </Button>
          <Button variant="secondary" onClick={() => openTool("metadata")}>
            Properties…
          </Button>
          <Button variant="secondary" onClick={() => openTool("extractText")}>
            Extract text…
          </Button>
          <Button variant="secondary" onClick={() => rotateAll(90)}>
            Rotate all ⟳
          </Button>
          <Button variant={selectMode ? "primary" : "secondary"} onClick={toggleSelectMode}>
            {selectMode ? "Cancel select" : "Select pages…"}
          </Button>
        </div>

        {selectMode && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-paper-dim p-2">
            <span className="text-xs text-slate">{selected.size} selected</span>
            <Button variant="secondary" onClick={extractSelected} disabled={selected.size === 0}>
              Extract to new document
            </Button>
            <Button variant="danger" onClick={deleteSelected} disabled={selected.size === 0 || selected.size >= thumbnails.length}>
              Delete selected
            </Button>
          </div>
        )}

        <form onSubmit={runSearch} className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="Search text in this document…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </Button>
          {searchResults && (
            <span className="text-xs text-slate">
              {searchResults.length === 0
                ? "No matches."
                : `Found on: ${searchResults
                    .map((i) => i + 1)
                    .join(", ")}`}
              {searchResults.length > 0 && (
                <span className="ml-1 space-x-1">
                  {searchResults.map((i) => (
                    <button key={i} type="button" className="text-signal-dim underline" onClick={() => jumpToPage(i)}>
                      p.{i + 1}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </form>
      </div>

      {notice && <p className="mb-4 text-sm text-signal-dim">{notice}</p>}
      {error && <p className="mb-4 text-sm text-brass">{error}</p>}
      {rendering && <p className="mb-4 text-xs text-slate">Rendering…</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {thumbnails.map((src, index) => (
          <div
            key={index}
            ref={(el) => {
              thumbRefs.current[index] = el;
            }}
            className="group relative"
            draggable={!selectMode}
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDropPage(index)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs from a canvas render, not an optimizable remote image */}
            <img src={src} alt={`Page ${index + 1}`} className="pdf-page w-full rounded" />
            <div className="mono absolute left-1 top-1 rounded bg-ink/70 px-1.5 py-0.5 text-[10px] text-paper">{index + 1}</div>

            {selectMode ? (
              <label className="absolute inset-0 flex cursor-pointer items-start justify-end p-2">
                <input type="checkbox" checked={selected.has(index)} onChange={() => toggleSelected(index)} className="h-5 w-5" />
              </label>
            ) : (
              <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-1 bg-ink/70 p-1 opacity-0 transition-opacity group-hover:opacity-100">
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
                <button className="mono text-xs text-paper hover:text-signal" title="Duplicate page" onClick={() => duplicatePage(index)}>
                  ⧉
                </button>
                <button className="mono text-xs text-paper hover:text-signal" title="Insert blank page after" onClick={() => insertBlankPage(index)}>
                  +
                </button>
                <button className="mono text-xs text-paper hover:text-signal" title="Annotate" onClick={() => openAnnotate(index)}>
                  ✎
                </button>
                <button className="mono text-xs text-paper hover:text-signal" title="Redact" onClick={() => openRedact(index)}>
                  ▮
                </button>
                <button className="mono text-xs text-paper hover:text-brass" title="Delete page" onClick={() => deletePage(index)}>
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <AnnotateModal
        open={annotatePage !== null}
        onClose={() => setAnnotatePage(null)}
        pdfDoc={pdfDoc}
        pageIndex={annotatePage ?? 0}
        onApplied={onToolApplied}
      />
      <RedactModal
        open={redactPage !== null}
        onClose={() => setRedactPage(null)}
        pdfDoc={pdfDoc}
        pageIndex={redactPage ?? 0}
        onApplied={onToolApplied}
      />
      <SignModal
        open={activeModal === "sign"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <FillFormModal open={activeModal === "fillForm"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} onApplied={onToolApplied} />
      <PageNumbersModal open={activeModal === "pageNumbers"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} onApplied={onToolApplied} />
      <MetadataModal open={activeModal === "metadata"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} onApplied={onToolApplied} />
      <CropModal open={activeModal === "crop"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} onApplied={onToolApplied} />
      <ExtractTextModal open={activeModal === "extractText"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} docName={docName} />
      <SplitModal
        open={activeModal === "split"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("Split complete.")}
      />
    </>
  );
}
