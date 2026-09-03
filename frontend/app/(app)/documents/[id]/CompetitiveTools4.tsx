"use client";

import { useEffect, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { PDFArray, PDFDict, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import { Button, Modal } from "@/components/ui";
import { loadPdfJs, toArrayBuffer } from "@/lib/pdfClient";
import { buildAndUpload } from "./ToolModals";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Walks the Bookmarks (round 3) outline tree — a linked list of Title/Dest/Next dicts hanging off
 *  Catalog/Outlines — and resolves each item's Dest back to a page index. Shared by every tool here
 *  that reads bookmarks, since pdf-lib has no high-level API to do this for us (same reason round 3
 *  had to build the tree by hand in the first place). Returns [] if there are no bookmarks. */
function readOutline(doc: PDFDocument): { title: string; pageIndex: number }[] {
  const outlinesRef = doc.catalog.get(PDFName.of("Outlines"));
  if (!outlinesRef) return [];
  let outlines: PDFDict;
  try {
    outlines = doc.context.lookup(outlinesRef, PDFDict);
  } catch {
    return [];
  }
  const pages = doc.getPages();
  const items: { title: string; pageIndex: number }[] = [];
  let cursor = outlines.get(PDFName.of("First"));
  let guard = 0;
  while (cursor && guard < 10000) {
    guard += 1;
    let item: PDFDict;
    try {
      item = doc.context.lookup(cursor, PDFDict);
    } catch {
      break;
    }
    const titleObj = item.lookup(PDFName.of("Title"));
    const destObj = item.lookup(PDFName.of("Dest"));
    if (titleObj instanceof PDFString && destObj instanceof PDFArray && destObj.size() > 0) {
      const pageRef = destObj.get(0);
      const pageIndex = pages.findIndex((p) => p.ref.tag === (pageRef as { tag?: unknown }).tag);
      if (pageIndex !== -1) items.push({ title: titleObj.asString(), pageIndex });
    }
    cursor = item.get(PDFName.of("Next"));
  }
  return items;
}

// -------------------------------------------------------------------------------------------
// Split by bookmarks: once a document has bookmarks (round 3's Bookmarks… tool, or ones it already
// carried from another PDF program), this is the fast way to break a long combined document back
// into one file per section — each bookmark's page becomes the start of a new document, running
// until the next bookmark (or the end of the document).

export function SplitByBookmarksModal({
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
  const [outline, setOutline] = useState<{ title: string; pageIndex: number }[] | null>(null);

  useEffect(() => {
    if (open && pdfDoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads this document's current bookmarks each time the modal (re)opens, not reacting to external state
      setOutline(readOutline(pdfDoc));
      setCreated([]);
      setError(null);
    }
  }, [open, pdfDoc]);

  async function run() {
    if (!pdfDoc || !outline || outline.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      const baseName = docName.replace(/\.pdf$/i, "");
      const sorted = [...outline].sort((a, b) => a.pageIndex - b.pageIndex);
      const results: { id: string; name: string }[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i].pageIndex;
        const end = i + 1 < sorted.length ? sorted[i + 1].pageIndex - 1 : pageCount - 1;
        if (end < start) continue;
        const indices = Array.from({ length: end - start + 1 }, (_, k) => start + k);
        const safeTitle = sorted[i].title.replace(/[\\/:*?"<>|]/g, "").trim() || `Section ${i + 1}`;
        results.push(await buildAndUpload(pdfDoc, indices, `${baseName} — ${safeTitle}.pdf`, folderId));
      }
      setCreated(results);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not split this document by bookmarks.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Split by bookmarks">
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
          <p className="text-xs text-slate">
            Creates one new document per bookmark, running from that bookmark&apos;s page to the page before the
            next one. This document is untouched.
          </p>
          {outline === null ? (
            <p className="text-sm text-slate">Checking for bookmarks…</p>
          ) : outline.length === 0 ? (
            <p className="text-sm text-slate">This document has no bookmarks yet — add some with Bookmarks… first.</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-xs text-ink">
              {outline.map((item, i) => (
                <li key={i}>
                  <span className="mono text-slate">p.{item.pageIndex + 1}</span> — {item.title}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-brass">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={working || !outline || outline.length === 0}>
              {working ? "Splitting…" : "Split"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Insert table of contents page: unlike Bookmarks (round 3), which only ever populates the reader's
// side-panel outline, this prints an actual page — titles, dot leaders, and page numbers — at the
// front of the document, the way a printed report or book has one. Built from the same bookmarks.

export function InsertTocPageModal({
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
  const [outline, setOutline] = useState<{ title: string; pageIndex: number }[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && pdfDoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads this document's current bookmarks each time the modal (re)opens, not reacting to external state
      setOutline(readOutline(pdfDoc));
      setError(null);
    }
  }, [open, pdfDoc]);

  async function apply() {
    if (!pdfDoc || !outline || outline.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const [refWidth, refHeight] = [pdfDoc.getPage(0).getWidth(), pdfDoc.getPage(0).getHeight()];
      const margin = 54;
      const size = 11;
      const lineHeight = 22;
      const titleHeight = 40;
      const availableHeight = refHeight - margin * 2 - titleHeight;
      const linesPerPage = Math.max(1, Math.floor(availableHeight / lineHeight));
      const tocPageCount = Math.max(1, Math.ceil(outline.length / linesPerPage));

      const sorted = [...outline].sort((a, b) => a.pageIndex - b.pageIndex);
      let cursor = 0;
      for (let sheet = 0; sheet < tocPageCount; sheet++) {
        const page = pdfDoc.insertPage(sheet, [refWidth, refHeight]);
        let y = refHeight - margin;
        if (sheet === 0) {
          page.drawText("Table of Contents", { x: margin, y, size: 20, font: boldFont });
          y -= titleHeight;
        }
        for (let line = 0; line < linesPerPage && cursor < sorted.length; line++, cursor++) {
          const entry = sorted[cursor];
          const label = `${entry.pageIndex + tocPageCount + 1}`;
          const labelWidth = font.widthOfTextAtSize(label, size);
          const titleWidth = font.widthOfTextAtSize(entry.title, size);
          const dotWidth = font.widthOfTextAtSize(".", size) || 3;
          const gap = refWidth - margin * 2 - titleWidth - labelWidth - 8;
          const dotCount = Math.max(0, Math.floor(gap / dotWidth));
          page.drawText(entry.title, { x: margin, y, size, font });
          if (dotCount > 0) page.drawText(".".repeat(dotCount), { x: margin + titleWidth + 4, y, size, font, color: rgb(0.6, 0.6, 0.6) });
          page.drawText(label, { x: refWidth - margin - labelWidth, y, size, font });
          y -= lineHeight;
        }
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not insert a table of contents.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Insert table of contents page">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Inserts one or more printed pages at the front of the document listing every bookmark and its page
          number — unlike Bookmarks…, which only adds an entry to the reader&apos;s own side panel.
        </p>
        {outline === null ? (
          <p className="text-sm text-slate">Checking for bookmarks…</p>
        ) : outline.length === 0 ? (
          <p className="text-sm text-slate">This document has no bookmarks yet — add some with Bookmarks… first.</p>
        ) : (
          <p className="text-sm text-ink">{outline.length} bookmark{outline.length === 1 ? "" : "s"} found.</p>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || !outline || outline.length === 0}>
            {applying ? "Inserting…" : "Insert"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Export / remove bookmarks: a plain-text list for pasting into an email or ticket without opening
// the PDF, and the paired cleanup for a document that shouldn't carry its outline any further (e.g.
// before sharing outside your organization).

export function ExportBookmarksModal({
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
  const [outline, setOutline] = useState<{ title: string; pageIndex: number }[] | null>(null);

  useEffect(() => {
    if (open && pdfDoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads this document's current bookmarks each time the modal (re)opens, not reacting to external state
      setOutline(readOutline(pdfDoc));
    }
  }, [open, pdfDoc]);

  function download() {
    if (!outline) return;
    const text = outline.map((item) => `p.${item.pageIndex + 1}\t${item.title}`).join("\n");
    downloadBlob(new Blob([text], { type: "text/plain" }), `${docName.replace(/\.pdf$/i, "")}-bookmarks.txt`);
  }

  return (
    <Modal open={open} onClose={onClose} title="Export bookmarks">
      <div className="space-y-4">
        {outline === null ? (
          <p className="text-sm text-slate">Checking for bookmarks…</p>
        ) : outline.length === 0 ? (
          <p className="text-sm text-slate">This document has no bookmarks.</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-xs text-ink">
            {outline.map((item, i) => (
              <li key={i}>
                <span className="mono text-slate">p.{item.pageIndex + 1}</span> — {item.title}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={download} disabled={!outline || outline.length === 0}>
            Download .txt
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function RemoveBookmarksModal({
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setError(null);
    }
  }, [open]);

  function apply() {
    if (!pdfDoc) return;
    if (!pdfDoc.catalog.get(PDFName.of("Outlines"))) {
      setError("This document has no bookmarks.");
      return;
    }
    pdfDoc.catalog.delete(PDFName.of("Outlines"));
    onApplied();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Remove bookmarks">
      <div className="space-y-4">
        <p className="text-xs text-slate">Removes this document&apos;s navigation outline entirely.</p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply}>
            Remove bookmarks
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Extract comments: reads real PDF comment annotations (Text/FreeText/Highlight notes with a
// Contents string) — the kind a reviewer leaves in Acrobat before a document is uploaded here, not
// the freehand pen/shape/text markup this app's own Annotate tool draws directly onto the page
// (which has no separate comment record to read back out).

type Comment = { pageIndex: number; subtype: string; text: string };

export function ExtractCommentsModal({
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
  const [comments, setComments] = useState<Comment[] | null>(null);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    const found: Comment[] = [];
    pdfDoc.getPages().forEach((page, pageIndex) => {
      let annots: PDFArray;
      try {
        annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
      } catch {
        return;
      }
      for (let i = 0; i < annots.size(); i++) {
        try {
          const dict = pdfDoc.context.lookup(annots.get(i), PDFDict);
          const contents = dict.lookup(PDFName.of("Contents"));
          if (!(contents instanceof PDFString)) continue;
          const subtypeObj = dict.lookup(PDFName.of("Subtype"));
          const subtype = subtypeObj instanceof PDFName ? subtypeObj.asString().replace(/^\//, "") : "Comment";
          found.push({ pageIndex, subtype, text: contents.asString() });
        } catch {
          // an unreadable annotation dict just isn't included in the report
        }
      }
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- scans this document's current annotations each time the modal (re)opens, not reacting to external state
    setComments(found);
  }, [open, pdfDoc]);

  function download() {
    if (!comments) return;
    const text = comments.map((c) => `p.${c.pageIndex + 1} [${c.subtype}]\n${c.text}\n`).join("\n");
    downloadBlob(new Blob([text], { type: "text/plain" }), `${docName.replace(/\.pdf$/i, "")}-comments.txt`);
  }

  return (
    <Modal open={open} onClose={onClose} title="Extract comments">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Reads real PDF comment annotations — the kind left in Acrobat or similar software — not the freehand
          markup this app&apos;s own Annotate tool draws directly onto the page.
        </p>
        {comments === null ? (
          <p className="text-sm text-slate">Scanning…</p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-slate">No comments found on any page.</p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-line p-2 text-xs text-ink">
            {comments.map((c, i) => (
              <div key={i}>
                <p className="mono text-slate">
                  p.{c.pageIndex + 1} [{c.subtype}]
                </p>
                <p>{c.text}</p>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={download} disabled={!comments || comments.length === 0}>
            Download .txt
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Document statistics: word/character count and an estimated reading time across the whole
// document — Acrobat's own "Document Properties" doesn't surface this, and it's a step beyond
// Extract Text (round 1), which hands you the raw text but not a summary of it.

export function DocumentStatsModal({
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
  const [stats, setStats] = useState<{ words: number; characters: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const bytes = await pdfDoc!.save();
        const pdfjsLib = await loadPdfJs();
        const doc = await pdfjsLib.getDocument({ data: toArrayBuffer(bytes) }).promise;
        let words = 0;
        let characters = 0;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          characters += text.replace(/\s/g, "").length;
          words += text.split(/\s+/).filter(Boolean).length;
        }
        if (!cancelled) setStats({ words, characters });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [open, pdfDoc]);

  const readingMinutes = stats ? Math.max(1, Math.round(stats.words / 200)) : 0;

  return (
    <Modal open={open} onClose={onClose} title="Document statistics">
      <div className="space-y-3 text-sm text-ink">
        {loading || !stats ? (
          <p className="text-slate">Counting…</p>
        ) : (
          <>
            <p>
              <span className="text-slate">Pages:</span> {pageCount}
            </p>
            <p>
              <span className="text-slate">Words:</span> {stats.words.toLocaleString()}
            </p>
            <p>
              <span className="text-slate">Characters (no spaces):</span> {stats.characters.toLocaleString()}
            </p>
            <p>
              <span className="text-slate">Estimated reading time:</span> {readingMinutes} min
            </p>
          </>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
