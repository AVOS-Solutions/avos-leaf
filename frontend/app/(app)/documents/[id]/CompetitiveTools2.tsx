"use client";

import { useEffect, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, PageSizes, StandardFonts, decodePDFRawStream, degrees, rgb } from "pdf-lib";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { renderPageToCanvas, toArrayBuffer } from "@/lib/pdfClient";
import { parsePageRanges } from "./ToolModals";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Uploads a PDFDocument that was assembled from scratch (as opposed to buildAndUpload in
 *  ToolModals.tsx, which only ever copies a page range out of one existing document) — used by the
 *  N-up and contact-sheet tools, both of which compose brand-new pages rather than copying old ones. */
async function uploadBuiltDoc(doc: PDFDocument, name: string, folderId: string | null) {
  const bytes = await doc.save();
  const form = new FormData();
  form.append("file", new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), name);
  if (folderId) form.append("folderId", folderId);
  const response = await fetch("/api/documents/upload", { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `Could not create "${name}".`);
  return body as { id: string; name: string };
}

/** A permutation parser for the reorder tool: unlike ToolModals.tsx's parsePageRanges (which sorts
 *  and de-duplicates — right for "pick a subset"), this preserves the order the user typed and
 *  requires every page to appear exactly once, since the result becomes the document's new order. */
function parsePageOrder(input: string, pageCount: number): number[] {
  const order: number[] = [];
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Enter the new page order, e.g. 3,1,2,4-6.");
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (a < 1 || a > pageCount || b < 1 || b > pageCount) throw new Error(`"${part}" is out of range for this ${pageCount}-page document.`);
      if (a <= b) for (let i = a; i <= b; i++) order.push(i - 1);
      else for (let i = a; i >= b; i--) order.push(i - 1);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > pageCount) throw new Error(`"${part}" is not a valid page number.`);
    order.push(n - 1);
  }
  const uniqueSorted = [...new Set(order)].sort((a, b) => a - b);
  if (order.length !== pageCount || uniqueSorted.length !== pageCount) {
    throw new Error(`The new order must list all ${pageCount} pages, each exactly once.`);
  }
  return order;
}

const POSITIONS = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "middle-left": "Middle left",
  "middle-center": "Middle center",
  "middle-right": "Middle right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
} as const;
type Position = keyof typeof POSITIONS;

function anchorPoint(position: Position, pageWidth: number, pageHeight: number, boxWidth: number, boxHeight: number, margin: number) {
  const [vert, horiz] = position.split("-") as ["top" | "middle" | "bottom", "left" | "center" | "right"];
  const x = horiz === "left" ? margin : horiz === "right" ? pageWidth - margin - boxWidth : (pageWidth - boxWidth) / 2;
  const y = vert === "bottom" ? margin : vert === "top" ? pageHeight - margin - boxHeight : (pageHeight - boxHeight) / 2;
  return { x, y };
}

// -------------------------------------------------------------------------------------------
// Extract odd/even pages: the classic duplex-scanning workaround — a single-sided scanner feeds
// front sides then back sides as two separate passes, so users need those recombined pages split
// back into an odd-pages document and an even-pages document. Read-only, like SplitModal: builds
// two new documents through the normal upload endpoint rather than touching the open one.

export function OddEvenModal({
  open,
  onClose,
  pdfDoc,
  docName,
  folderId,
  pageCount,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
  folderId: string | null;
  pageCount: number;
  onCreated: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setCreated([]);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const { buildAndUpload } = await import("./ToolModals");
      const baseName = docName.replace(/\.pdf$/i, "");
      const odd = Array.from({ length: Math.ceil(pageCount / 2) }, (_, i) => i * 2);
      const even = Array.from({ length: Math.floor(pageCount / 2) }, (_, i) => i * 2 + 1);
      const results = await Promise.all([
        buildAndUpload(pdfDoc, odd, `${baseName} (odd pages).pdf`, folderId),
        buildAndUpload(pdfDoc, even, `${baseName} (even pages).pdf`, folderId),
      ]);
      setCreated(results);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split this document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Extract odd/even pages">
      {created.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">Created {created.length} new documents:</p>
          <ul className="space-y-1 text-sm">
            {created.map((doc) => (
              <li key={doc.id}>
                <a className="text-signal-dim underline" href={`/documents/${doc.id}`}>
                  {doc.name}
                </a>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate">
            Splits this {pageCount}-page document into two new documents — one with every odd page, one with
            every even page. Handy for recombining a duplex scan done as two single-sided passes.
          </p>
          {error && <p className="text-sm text-brass">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={working}>
              {working ? "Splitting…" : "Split odd/even"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Flatten form fields: after filling a form with FillFormModal, "flatten" burns the entered values
// into the page content and removes the interactive widgets, so the result can't be accidentally
// edited or re-submitted — the same one-way operation Acrobat's own "Flatten" print option does.

export function FlattenFormModal({
  open,
  onClose,
  pdfDoc,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const form = pdfDoc.getForm();
      if (form.getFields().length === 0) {
        setError("This document doesn't have any fillable form fields.");
        return;
      }
      form.flatten();
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not flatten this document's form fields.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Flatten form fields">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Bakes every filled-in form field&apos;s current value directly into the page and removes the interactive
          widget, so the result can no longer be edited or re-submitted as a form. This can&apos;t be undone by
          re-opening the form fields — only by the Undo button.
        </p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Flattening…" : "Flatten form fields"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Remove annotations: strips every comment/markup/sticky-note left by AnnotateModal (or by any
// other PDF tool) from every page at once, distinct from redaction — this only removes the
// separate Annots layer, it never touches the page's own drawn content.

export function RemoveAnnotationsModal({
  open,
  onClose,
  pdfDoc,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      let count = 0;
      for (const page of pdfDoc.getPages()) {
        if (page.node.lookup(PDFName.of("Annots"))) {
          page.node.delete(PDFName.of("Annots"));
          count += 1;
        }
      }
      if (count === 0) {
        setError("No annotations, comments, or markup found on any page.");
        return;
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove annotations.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Remove all annotations">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Removes every comment, sticky note, and markup from every page. This doesn&apos;t touch the page&apos;s
          own drawn content — use Redact for that.
        </p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Removing…" : "Remove annotations"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// N-up: lays 2 or 4 source pages onto each output sheet, using pdf-lib's embedPage/drawPage so the
// original vector content (text stays text) is reused rather than rasterized. Read-only — like
// Split, it builds and uploads a brand-new document rather than mutating the open one. Each source
// page is embedded individually (not via the batch embedPages) so one page with no drawable content
// (e.g. a truly blank page from Insert Blank Page) just leaves its grid cell empty instead of
// aborting the whole tool.

export function NUpModal({
  open,
  onClose,
  pdfDoc,
  docName,
  folderId,
  pageCount,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
  folderId: string | null;
  pageCount: number;
  onCreated: () => void;
}) {
  const [perSheet, setPerSheet] = useState<2 | 4>(2);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setCreated(null);
      setProgress(0);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const bytes = await pdfDoc.save();
      const srcDoc = await PDFDoc.load(bytes);
      const newDoc = await PDFDoc.create();
      const cols = 2;
      const rows = perSheet === 2 ? 1 : 2;
      const [sheetW, sheetH] = perSheet === 2 ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
      const cellW = sheetW / cols;
      const cellH = sheetH / rows;
      const margin = 10;

      const srcPages = srcDoc.getPages();
      for (let start = 0; start < srcPages.length; start += perSheet) {
        const sheet = newDoc.addPage([sheetW, sheetH]);
        for (let slot = 0; slot < perSheet && start + slot < srcPages.length; slot++) {
          let embedded;
          try {
            embedded = await newDoc.embedPage(srcPages[start + slot]);
          } catch {
            continue; // no drawable content on this source page — leave the cell blank
          }
          const col = slot % cols;
          const row = Math.floor(slot / cols);
          const availW = cellW - margin * 2;
          const availH = cellH - margin * 2;
          const scale = Math.min(availW / embedded.width, availH / embedded.height);
          const w = embedded.width * scale;
          const h = embedded.height * scale;
          const x = col * cellW + (cellW - w) / 2;
          const y = sheetH - (row + 1) * cellH + (cellH - h) / 2;
          sheet.drawPage(embedded, { x, y, width: w, height: h });
        }
        setProgress(Math.min(start + perSheet, srcPages.length));
      }

      const baseName = docName.replace(/\.pdf$/i, "");
      const result = await uploadBuiltDoc(newDoc, `${baseName} (${perSheet}-up).pdf`, folderId);
      setCreated(result);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the N-up layout.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Multiple pages per sheet (N-up)">
      {created ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Created{" "}
            <a className="text-signal-dim underline" href={`/documents/${created.id}`}>
              {created.name}
            </a>
            .
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate">
            Creates a new document with {perSheet} of this document&apos;s pages arranged on each sheet — useful
            for printing handouts or drafts on fewer pages of paper. The original document is untouched.
          </p>
          <div>
            <Label htmlFor="nup-per-sheet">Pages per sheet</Label>
            <Select id="nup-per-sheet" value={perSheet} onChange={(e) => setPerSheet(Number(e.target.value) as 2 | 4)}>
              <option value={2}>2</option>
              <option value={4}>4</option>
            </Select>
          </div>
          {working && <p className="text-xs text-slate">Laid out {progress} of {pageCount} pages…</p>}
          {error && <p className="text-sm text-brass">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={working}>
              {working ? "Building…" : "Create"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Compress: rasterizes every page to a JPEG at a chosen quality/resolution and rebuilds the
// document from those images — the standard lossy trick for shrinking a PDF full of high-resolution
// scans or photos. Mutates the open document in place (like the other page-replacing tools), and
// reports the before/after size since that's the entire point of running it.

const COMPRESS_PRESETS = {
  high: { label: "High compression (smaller file, lower quality)", scale: 1, quality: 0.5 },
  balanced: { label: "Balanced", scale: 1.5, quality: 0.7 },
  low: { label: "Low compression (larger file, better quality)", scale: 2, quality: 0.85 },
} as const;
type CompressLevel = keyof typeof COMPRESS_PRESETS;

export function CompressModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [level, setLevel] = useState<CompressLevel>("balanced");
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ before: number; after: number } | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setResult(null);
      setProgress(0);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const preset = COMPRESS_PRESETS[level];
      const bytes = await pdfDoc.save();
      const before = bytes.byteLength;
      for (let i = 0; i < pageCount; i++) {
        const { width, height } = pdfDoc.getPage(i).getSize();
        const { canvas } = await renderPageToCanvas(bytes, i + 1, preset.scale);
        const jpgBytes = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob(
            async (blob) => {
              if (!blob) return reject(new Error("Could not compress a page."));
              resolve(new Uint8Array(await blob.arrayBuffer()));
            },
            "image/jpeg",
            preset.quality,
          );
        });
        const image = await pdfDoc.embedJpg(jpgBytes);
        pdfDoc.removePage(i);
        const newPage = pdfDoc.insertPage(i, [width, height]);
        newPage.drawImage(image, { x: 0, y: 0, width, height });
        setProgress(i + 1);
      }
      const afterBytes = await pdfDoc.save();
      setResult({ before, after: afterBytes.byteLength });
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compress this document.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Compress PDF">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Redraws every page as a flattened image at the chosen quality — text is no longer selectable
          afterward. Best for documents made up of scans or photos rather than typed text.
        </p>
        {result ? (
          <p className="text-sm text-ink">
            {formatBytes(result.before)} → {formatBytes(result.after)}
            {result.after < result.before ? ` (${Math.round((1 - result.after / result.before) * 100)}% smaller)` : ""}
          </p>
        ) : (
          <div>
            <Label htmlFor="compress-level">Compression level</Label>
            <Select id="compress-level" value={level} onChange={(e) => setLevel(e.target.value as CompressLevel)}>
              {Object.entries(COMPRESS_PRESETS).map(([value, preset]) => (
                <option key={value} value={value}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        {applying && <p className="text-xs text-slate">Compressing page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button onClick={apply} disabled={applying}>
              {applying ? "Compressing…" : "Compress"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Grayscale: same page-replacement mechanics as Compress, but desaturates via canvas pixel data and
// re-embeds as PNG (not JPEG) to keep the tool lossless-in-color-terms rather than compounding two
// kinds of lossy conversion into one button.

export function GrayscaleModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setProgress(0);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const bytes = await pdfDoc.save();
      for (let i = 0; i < pageCount; i++) {
        const { width, height } = pdfDoc.getPage(i).getSize();
        const { canvas } = await renderPageToCanvas(bytes, i + 1, 1.5);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not prepare a page for grayscale conversion.");
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let p = 0; p < data.length; p += 4) {
          const gray = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
          data[p] = gray;
          data[p + 1] = gray;
          data[p + 2] = gray;
        }
        ctx.putImageData(imageData, 0, 0);
        const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error("Could not convert a page to grayscale."));
            resolve(new Uint8Array(await blob.arrayBuffer()));
          }, "image/png");
        });
        const image = await pdfDoc.embedPng(pngBytes);
        pdfDoc.removePage(i);
        const newPage = pdfDoc.insertPage(i, [width, height]);
        newPage.drawImage(image, { x: 0, y: 0, width, height });
        setProgress(i + 1);
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not convert this document to grayscale.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Convert to grayscale">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Redraws every page in black and white — like Compress, text is flattened into an image and is no
          longer selectable afterward.
        </p>
        {applying && <p className="text-xs text-slate">Converting page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Converting…" : "Convert all pages"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Image watermark/stamp: the existing addWatermark() in DocumentEditor only ever stamps fixed
// diagonal text — this stamps an uploaded logo/image at a chosen corner, size, and opacity, on
// either every page or a chosen range, the way a company letterhead or "DRAFT" logo stamp works.

export function ImageWatermarkModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [position, setPosition] = useState<Position>("bottom-right");
  const [widthPct, setWidthPct] = useState(20);
  const [opacityPct, setOpacityPct] = useState(60);
  const [pageRange, setPageRange] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFile(null);
      setPageRange("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc || !file) return;
    setApplying(true);
    setError(null);
    try {
      const isPng = file.type === "image/png";
      const isJpeg = file.type === "image/jpeg" || file.type === "image/jpg";
      if (!isPng && !isJpeg) throw new Error("Choose a JPEG or PNG image.");
      const bytes = await file.arrayBuffer();
      const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      const indices = pageRange.trim() ? parsePageRanges(pageRange, pageCount) : Array.from({ length: pageCount }, (_, i) => i);
      const margin = 24;
      for (const i of indices) {
        const page = pdfDoc.getPage(i);
        const { width: pageWidth, height: pageHeight } = page.getSize();
        const w = pageWidth * (widthPct / 100);
        const h = w * (image.height / image.width);
        const { x, y } = anchorPoint(position, pageWidth, pageHeight, w, h, margin);
        page.drawImage(image, { x, y, width: w, height: h, opacity: opacityPct / 100 });
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this image stamp.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Image watermark / stamp">
      <div className="space-y-4">
        <div>
          <Label>Image</Label>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink"
          />
        </div>
        <div>
          <Label htmlFor="stamp-position">Position</Label>
          <Select id="stamp-position" value={position} onChange={(e) => setPosition(e.target.value as Position)}>
            {Object.entries(POSITIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="stamp-width">Width (% of page)</Label>
            <Input id="stamp-width" type="number" min={1} max={100} value={widthPct} onChange={(e) => setWidthPct(Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="stamp-opacity">Opacity (%)</Label>
            <Input id="stamp-opacity" type="number" min={1} max={100} value={opacityPct} onChange={(e) => setOpacityPct(Number(e.target.value))} />
          </div>
        </div>
        <div>
          <Label htmlFor="stamp-range">Pages (optional)</Label>
          <Input id="stamp-range" placeholder="Leave blank for every page, e.g. 1-3, 5" value={pageRange} onChange={(e) => setPageRange(e.target.value)} />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || !file}>
            {applying ? "Adding…" : "Add stamp"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Bates numbering: the sequential, zero-padded identifier (e.g. ABC0000001) legal document
// production stamps on every page for citation — distinct from the generic page-numbers tool,
// which only ever shows "n of total" and resets with the document rather than continuing a
// firm-wide numbering scheme across many documents (hence the configurable starting number).

export function BatesNumberingModal({
  open,
  onClose,
  pdfDoc,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  onApplied: () => void;
}) {
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [startAt, setStartAt] = useState(1);
  const [digits, setDigits] = useState(6);
  const [position, setPosition] = useState<Position>("bottom-right");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const size = 9;
      const margin = 24;
      pdfDoc.getPages().forEach((page, index) => {
        const label = `${prefix}${String(startAt + index).padStart(Math.max(1, digits), "0")}${suffix}`;
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(label, size);
        const { x, y } = anchorPoint(position, width, height, textWidth, size, margin);
        page.drawText(label, { x, y, size, font, color: rgb(0.2, 0.2, 0.2) });
      });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add Bates numbering.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Bates numbering">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Stamps a sequential, zero-padded identifier on every page (e.g. {prefix || "ABC"}
          {String(startAt).padStart(Math.max(1, digits), "0")}
          {suffix}) — the citation numbering used in legal document production.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bates-prefix">Prefix</Label>
            <Input id="bates-prefix" placeholder="ABC" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bates-suffix">Suffix</Label>
            <Input id="bates-suffix" value={suffix} onChange={(e) => setSuffix(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bates-start">Start at</Label>
            <Input id="bates-start" type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="bates-digits">Digits</Label>
            <Input id="bates-digits" type="number" min={1} max={12} value={digits} onChange={(e) => setDigits(Number(e.target.value))} />
          </div>
        </div>
        <div>
          <Label htmlFor="bates-position">Position</Label>
          <Select id="bates-position" value={position} onChange={(e) => setPosition(e.target.value as Position)}>
            {Object.entries(POSITIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Stamping…" : "Add to every page"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Extract images: walks every page's XObject resources looking for embedded images, rather than
// rendering pages as images (that's Export as images). JPEG/JP2-encoded images (by far the common
// case for photos in real-world PDFs) are dumped as-is since the stream's raw bytes already are a
// complete image file; plain RGB/grayscale raster images are decoded and re-encoded as PNG.
// Anything else (CMYK, indexed palettes, chained filters, ICC profiles) is reported as skipped
// rather than guessed at, since getting a color transform wrong is worse than not extracting it.

type ExtractedImage = { bytes: Uint8Array; ext: "jpg" | "jp2" | "png" };

async function extractImagesFromDoc(doc: PDFDocument): Promise<{ images: ExtractedImage[]; skipped: number }> {
  const images: ExtractedImage[] = [];
  let skipped = 0;

  for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex++) {
    const page = doc.getPage(pageIndex);
    let xobjects: PDFDict;
    try {
      const resources = page.node.lookup(PDFName.of("Resources"), PDFDict);
      xobjects = resources.lookup(PDFName.of("XObject"), PDFDict);
    } catch {
      continue; // no images on this page
    }

    for (const key of xobjects.keys()) {
      try {
        const resolved = doc.context.lookup(xobjects.get(key), PDFStream);
        if (!(resolved instanceof PDFRawStream)) continue;
        const stream = resolved;
        const subtype = stream.dict.lookup(PDFName.of("Subtype"));
        if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;

        const filterObj = stream.dict.lookup(PDFName.of("Filter"));
        const filterName =
          filterObj instanceof PDFName
            ? filterObj.asString()
            : filterObj instanceof PDFArray && filterObj.size() === 1 && filterObj.get(0) instanceof PDFName
              ? (filterObj.get(0) as PDFName).asString()
              : null;

        if (filterName === "/DCTDecode") {
          images.push({ bytes: stream.contents, ext: "jpg" });
          continue;
        }
        if (filterName === "/JPXDecode") {
          images.push({ bytes: stream.contents, ext: "jp2" });
          continue;
        }
        if (filterName !== null && filterName !== "/FlateDecode") {
          skipped += 1;
          continue;
        }

        const widthObj = stream.dict.lookup(PDFName.of("Width"));
        const heightObj = stream.dict.lookup(PDFName.of("Height"));
        const bpcObj = stream.dict.lookup(PDFName.of("BitsPerComponent"));
        const csObj = stream.dict.lookup(PDFName.of("ColorSpace"));
        const width = widthObj instanceof PDFNumber ? widthObj.asNumber() : null;
        const height = heightObj instanceof PDFNumber ? heightObj.asNumber() : null;
        const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : null;
        const csName = csObj instanceof PDFName ? csObj.asString() : null;
        if (!width || !height || bpc !== 8 || (csName !== "/DeviceRGB" && csName !== "/DeviceGray")) {
          skipped += 1;
          continue;
        }

        const raw = decodePDFRawStream(stream).decode();
        const channels = csName === "/DeviceRGB" ? 3 : 1;
        if (raw.length !== width * height * channels) {
          skipped += 1;
          continue;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          skipped += 1;
          continue;
        }
        const imageData = ctx.createImageData(width, height);
        for (let p = 0; p < width * height; p++) {
          const r = raw[p * channels];
          const g = channels === 3 ? raw[p * channels + 1] : r;
          const b = channels === 3 ? raw[p * channels + 2] : r;
          imageData.data[p * 4] = r;
          imageData.data[p * 4 + 1] = g;
          imageData.data[p * 4 + 2] = b;
          imageData.data[p * 4 + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error("canvas export failed"));
            resolve(new Uint8Array(await blob.arrayBuffer()));
          }, "image/png");
        });
        images.push({ bytes: pngBytes, ext: "png" });
      } catch {
        skipped += 1;
      }
    }
  }

  return { images, skipped };
}

export function ExtractImagesModal({
  open,
  onClose,
  pdfDoc,
  docName,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; skipped: number } | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setResult(null);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const bytes = await pdfDoc.save();
      const doc = await PDFDoc.load(bytes);
      const { images, skipped } = await extractImagesFromDoc(doc);
      const baseName = docName.replace(/\.pdf$/i, "");
      if (images.length === 0) {
        setResult({ count: 0, skipped });
        return;
      }
      if (images.length === 1) {
        downloadBlob(new Blob([toArrayBuffer(images[0].bytes)]), `${baseName}-image-1.${images[0].ext}`);
      } else {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        images.forEach((img, i) => zip.file(`${baseName}-image-${i + 1}.${img.ext}`, img.bytes));
        const zipBlob = await zip.generateAsync({ type: "blob" });
        downloadBlob(zipBlob, `${baseName}-images.zip`);
      }
      setResult({ count: images.length, skipped });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not extract images from this document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Extract images">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Pulls the original embedded images out of this document (not a re-render of the page) and downloads
          them as-is. Photos are usually recovered exactly as embedded; a few unusual color encodings aren&apos;t
          supported and are reported as skipped rather than guessed at.
        </p>
        {result && (
          <p className="text-sm text-ink">
            {result.count === 0
              ? "No extractable images were found on any page."
              : `Downloaded ${result.count} image${result.count === 1 ? "" : "s"}.`}
            {result.skipped > 0 ? ` ${result.skipped} image${result.skipped === 1 ? "" : "s"} had an unsupported encoding and were skipped.` : ""}
          </p>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={run} disabled={working}>
            {working ? "Extracting…" : "Extract"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Rotate/Delete/Blackout by page range: the thumbnail grid's per-page buttons and select-mode
// already cover ad-hoc clicking, but a 200-page document is much faster to operate on by typing
// "1-3, 200" than by scrolling and clicking. All three reuse ToolModals.tsx's parsePageRanges.

export function RotateRangeModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [range, setRange] = useState("");
  const [delta, setDelta] = useState<90 | -90 | 180>(90);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setRange("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const indices = parsePageRanges(range, pageCount);
      for (const i of indices) {
        const page = pdfDoc.getPage(i);
        page.setRotation(degrees(page.getRotation().angle + delta));
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate those pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Rotate pages…">
      <div className="space-y-4">
        <div>
          <Label htmlFor="rotate-range">Pages</Label>
          <Input id="rotate-range" placeholder="e.g. 1-3, 5" value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="rotate-delta">Direction</Label>
          <Select id="rotate-delta" value={delta} onChange={(e) => setDelta(Number(e.target.value) as 90 | -90 | 180)}>
            <option value={90}>Rotate right 90°</option>
            <option value={-90}>Rotate left 90°</option>
            <option value={180}>Rotate 180°</option>
          </Select>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Rotating…" : "Rotate"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteRangeModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [range, setRange] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setRange("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const indices = parsePageRanges(range, pageCount);
      if (indices.length >= pageCount) throw new Error("A document needs at least one page — narrow the range.");
      [...indices].sort((a, b) => b - a).forEach((i) => pdfDoc.removePage(i));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete those pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete pages…">
      <div className="space-y-4">
        <p className="text-xs text-slate">Faster than clicking through the thumbnail grid on a long document.</p>
        <div>
          <Label htmlFor="delete-range">Pages to delete</Label>
          <Input id="delete-range" placeholder="e.g. 1-3, 5" value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function BlackoutPagesModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [range, setRange] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setRange("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const indices = parsePageRanges(range, pageCount);
      for (const i of indices) {
        const { width, height } = pdfDoc.getPage(i).getSize();
        pdfDoc.removePage(i);
        const newPage = pdfDoc.insertPage(i, [width, height]);
        newPage.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0, 0, 0) });
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not black out those pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Blackout entire pages">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Replaces each chosen page outright with a solid black page — unlike deleting, page numbering and the
          page count are preserved, which is the point for withholding a specific page (e.g. a privileged
          document in a production) while keeping the rest of the pagination intact. The page is rebuilt from
          scratch, so nothing from the original survives underneath.
        </p>
        <div>
          <Label htmlFor="blackout-range">Pages to black out</Label>
          <Input id="blackout-range" placeholder="e.g. 4, 9-10" value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Blacking out…" : "Black out"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Resize pages to a standard size: rescales each page's content (not a re-render — pdf-lib's
// scaleContent/translateContent operate on the page's content-stream transform, so text stays
// text) to fit a target paper size, centering it. Distinct from Crop, which trims the visible area
// without touching scale.

const STANDARD_SIZES = { A4: PageSizes.A4, A3: PageSizes.A3, Letter: PageSizes.Letter, Legal: PageSizes.Legal } as const;
type StandardSize = keyof typeof STANDARD_SIZES;

export function ResizePagesModal({
  open,
  onClose,
  pdfDoc,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  onApplied: () => void;
}) {
  const [target, setTarget] = useState<StandardSize>("A4");
  const [mode, setMode] = useState<"fit" | "stretch">("fit");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const [targetW, targetH] = STANDARD_SIZES[target];
      for (const page of pdfDoc.getPages()) {
        const { width, height } = page.getSize();
        const scaleX = mode === "stretch" ? targetW / width : Math.min(targetW / width, targetH / height);
        const scaleY = mode === "stretch" ? targetH / height : scaleX;
        page.scaleContent(scaleX, scaleY);
        page.translateContent((targetW - width * scaleX) / 2, (targetH - height * scaleY) / 2);
        page.setSize(targetW, targetH);
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resize this document's pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Resize pages">
      <div className="space-y-4">
        <div>
          <Label htmlFor="resize-target">Target size</Label>
          <Select id="resize-target" value={target} onChange={(e) => setTarget(e.target.value as StandardSize)}>
            {Object.keys(STANDARD_SIZES).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="resize-mode">Mode</Label>
          <Select id="resize-mode" value={mode} onChange={(e) => setMode(e.target.value as "fit" | "stretch")}>
            <option value="fit">Fit (preserve proportions, center with margins)</option>
            <option value="stretch">Stretch to fill (may distort content)</option>
          </Select>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Resizing…" : "Resize every page"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Insert blank pages (bulk): the per-thumbnail "+" button only ever inserts one blank page after
// that thumbnail — this covers "add 10 blank pages at the end" in one step.

export function InsertBlankPagesModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [count, setCount] = useState(1);
  const [size, setSize] = useState<StandardSize | "match">("match");
  const [position, setPosition] = useState<"start" | "end" | "after">("end");
  const [afterPage, setAfterPage] = useState(1);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setCount(1);
      setPosition("end");
      setAfterPage(pageCount);
      setError(null);
    }
  }, [open, pageCount]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const dims: [number, number] = size === "match" ? [pdfDoc.getPage(0).getWidth(), pdfDoc.getPage(0).getHeight()] : STANDARD_SIZES[size];
      const insertAt = position === "start" ? 0 : position === "end" ? pdfDoc.getPageCount() : Math.min(Math.max(afterPage, 0), pdfDoc.getPageCount());
      for (let i = 0; i < Math.max(1, Math.floor(count)); i++) pdfDoc.insertPage(insertAt + i, dims);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not insert blank pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Insert blank pages">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="blank-count">How many</Label>
            <Input id="blank-count" type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="blank-size">Size</Label>
            <Select id="blank-size" value={size} onChange={(e) => setSize(e.target.value as StandardSize | "match")}>
              <option value="match">Match page 1</option>
              {Object.keys(STANDARD_SIZES).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="blank-position">Position</Label>
          <Select id="blank-position" value={position} onChange={(e) => setPosition(e.target.value as "start" | "end" | "after")}>
            <option value="start">At the beginning</option>
            <option value="end">At the end</option>
            <option value="after">After page…</option>
          </Select>
        </div>
        {position === "after" && (
          <div>
            <Label htmlFor="blank-after">After page number</Label>
            <Input id="blank-after" type="number" min={0} max={pageCount} value={afterPage} onChange={(e) => setAfterPage(Number(e.target.value))} />
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Inserting…" : "Insert"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Reorder pages: the thumbnail grid supports drag-and-drop, which gets tedious past a couple dozen
// pages — this lets you type the full target order (e.g. "3,1,2,4-10") in one go instead.

export function ReorderPagesModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
  onApplied: () => void;
}) {
  const [order, setOrder] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setOrder("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const newOrder = parsePageOrder(order, pageCount);
      const pages = newOrder.map((i) => pdfDoc.getPage(i));
      for (let i = pageCount - 1; i >= 0; i--) pdfDoc.removePage(i);
      pages.forEach((page, i) => pdfDoc.insertPage(i, page));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reorder these pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reorder pages">
      <div className="space-y-4">
        <div>
          <Label htmlFor="reorder-input">New order</Label>
          <Input id="reorder-input" placeholder="e.g. 3,1,2,4-10" value={order} onChange={(e) => setOrder(e.target.value)} />
          <p className="mt-1 text-xs text-slate">Must list every one of this {pageCount}-page document&apos;s pages exactly once.</p>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Reordering…" : "Apply order"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Export as one long image: stitches every page into a single tall PNG, top to bottom — useful for
// sharing a short document somewhere that only accepts one image (a chat, a ticket) rather than a
// PDF or a batch of per-page files (that's Export as images). Read-only.

export function LongImageModal({
  open,
  onClose,
  pdfDoc,
  docName,
  pageCount,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
  pageCount: number;
}) {
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setProgress(0);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const bytes = await pdfDoc.save();
      const scale = pageCount > 20 ? 1 : 1.5;
      const pages: HTMLCanvasElement[] = [];
      let totalHeight = 0;
      let maxWidth = 0;
      for (let i = 1; i <= pageCount; i++) {
        const { canvas } = await renderPageToCanvas(bytes, i, scale);
        pages.push(canvas);
        totalHeight += canvas.height;
        maxWidth = Math.max(maxWidth, canvas.width);
        setProgress(i);
      }
      const combined = document.createElement("canvas");
      combined.width = maxWidth;
      combined.height = totalHeight;
      const ctx = combined.getContext("2d");
      if (!ctx) throw new Error("Could not assemble the combined image.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, maxWidth, totalHeight);
      let y = 0;
      for (const canvas of pages) {
        ctx.drawImage(canvas, (maxWidth - canvas.width) / 2, y);
        y += canvas.height;
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        combined.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not export the combined image."))), "image/png");
      });
      downloadBlob(blob, `${docName.replace(/\.pdf$/i, "")}-long.png`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stitch this document into one image.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export as one long image">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Stacks every page top to bottom into a single PNG — handy for sharing a short document somewhere that
          only takes one image. Best for shorter documents; very long or high-page-count documents may hit your
          browser&apos;s maximum image size.
        </p>
        {working && <p className="text-xs text-slate">Rendering page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={working}>
            {working ? "Rendering…" : "Export"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Contact sheet: a printable index of thumbnails with page numbers, several to a sheet — the way
// Acrobat/Bridge's "contact sheet" tool works for quickly locating a page in a long document
// without opening it, or for a quick paper index. Rasterizes thumbnails via pdf.js (no embedPage
// risk from blank pages, unlike N-up) and uploads the result as a new document, like Split.

export function ContactSheetModal({
  open,
  onClose,
  pdfDoc,
  docName,
  folderId,
  pageCount,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
  folderId: string | null;
  pageCount: number;
  onCreated: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setCreated(null);
      setProgress(0);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const bytes = await pdfDoc.save();
      const newDoc = await PDFDoc.create();
      const font = await newDoc.embedFont(StandardFonts.Helvetica);
      const cols = 4;
      const rows = 5;
      const perSheet = cols * rows;
      const [sheetW, sheetH] = PageSizes.A4;
      const margin = 24;
      const labelHeight = 12;
      const cellW = (sheetW - margin * 2) / cols;
      const cellH = (sheetH - margin * 2) / rows;

      for (let start = 0; start < pageCount; start += perSheet) {
        const sheet = newDoc.addPage([sheetW, sheetH]);
        for (let slot = 0; slot < perSheet && start + slot < pageCount; slot++) {
          const pageNum = start + slot + 1;
          const { canvas } = await renderPageToCanvas(bytes, pageNum, 0.3);
          const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
            canvas.toBlob(async (blob) => {
              if (!blob) return reject(new Error("Could not render a thumbnail."));
              resolve(new Uint8Array(await blob.arrayBuffer()));
            }, "image/png");
          });
          const image = await newDoc.embedPng(pngBytes);
          const col = slot % cols;
          const row = Math.floor(slot / cols);
          const cellX = margin + col * cellW;
          const cellTop = sheetH - margin - row * cellH;
          const availW = cellW - 8;
          const availH = cellH - labelHeight - 8;
          const scale = Math.min(availW / image.width, availH / image.height, 1);
          const w = image.width * scale;
          const h = image.height * scale;
          const x = cellX + (cellW - w) / 2;
          const y = cellTop - cellH + labelHeight + (cellH - labelHeight - h) / 2;
          sheet.drawImage(image, { x, y, width: w, height: h });
          const label = `${pageNum}`;
          const labelWidth = font.widthOfTextAtSize(label, 8);
          sheet.drawText(label, { x: cellX + (cellW - labelWidth) / 2, y: cellTop - cellH + 2, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
          setProgress(pageNum);
        }
      }

      const baseName = docName.replace(/\.pdf$/i, "");
      const result = await uploadBuiltDoc(newDoc, `${baseName} (contact sheet).pdf`, folderId);
      setCreated(result);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build a contact sheet.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create thumbnail contact sheet">
      {created ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Created{" "}
            <a className="text-signal-dim underline" href={`/documents/${created.id}`}>
              {created.name}
            </a>
            .
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate">
            Builds a new document that&apos;s a printable index of every page&apos;s thumbnail with its page number — a
            quick way to find a page in a long document without opening it. The original document is untouched.
          </p>
          {working && <p className="text-xs text-slate">Rendered {progress} of {pageCount} thumbnails…</p>}
          {error && <p className="text-sm text-brass">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={working}>
              {working ? "Building…" : "Create"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Split into single-page PDFs (zip): a quick one-off download alternative to SplitModal's
// "split every N pages" mode, which uploads each part into your library — this instead zips every
// page as its own PDF straight to your downloads, for when you just need the files once.

export function SplitToZipModal({
  open,
  onClose,
  pdfDoc,
  docName,
  pageCount,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  docName: string;
  pageCount: number;
}) {
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
      setProgress(0);
    }
  }, [open]);

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const { default: JSZip } = await import("jszip");
      const baseName = docName.replace(/\.pdf$/i, "");
      const zip = new JSZip();
      for (let i = 0; i < pageCount; i++) {
        const single = await PDFDoc.create();
        const [copied] = await single.copyPages(pdfDoc, [i]);
        single.addPage(copied);
        const bytes = await single.save();
        zip.file(`${baseName}-page-${i + 1}.pdf`, bytes);
        setProgress(i + 1);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `${baseName}-pages.zip`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split this document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Split into single-page PDFs">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Downloads a .zip with {pageCount} PDFs, one per page — without adding anything to your document
          library. Use Split… instead if you want the parts saved here.
        </p>
        {working && <p className="text-xs text-slate">Splitting page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={working}>
            {working ? "Splitting…" : "Split & download"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
