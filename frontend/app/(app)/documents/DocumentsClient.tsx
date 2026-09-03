"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Card, Input, Label, Modal, PageHeader, Select, Textarea } from "@/components/ui";
import { toArrayBuffer } from "@/lib/pdfClient";
import type { DocumentSummary, FolderSummary } from "@/lib/types";
import { BatchRedactModal, BatchRenameModal, CsvToPdfModal, MarkdownToPdfModal, MergeMultipleModal } from "./ListTools";

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

type View = "browse" | "starred" | "trash";

export function DocumentsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder");
  const view = (searchParams.get("view") as View | null) ?? "browse";

  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ kind: "folder" | "document"; id: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ kind: "folder" | "document"; id: string; currentFolderId: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [convertingImages, setConvertingImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesInputRef = useRef<HTMLInputElement>(null);

  const [textPdfOpen, setTextPdfOpen] = useState(false);
  const [textPdfTitle, setTextPdfTitle] = useState("");
  const [textPdfBody, setTextPdfBody] = useState("");
  const [creatingTextPdf, setCreatingTextPdf] = useState(false);
  const [textPdfError, setTextPdfError] = useState<string | null>(null);

  const [combineOpen, setCombineOpen] = useState(false);
  const [combineCandidates, setCombineCandidates] = useState<DocumentSummary[]>([]);
  const [combineSelected, setCombineSelected] = useState<string[]>([]);
  const [combining, setCombining] = useState(false);
  const [combineError, setCombineError] = useState<string | null>(null);

  const [mergeMultipleOpen, setMergeMultipleOpen] = useState(false);
  const [markdownPdfOpen, setMarkdownPdfOpen] = useState(false);
  const [csvPdfOpen, setCsvPdfOpen] = useState(false);

  const [sortBy, setSortBy] = useState<"name" | "date" | "size">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [batchRenameOpen, setBatchRenameOpen] = useState(false);
  const [batchRedactOpen, setBatchRedactOpen] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const loadFolders = useCallback(async () => {
    const response = await fetch("/api/backend/folders");
    if (response.ok) setFolders(await response.json());
  }, []);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url =
        view === "starred"
          ? "/api/backend/documents/starred"
          : view === "trash"
            ? "/api/backend/documents?trashed=true"
            : `/api/backend/documents${folderId ? `?folderId=${folderId}` : ""}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load your documents.");
      setDocuments(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your documents.");
    } finally {
      setLoading(false);
    }
  }, [view, folderId]);

  useEffect(() => {
    // Plain fetch-on-mount/dependency-change — the eslint-plugin-react-hooks "set state in
    // effect" rule flags this shape generically, but there's no external-system subscription to
    // model here, just "load the current view's folders/documents."
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDocuments();
  }, [loadDocuments]);

  function goTo(next: { folder?: string | null; view?: View }) {
    const params = new URLSearchParams();
    if (next.view && next.view !== "browse") params.set("view", next.view);
    if (next.view === undefined && view !== "browse") params.set("view", view);
    if (next.folder !== undefined ? next.folder : folderId) {
      params.set("folder", (next.folder !== undefined ? next.folder : folderId)!);
    }
    router.push(params.toString() ? `/documents?${params}` : "/documents");
  }

  const subfolders = view === "browse" ? folders.filter((f) => f.parentFolderId === folderId) : [];
  const breadcrumb: FolderSummary[] = [];
  if (view === "browse") {
    let cursor = folderId ? folders.find((f) => f.id === folderId) : undefined;
    while (cursor) {
      breadcrumb.unshift(cursor);
      cursor = cursor.parentFolderId ? folders.find((f) => f.id === cursor!.parentFolderId) : undefined;
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (folderId) form.append("folderId", folderId);
      const response = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Upload failed.");
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  /** Builds a new PDF from one or more images (one page per image, fitted to A4 with a margin,
   *  preserving aspect ratio) and uploads it through the same endpoint a regular PDF upload uses —
   *  the backend never needs to know this document didn't start life as a PDF. */
  async function handleImagesToPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setConvertingImages(true);
    setError(null);
    try {
      const { PDFDocument, PageSizes } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      const margin = 36;
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const isPng = file.type === "image/png";
        const isJpeg = file.type === "image/jpeg" || file.type === "image/jpg";
        if (!isPng && !isJpeg) throw new Error(`"${file.name}" isn't a JPEG or PNG image.`);
        const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [pageWidth, pageHeight] = PageSizes.A4;
        const availableWidth = pageWidth - margin * 2;
        const availableHeight = pageHeight - margin * 2;
        const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
        const width = image.width * scale;
        const height = image.height * scale;
        const page = doc.addPage(PageSizes.A4);
        page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
      }
      const pdfBytes = await doc.save();
      const form = new FormData();
      const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, ".pdf") : "Images.pdf";
      form.append("file", new Blob([toArrayBuffer(pdfBytes)], { type: "application/pdf" }), name);
      if (folderId) form.append("folderId", folderId);
      const response = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Could not create a PDF from these images.");
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a PDF from these images.");
    } finally {
      setConvertingImages(false);
    }
  }

  /** Wraps pasted plain text into a paginated PDF (simple word-wrap against the page's text width,
   *  same font metrics trick pdf-lib's own docs use) and uploads it like any other new document —
   *  the missing counterpart to "Extract text" on the editor's own toolbar. */
  async function createTextPdf(e: React.FormEvent) {
    e.preventDefault();
    if (!textPdfBody.trim()) return;
    setCreatingTextPdf(true);
    setTextPdfError(null);
    try {
      const { PDFDocument, StandardFonts, PageSizes } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const size = 11;
      const lineHeight = size * 1.4;
      const margin = 54;
      const [pageWidth, pageHeight] = PageSizes.A4;
      const maxWidth = pageWidth - margin * 2;

      const lines: string[] = [];
      for (const paragraph of textPdfBody.split("\n")) {
        if (paragraph.trim() === "") {
          lines.push("");
          continue;
        }
        let current = "";
        for (const word of paragraph.split(" ")) {
          const candidate = current ? `${current} ${word}` : word;
          if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
            lines.push(current);
            current = word;
          } else {
            current = candidate;
          }
        }
        lines.push(current);
      }

      let page = doc.addPage(PageSizes.A4);
      let y = pageHeight - margin;
      for (const line of lines) {
        if (y < margin) {
          page = doc.addPage(PageSizes.A4);
          y = pageHeight - margin;
        }
        if (line) page.drawText(line, { x: margin, y, size, font });
        y -= lineHeight;
      }

      const bytes = await doc.save();
      const form = new FormData();
      const name = `${(textPdfTitle.trim() || "Untitled").replace(/\.pdf$/i, "")}.pdf`;
      form.append("file", new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), name);
      if (folderId) form.append("folderId", folderId);
      const response = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Could not create that document.");
      setTextPdfOpen(false);
      setTextPdfTitle("");
      setTextPdfBody("");
      await loadDocuments();
    } catch (err) {
      setTextPdfError(err instanceof Error ? err.message : "Could not create that document.");
    } finally {
      setCreatingTextPdf(false);
    }
  }

  /** Merge only ever accepted an upload from outside the app (DocumentEditor's mergeFile) — this
   *  covers combining documents that already live in this account's library, fetching each one's
   *  current content through the same endpoint the editor itself reads from. */
  async function openCombine() {
    setCombineError(null);
    setCombineSelected([]);
    setCombineOpen(true);
    const response = await fetch("/api/backend/documents");
    if (response.ok) setCombineCandidates(await response.json());
  }

  function toggleCombine(id: string) {
    setCombineSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function runCombine() {
    if (combineSelected.length < 2) return;
    setCombining(true);
    setCombineError(null);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const merged = await PDFDocument.create();
      for (const id of combineSelected) {
        const response = await fetch(`/api/documents/${id}/content`);
        if (!response.ok) throw new Error("Could not read one of the selected documents.");
        const bytes = await response.arrayBuffer();
        const source = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      }
      const mergedBytes = await merged.save();
      const form = new FormData();
      form.append("file", new Blob([toArrayBuffer(mergedBytes)], { type: "application/pdf" }), "Combined.pdf");
      if (folderId) form.append("folderId", folderId);
      const response = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Could not combine these documents.");
      setCombineOpen(false);
      await loadDocuments();
    } catch (err) {
      setCombineError(err instanceof Error ? err.message : "Could not combine these documents.");
    } finally {
      setCombining(false);
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const response = await fetch("/api/backend/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newFolderName, parentFolderId: folderId }),
    });
    if (response.ok) {
      setNewFolderOpen(false);
      setNewFolderName("");
      await loadFolders();
    }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;
    const path = renameTarget.kind === "folder" ? `/api/backend/folders/${renameTarget.id}` : `/api/backend/documents/${renameTarget.id}`;
    const response = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameTarget.name }),
    });
    if (response.ok) {
      setRenameTarget(null);
      await Promise.all([loadFolders(), loadDocuments()]);
    }
  }

  async function submitMove(newFolderId: string) {
    if (!moveTarget) return;
    const path =
      moveTarget.kind === "folder" ? `/api/backend/folders/${moveTarget.id}/move` : `/api/backend/documents/${moveTarget.id}/move`;
    const body = moveTarget.kind === "folder" ? JSON.stringify(newFolderId || null) : JSON.stringify({ folderId: newFolderId || null });
    const response = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (response.ok) {
      setMoveTarget(null);
      await Promise.all([loadFolders(), loadDocuments()]);
    }
  }

  async function deleteFolder(id: string) {
    if (!confirm("Delete this folder? It must be empty.")) return;
    const response = await fetch(`/api/backend/folders/${id}`, { method: "DELETE" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      alert(body?.message ?? "Could not delete that folder.");
      return;
    }
    await loadFolders();
  }

  async function toggleStar(doc: DocumentSummary) {
    await fetch(`/api/backend/documents/${doc.id}/star`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: !doc.starred }),
    });
    await loadDocuments();
  }

  async function trashDocument(id: string) {
    await fetch(`/api/backend/documents/${id}`, { method: "DELETE" });
    await loadDocuments();
  }

  async function restoreDocument(id: string) {
    await fetch(`/api/backend/documents/${id}/restore`, { method: "POST" });
    await loadDocuments();
  }

  async function deleteForever(id: string) {
    if (!confirm("Permanently delete this document? This cannot be undone.")) return;
    await fetch(`/api/backend/documents/${id}/forever`, { method: "DELETE" });
    await loadDocuments();
  }

  async function duplicateDocument(id: string) {
    await fetch(`/api/backend/documents/${id}/duplicate`, { method: "POST" });
    await loadDocuments();
  }

  const sortedDocuments = [...documents]
    .filter((d) => d.name.toLowerCase().includes(filterQuery.trim().toLowerCase()))
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === "name") cmp = a.name.localeCompare(b.name);
      else if (sortBy === "size") cmp = a.sizeBytes - b.sizeBytes;
      else cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return sortDir === "asc" ? cmp : -cmp;
    });

  const totalSizeBytes = documents.reduce((sum, d) => sum + d.sizeBytes, 0);

  function selectAllVisible() {
    setBulkSelected(new Set(sortedDocuments.map((d) => d.id)));
  }

  function toggleBulkMode() {
    setBulkMode((prev) => !prev);
    setBulkSelected(new Set());
  }

  function toggleBulkSelected(id: string) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkTrash() {
    setBulkWorking(true);
    try {
      await Promise.all([...bulkSelected].map((id) => fetch(`/api/backend/documents/${id}`, { method: "DELETE" })));
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  async function bulkDuplicate() {
    setBulkWorking(true);
    try {
      await Promise.all([...bulkSelected].map((id) => fetch(`/api/backend/documents/${id}/duplicate`, { method: "POST" })));
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  async function bulkRestore() {
    setBulkWorking(true);
    try {
      await Promise.all([...bulkSelected].map((id) => fetch(`/api/backend/documents/${id}/restore`, { method: "POST" })));
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  async function bulkStar(starred: boolean) {
    setBulkWorking(true);
    try {
      await Promise.all(
        [...bulkSelected].map((id) =>
          fetch(`/api/backend/documents/${id}/star`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ starred }),
          }),
        ),
      );
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  async function bulkDeleteForever() {
    if (!confirm(`Permanently delete ${bulkSelected.size} document${bulkSelected.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBulkWorking(true);
    try {
      await Promise.all([...bulkSelected].map((id) => fetch(`/api/backend/documents/${id}/forever`, { method: "DELETE" })));
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  async function bulkMoveTo(newFolderId: string) {
    setBulkWorking(true);
    try {
      await Promise.all(
        [...bulkSelected].map((id) =>
          fetch(`/api/backend/documents/${id}/move`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId: newFolderId || null }),
          }),
        ),
      );
      setBulkMoveOpen(false);
      setBulkSelected(new Set());
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  /** Shared by "download selected as zip" and "download this folder as zip" — the only difference
   *  is which document ids feed in, so both funnel through here rather than duplicating the
   *  fetch-then-zip loop. */
  async function downloadDocumentsAsZip(ids: string[], zipName: string) {
    if (ids.length === 0) return;
    setZipping(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const byId = new Map(documents.map((d) => [d.id, d]));
      for (const id of ids) {
        const response = await fetch(`/api/documents/${id}/content`);
        if (!response.ok) continue;
        const bytes = await response.arrayBuffer();
        const name = byId.get(id)?.name ?? `${id}.pdf`;
        zip.file(name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`, bytes);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setZipping(false);
    }
  }

  /** Fetches every selected document's current content and combines them client-side, without
   *  uploading anything — for a one-off print or download rather than a new library entry (that's
   *  what Combine documents… is for). */
  async function mergeSelectedInMemory(): Promise<Uint8Array | null> {
    if (bulkSelected.size === 0) return null;
    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();
    for (const id of bulkSelected) {
      const response = await fetch(`/api/documents/${id}/content`);
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const source = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(source, source.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
    }
    return merged.save();
  }

  async function printSelected() {
    setBulkWorking(true);
    try {
      const bytes = await mergeSelectedInMemory();
      if (!bytes) return;
      const blob = new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
      window.open(URL.createObjectURL(blob), "_blank");
    } finally {
      setBulkWorking(false);
    }
  }

  async function downloadSelectedMerged() {
    setBulkWorking(true);
    try {
      const bytes = await mergeSelectedInMemory();
      if (!bytes) return;
      const blob = new Blob([toArrayBuffer(bytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Combined.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBulkWorking(false);
    }
  }

  async function emptyTrash() {
    if (documents.length === 0) return;
    if (!confirm(`Permanently delete all ${documents.length} document${documents.length === 1 ? "" : "s"} in Trash? This cannot be undone.`)) return;
    setBulkWorking(true);
    try {
      await Promise.all(documents.map((d) => fetch(`/api/backend/documents/${d.id}/forever`, { method: "DELETE" })));
      await loadDocuments();
    } finally {
      setBulkWorking(false);
    }
  }

  function exportListAsCsv() {
    const header = ["Name", "Size (bytes)", "Pages", "Created", "Last modified"];
    const rows = sortedDocuments.map((d) => [d.name, String(d.sizeBytes), String(d.pageCount ?? ""), d.createdAt, d.updatedAt]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "documents.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        eyebrow="AVOS Leaf"
        title="Documents"
        action={
          view === "browse" && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setNewFolderOpen(true)}>
                New folder
              </Button>
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading…" : "Upload PDF"}
              </Button>
              <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleUpload} />
              <Button variant="secondary" onClick={() => imagesInputRef.current?.click()} disabled={convertingImages}>
                {convertingImages ? "Converting…" : "Images to PDF…"}
              </Button>
              <input
                ref={imagesInputRef}
                type="file"
                accept="image/png,image/jpeg"
                multiple
                className="hidden"
                onChange={handleImagesToPdf}
              />
              <Button variant="secondary" onClick={() => setTextPdfOpen(true)}>
                New PDF from text…
              </Button>
              <Button variant="secondary" onClick={() => setMarkdownPdfOpen(true)}>
                Markdown to PDF…
              </Button>
              <Button variant="secondary" onClick={() => setCsvPdfOpen(true)}>
                CSV to PDF…
              </Button>
              <Button variant="secondary" onClick={openCombine}>
                Combine documents…
              </Button>
              <Button variant="secondary" onClick={() => setMergeMultipleOpen(true)}>
                Merge multiple PDFs…
              </Button>
            </div>
          )
        }
      />

      <div className="mb-6 flex items-center gap-6 border-b border-line pb-4 text-sm">
        <button className={view === "browse" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "browse", folder: null })}>
          All documents
        </button>
        <button className={view === "starred" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "starred", folder: null })}>
          Starred
        </button>
        <button className={view === "trash" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "trash", folder: null })}>
          Trash
        </button>
      </div>

      {view === "browse" && (
        <div className="mb-4 flex flex-wrap items-center gap-1 text-sm text-slate">
          <button className="hover:text-signal-dim" onClick={() => goTo({ folder: null })}>
            Root
          </button>
          {breadcrumb.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <span>/</span>
              <button className="hover:text-signal-dim" onClick={() => goTo({ folder: f.id })}>
                {f.name}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Input
          className="max-w-xs"
          placeholder="Filter by name…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        <span className="text-xs text-slate">
          {documents.length} document{documents.length === 1 ? "" : "s"}
          {subfolders.length > 0 ? ` · ${subfolders.length} folder${subfolders.length === 1 ? "" : "s"}` : ""} · {formatBytes(totalSizeBytes)}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-slate">
          <span>Sort by:</span>
          <Select className="w-auto" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="name">Name</option>
            <option value="date">Last modified</option>
            <option value="size">Size</option>
          </Select>
          <button className="hover:text-ink" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
            {sortDir === "asc" ? "↑ Ascending" : "↓ Descending"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {view === "trash" ? (
            documents.length > 0 && (
              <Button variant="danger" onClick={emptyTrash} disabled={bulkWorking}>
                Empty trash
              </Button>
            )
          ) : (
            <>
              <Button variant="secondary" onClick={exportListAsCsv} disabled={documents.length === 0}>
                Export list as CSV
              </Button>
              <Button variant="secondary" onClick={() => downloadDocumentsAsZip(documents.map((d) => d.id), "documents.zip")} disabled={zipping || documents.length === 0}>
                {zipping ? "Zipping…" : "Download all as zip"}
              </Button>
            </>
          )}
          <Button variant={bulkMode ? "primary" : "secondary"} onClick={toggleBulkMode}>
            {bulkMode ? "Cancel select" : "Select…"}
          </Button>
        </div>
      </div>

      {bulkMode && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-paper-dim p-2 text-xs">
          <span className="text-slate">{bulkSelected.size} selected</span>
          <Button variant="secondary" onClick={selectAllVisible} disabled={sortedDocuments.length === 0}>
            Select all
          </Button>
          <Button variant="secondary" onClick={() => setBulkSelected(new Set())} disabled={bulkSelected.size === 0}>
            Select none
          </Button>
          {view === "trash" ? (
            <>
              <Button variant="secondary" onClick={bulkRestore} disabled={bulkSelected.size === 0 || bulkWorking}>
                Restore
              </Button>
              <Button variant="danger" onClick={bulkDeleteForever} disabled={bulkSelected.size === 0 || bulkWorking}>
                Delete forever
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setBulkMoveOpen(true)} disabled={bulkSelected.size === 0}>
                Move…
              </Button>
              <Button variant="danger" onClick={bulkTrash} disabled={bulkSelected.size === 0 || bulkWorking}>
                Trash
              </Button>
              <Button variant="secondary" onClick={() => bulkStar(true)} disabled={bulkSelected.size === 0 || bulkWorking}>
                Star
              </Button>
              <Button variant="secondary" onClick={() => bulkStar(false)} disabled={bulkSelected.size === 0 || bulkWorking}>
                Unstar
              </Button>
              <Button variant="secondary" onClick={bulkDuplicate} disabled={bulkSelected.size === 0 || bulkWorking}>
                Duplicate
              </Button>
              <Button variant="secondary" onClick={() => setBatchRenameOpen(true)} disabled={bulkSelected.size === 0}>
                Batch rename…
              </Button>
              <Button variant="secondary" onClick={() => setBatchRedactOpen(true)} disabled={bulkSelected.size === 0}>
                Batch redact…
              </Button>
              <Button
                variant="secondary"
                onClick={() => downloadDocumentsAsZip([...bulkSelected], "documents.zip")}
                disabled={bulkSelected.size === 0 || zipping}
              >
                {zipping ? "Zipping…" : "Download as zip"}
              </Button>
              <Button variant="secondary" onClick={printSelected} disabled={bulkSelected.size === 0 || bulkWorking}>
                Print merged
              </Button>
              <Button variant="secondary" onClick={downloadSelectedMerged} disabled={bulkSelected.size === 0 || bulkWorking}>
                Download merged
              </Button>
            </>
          )}
        </div>
      )}

      {error && <p className="mb-4 text-sm text-brass">{error}</p>}

      {loading ? (
        <p className="text-sm text-slate">Loading…</p>
      ) : (
        <div className="space-y-2">
          {subfolders.map((folder) => (
            <Card key={folder.id} className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <button className="text-left sm:flex-1" onClick={() => goTo({ folder: folder.id })}>
                📁 {folder.name}
              </button>
              <div className="flex flex-wrap gap-3 text-xs text-slate">
                <button className="hover:text-ink" onClick={() => setRenameTarget({ kind: "folder", id: folder.id, name: folder.name })}>
                  Rename
                </button>
                <button className="hover:text-ink" onClick={() => setMoveTarget({ kind: "folder", id: folder.id, currentFolderId: folder.parentFolderId })}>
                  Move
                </button>
                <button className="hover:text-brass" onClick={() => deleteFolder(folder.id)}>
                  Delete
                </button>
              </div>
            </Card>
          ))}

          {documents.length === 0 && subfolders.length === 0 && (
            <p className="py-8 text-center text-sm text-slate">
              {view === "trash" ? "Trash is empty." : view === "starred" ? "No starred documents yet." : "No documents here yet."}
            </p>
          )}

          {sortedDocuments.map((doc) => (
            <Card key={doc.id} className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 items-center gap-2 sm:flex-1">
                {bulkMode && (
                  <input type="checkbox" checked={bulkSelected.has(doc.id)} onChange={() => toggleBulkSelected(doc.id)} className="h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0">
                  {view === "trash" ? (
                    <span className="block truncate text-ink-soft">{doc.name}</span>
                  ) : (
                    <Link href={`/documents/${doc.id}`} className="block truncate text-ink no-underline hover:text-signal-dim">
                      📄 {doc.name}
                    </Link>
                  )}
                  <span className="mono text-xs text-slate">
                    {formatBytes(doc.sizeBytes)} · {doc.pageCount || "?"} pages
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-slate sm:shrink-0">
                {view === "trash" ? (
                  <>
                    <button className="hover:text-ink" onClick={() => restoreDocument(doc.id)}>
                      Restore
                    </button>
                    <button className="hover:text-brass" onClick={() => deleteForever(doc.id)}>
                      Delete forever
                    </button>
                  </>
                ) : (
                  <>
                    <button className="hover:text-ink" onClick={() => toggleStar(doc)}>
                      {doc.starred ? "★ Unstar" : "☆ Star"}
                    </button>
                    <button className="hover:text-ink" onClick={() => setRenameTarget({ kind: "document", id: doc.id, name: doc.name })}>
                      Rename
                    </button>
                    <button className="hover:text-ink" onClick={() => setMoveTarget({ kind: "document", id: doc.id, currentFolderId: doc.folderId })}>
                      Move
                    </button>
                    <button className="hover:text-ink" onClick={() => duplicateDocument(doc.id)}>
                      Duplicate
                    </button>
                    <button className="hover:text-brass" onClick={() => trashDocument(doc.id)}>
                      Trash
                    </button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title="New folder">
        <form onSubmit={createFolder} className="space-y-4">
          <div>
            <Label htmlFor="folderName">Name</Label>
            <Input id="folderName" required autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} />
          </div>
          <Button type="submit" className="w-full">
            Create
          </Button>
        </form>
      </Modal>

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title="Rename">
        <form onSubmit={submitRename} className="space-y-4">
          <div>
            <Label htmlFor="renameName">Name</Label>
            <Input
              id="renameName"
              required
              autoFocus
              value={renameTarget?.name ?? ""}
              onChange={(e) => setRenameTarget((t) => (t ? { ...t, name: e.target.value } : t))}
            />
          </div>
          <Button type="submit" className="w-full">
            Save
          </Button>
        </form>
      </Modal>

      <Modal open={!!moveTarget} onClose={() => setMoveTarget(null)} title="Move to folder">
        <div className="space-y-4">
          <Select
            defaultValue={moveTarget?.currentFolderId ?? ""}
            onChange={(e) => submitMove(e.target.value)}
          >
            <option value="">Root</option>
            {folders
              .filter((f) => !moveTarget || moveTarget.kind !== "folder" || f.id !== moveTarget.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </Select>
        </div>
      </Modal>

      <Modal open={bulkMoveOpen} onClose={() => setBulkMoveOpen(false)} title="Move selected to folder">
        <div className="space-y-4">
          <Select defaultValue="" onChange={(e) => bulkMoveTo(e.target.value)}>
            <option value="">Root</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      <MergeMultipleModal open={mergeMultipleOpen} onClose={() => setMergeMultipleOpen(false)} folderId={folderId} onCreated={loadDocuments} />
      <BatchRenameModal
        open={batchRenameOpen}
        onClose={() => setBatchRenameOpen(false)}
        documents={sortedDocuments.filter((d) => bulkSelected.has(d.id))}
        onRenamed={() => {
          setBulkSelected(new Set());
          loadDocuments();
        }}
      />
      <BatchRedactModal
        open={batchRedactOpen}
        onClose={() => setBatchRedactOpen(false)}
        documents={sortedDocuments.filter((d) => bulkSelected.has(d.id))}
        folderId={folderId}
        onCreated={loadDocuments}
      />
      <MarkdownToPdfModal open={markdownPdfOpen} onClose={() => setMarkdownPdfOpen(false)} folderId={folderId} onCreated={loadDocuments} />
      <CsvToPdfModal open={csvPdfOpen} onClose={() => setCsvPdfOpen(false)} folderId={folderId} onCreated={loadDocuments} />

      <Modal open={textPdfOpen} onClose={() => setTextPdfOpen(false)} title="New PDF from text">
        <form onSubmit={createTextPdf} className="space-y-4">
          <div>
            <Label htmlFor="textpdf-title">Title</Label>
            <Input id="textpdf-title" placeholder="Untitled" value={textPdfTitle} onChange={(e) => setTextPdfTitle(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="textpdf-body">Text</Label>
            <Textarea
              id="textpdf-body"
              rows={12}
              required
              autoFocus
              placeholder="Paste or type the text for this document…"
              value={textPdfBody}
              onChange={(e) => setTextPdfBody(e.target.value)}
            />
          </div>
          {textPdfError && <p className="text-sm text-brass">{textPdfError}</p>}
          <Button type="submit" className="w-full" disabled={creatingTextPdf}>
            {creatingTextPdf ? "Creating…" : "Create PDF"}
          </Button>
        </form>
      </Modal>

      <Modal open={combineOpen} onClose={() => setCombineOpen(false)} title="Combine documents">
        <div className="space-y-4">
          <p className="text-xs text-slate">
            Pick two or more documents from your library to merge into one new PDF, in the order you select
            them. The originals are untouched.
          </p>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {combineCandidates.length === 0 ? (
              <p className="text-sm text-slate">No documents available.</p>
            ) : (
              combineCandidates.map((doc) => {
                const position = combineSelected.indexOf(doc.id);
                return (
                  <label key={doc.id} className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={position !== -1} onChange={() => toggleCombine(doc.id)} />
                    <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                    {position !== -1 && <span className="mono text-xs text-slate">#{position + 1}</span>}
                  </label>
                );
              })
            )}
          </div>
          {combineError && <p className="text-sm text-brass">{combineError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCombineOpen(false)}>
              Cancel
            </Button>
            <Button onClick={runCombine} disabled={combining || combineSelected.length < 2}>
              {combining ? "Combining…" : `Combine ${combineSelected.length || ""}`.trim()}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
