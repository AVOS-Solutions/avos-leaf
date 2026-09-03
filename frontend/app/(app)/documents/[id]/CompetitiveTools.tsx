"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { rgb, StandardFonts } from "pdf-lib";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { loadPdfJs, renderPageToCanvas, toArrayBuffer } from "@/lib/pdfClient";
import { extractTextRuns, type TextRun } from "@/lib/pdfContentStream";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------------------------------------
// Find & redact: the manual RedactModal only ever handles one page, one box at a time — this
// runs the same extractTextRuns() text-position machinery EditTextModal already relies on across
// every page at once, so a phrase that appears 40 times doesn't mean 40 trips through the manual
// tool. Applying still rasterizes each affected page exactly like RedactModal does (a flat image
// replaces the page, so nothing underneath a box survives), it's just driven by a search match
// list instead of mouse drags.

type Match = { pageIndex: number; box: TextRun["box"]; snippet: string };

export function FindRedactModal({
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
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens, not reacting to pdfDoc's own state
      setQuery("");
      setMatches(null);
      setSelected(new Set());
      setError(null);
    }
  }, [open]);

  async function search() {
    if (!pdfDoc || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const needle = query.trim().toLowerCase();
      const found: Match[] = [];
      for (let i = 0; i < pageCount; i++) {
        const runs = await extractTextRuns(pdfDoc.getPage(i));
        for (const run of runs) {
          if (run.text && run.text.toLowerCase().includes(needle)) {
            found.push({ pageIndex: i, box: run.box, snippet: run.text.trim().slice(0, 80) });
          }
        }
      }
      setMatches(found);
      setSelected(new Set(found.map((_, i) => i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not search this document.");
    } finally {
      setSearching(false);
    }
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function apply() {
    if (!pdfDoc || !matches || selected.size === 0) return;
    setApplying(true);
    setError(null);
    try {
      const byPage = new Map<number, Match[]>();
      matches.forEach((m, i) => {
        if (!selected.has(i)) return;
        if (!byPage.has(m.pageIndex)) byPage.set(m.pageIndex, []);
        byPage.get(m.pageIndex)!.push(m);
      });

      for (const [pageIndex, pageMatches] of byPage) {
        const page = pdfDoc.getPage(pageIndex);
        const pdfW = page.getWidth();
        const pdfH = page.getHeight();
        const exportScale = 2;
        const bytes = await pdfDoc.save();
        const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, exportScale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not prepare the redacted page.");
        ctx.fillStyle = "#000000";
        for (const m of pageMatches) {
          ctx.fillRect(
            m.box.x * exportScale,
            canvas.height - (m.box.y + m.box.height) * exportScale,
            m.box.width * exportScale,
            m.box.height * exportScale,
          );
        }
        const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error("Could not export the redacted page."));
            resolve(new Uint8Array(await blob.arrayBuffer()));
          }, "image/png");
        });
        const image = await pdfDoc.embedPng(pngBytes);
        pdfDoc.removePage(pageIndex);
        const newPage = pdfDoc.insertPage(pageIndex, [pdfW, pdfH]);
        newPage.drawImage(image, { x: 0, y: 0, width: pdfW, height: pdfH });
      }

      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply these redactions.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Find & redact">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Finds every occurrence of a word or phrase across the whole document and lets you redact them all at
          once — each affected page is flattened to an image, so the text underneath a box is permanently gone.
        </p>
        <div className="flex gap-2">
          <Input placeholder="Text to find…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button variant="secondary" onClick={search} disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Find"}
          </Button>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        {matches && (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {matches.length === 0 ? (
              <p className="text-sm text-slate">No matches found.</p>
            ) : (
              matches.map((m, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-ink">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="mt-0.5" />
                  <span>
                    <span className="mono text-slate">p.{m.pageIndex + 1}</span> — “{m.snippet}
                    {m.snippet.length >= 80 ? "…" : ""}”
                  </span>
                </label>
              ))
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={!matches || selected.size === 0 || applying}>
            {applying ? "Redacting…" : `Redact ${selected.size || ""} match${selected.size === 1 ? "" : "es"}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Header & footer: distinct from the existing page-numbers tool (which only ever centers a
// number) and from watermark (one big diagonal stamp) — this is the small-print running text
// Acrobat's own "Add Header and Footer" produces, with independent left/center/right slots on
// each edge. {page} and {pages} are substituted per page so the same text can carry numbering too.

type HeaderFooterFields = { hl: string; hc: string; hr: string; fl: string; fc: string; fr: string };
const EMPTY_HF: HeaderFooterFields = { hl: "", hc: "", hr: "", fl: "", fc: "", fr: "" };

export function HeaderFooterModal({
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
  const [fields, setFields] = useState<HeaderFooterFields>(EMPTY_HF);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFields(EMPTY_HF);
      setError(null);
    }
  }, [open]);

  function set(key: keyof HeaderFooterFields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function apply() {
    if (!pdfDoc) return;
    const hasAny = Object.values(fields).some((v) => v.trim());
    if (!hasAny) return;
    setApplying(true);
    setError(null);
    try {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const size = 9;
      const margin = 28;
      const pages = pdfDoc.getPages();
      const total = pages.length;
      pages.forEach((page, index) => {
        const { width, height } = page.getSize();
        const resolve = (text: string) => text.replace(/\{page\}/g, `${index + 1}`).replace(/\{pages\}/g, `${total}`);
        const draw = (text: string, y: number, align: "left" | "center" | "right") => {
          const label = resolve(text);
          if (!label) return;
          const textWidth = font.widthOfTextAtSize(label, size);
          const x = align === "left" ? margin : align === "right" ? width - margin - textWidth : width / 2 - textWidth / 2;
          page.drawText(label, { x, y, size, font, color: rgb(0.35, 0.35, 0.35) });
        };
        draw(fields.hl, height - margin, "left");
        draw(fields.hc, height - margin, "center");
        draw(fields.hr, height - margin, "right");
        draw(fields.fl, margin - size, "left");
        draw(fields.fc, margin - size, "center");
        draw(fields.fr, margin - size, "right");
      });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the header/footer.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Header & footer">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Small running text along the top and bottom of every page. Use <code className="mono">{"{page}"}</code> and{" "}
          <code className="mono">{"{pages}"}</code> anywhere to insert numbering.
        </p>
        <div>
          <Label>Header</Label>
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="Left" value={fields.hl} onChange={(e) => set("hl", e.target.value)} />
            <Input placeholder="Center" value={fields.hc} onChange={(e) => set("hc", e.target.value)} />
            <Input placeholder="Right" value={fields.hr} onChange={(e) => set("hr", e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Footer</Label>
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder="Left" value={fields.fl} onChange={(e) => set("fl", e.target.value)} />
            <Input placeholder="Center" value={fields.fc} onChange={(e) => set("fc", e.target.value)} />
            <Input placeholder="Right" value={fields.fr} onChange={(e) => set("fr", e.target.value)} />
          </div>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Adding…" : "Add to every page"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Insert PDF at a position: "Merge PDF" always appends at the end — this covers the more common
// real request ("drop these 2 pages in before page 5"), reusing the same copyPages plumbing.

type InsertPosition = "start" | "end" | "after";

export function InsertPdfModal({
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
  const [position, setPosition] = useState<InsertPosition>("end");
  const [afterPage, setAfterPage] = useState(1);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFile(null);
      setPosition("end");
      setAfterPage(pageCount);
      setError(null);
    }
  }, [open, pageCount]);

  async function apply() {
    if (!pdfDoc || !file) return;
    setApplying(true);
    setError(null);
    try {
      const { PDFDocument: PDFDoc } = await import("pdf-lib");
      const bytes = await file.arrayBuffer();
      const otherDoc = await PDFDoc.load(bytes);
      const copiedPages = await pdfDoc.copyPages(otherDoc, otherDoc.getPageIndices());
      const insertAt = position === "start" ? 0 : position === "end" ? pdfDoc.getPageCount() : Math.min(Math.max(afterPage, 0), pdfDoc.getPageCount());
      copiedPages.forEach((page, i) => pdfDoc.insertPage(insertAt + i, page));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not insert that PDF.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Insert PDF">
      <div className="space-y-4">
        <div>
          <Label>PDF to insert</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink"
          />
        </div>
        <div>
          <Label htmlFor="insert-position">Position</Label>
          <Select id="insert-position" value={position} onChange={(e) => setPosition(e.target.value as InsertPosition)}>
            <option value="start">At the beginning</option>
            <option value="end">At the end</option>
            <option value="after">After page…</option>
          </Select>
        </div>
        {position === "after" && (
          <div>
            <Label htmlFor="insert-after">After page number</Label>
            <Input
              id="insert-after"
              type="number"
              min={0}
              max={pageCount}
              value={afterPage}
              onChange={(e) => setAfterPage(Number(e.target.value))}
            />
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || !file}>
            {applying ? "Inserting…" : "Insert"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Export pages as images: never touches the open document (read-only, same "nothing to undo"
// convention as SplitModal), renders every page at a chosen quality and bundles the result as a
// zip when there's more than one page.

export function ExportImagesModal({
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
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [quality, setQuality] = useState<1 | 2 | 3>(2);
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
    setProgress(0);
    try {
      const baseName = docName.replace(/\.pdf$/i, "");
      const bytes = await pdfDoc.save();
      const mime = format === "png" ? "image/png" : "image/jpeg";
      const ext = format === "png" ? "png" : "jpg";

      const pageBlobs: Blob[] = [];
      for (let i = 1; i <= pageCount; i++) {
        const { canvas } = await renderPageToCanvas(bytes, i, quality);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render a page."))), mime, 0.92);
        });
        pageBlobs.push(blob);
        setProgress(i);
      }

      if (pageBlobs.length === 1) {
        downloadBlob(pageBlobs[0], `${baseName}.${ext}`);
      } else {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        pageBlobs.forEach((blob, i) => zip.file(`${baseName}-page-${i + 1}.${ext}`, blob));
        const zipBlob = await zip.generateAsync({ type: "blob" });
        downloadBlob(zipBlob, `${baseName}-images.zip`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export these pages as images.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export as images">
      <div className="space-y-4">
        <div>
          <Label htmlFor="img-format">Format</Label>
          <Select id="img-format" value={format} onChange={(e) => setFormat(e.target.value as "png" | "jpeg")}>
            <option value="png">PNG (lossless)</option>
            <option value="jpeg">JPEG (smaller files)</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="img-quality">Resolution</Label>
          <Select id="img-quality" value={quality} onChange={(e) => setQuality(Number(e.target.value) as 1 | 2 | 3)}>
            <option value={1}>Standard</option>
            <option value={2}>High</option>
            <option value={3}>Maximum</option>
          </Select>
        </div>
        <p className="text-xs text-slate">
          {pageCount === 1 ? "Downloads a single image." : `Downloads a .zip with ${pageCount} images, one per page.`}
        </p>
        {working && <p className="text-xs text-slate">Rendering page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={working}>
            {working ? "Exporting…" : "Export"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Compare with another PDF: a lightweight per-page text diff (same "extract every page's text"
// approach as the search box and ExtractTextModal) — flags which pages differ, were added, or
// were removed, without trying to render a visual diff. Read-only on both documents.

type CompareRow = { pageIndex: number; status: "same" | "different" | "added" | "removed" };

export function CompareModal({
  open,
  onClose,
  pdfDoc,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFile(null);
      setRows(null);
      setError(null);
    }
  }, [open]);

  async function pageTexts(bytes: ArrayBuffer): Promise<string[]> {
    const pdfjsLib = await loadPdfJs();
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      texts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim().replace(/\s+/g, " "));
    }
    return texts;
  }

  async function compare() {
    if (!pdfDoc || !file) return;
    setComparing(true);
    setError(null);
    try {
      const [textsA, textsB] = await Promise.all([
        pageTexts(toArrayBuffer(await pdfDoc.save())),
        pageTexts(await file.arrayBuffer()),
      ]);
      const max = Math.max(textsA.length, textsB.length);
      const result: CompareRow[] = [];
      for (let i = 0; i < max; i++) {
        const a = textsA[i];
        const b = textsB[i];
        const status: CompareRow["status"] = a === undefined ? "added" : b === undefined ? "removed" : a === b ? "same" : "different";
        result.push({ pageIndex: i, status });
      }
      setRows(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compare these documents.");
    } finally {
      setComparing(false);
    }
  }

  const differing = rows?.filter((r) => r.status !== "same").length ?? 0;
  const STATUS_LABEL: Record<CompareRow["status"], string> = {
    same: "Identical text",
    different: "Text differs",
    added: "Only in this document",
    removed: "Only in the other document",
  };
  const STATUS_CLASS: Record<CompareRow["status"], string> = {
    same: "text-slate",
    different: "text-brass",
    added: "text-signal-dim",
    removed: "text-signal-dim",
  };

  return (
    <Modal open={open} onClose={onClose} title="Compare with another PDF">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Compares extracted text page by page — useful for spotting which pages changed between two versions of a
          document. This doesn&apos;t detect purely visual differences (layout, images, formatting).
        </p>
        <div>
          <Label>Other PDF</Label>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink"
          />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        {rows && (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            <p className="mb-1 text-xs text-ink">
              {differing === 0 ? "No differences found." : `${differing} of ${rows.length} page${rows.length === 1 ? "" : "s"} differ.`}
            </p>
            {rows.map((row) => (
              <div key={row.pageIndex} className="flex justify-between text-xs">
                <span className="mono text-slate">p.{row.pageIndex + 1}</span>
                <span className={STATUS_CLASS[row.status]}>{STATUS_LABEL[row.status]}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={compare} disabled={comparing || !file}>
            {comparing ? "Comparing…" : "Compare"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
