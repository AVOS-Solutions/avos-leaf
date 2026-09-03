"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input, Label, Modal, Textarea } from "@/components/ui";
import { renderPageToCanvas, toArrayBuffer } from "@/lib/pdfClient";
import { extractTextRuns } from "@/lib/pdfContentStream";

async function uploadPdf(bytes: Uint8Array, name: string, folderId: string | null) {
  const form = new FormData();
  form.append("file", new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), name);
  if (folderId) form.append("folderId", folderId);
  const response = await fetch("/api/documents/upload", { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? `Could not create "${name}".`);
  return body as { id: string; name: string };
}

// -------------------------------------------------------------------------------------------
// Merge multiple PDFs: the editor's own "Merge PDF" only ever appends one file at a time to the
// currently open document — this is the flagship "combine several files into one" flow most PDF
// tools lead with, working entirely from local files (Combine documents… next to it covers the
// same idea for files already saved in this account's library).

type PickedFile = { id: string; file: File };

export function MergeMultipleModal({
  open,
  onClose,
  folderId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string | null;
  onCreated: () => void;
}) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFiles([]);
      setError(null);
    }
  }, [open]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list).map((file) => ({ id: `${Date.now()}-${nextId.current++}`, file }));
    setFiles((prev) => [...prev, ...picked]);
  }

  function move(index: number, direction: -1 | 1) {
    setFiles((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function remove(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function run() {
    if (files.length < 2) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const merged = await PDFDocument.create();
      for (const { file } of files) {
        const bytes = await file.arrayBuffer();
        const source = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      }
      const bytes = await merged.save();
      await uploadPdf(bytes, "Merged.pdf", folderId);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not merge these files. Make sure they're all PDFs.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Merge multiple PDFs">
      <div className="space-y-4">
        <p className="text-xs text-slate">Pick several PDF files from your computer, arrange their order, and combine them into one new document.</p>
        <input ref={inputRef} type="file" accept="application/pdf" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          Add files…
        </Button>
        {files.length > 0 && (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {files.map((f, i) => (
              <div key={f.id} className="flex items-center gap-2 text-sm">
                <span className="mono w-6 shrink-0 text-xs text-slate">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{f.file.name}</span>
                <button type="button" className="text-xs text-slate hover:text-ink disabled:opacity-30" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button
                  type="button"
                  className="text-xs text-slate hover:text-ink disabled:opacity-30"
                  onClick={() => move(i, 1)}
                  disabled={i === files.length - 1}
                >
                  ↓
                </button>
                <button type="button" className="text-xs text-brass" onClick={() => remove(f.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={working || files.length < 2}>
            {working ? "Merging…" : "Merge"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// New PDF from Markdown: a step up from "New PDF from text" for anyone drafting notes in
// Markdown — headers, bullet lists, and blank-line paragraph breaks get real formatting instead of
// being rendered as literal "# " characters. Deliberately covers only the common subset (no tables,
// links, or inline code) rather than a half-working stab at the whole spec.

export function MarkdownToPdfModal({
  open,
  onClose,
  folderId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setTitle("");
      setBody("");
      setError(null);
    }
  }, [open]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument, StandardFonts, PageSizes } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      const regular = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const margin = 54;
      const [pageWidth, pageHeight] = PageSizes.A4;
      const maxWidth = pageWidth - margin * 2;

      type Line = { text: string; size: number; font: typeof regular; indent: number; spaceAfter: number };
      const lines: Line[] = [];

      function wrap(text: string, size: number, font: typeof regular, indent: number, spaceAfter: number) {
        let current = "";
        const availableWidth = maxWidth - indent;
        for (const word of text.split(" ")) {
          const candidate = current ? `${current} ${word}` : word;
          if (font.widthOfTextAtSize(candidate, size) > availableWidth && current) {
            lines.push({ text: current, size, font, indent, spaceAfter: 0 });
            current = word;
          } else {
            current = candidate;
          }
        }
        lines.push({ text: current, size, font, indent, spaceAfter });
      }

      for (const raw of body.split("\n")) {
        const line = raw.trimEnd();
        if (!line.trim()) {
          lines.push({ text: "", size: 11, font: regular, indent: 0, spaceAfter: 6 });
          continue;
        }
        const h3 = line.match(/^###\s+(.*)/);
        const h2 = line.match(/^##\s+(.*)/);
        const h1 = line.match(/^#\s+(.*)/);
        const bullet = line.match(/^[-*]\s+(.*)/);
        if (h1) wrap(h1[1].replace(/\*\*/g, ""), 20, bold, 0, 10);
        else if (h2) wrap(h2[1].replace(/\*\*/g, ""), 16, bold, 0, 8);
        else if (h3) wrap(h3[1].replace(/\*\*/g, ""), 13, bold, 0, 6);
        else if (bullet) wrap(`•  ${bullet[1].replace(/\*\*/g, "")}`, 11, regular, 14, 2);
        else {
          const isBoldLine = /^\*\*(.*)\*\*$/.test(line.trim());
          const text = line.trim().replace(/^\*\*(.*)\*\*$/, "$1").replace(/\*\*/g, "");
          wrap(text, 11, isBoldLine ? bold : regular, 0, 4);
        }
      }

      let page = doc.addPage(PageSizes.A4);
      let y = pageHeight - margin;
      for (const line of lines) {
        if (y < margin) {
          page = doc.addPage(PageSizes.A4);
          y = pageHeight - margin;
        }
        if (line.text) page.drawText(line.text, { x: margin + line.indent, y, size: line.size, font: line.font });
        y -= line.size * 1.35 + line.spaceAfter;
      }

      const bytes = await doc.save();
      const name = `${(title.trim() || "Untitled").replace(/\.pdf$/i, "")}.pdf`;
      await uploadPdf(bytes, name, folderId);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New PDF from Markdown">
      <form onSubmit={run} className="space-y-4">
        <div>
          <Label htmlFor="md-title">Title</Label>
          <Input id="md-title" placeholder="Untitled" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="md-body">Markdown</Label>
          <Textarea
            id="md-body"
            rows={12}
            required
            autoFocus
            placeholder={"# Heading\n\nA paragraph of text.\n\n- A bullet\n- Another bullet"}
            className="mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate">Supports #/##/### headings, - or * bullets, **bold**, and blank-line paragraph breaks.</p>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <Button type="submit" className="w-full" disabled={working}>
          {working ? "Creating…" : "Create PDF"}
        </Button>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// CSV to PDF: renders simple comma-separated data as a paginated table with a bolded header row —
// column widths are computed from the data itself so a spreadsheet export doesn't need any manual
// layout. Deliberately handles only unquoted CSV (the common case for pasted/exported data); a
// field containing a literal comma needs to be re-separated by hand first.

export function CsvToPdfModal({
  open,
  onClose,
  folderId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [csv, setCsv] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setTitle("");
      setCsv("");
      setError(null);
    }
  }, [open]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const rows = csv
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => r.split(",").map((cell) => cell.trim()));
    if (rows.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument, StandardFonts, PageSizes, rgb } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      const regular = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const margin = 36;
      const [pageWidth, pageHeight] = [PageSizes.A4[1], PageSizes.A4[0]]; // landscape — tables are usually wider than tall
      const size = 9;
      const rowHeight = size * 2.2;
      const columnCount = Math.max(...rows.map((r) => r.length));
      const tableWidth = pageWidth - margin * 2;
      const columnWidths = Array.from({ length: columnCount }, (_, col) => {
        const maxLen = Math.max(...rows.map((r) => (r[col] ?? "").length), 3);
        return maxLen;
      });
      const totalUnits = columnWidths.reduce((a, b) => a + b, 0);
      const colPx = columnWidths.map((units) => (units / totalUnits) * tableWidth);

      let page = doc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - margin;
      rows.forEach((row, rowIndex) => {
        if (y < margin + rowHeight) {
          page = doc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        const isHeader = rowIndex === 0;
        if (isHeader) {
          page.drawRectangle({ x: margin, y: y - rowHeight + size * 0.3, width: tableWidth, height: rowHeight, color: rgb(0.92, 0.92, 0.9) });
        }
        let x = margin;
        row.forEach((cell, col) => {
          const w = colPx[col] ?? tableWidth / columnCount;
          const text = cell.length > 40 ? `${cell.slice(0, 37)}…` : cell;
          page.drawText(text, { x: x + 3, y: y - rowHeight + size * 0.8, size, font: isHeader ? bold : regular });
          x += w;
        });
        page.drawLine({ start: { x: margin, y: y - rowHeight }, end: { x: margin + tableWidth, y: y - rowHeight }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
        y -= rowHeight;
      });

      const bytes = await doc.save();
      const name = `${(title.trim() || "Table").replace(/\.pdf$/i, "")}.pdf`;
      await uploadPdf(bytes, name, folderId);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that document.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="CSV to PDF">
      <form onSubmit={run} className="space-y-4">
        <div>
          <Label htmlFor="csv-title">Title</Label>
          <Input id="csv-title" placeholder="Table" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="csv-body">CSV data</Label>
          <Textarea
            id="csv-body"
            rows={12}
            required
            autoFocus
            placeholder={"Name,Amount,Date\nAcme Inc,1200,2026-01-15"}
            className="mono"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate">The first row is treated as a header. Fields with a literal comma aren&apos;t supported.</p>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <Button type="submit" className="w-full" disabled={working}>
          {working ? "Creating…" : "Create PDF"}
        </Button>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Batch rename: renames every selected document at once using a pattern with {n} (a counter,
// zero-padded to the width you choose) and {name} (the original name, minus its .pdf extension) —
// applied in the order the documents are currently sorted/selected, the way a batch-rename tool in
// a file manager works.

export function BatchRenameModal({
  open,
  onClose,
  documents,
  onRenamed,
}: {
  open: boolean;
  onClose: () => void;
  documents: { id: string; name: string }[];
  onRenamed: () => void;
}) {
  const [pattern, setPattern] = useState("{name}");
  const [startAt, setStartAt] = useState(1);
  const [digits, setDigits] = useState(2);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setPattern("{name}");
      setStartAt(1);
      setError(null);
    }
  }, [open]);

  function preview(index: number) {
    const original = documents[index]?.name.replace(/\.pdf$/i, "") ?? "";
    const counter = String(startAt + index).padStart(Math.max(1, digits), "0");
    const name = pattern.replace(/\{n\}/g, counter).replace(/\{name\}/g, original);
    return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
  }

  async function apply() {
    if (documents.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      for (let i = 0; i < documents.length; i++) {
        const response = await fetch(`/api/backend/documents/${documents[i].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: preview(i) }),
        });
        if (!response.ok) throw new Error(`Could not rename "${documents[i].name}".`);
      }
      onRenamed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename these documents.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Batch rename">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Renames all {documents.length} selected document{documents.length === 1 ? "" : "s"}. Use{" "}
          <code className="mono">{"{n}"}</code> for a counter and <code className="mono">{"{name}"}</code> for the
          original name.
        </p>
        <div>
          <Label htmlFor="rename-pattern">Pattern</Label>
          <Input id="rename-pattern" placeholder="Invoice {n} — {name}" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="rename-start">Counter starts at</Label>
            <Input id="rename-start" type="number" min={0} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))} />
          </div>
          <div>
            <Label htmlFor="rename-digits">Counter digits</Label>
            <Input id="rename-digits" type="number" min={1} max={6} value={digits} onChange={(e) => setDigits(Number(e.target.value))} />
          </div>
        </div>
        {documents.length > 0 && (
          <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-line p-2 text-xs text-slate">
            {documents.slice(0, 8).map((_, i) => (
              <p key={i} className="mono truncate">
                {preview(i)}
              </p>
            ))}
            {documents.length > 8 && <p>…and {documents.length - 8} more</p>}
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={working || documents.length === 0}>
            {working ? "Renaming…" : "Rename all"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Batch redact: runs the editor's own Find & Redact (round 2) across every selected document at
// once instead of one at a time — a real compliance/legal-review gap even Acrobat doesn't close
// natively (its batch sequences don't include redaction). Each match is still rasterized exactly
// like the single-document tool, and results land as new "(redacted)" copies so nothing is silently
// overwritten.

type BatchRedactResult = { name: string; matchCount: number; created?: { id: string; name: string } };

export function BatchRedactModal({
  open,
  onClose,
  documents,
  folderId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  documents: { id: string; name: string }[];
  folderId: string | null;
  onCreated: () => void;
}) {
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<BatchRedactResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setQuery("");
      setResults(null);
      setError(null);
      setProgress(0);
    }
  }, [open]);

  async function run() {
    if (!query.trim() || documents.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const needle = query.trim().toLowerCase();
      const out: BatchRedactResult[] = [];
      for (const doc of documents) {
        const response = await fetch(`/api/documents/${doc.id}/content`);
        if (!response.ok) {
          out.push({ name: doc.name, matchCount: 0 });
          setProgress((p) => p + 1);
          continue;
        }
        const bytes = await response.arrayBuffer();
        const pdf = await PDFDocument.load(bytes);
        const matches: { pageIndex: number; box: { x: number; y: number; width: number; height: number } }[] = [];
        for (let i = 0; i < pdf.getPageCount(); i++) {
          const runs = await extractTextRuns(pdf.getPage(i));
          for (const run of runs) {
            if (run.text && run.text.toLowerCase().includes(needle)) matches.push({ pageIndex: i, box: run.box });
          }
        }
        if (matches.length === 0) {
          out.push({ name: doc.name, matchCount: 0 });
          setProgress((p) => p + 1);
          continue;
        }
        const byPage = new Map<number, typeof matches>();
        matches.forEach((m) => {
          if (!byPage.has(m.pageIndex)) byPage.set(m.pageIndex, []);
          byPage.get(m.pageIndex)!.push(m);
        });
        for (const [pageIndex, pageMatches] of byPage) {
          const page = pdf.getPage(pageIndex);
          const pdfW = page.getWidth();
          const pdfH = page.getHeight();
          const pdfBytes = await pdf.save();
          const { canvas } = await renderPageToCanvas(pdfBytes, pageIndex + 1, 2);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.fillStyle = "#000000";
          for (const m of pageMatches) {
            ctx.fillRect(m.box.x * 2, canvas.height - (m.box.y + m.box.height) * 2, m.box.width * 2, m.box.height * 2);
          }
          const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
            canvas.toBlob(async (blob) => {
              if (!blob) return reject(new Error("Could not export a redacted page."));
              resolve(new Uint8Array(await blob.arrayBuffer()));
            }, "image/png");
          });
          const image = await pdf.embedPng(pngBytes);
          pdf.removePage(pageIndex);
          const newPage = pdf.insertPage(pageIndex, [pdfW, pdfH]);
          newPage.drawImage(image, { x: 0, y: 0, width: pdfW, height: pdfH });
        }
        const finalBytes = await pdf.save();
        const created = await uploadPdf(finalBytes, `${doc.name.replace(/\.pdf$/i, "")} (redacted).pdf`, folderId);
        out.push({ name: doc.name, matchCount: matches.length, created });
        setProgress((p) => p + 1);
      }
      setResults(out);
      if (out.some((r) => r.created)) onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not batch-redact these documents.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Batch redact">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Finds and redacts every occurrence of a phrase across all {documents.length} selected document
          {documents.length === 1 ? "" : "s"}. Each affected page is flattened to an image, same as the editor&apos;s
          own Find & Redact. Results are created as new &quot;(redacted)&quot; copies — nothing is overwritten.
        </p>
        {!results && (
          <div className="flex gap-2">
            <Input placeholder="Text to find and redact…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button onClick={run} disabled={working || !query.trim() || documents.length === 0}>
              {working ? `Working ${progress}/${documents.length}…` : "Run"}
            </Button>
          </div>
        )}
        {results && (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-sm">
            {results.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{r.name}</span>
                <span className="shrink-0 text-xs text-slate">
                  {r.matchCount === 0
                    ? "no matches"
                    : r.created && (
                        <a className="text-signal-dim underline" href={`/documents/${r.created.id}`}>
                          {r.matchCount} redacted →
                        </a>
                      )}
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {results ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
