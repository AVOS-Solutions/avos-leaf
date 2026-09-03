"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFObject, PDFString, rgb } from "pdf-lib";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { canvasPointToPdf, renderPageToCanvas } from "@/lib/pdfClient";
import { extractTextRuns, type TextRun } from "@/lib/pdfContentStream";
import { parsePageRanges } from "./ToolModals";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type Match = { pageIndex: number; box: TextRun["box"]; snippet: string; label: string };

async function findMatches(pdfDoc: PDFDocument, pageCount: number, testers: { label: string; test: (text: string) => boolean }[]): Promise<Match[]> {
  const found: Match[] = [];
  for (let i = 0; i < pageCount; i++) {
    const runs = await extractTextRuns(pdfDoc.getPage(i));
    for (const run of runs) {
      if (!run.text) continue;
      for (const tester of testers) {
        if (tester.test(run.text)) {
          found.push({ pageIndex: i, box: run.box, snippet: run.text.trim().slice(0, 80), label: tester.label });
          break;
        }
      }
    }
  }
  return found;
}

// -------------------------------------------------------------------------------------------
// Redact by pattern: Find & Redact (round 2) only ever matches one literal phrase — this instead
// runs a set of common sensitive-data patterns (email, phone, SSN-like, card-number-like) plus an
// optional custom regex across the whole document in one pass, the way a compliance/legal review
// pass usually needs ("find every email address in this filing"). Same match-then-select-then-
// rasterize flow as Find & Redact, since a false-positive pattern match is far more likely here
// than with a literal phrase — reviewing the list before applying matters more, not less.

const REDACT_PRESETS: Record<string, { label: string; pattern: RegExp }> = {
  email: { label: "Email address", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  phone: { label: "Phone number", pattern: /(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
  ssn: { label: "SSN-like (###-##-####)", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  card: { label: "Card-number-like (13-16 digits)", pattern: /\b(?:\d[ -]?){13,16}\b/ },
};

export function RedactPatternsModal({
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
  const [enabled, setEnabled] = useState<Set<string>>(new Set(["email"]));
  const [customPattern, setCustomPattern] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setMatches(null);
      setSelected(new Set());
      setError(null);
    }
  }, [open]);

  function toggle(key: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function search() {
    if (!pdfDoc) return;
    setSearching(true);
    setError(null);
    try {
      const testers: { label: string; test: (text: string) => boolean }[] = [];
      for (const key of enabled) {
        const preset = REDACT_PRESETS[key];
        testers.push({ label: preset.label, test: (text) => preset.pattern.test(text) });
      }
      if (customPattern.trim()) {
        const re = new RegExp(customPattern, "i");
        testers.push({ label: "Custom pattern", test: (text) => re.test(text) });
      }
      if (testers.length === 0) throw new Error("Choose at least one pattern.");
      const found = await findMatches(pdfDoc, pageCount, testers);
      setMatches(found);
      setSelected(new Set(found.map((_, i) => i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not search this document. Check your custom pattern.");
    } finally {
      setSearching(false);
    }
  }

  function toggleMatch(i: number) {
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
    <Modal open={open} onClose={onClose} title="Redact by pattern">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Scans the whole document for common sensitive-data patterns. Patterns can over-match (e.g. any run of
          13-16 digits) — review the list before redacting.
        </p>
        <div className="space-y-1">
          {Object.entries(REDACT_PRESETS).map(([key, preset]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={enabled.has(key)} onChange={() => toggle(key)} />
              {preset.label}
            </label>
          ))}
        </div>
        <div>
          <Label htmlFor="redact-custom">Custom regular expression (optional)</Label>
          <Input id="redact-custom" placeholder="e.g. INV-\d{6}" value={customPattern} onChange={(e) => setCustomPattern(e.target.value)} />
        </div>
        <Button variant="secondary" onClick={search} disabled={searching}>
          {searching ? "Searching…" : "Find matches"}
        </Button>
        {error && <p className="text-sm text-brass">{error}</p>}
        {matches && (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {matches.length === 0 ? (
              <p className="text-sm text-slate">No matches found.</p>
            ) : (
              matches.map((m, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-ink">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggleMatch(i)} className="mt-0.5" />
                  <span>
                    <span className="mono text-slate">p.{m.pageIndex + 1}</span> [{m.label}] — “{m.snippet}
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
            {applying ? "Redacting…" : `Redact ${selected.size || ""}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Find & mark: like Find & Redact, but non-destructive — a translucent highlight, an underline, or
// a strikethrough drawn directly onto the existing page (no rasterization, unlike redact, since the
// point here is to annotate text while keeping it intact and selectable underneath).

type MarkMode = "highlight" | "underline" | "strikethrough";
const MARK_COLORS: Record<string, [number, number, number]> = {
  yellow: [1, 0.92, 0.2],
  green: [0.6, 0.95, 0.5],
  pink: [1, 0.6, 0.8],
  blue: [0.55, 0.8, 1],
};

export function FindMarkModal({
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
  const [mode, setMode] = useState<MarkMode>("highlight");
  const [color, setColor] = useState<keyof typeof MARK_COLORS>("yellow");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
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
      const found = await findMatches(pdfDoc, pageCount, [{ label: "match", test: (text) => text.toLowerCase().includes(needle) }]);
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
      const [r, g, b] = MARK_COLORS[color];
      matches.forEach((m, i) => {
        if (!selected.has(i)) return;
        const page = pdfDoc.getPage(m.pageIndex);
        if (mode === "highlight") {
          page.drawRectangle({ x: m.box.x, y: m.box.y, width: m.box.width, height: m.box.height, color: rgb(r, g, b), opacity: 0.45 });
        } else if (mode === "underline") {
          page.drawLine({ start: { x: m.box.x, y: m.box.y }, end: { x: m.box.x + m.box.width, y: m.box.y }, thickness: 1.2, color: rgb(r, g, b) });
        } else {
          const midY = m.box.y + m.box.height / 2;
          page.drawLine({ start: { x: m.box.x, y: midY }, end: { x: m.box.x + m.box.width, y: midY }, thickness: 1.2, color: rgb(r, g, b) });
        }
      });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark these matches.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Find & mark">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Finds every occurrence of a word or phrase and highlights, underlines, or strikes through them — unlike
          Find & Redact, the text stays intact and selectable underneath.
        </p>
        <div className="flex gap-2">
          <Input placeholder="Text to find…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button variant="secondary" onClick={search} disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Find"}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="mark-mode">Mark as</Label>
            <Select id="mark-mode" value={mode} onChange={(e) => setMode(e.target.value as MarkMode)}>
              <option value="highlight">Highlight</option>
              <option value="underline">Underline</option>
              <option value="strikethrough">Strikethrough</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="mark-color">Color</Label>
            <Select id="mark-color" value={color} onChange={(e) => setColor(e.target.value as keyof typeof MARK_COLORS)}>
              {Object.keys(MARK_COLORS).map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </Select>
          </div>
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
          <Button onClick={apply} disabled={!matches || selected.size === 0 || applying}>
            {applying ? "Marking…" : `Mark ${selected.size || ""}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Photo filters: same rasterize-and-rebuild mechanics as Compress/Grayscale (round 2), but with a
// choice of pixel filters instead of just desaturating — a lightweight photo-editing pass for
// documents that are really scans or photos rather than typed text.

function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

const PHOTO_FILTERS = {
  invert: (data: Uint8ClampedArray) => {
    for (let p = 0; p < data.length; p += 4) {
      data[p] = 255 - data[p];
      data[p + 1] = 255 - data[p + 1];
      data[p + 2] = 255 - data[p + 2];
    }
  },
  sepia: (data: Uint8ClampedArray) => {
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      data[p] = clamp255(0.393 * r + 0.769 * g + 0.189 * b);
      data[p + 1] = clamp255(0.349 * r + 0.686 * g + 0.168 * b);
      data[p + 2] = clamp255(0.272 * r + 0.534 * g + 0.131 * b);
    }
  },
  brighten: (data: Uint8ClampedArray) => {
    for (let p = 0; p < data.length; p += 4) {
      data[p] = clamp255(data[p] * 1.3);
      data[p + 1] = clamp255(data[p + 1] * 1.3);
      data[p + 2] = clamp255(data[p + 2] * 1.3);
    }
  },
  darken: (data: Uint8ClampedArray) => {
    for (let p = 0; p < data.length; p += 4) {
      data[p] = clamp255(data[p] * 0.7);
      data[p + 1] = clamp255(data[p + 1] * 0.7);
      data[p + 2] = clamp255(data[p + 2] * 0.7);
    }
  },
  blur: (data: Uint8ClampedArray, width: number, height: number) => {
    const copy = Uint8ClampedArray.from(data);
    const at = (x: number, y: number, ch: number) => copy[(y * width + x) * 4 + ch];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0;
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
              sum += at(nx, ny, ch);
              count += 1;
            }
          }
          data[(y * width + x) * 4 + ch] = sum / count;
        }
      }
    }
  },
} as const;
type PhotoFilterKey = keyof typeof PHOTO_FILTERS;
const PHOTO_FILTER_LABELS: Record<PhotoFilterKey, string> = {
  invert: "Invert colors",
  sepia: "Sepia tone",
  brighten: "Brighten",
  darken: "Darken",
  blur: "Blur",
};

export function PhotoFiltersModal({
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
  const [filter, setFilter] = useState<PhotoFilterKey>("invert");
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
        if (!ctx) throw new Error("Could not prepare a page for filtering.");
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (filter === "blur") PHOTO_FILTERS.blur(imageData.data, canvas.width, canvas.height);
        else PHOTO_FILTERS[filter](imageData.data);
        ctx.putImageData(imageData, 0, 0);
        const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
          canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error("Could not export a filtered page."));
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
      setError(err instanceof Error ? err.message : "Could not apply this filter.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Photo filters">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Like Compress/Grayscale, this redraws every page as a flattened image — text is no longer selectable
          afterward. Best for documents made of scans or photos.
        </p>
        <div>
          <Label htmlFor="photo-filter">Filter</Label>
          <Select id="photo-filter" value={filter} onChange={(e) => setFilter(e.target.value as PhotoFilterKey)}>
            {(Object.keys(PHOTO_FILTER_LABELS) as PhotoFilterKey[]).map((key) => (
              <option key={key} value={key}>
                {PHOTO_FILTER_LABELS[key]}
              </option>
            ))}
          </Select>
        </div>
        {applying && <p className="text-xs text-slate">Filtering page {progress} of {pageCount}…</p>}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Applying…" : "Apply to every page"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Duplicate pages by range: the thumbnail grid's "⧉" button only ever duplicates one page at a
// time, right after itself — this covers "duplicate pages 3-5" in one step, each duplicated page
// landing immediately after its original (not all bunched at the end).

export function DuplicateRangeModal({
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
      const indices = parsePageRanges(range, pageCount).sort((a, b) => a - b);
      let offset = 0;
      for (const i of indices) {
        const [copy] = await pdfDoc.copyPages(pdfDoc, [i + offset]);
        pdfDoc.insertPage(i + offset + 1, copy);
        offset += 1;
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not duplicate those pages.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Duplicate pages…">
      <div className="space-y-4">
        <div>
          <Label htmlFor="dup-range">Pages to duplicate</Label>
          <Input id="dup-range" placeholder="e.g. 3-5" value={range} onChange={(e) => setRange(e.target.value)} />
          <p className="mt-1 text-xs text-slate">Each duplicated page is inserted right after its original.</p>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Duplicating…" : "Duplicate"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Bookmarks: builds the PDF's navigation outline (the panel most readers show down the side) from a
// title typed against any subset of pages — constructed directly against pdf-lib's low-level object
// model (Catalog/Outlines tree of Title/Parent/Prev/Next/Dest dicts), since pdf-lib has no
// high-level bookmarks API.

export function BookmarksModal({
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
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setTitles({});
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    const entries = Object.entries(titles)
      .map(([index, title]) => ({ index: Number(index), title: title.trim() }))
      .filter((e) => e.title)
      .sort((a, b) => a.index - b.index);
    if (entries.length === 0) {
      setError("Enter at least one bookmark title.");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const context = pdfDoc.context;
      const pages = pdfDoc.getPages();
      const itemRefs = entries.map(() => context.nextRef());
      entries.forEach((entry, i) => {
        const dest = context.obj([pages[entry.index].ref, PDFName.of("Fit")]);
        const itemDict = context.obj({ Title: PDFString.of(entry.title), Dest: dest });
        if (i > 0) itemDict.set(PDFName.of("Prev"), itemRefs[i - 1]);
        if (i < itemRefs.length - 1) itemDict.set(PDFName.of("Next"), itemRefs[i + 1]);
        context.assign(itemRefs[i], itemDict);
      });
      const rootRef = context.nextRef();
      itemRefs.forEach((ref) => {
        const dict = context.lookup(ref, PDFDict);
        dict.set(PDFName.of("Parent"), rootRef);
      });
      const root = context.obj({ First: itemRefs[0], Last: itemRefs[itemRefs.length - 1], Count: PDFNumber.of(itemRefs.length) });
      context.assign(rootRef, root);
      pdfDoc.catalog.set(PDFName.of("Outlines"), rootRef);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add bookmarks.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add bookmarks">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Builds the navigation outline most PDF readers show in a side panel. Replaces this document&apos;s
          existing bookmarks, if any. Leave a page blank to skip it.
        </p>
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-line p-2">
          {Array.from({ length: pageCount }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="mono w-10 shrink-0 text-xs text-slate">p.{i + 1}</span>
              <Input
                placeholder="Bookmark title…"
                value={titles[i] ?? ""}
                onChange={(e) => setTitles((prev) => ({ ...prev, [i]: e.target.value }))}
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
            {applying ? "Adding…" : "Add bookmarks"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Page labels: the numbering scheme shown in the reader's own page indicator (e.g. front matter as
// i, ii, iii, then the body starting back at 1) — distinct from the page-numbers tool, which only
// ever stamps visible text onto the page itself. Built against the low-level Catalog/PageLabels
// number tree, since pdf-lib has no high-level API for it either.

const LABEL_STYLES = { D: "1, 2, 3", R: "I, II, III", r: "i, ii, iii", A: "A, B, C", a: "a, b, c", none: "No number (prefix only)" } as const;
type LabelStyleKey = keyof typeof LABEL_STYLES;
type LabelSection = { startPage: number; style: LabelStyleKey; prefix: string; startAt: number };

export function PageLabelsModal({
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
  const [sections, setSections] = useState<LabelSection[]>([{ startPage: 1, style: "D", prefix: "", startAt: 1 }]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setSections([{ startPage: 1, style: "D", prefix: "", startAt: 1 }]);
      setError(null);
    }
  }, [open]);

  function updateSection(i: number, patch: Partial<LabelSection>) {
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function addSection() {
    setSections((prev) => [...prev, { startPage: Math.min(pageCount, (prev[prev.length - 1]?.startPage ?? 0) + 1), style: "D", prefix: "", startAt: 1 }]);
  }

  function removeSection(i: number) {
    setSections((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const sorted = [...sections].sort((a, b) => a.startPage - b.startPage);
      const context = pdfDoc.context;
      const nums: PDFObject[] = [];
      for (const section of sorted) {
        const pageIndex = Math.min(Math.max(section.startPage - 1, 0), pageCount - 1);
        const labelDict: Record<string, PDFObject> = {};
        if (section.style !== "none") labelDict.S = PDFName.of(section.style);
        if (section.prefix) labelDict.P = PDFString.of(section.prefix);
        if (section.startAt !== 1) labelDict.St = PDFNumber.of(section.startAt);
        nums.push(PDFNumber.of(pageIndex), context.obj(labelDict));
      }
      pdfDoc.catalog.set(PDFName.of("PageLabels"), context.obj({ Nums: context.obj(nums) }));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set page labels.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Page labels">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Sets the numbering scheme your PDF reader shows in its own page indicator — e.g. front matter as i, ii,
          iii, then the body restarting at 1. This doesn&apos;t stamp anything visible on the page itself.
        </p>
        <div className="space-y-3">
          {sections.map((section, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line p-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor={`label-start-${i}`}>From page</Label>
                  <Input
                    id={`label-start-${i}`}
                    type="number"
                    min={1}
                    max={pageCount}
                    value={section.startPage}
                    onChange={(e) => updateSection(i, { startPage: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <Label htmlFor={`label-style-${i}`}>Style</Label>
                  <Select id={`label-style-${i}`} value={section.style} onChange={(e) => updateSection(i, { style: e.target.value as LabelStyleKey })}>
                    {Object.entries(LABEL_STYLES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`label-prefix-${i}`}>Prefix</Label>
                  <Input id={`label-prefix-${i}`} value={section.prefix} onChange={(e) => updateSection(i, { prefix: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor={`label-startat-${i}`}>Start numbering at</Label>
                  <Input
                    id={`label-startat-${i}`}
                    type="number"
                    min={1}
                    value={section.startAt}
                    onChange={(e) => updateSection(i, { startAt: Number(e.target.value) })}
                  />
                </div>
              </div>
              {sections.length > 1 && (
                <button type="button" className="text-xs text-brass" onClick={() => removeSection(i)}>
                  Remove section
                </button>
              )}
            </div>
          ))}
          <Button variant="secondary" onClick={addSection}>
            Add section
          </Button>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Setting…" : "Set page labels"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Opening page: sets which page a PDF reader jumps to as soon as the file is opened — useful for a
// document with a cover page where readers should land straight on the content.

export function OpeningPageModal({
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
  const [page, setPage] = useState(1);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setPage(1);
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const index = Math.min(Math.max(page - 1, 0), pageCount - 1);
      const target = pdfDoc.getPage(index);
      pdfDoc.catalog.set(PDFName.of("OpenAction"), pdfDoc.context.obj([target.ref, PDFName.of("Fit")]));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the opening page.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Set opening page">
      <div className="space-y-4">
        <div>
          <Label htmlFor="opening-page">Open to page</Label>
          <Input id="opening-page" type="number" min={1} max={pageCount} value={page} onChange={(e) => setPage(Number(e.target.value))} />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying}>
            {applying ? "Setting…" : "Set"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Clear metadata: wipes the visible document-info fields (Title/Author/Subject/Keywords/Producer/
// Creator) — the same fields Properties… lets you edit one at a time, cleared in one step before
// sharing a document outside your organization.

export function ClearMetadataModal({
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
      pdfDoc.setTitle("");
      pdfDoc.setAuthor("");
      pdfDoc.setSubject("");
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer("");
      pdfDoc.setCreator("");
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear this document's metadata.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Clear document metadata">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Clears the Title, Author, Subject, Keywords, Producer, and Creator fields — the same fields
          Properties… edits one at a time. This only covers those document-info fields, not every possible
          hidden metadata a PDF can carry.
        </p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Clearing…" : "Clear metadata"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Add link: draws one clickable rectangle on a chosen page, linking either to an external URL or to
// another page in this document — built as a low-level Link annotation, since pdf-lib has no
// high-level link API. Reuses RedactModal's box-drawing-on-a-rendered-page mechanics for the "where
// does the box go" interaction, and pdfClient's canvasPointToPdf for the coordinate conversion.

type Box = { start: { x: number; y: number }; end: { x: number; y: number } };

export function AddLinkModal({
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
  const [pageIndex, setPageIndex] = useState(0);
  const [target, setTarget] = useState<"url" | "page">("url");
  const [url, setUrl] = useState("");
  const [targetPage, setTargetPage] = useState(1);
  const [box, setBox] = useState<Box | null>(null);
  const [drawing, setDrawing] = useState<Box | null>(null);
  const [dims, setDims] = useState<{ canvasW: number; canvasH: number; pdfW: number; pdfH: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setPageIndex(0);
      setUrl("");
      setTargetPage(1);
      setBox(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function render() {
      setLoading(true);
      setBox(null);
      try {
        const page = pdfDoc!.getPage(pageIndex);
        const pdfW = page.getWidth();
        const pdfH = page.getHeight();
        const scale = Math.min(700 / pdfW, 1.6);
        const bytes = await pdfDoc!.save();
        const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, scale);
        if (cancelled) return;
        const bg = bgCanvasRef.current;
        const overlay = overlayRef.current;
        if (!bg || !overlay) return;
        bg.width = overlay.width = canvas.width;
        bg.height = overlay.height = canvas.height;
        bg.getContext("2d")?.drawImage(canvas, 0, 0);
        setDims({ canvasW: canvas.width, canvasH: canvas.height, pdfW, pdfH });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [open, pdfDoc, pageIndex]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const current = drawing ?? box;
    if (current) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.strokeRect(current.start.x, current.start.y, current.end.x - current.start.x, current.end.y - current.start.y);
      ctx.fillStyle = "rgba(37, 99, 235, 0.15)";
      ctx.fillRect(current.start.x, current.start.y, current.end.x - current.start.x, current.end.y - current.start.y);
    }
  }, [box, drawing]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointFromEvent(e);
    setDrawing({ start: p, end: p });
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    setDrawing({ ...drawing, end: pointFromEvent(e) });
  }

  function onPointerUp() {
    if (drawing) setBox(drawing);
    setDrawing(null);
  }

  async function apply() {
    if (!pdfDoc || !box || !dims) return;
    if (target === "url" && !url.trim()) {
      setError("Enter a URL.");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const p1 = canvasPointToPdf(box.start.x, box.start.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
      const p2 = canvasPointToPdf(box.end.x, box.end.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
      const rect = [Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)];
      const context = pdfDoc.context;
      const page = pdfDoc.getPage(pageIndex);
      const annotDict: Record<string, PDFObject> = {
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Link"),
        Rect: context.obj(rect),
        Border: context.obj([0, 0, 0]),
      };
      if (target === "url") {
        annotDict.A = context.obj({ Type: PDFName.of("Action"), S: PDFName.of("URI"), URI: PDFString.of(url.trim()) });
      } else {
        const destIndex = Math.min(Math.max(targetPage - 1, 0), pdfDoc.getPageCount() - 1);
        annotDict.Dest = context.obj([pdfDoc.getPage(destIndex).ref, PDFName.of("Fit")]);
      }
      const annotRef = context.register(context.obj(annotDict));
      let existing: PDFArray | undefined;
      try {
        existing = page.node.lookup(PDFName.of("Annots"), PDFArray);
      } catch {
        existing = undefined;
      }
      if (existing) existing.push(annotRef);
      else page.node.set(PDFName.of("Annots"), context.obj([annotRef]));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this link.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add link">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="link-page">Page</Label>
            <Input
              id="link-page"
              type="number"
              min={1}
              max={pageCount}
              value={pageIndex + 1}
              onChange={(e) => setPageIndex(Math.min(Math.max(Number(e.target.value) - 1, 0), pageCount - 1))}
            />
          </div>
          <div>
            <Label htmlFor="link-target">Links to</Label>
            <Select id="link-target" value={target} onChange={(e) => setTarget(e.target.value as "url" | "page")}>
              <option value="url">External URL</option>
              <option value="page">A page in this document</option>
            </Select>
          </div>
        </div>
        {target === "url" ? (
          <div>
            <Label htmlFor="link-url">URL</Label>
            <Input id="link-url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
        ) : (
          <div>
            <Label htmlFor="link-target-page">Target page</Label>
            <Input id="link-target-page" type="number" min={1} max={pageCount} value={targetPage} onChange={(e) => setTargetPage(Number(e.target.value))} />
          </div>
        )}
        <p className="text-xs text-slate">Drag on the page below to place the clickable area.</p>
        {loading ? (
          <p className="text-sm text-slate">Rendering…</p>
        ) : (
          <div className="relative inline-block border border-line">
            <canvas ref={bgCanvasRef} className="block" />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 cursor-crosshair touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || !box}>
            {applying ? "Adding…" : "Add link"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Remove all links: strips only Link annotations (URL or internal jump targets), leaving comments,
// highlights, and other markup from Remove Annotations untouched — a narrower, more targeted cleanup.

export function RemoveLinksModal({
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
      let removed = 0;
      for (const page of pdfDoc.getPages()) {
        let annots: PDFArray;
        try {
          annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
        } catch {
          continue;
        }
        const kept: PDFObject[] = [];
        for (let i = 0; i < annots.size(); i++) {
          const ref = annots.get(i);
          let isLink = false;
          try {
            const dict = pdfDoc.context.lookup(ref, PDFDict);
            const subtype = dict.lookup(PDFName.of("Subtype"));
            isLink = subtype instanceof PDFName && subtype.asString() === "/Link";
          } catch {
            isLink = false;
          }
          if (isLink) removed += 1;
          else kept.push(ref);
        }
        if (kept.length === 0) page.node.delete(PDFName.of("Annots"));
        else page.node.set(PDFName.of("Annots"), pdfDoc.context.obj(kept));
      }
      if (removed === 0) {
        setError("No links found on any page.");
        return;
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove links.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Remove all links">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Removes every clickable link (URL or jump-to-page) from every page, leaving comments and other markup
          from Remove Annotations untouched.
        </p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying}>
            {applying ? "Removing…" : "Remove links"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Visual compare: the text-based Compare (round 2) only ever diffs extracted text — this renders
// the same page number from both documents and highlights pixels that differ, catching layout or
// image changes a text diff can't see. Read-only, and single-page at a time (a full-document pixel
// diff would be slow and rarely needed at once).

export function VisualCompareModal({
  open,
  onClose,
  pdfDoc,
  pageCount,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageCount: number;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [page, setPage] = useState(1);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffCount, setDiffCount] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFile(null);
      setDiffCount(null);
      setError(null);
    }
  }, [open]);

  async function compare() {
    if (!pdfDoc || !file) return;
    setComparing(true);
    setError(null);
    setDiffCount(null);
    try {
      const scale = 1.5;
      const bytesA = await pdfDoc.save();
      const bytesB = new Uint8Array(await file.arrayBuffer());
      const [{ canvas: canvasA }, { canvas: canvasB }] = await Promise.all([
        renderPageToCanvas(bytesA, page, scale),
        renderPageToCanvas(bytesB, page, scale),
      ]);
      const width = Math.max(canvasA.width, canvasB.width);
      const height = Math.max(canvasA.height, canvasB.height);
      const out = canvasRef.current;
      if (!out) return;
      out.width = width;
      out.height = height;
      const ctxA = canvasA.getContext("2d")!;
      const ctxB = canvasB.getContext("2d")!;
      const dataA = ctxA.getImageData(0, 0, canvasA.width, canvasA.height);
      const dataB = ctxB.getImageData(0, 0, canvasB.width, canvasB.height);
      const outCtx = out.getContext("2d")!;
      const result = outCtx.createImageData(width, height);
      let diffPixels = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const inA = x < canvasA.width && y < canvasA.height;
          const inB = x < canvasB.width && y < canvasB.height;
          const ai = inA ? (y * canvasA.width + x) * 4 : -1;
          const bi = inB ? (y * canvasB.width + x) * 4 : -1;
          const ar = inA ? dataA.data[ai] : 255;
          const ag = inA ? dataA.data[ai + 1] : 255;
          const ab = inA ? dataA.data[ai + 2] : 255;
          const br = inB ? dataB.data[bi] : 255;
          const bg = inB ? dataB.data[bi + 1] : 255;
          const bb = inB ? dataB.data[bi + 2] : 255;
          const delta = Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
          if (delta > 30) {
            diffPixels += 1;
            result.data[idx] = 220;
            result.data[idx + 1] = 40;
            result.data[idx + 2] = 40;
            result.data[idx + 3] = 255;
          } else {
            const gray = (ar + ag + ab) / 3;
            result.data[idx] = gray;
            result.data[idx + 1] = gray;
            result.data[idx + 2] = gray;
            result.data[idx + 3] = 255;
          }
        }
      }
      outCtx.putImageData(result, 0, 0);
      setDiffCount(diffPixels);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compare these pages.");
    } finally {
      setComparing(false);
    }
  }

  function download() {
    canvasRef.current?.toBlob((blob) => {
      if (blob) downloadBlob(blob, `page-${page}-visual-diff.png`);
    }, "image/png");
  }

  return (
    <Modal open={open} onClose={onClose} title="Visual compare">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Renders the same page from both documents and highlights pixels that differ in red — catches layout or
          image changes a text diff can&apos;t see.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Other PDF</Label>
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-ink" />
          </div>
          <div>
            <Label htmlFor="vc-page">Page</Label>
            <Input id="vc-page" type="number" min={1} max={pageCount} value={page} onChange={(e) => setPage(Number(e.target.value))} />
          </div>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        {diffCount !== null && (
          <p className="text-sm text-ink">{diffCount === 0 ? "No visible differences on this page." : `${diffCount.toLocaleString()} differing pixels highlighted below.`}</p>
        )}
        <div className="max-h-80 overflow-auto rounded-md border border-line">
          <canvas ref={canvasRef} className="block max-w-full" />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {diffCount !== null && (
            <Button variant="secondary" onClick={download}>
              Download image
            </Button>
          )}
          <Button onClick={compare} disabled={comparing || !file}>
            {comparing ? "Comparing…" : "Compare"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
