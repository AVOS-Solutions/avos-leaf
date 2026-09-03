"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageSizes, PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { Button, Input } from "@/components/ui";
import { loadPdfJs, renderPageToCanvas, toArrayBuffer } from "@/lib/pdfClient";
import { AnnotateModal } from "./AnnotateModal";
import { EditTextModal } from "./EditTextModal";
import { RedactModal } from "./RedactModal";
import { SignModal } from "./SignModal";
import { FillFormModal } from "./FillFormModal";
import { CropModal, ExtractTextModal, MetadataModal, PageNumbersModal, SplitModal, buildAndUpload } from "./ToolModals";
import { CompareModal, ExportImagesModal, FindRedactModal, HeaderFooterModal, InsertPdfModal } from "./CompetitiveTools";
import {
  BatesNumberingModal,
  BlackoutPagesModal,
  CompressModal,
  ContactSheetModal,
  DeleteRangeModal,
  ExtractImagesModal,
  FlattenFormModal,
  GrayscaleModal,
  ImageWatermarkModal,
  InsertBlankPagesModal,
  LongImageModal,
  NUpModal,
  OddEvenModal,
  RemoveAnnotationsModal,
  ReorderPagesModal,
  ResizePagesModal,
  RotateRangeModal,
  SplitToZipModal,
} from "./CompetitiveTools2";
import {
  AddLinkModal,
  BookmarksModal,
  ClearMetadataModal,
  DuplicateRangeModal,
  FindMarkModal,
  OpeningPageModal,
  PageLabelsModal,
  PhotoFiltersModal,
  RedactPatternsModal,
  RemoveLinksModal,
  VisualCompareModal,
} from "./CompetitiveTools3";
import {
  DocumentStatsModal,
  ExportBookmarksModal,
  ExtractCommentsModal,
  InsertTocPageModal,
  RemoveBookmarksModal,
  SplitByBookmarksModal,
} from "./CompetitiveTools4";
import {
  AccessibilityCheckModal,
  AttachFileModal,
  ManageAttachmentsModal,
  MeasureToolModal,
  PrepareFormModal,
  RemoveJavaScriptModal,
} from "./CompetitiveTools5";

const MAX_HISTORY = 20;

type SimpleModal =
  | "split"
  | "pageNumbers"
  | "metadata"
  | "crop"
  | "extractText"
  | "fillForm"
  | "sign"
  | "findRedact"
  | "headerFooter"
  | "insertPdf"
  | "exportImages"
  | "compare"
  | "oddEven"
  | "flattenForm"
  | "removeAnnotations"
  | "nUp"
  | "compress"
  | "grayscale"
  | "imageWatermark"
  | "bates"
  | "extractImages"
  | "rotateRange"
  | "deleteRange"
  | "blackout"
  | "resizePages"
  | "insertBlankPages"
  | "reorderPages"
  | "longImage"
  | "contactSheet"
  | "splitToZip"
  | "redactPatterns"
  | "findMark"
  | "photoFilters"
  | "duplicateRange"
  | "bookmarks"
  | "pageLabels"
  | "openingPage"
  | "clearMetadata"
  | "addLink"
  | "removeLinks"
  | "visualCompare"
  | "splitByBookmarks"
  | "insertToc"
  | "exportBookmarks"
  | "removeBookmarks"
  | "extractComments"
  | "documentStats"
  | "prepareForm"
  | "attachFile"
  | "manageAttachments"
  | "accessibilityCheck"
  | "removeJavaScript"
  | "measure"
  | null;

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
  const [editTextPage, setEditTextPage] = useState<number | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [matchCursor, setMatchCursor] = useState(0);
  const [copyingPage, setCopyingPage] = useState<number | null>(null);

  const [jumpValue, setJumpValue] = useState("");
  const [thumbSize, setThumbSize] = useState<"small" | "medium" | "large">("medium");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const draftKey = `avos-leaf-draft-${documentId}`;
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draftAvailable, setDraftAvailable] = useState<string | null>(null);

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
        try {
          const raw = localStorage.getItem(`avos-leaf-draft-${documentId}`);
          if (raw) setDraftAvailable((JSON.parse(raw) as { savedAt: string }).savedAt);
        } catch {
          // localStorage unavailable or the stored draft is corrupt — nothing to restore
        }
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

  /** Debounced local backup of the in-progress edit, so a crashed tab or an accidentally closed
   *  window doesn't lose work that was never explicitly saved. Capped well under typical browser
   *  localStorage quotas (~5-10MB) and wrapped defensively — a quota error or a document too big to
   *  fit just means no local backup for this edit, never a user-facing failure. */
  function scheduleDraftSave(doc: PDFDocument) {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(async () => {
      try {
        const bytes = await doc.save();
        if (bytes.byteLength > 3_000_000) return;
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        localStorage.setItem(draftKey, JSON.stringify({ savedAt: new Date().toISOString(), base64: btoa(binary) }));
      } catch {
        // quota exceeded or localStorage unavailable — the autosave is best-effort only
      }
    }, 1500);
  }

  async function restoreDraft() {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const { base64 } = JSON.parse(raw) as { base64: string };
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const restored = await PDFDocument.load(bytes);
      setPdfDoc(restored);
      setDirty(true);
      setDraftAvailable(null);
      await renderThumbnails(restored);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore that draft.");
    }
  }

  function discardDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // nothing to clean up if storage was already unavailable
    }
    setDraftAvailable(null);
  }

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
    scheduleDraftSave(pdfDoc);
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
    if (pdfDoc) {
      await renderThumbnails(pdfDoc);
      scheduleDraftSave(pdfDoc);
    }
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

  async function openEditText(index: number) {
    await beginToolMutation();
    setEditTextPage(index);
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
      setMatchCursor(0);
      if (matches.length > 0) jumpToPage(matches[0]);
    } finally {
      setSearching(false);
    }
  }

  function stepMatch(delta: 1 | -1) {
    if (!searchResults || searchResults.length === 0) return;
    const next = (matchCursor + delta + searchResults.length) % searchResults.length;
    setMatchCursor(next);
    jumpToPage(searchResults[next]);
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
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // nothing to clean up if storage was already unavailable
      }
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

  function dateStamp() {
    withDoc(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const label = new Date().toLocaleDateString();
      const size = 9;
      const margin = 20;
      for (const page of doc.getPages()) {
        const { width } = page.getSize();
        const textWidth = font.widthOfTextAtSize(label, size);
        page.drawText(label, { x: width - margin - textWidth, y: margin, size, font, color: rgb(0.4, 0.4, 0.4) });
      }
    });
  }

  /** Renders the page fresh (not from the small on-screen thumbnail) so what lands on the clipboard
   *  is reasonably sharp, then hands it to the async Clipboard API — which some browsers/contexts
   *  (non-HTTPS, older Safari, a denied permission) don't support for images, so a failure here is
   *  reported rather than silently swallowed. */
  async function copyPageImage(index: number) {
    if (!pdfDoc) return;
    setCopyingPage(index);
    try {
      const bytes = await pdfDoc.save();
      const { canvas } = await renderPageToCanvas(bytes, index + 1, 2);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render this page."))), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setNotice(`Page ${index + 1} copied to clipboard as an image.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy this page — your browser may not support copying images.");
    } finally {
      setCopyingPage(null);
    }
  }

  function reversePages() {
    withDoc((doc) => {
      const pages = [...doc.getPages()].reverse();
      const count = doc.getPageCount();
      for (let i = count - 1; i >= 0; i--) doc.removePage(i);
      pages.forEach((page, i) => doc.insertPage(i, page));
    });
  }

  function submitJump(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(jumpValue);
    if (!Number.isInteger(n) || n < 1 || n > thumbnails.length) return;
    jumpToPage(n - 1);
  }

  async function openPreview(index: number) {
    if (!pdfDoc) return;
    setPreviewIndex(index);
    setPreviewLoading(true);
    setPreviewSrc(null);
    try {
      const bytes = await pdfDoc.save();
      const { canvas } = await renderPageToCanvas(bytes, index + 1, 2);
      setPreviewSrc(canvas.toDataURL());
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    setPreviewIndex(null);
    setPreviewSrc(null);
  }

  // Keyboard shortcuts: Ctrl/Cmd+S saves, Ctrl/Cmd+P prints (both always, since they replace a
  // browser default we deliberately want to override even while a form field has focus). Undo/redo
  // only fire when focus isn't in a text field, so Ctrl+Z inside e.g. the header/footer text inputs
  // still undoes a keystroke there rather than the whole document.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (key === "p") {
        e.preventDefault();
        printDoc();
        return;
      }
      const target = document.activeElement;
      const inTextField = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inTextField) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, history, redoStack, docName]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const THUMB_GRID = {
    small: "grid-cols-3 sm:grid-cols-4 md:grid-cols-6",
    medium: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4",
    large: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3",
  } as const;

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

        {/* A single scrollable row rather than flex-wrap: with 11 buttons this would otherwise wrap
            into 4-5 stacked rows on a phone, pushing the actual page thumbnails well below the
            fold. Same tradeoff avos-quill's ribbon toolbar made for its own tab strip. */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("split")}>
            Split…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => mergeInputRef.current?.click()}>
            Merge PDF…
          </Button>
          <input ref={mergeInputRef} type="file" accept="application/pdf" className="hidden" onChange={mergeFile} />
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("fillForm")}>
            Fill form…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("sign")}>
            Sign…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={addWatermark}>
            Watermark…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("pageNumbers")}>
            Page numbers…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("crop")}>
            Crop…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("metadata")}>
            Properties…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("extractText")}>
            Extract text…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("insertPdf")}>
            Insert PDF…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("headerFooter")}>
            Header &amp; footer…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("findRedact")}>
            Find &amp; redact…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("exportImages")}>
            Export as images…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("compare")}>
            Compare…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("oddEven")}>
            Odd/even pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("splitToZip")}>
            Split to zip…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("nUp")}>
            N-up…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("contactSheet")}>
            Contact sheet…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("compress")}>
            Compress…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("grayscale")}>
            Grayscale…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("imageWatermark")}>
            Image stamp…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("bates")}>
            Bates numbering…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("extractImages")}>
            Extract images…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("longImage")}>
            Export as one image…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("flattenForm")}>
            Flatten form…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("removeAnnotations")}>
            Remove annotations…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("rotateRange")}>
            Rotate pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("deleteRange")}>
            Delete pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("blackout")}>
            Blackout pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("resizePages")}>
            Resize pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("insertBlankPages")}>
            Insert blank pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("reorderPages")}>
            Reorder pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("redactPatterns")}>
            Redact by pattern…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("findMark")}>
            Find &amp; mark…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("photoFilters")}>
            Photo filters…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("duplicateRange")}>
            Duplicate pages…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("bookmarks")}>
            Bookmarks…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("pageLabels")}>
            Page labels…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("openingPage")}>
            Opening page…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("clearMetadata")}>
            Clear metadata…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("addLink")}>
            Add link…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("removeLinks")}>
            Remove links…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("visualCompare")}>
            Visual compare…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("splitByBookmarks")}>
            Split by bookmarks…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("insertToc")}>
            Insert TOC page…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("exportBookmarks")}>
            Export bookmarks…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("removeBookmarks")}>
            Remove bookmarks…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("extractComments")}>
            Extract comments…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("documentStats")}>
            Document stats…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={dateStamp}>
            Date stamp
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("prepareForm")}>
            Prepare form…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("attachFile")}>
            Attach file…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("manageAttachments")}>
            Manage attachments…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("accessibilityCheck")}>
            Accessibility check…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("removeJavaScript")}>
            Remove JavaScript…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => openTool("measure")}>
            Measure…
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={reversePages}>
            Reverse pages
          </Button>
          <Button className="shrink-0" variant="secondary" onClick={() => rotateAll(90)}>
            Rotate all ⟳
          </Button>
          <Button className="shrink-0" variant={selectMode ? "primary" : "secondary"} onClick={toggleSelectMode}>
            {selectMode ? "Cancel select" : "Select pages…"}
          </Button>
        </div>

        {selectMode && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-paper-dim p-2">
            <span className="text-xs text-slate">{selected.size} selected</span>
            <Button variant="secondary" onClick={() => setSelected(new Set(thumbnails.map((_, i) => i)))}>
              Select all
            </Button>
            <Button variant="secondary" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              Select none
            </Button>
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
          {searchResults && searchResults.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-slate">
              <button type="button" className="hover:text-ink" onClick={() => stepMatch(-1)}>
                ‹ prev
              </button>
              <span>
                match {matchCursor + 1} / {searchResults.length}
              </span>
              <button type="button" className="hover:text-ink" onClick={() => stepMatch(1)}>
                next ›
              </button>
            </span>
          )}
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

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <form onSubmit={submitJump} className="flex items-center gap-2">
            <Input
              className="w-24"
              type="number"
              min={1}
              max={thumbnails.length}
              placeholder="Page #"
              value={jumpValue}
              onChange={(e) => setJumpValue(e.target.value)}
            />
            <Button type="submit" variant="secondary">
              Go
            </Button>
          </form>
          <div className="flex items-center gap-1 text-xs text-slate">
            <span>Thumbnail size:</span>
            {(["small", "medium", "large"] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={size === thumbSize ? "text-signal-dim underline" : "hover:text-ink"}
                onClick={() => setThumbSize(size)}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
      </div>

      {draftAvailable && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-paper-dim p-2 text-xs text-ink">
          <span>An unsaved draft from {new Date(draftAvailable).toLocaleString()} was found for this document.</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={discardDraft}>
              Discard
            </Button>
            <Button onClick={restoreDraft}>Restore</Button>
          </div>
        </div>
      )}

      {notice && <p className="mb-4 text-sm text-signal-dim">{notice}</p>}
      {error && <p className="mb-4 text-sm text-brass">{error}</p>}
      {rendering && <p className="mb-4 text-xs text-slate">Rendering…</p>}

      <div className={`grid gap-4 ${THUMB_GRID[thumbSize]}`}>
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
            <img
              src={src}
              alt={`Page ${index + 1}`}
              className="pdf-page w-full cursor-zoom-in rounded"
              onClick={() => !selectMode && openPreview(index)}
            />
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
                <button className="mono text-xs text-paper hover:text-signal" title="Edit text" onClick={() => openEditText(index)}>
                  Tt
                </button>
                <button className="mono text-xs text-paper hover:text-signal" title="Annotate" onClick={() => openAnnotate(index)}>
                  ✎
                </button>
                <button className="mono text-xs text-paper hover:text-signal" title="Redact" onClick={() => openRedact(index)}>
                  ▮
                </button>
                <button
                  className="mono text-xs text-paper hover:text-signal disabled:opacity-50"
                  title="Copy page as image"
                  disabled={copyingPage === index}
                  onClick={() => copyPageImage(index)}
                >
                  ⧈
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
      <EditTextModal
        open={editTextPage !== null}
        onClose={() => setEditTextPage(null)}
        pdfDoc={pdfDoc}
        pageIndex={editTextPage ?? 0}
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
      <InsertPdfModal
        open={activeModal === "insertPdf"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <HeaderFooterModal
        open={activeModal === "headerFooter"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <FindRedactModal
        open={activeModal === "findRedact"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <ExportImagesModal
        open={activeModal === "exportImages"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        pageCount={thumbnails.length}
      />
      <CompareModal open={activeModal === "compare"} onClose={() => setActiveModal(null)} pdfDoc={pdfDoc} />
      <OddEvenModal
        open={activeModal === "oddEven"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("Odd/even split complete.")}
      />
      <SplitToZipModal
        open={activeModal === "splitToZip"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        pageCount={thumbnails.length}
      />
      <NUpModal
        open={activeModal === "nUp"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("N-up layout created.")}
      />
      <ContactSheetModal
        open={activeModal === "contactSheet"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("Contact sheet created.")}
      />
      <CompressModal
        open={activeModal === "compress"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <GrayscaleModal
        open={activeModal === "grayscale"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <ImageWatermarkModal
        open={activeModal === "imageWatermark"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <BatesNumberingModal
        open={activeModal === "bates"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <ExtractImagesModal
        open={activeModal === "extractImages"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
      />
      <LongImageModal
        open={activeModal === "longImage"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        pageCount={thumbnails.length}
      />
      <FlattenFormModal
        open={activeModal === "flattenForm"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <RemoveAnnotationsModal
        open={activeModal === "removeAnnotations"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <RotateRangeModal
        open={activeModal === "rotateRange"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <DeleteRangeModal
        open={activeModal === "deleteRange"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <BlackoutPagesModal
        open={activeModal === "blackout"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <ResizePagesModal
        open={activeModal === "resizePages"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <InsertBlankPagesModal
        open={activeModal === "insertBlankPages"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <ReorderPagesModal
        open={activeModal === "reorderPages"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <SplitModal
        open={activeModal === "split"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("Split complete.")}
      />
      <RedactPatternsModal
        open={activeModal === "redactPatterns"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <FindMarkModal
        open={activeModal === "findMark"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <PhotoFiltersModal
        open={activeModal === "photoFilters"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <DuplicateRangeModal
        open={activeModal === "duplicateRange"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <BookmarksModal
        open={activeModal === "bookmarks"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <PageLabelsModal
        open={activeModal === "pageLabels"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <OpeningPageModal
        open={activeModal === "openingPage"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <ClearMetadataModal
        open={activeModal === "clearMetadata"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <AddLinkModal
        open={activeModal === "addLink"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <RemoveLinksModal
        open={activeModal === "removeLinks"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <VisualCompareModal
        open={activeModal === "visualCompare"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
      />
      <SplitByBookmarksModal
        open={activeModal === "splitByBookmarks"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
        folderId={folderId}
        pageCount={thumbnails.length}
        onCreated={() => setNotice("Split by bookmarks complete.")}
      />
      <InsertTocPageModal
        open={activeModal === "insertToc"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <ExportBookmarksModal
        open={activeModal === "exportBookmarks"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
      />
      <RemoveBookmarksModal
        open={activeModal === "removeBookmarks"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <ExtractCommentsModal
        open={activeModal === "extractComments"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        docName={docName}
      />
      <DocumentStatsModal
        open={activeModal === "documentStats"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
      />
      <PrepareFormModal
        open={activeModal === "prepareForm"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />
      <AttachFileModal
        open={activeModal === "attachFile"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <ManageAttachmentsModal
        open={activeModal === "manageAttachments"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <AccessibilityCheckModal
        open={activeModal === "accessibilityCheck"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <RemoveJavaScriptModal
        open={activeModal === "removeJavaScript"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        onApplied={onToolApplied}
      />
      <MeasureToolModal
        open={activeModal === "measure"}
        onClose={() => setActiveModal(null)}
        pdfDoc={pdfDoc}
        pageCount={thumbnails.length}
        onApplied={onToolApplied}
      />

      {previewIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" onClick={closePreview}>
          <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            {previewLoading || !previewSrc ? (
              <p className="text-sm text-paper">Rendering…</p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- data: URL from a canvas render, not an optimizable remote image
              <img src={previewSrc} alt={`Page ${previewIndex + 1}`} className="max-h-[85vh] max-w-full rounded bg-white" />
            )}
            <div className="mt-3 flex items-center justify-center gap-4">
              <Button
                variant="secondary"
                onClick={() => previewIndex > 0 && openPreview(previewIndex - 1)}
                disabled={previewIndex <= 0}
              >
                ← Previous
              </Button>
              <span className="mono text-sm text-paper">
                {previewIndex + 1} / {thumbnails.length}
              </span>
              <Button
                variant="secondary"
                onClick={() => previewIndex < thumbnails.length - 1 && openPreview(previewIndex + 1)}
                disabled={previewIndex >= thumbnails.length - 1}
              >
                Next →
              </Button>
              <Button variant="secondary" onClick={closePreview}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
