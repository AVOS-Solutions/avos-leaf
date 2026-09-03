"use client";

import { useEffect, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { rgb, StandardFonts } from "pdf-lib";
import { Button, Input, Label, Modal, Select, Textarea } from "@/components/ui";
import { loadPdfJs, toArrayBuffer } from "@/lib/pdfClient";

/** Parses a page-range string like "1-3, 5, 8-10" (1-indexed, as shown to the user) into a sorted,
 *  de-duplicated array of 0-indexed page numbers, clamped to [0, pageCount). Throws with a message
 *  safe to show the user on anything unparseable, rather than silently producing an empty result. */
function parsePageRanges(input: string, pageCount: number): number[] {
  const indices = new Set<number>();
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Enter at least one page or range, e.g. 1-3, 5.");
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end > pageCount || start > end) throw new Error(`"${part}" is not a valid range for this ${pageCount}-page document.`);
      for (let i = start; i <= end; i++) indices.add(i - 1);
      continue;
    }
    const single = Number(part);
    if (!Number.isInteger(single) || single < 1 || single > pageCount) throw new Error(`"${part}" is not a valid page number.`);
    indices.add(single - 1);
  }
  return [...indices].sort((a, b) => a - b);
}

export async function buildAndUpload(sourceDoc: PDFDocument, pageIndices: number[], name: string, folderId: string | null) {
  const { PDFDocument: PDFDoc } = await import("pdf-lib");
  const newDoc = await PDFDoc.create();
  const pages = await newDoc.copyPages(sourceDoc, pageIndices);
  pages.forEach((page) => newDoc.addPage(page));
  const bytes = await newDoc.save();
  const form = new FormData();
  form.append("file", new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), name);
  if (folderId) form.append("folderId", folderId);
  const response = await fetch("/api/documents/upload", { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `Could not create "${name}".`);
  return body as { id: string; name: string };
}

/** Splitting never touches the document currently open — it only ever reads from it (via
 *  copyPages) to create brand-new documents through the normal upload endpoint, so there's nothing
 *  to undo here and the original stays exactly as it was. */
export function SplitModal({
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
  const [mode, setMode] = useState<"range" | "everyN">("range");
  const [range, setRange] = useState("");
  const [everyN, setEveryN] = useState(1);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form to a blank state each time the modal (re)opens, not reacting to pdfDoc's own state
      setError(null);
      setCreated([]);
      setRange("");
    }
  }, [open]);

  const baseName = docName.replace(/\.pdf$/i, "");

  async function run() {
    if (!pdfDoc) return;
    setWorking(true);
    setError(null);
    try {
      const results: { id: string; name: string }[] = [];
      if (mode === "range") {
        const indices = parsePageRanges(range, pageCount);
        results.push(await buildAndUpload(pdfDoc, indices, `${baseName} (pages ${range.trim()}).pdf`, folderId));
      } else {
        const chunkSize = Math.max(1, Math.floor(everyN));
        let part = 1;
        for (let start = 0; start < pageCount; start += chunkSize) {
          const indices = Array.from({ length: Math.min(chunkSize, pageCount - start) }, (_, i) => start + i);
          results.push(await buildAndUpload(pdfDoc, indices, `${baseName} (part ${part}).pdf`, folderId));
          part += 1;
        }
      }
      setCreated(results);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split this document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Split document">
      {created.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">Created {created.length} new document{created.length === 1 ? "" : "s"}:</p>
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
          <div className="flex gap-2">
            <Button variant={mode === "range" ? "primary" : "secondary"} onClick={() => setMode("range")}>
              Extract a range
            </Button>
            <Button variant={mode === "everyN" ? "primary" : "secondary"} onClick={() => setMode("everyN")}>
              Split every N pages
            </Button>
          </div>
          {mode === "range" ? (
            <div>
              <Label htmlFor="split-range">Pages to extract into a new document</Label>
              <Input id="split-range" placeholder="e.g. 1-3, 5" value={range} onChange={(e) => setRange(e.target.value)} />
              <p className="mt-1 text-xs text-slate">This {pageCount}-page document stays untouched — a new document is created from these pages.</p>
            </div>
          ) : (
            <div>
              <Label htmlFor="split-every">Pages per new document</Label>
              <Input id="split-every" type="number" min={1} max={pageCount} value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} />
              <p className="mt-1 text-xs text-slate">
                Creates {Math.ceil(pageCount / Math.max(1, everyN))} new documents from this {pageCount}-page document.
              </p>
            </div>
          )}
          {error && <p className="text-sm text-brass">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={working}>
              {working ? "Splitting…" : "Split"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

const PAGE_NUMBER_POSITIONS = {
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
  "top-center": "Top center",
  "top-right": "Top right",
} as const;
type PageNumberPosition = keyof typeof PAGE_NUMBER_POSITIONS;

export function PageNumbersModal({
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
  const [position, setPosition] = useState<PageNumberPosition>("bottom-center");
  const [format, setFormat] = useState<"n" | "n-of-total" | "page-n-of-total">("n-of-total");
  const [startAt, setStartAt] = useState(1);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const pages = pdfDoc.getPages();
      const total = pages.length;
      pages.forEach((page, index) => {
        const n = startAt + index;
        const label = format === "n" ? `${n}` : format === "n-of-total" ? `${n} / ${total}` : `Page ${n} of ${total}`;
        const size = 9;
        const textWidth = font.widthOfTextAtSize(label, size);
        const { width, height } = page.getSize();
        const margin = 24;
        const positions: Record<PageNumberPosition, { x: number; y: number }> = {
          "bottom-center": { x: width / 2 - textWidth / 2, y: margin / 2 },
          "bottom-right": { x: width - margin - textWidth, y: margin / 2 },
          "top-center": { x: width / 2 - textWidth / 2, y: height - margin },
          "top-right": { x: width - margin - textWidth, y: height - margin },
        };
        const { x, y } = positions[position];
        page.drawText(label, { x, y, size, font, color: rgb(0.35, 0.35, 0.35) });
      });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add page numbers.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add page numbers">
      <div className="space-y-4">
        <div>
          <Label htmlFor="pn-position">Position</Label>
          <Select id="pn-position" value={position} onChange={(e) => setPosition(e.target.value as PageNumberPosition)}>
            {Object.entries(PAGE_NUMBER_POSITIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="pn-format">Format</Label>
          <Select id="pn-format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="n">1</option>
            <option value="n-of-total">1 / 12</option>
            <option value="page-n-of-total">Page 1 of 12</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="pn-start">Start numbering at</Label>
          <Input id="pn-start" type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} />
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

export function MetadataModal({
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
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [subject, setSubject] = useState("");
  const [keywords, setKeywords] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (open && pdfDoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-filling the form from the document's current metadata each time the modal opens, not reacting to external state
      setTitle(pdfDoc.getTitle() ?? "");
      setAuthor(pdfDoc.getAuthor() ?? "");
      setSubject(pdfDoc.getSubject() ?? "");
      setKeywords((pdfDoc.getKeywords() ?? "").toString());
    }
  }, [open, pdfDoc]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    try {
      pdfDoc.setTitle(title);
      pdfDoc.setAuthor(author);
      pdfDoc.setSubject(subject);
      pdfDoc.setKeywords(keywords.split(",").map((k) => k.trim()).filter(Boolean));
      pdfDoc.setModificationDate(new Date());
      onApplied();
      onClose();
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Document properties">
      <div className="space-y-4">
        <div>
          <Label htmlFor="meta-title">Title</Label>
          <Input id="meta-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="meta-author">Author</Label>
          <Input id="meta-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="meta-subject">Subject</Label>
          <Input id="meta-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="meta-keywords">Keywords (comma-separated)</Label>
          <Input id="meta-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CropModal({
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
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      for (const page of pdfDoc.getPages()) {
        const { width, height } = page.getSize();
        const newWidth = width - margins.left - margins.right;
        const newHeight = height - margins.top - margins.bottom;
        if (newWidth <= 0 || newHeight <= 0) throw new Error("Those margins would leave nothing on the page.");
        page.setCropBox(margins.left, margins.bottom, newWidth, newHeight);
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not crop this document.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Crop margins (all pages)">
      <div className="space-y-4">
        <p className="text-xs text-slate">Margins in points (72 pt = 1 inch), trimmed from every page&apos;s visible area.</p>
        <div className="grid grid-cols-2 gap-3">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <div key={side}>
              <Label htmlFor={`crop-${side}`} className="capitalize">
                {side}
              </Label>
              <Input
                id={`crop-${side}`}
                type="number"
                min={0}
                value={margins[side]}
                onChange={(e) => setMargins((prev) => ({ ...prev, [side]: Number(e.target.value) }))}
              />
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Cropping…" : "Apply crop"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ExtractTextModal({
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
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function extract() {
      setLoading(true);
      setCopied(false);
      try {
        const bytes = await pdfDoc!.save();
        const pdfjsLib = await loadPdfJs();
        const doc = await pdfjsLib.getDocument({ data: toArrayBuffer(bytes) }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          parts.push(`--- Page ${i} ---\n${pageText}`);
        }
        if (!cancelled) setText(parts.join("\n\n"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    extract();
    return () => {
      cancelled = true;
    };
  }, [open, pdfDoc]);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  function download() {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docName.replace(/\.pdf$/i, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal open={open} onClose={onClose} title="Extracted text">
      {loading ? (
        <p className="text-sm text-slate">Extracting…</p>
      ) : (
        <div className="space-y-3">
          <Textarea readOnly value={text} rows={14} className="mono text-xs" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={download}>
              Download .txt
            </Button>
            <Button onClick={copy}>{copied ? "Copied!" : "Copy to clipboard"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
