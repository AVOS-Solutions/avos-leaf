"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream, rgb } from "pdf-lib";
import { Button, Input, Label, Modal, Select } from "@/components/ui";
import { canvasPointToPdf, renderPageToCanvas, toArrayBuffer } from "@/lib/pdfClient";

// -------------------------------------------------------------------------------------------
// Prepare Form: Acrobat Pro's flagship "turn a static PDF into a fillable form" tool. Draw a box on
// any page, pick a field type, and it becomes a real AcroForm field (not a drawn look-alike) —
// pdf-lib's form.createTextField/createCheckBox/createDropdown plus .addToPage() do the heavy
// lifting; this just wraps the same box-drawing interaction RedactModal/AddLinkModal already use so
// several fields can be placed across different pages before committing them all at once.

type Box = { start: { x: number; y: number }; end: { x: number; y: number } };
type FieldType = "text" | "checkbox" | "dropdown";
type PendingField = { pageIndex: number; rect: [number, number, number, number]; type: FieldType; name: string; options?: string[] };

function pdfRectToCanvas(rect: [number, number, number, number], canvasW: number, canvasH: number, pdfW: number, pdfH: number) {
  const [x, y, w, h] = rect;
  return {
    left: (x / pdfW) * canvasW,
    top: canvasH - ((y + h) / pdfH) * canvasH,
    width: (w / pdfW) * canvasW,
    height: (h / pdfH) * canvasH,
  };
}

export function PrepareFormModal({
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
  const [fieldType, setFieldType] = useState<FieldType>("text");
  const [fieldName, setFieldName] = useState("");
  const [fieldOptions, setFieldOptions] = useState("");
  const [box, setBox] = useState<Box | null>(null);
  const [drawing, setDrawing] = useState<Box | null>(null);
  const [dims, setDims] = useState<{ canvasW: number; canvasH: number; pdfW: number; pdfH: number } | null>(null);
  const [pending, setPending] = useState<PendingField[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setPageIndex(0);
      setPending([]);
      setFieldName("");
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
    if (!overlay || !dims) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const field of pending.filter((f) => f.pageIndex === pageIndex)) {
      const r = pdfRectToCanvas(field.rect, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.left, r.top, r.width, r.height);
      ctx.fillStyle = "rgba(22, 163, 74, 0.12)";
      ctx.fillRect(r.left, r.top, r.width, r.height);
      ctx.fillStyle = "#16a34a";
      ctx.font = "10px sans-serif";
      ctx.fillText(field.name, r.left + 2, r.top + 10);
    }
    const current = drawing ?? box;
    if (current) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.strokeRect(current.start.x, current.start.y, current.end.x - current.start.x, current.end.y - current.start.y);
      ctx.fillStyle = "rgba(37, 99, 235, 0.15)";
      ctx.fillRect(current.start.x, current.start.y, current.end.x - current.start.x, current.end.y - current.start.y);
    }
  }, [pending, pageIndex, box, drawing, dims]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    setDrawing({ start: pointFromEvent(e), end: pointFromEvent(e) });
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    setDrawing({ ...drawing, end: pointFromEvent(e) });
  }

  function onPointerUp() {
    if (drawing) setBox(drawing);
    setDrawing(null);
  }

  function addField() {
    if (!box || !dims || !pdfDoc) return;
    const name = fieldName.trim();
    if (!name) {
      setError("Give this field a name.");
      return;
    }
    const existingNames = new Set(pdfDoc.getForm().getFields().map((f) => f.getName()));
    if (existingNames.has(name) || pending.some((p) => p.name === name)) {
      setError(`A field named "${name}" already exists — choose a unique name.`);
      return;
    }
    const p1 = canvasPointToPdf(box.start.x, box.start.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
    const p2 = canvasPointToPdf(box.end.x, box.end.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
    const rect: [number, number, number, number] = [
      Math.min(p1.x, p2.x),
      Math.min(p1.y, p2.y),
      Math.abs(p2.x - p1.x),
      Math.abs(p2.y - p1.y),
    ];
    if (rect[2] < 4 || rect[3] < 4) {
      setError("Draw a larger box for this field.");
      return;
    }
    const options = fieldType === "dropdown" ? fieldOptions.split(",").map((o) => o.trim()).filter(Boolean) : undefined;
    if (fieldType === "dropdown" && (!options || options.length === 0)) {
      setError("Enter at least one option for a dropdown, separated by commas.");
      return;
    }
    setPending((prev) => [...prev, { pageIndex, rect, type: fieldType, name, options }]);
    setFieldName("");
    setBox(null);
    setError(null);
  }

  function removeField(index: number) {
    setPending((prev) => prev.filter((_, i) => i !== index));
  }

  async function apply() {
    if (!pdfDoc || pending.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const form = pdfDoc.getForm();
      for (const field of pending) {
        const page = pdfDoc.getPage(field.pageIndex);
        const [x, y, width, height] = field.rect;
        if (field.type === "text") {
          form.createTextField(field.name).addToPage(page, { x, y, width, height });
        } else if (field.type === "checkbox") {
          form.createCheckBox(field.name).addToPage(page, { x, y, width, height });
        } else {
          const dropdown = form.createDropdown(field.name);
          dropdown.addOptions(field.options ?? []);
          dropdown.addToPage(page, { x, y, width, height });
        }
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create these form fields.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Prepare form">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Draw a box to place a real fillable field — not a drawn look-alike. Add as many as you need, across any
          page, then create them all at once.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="form-page">Page</Label>
            <Input
              id="form-page"
              type="number"
              min={1}
              max={pageCount}
              value={pageIndex + 1}
              onChange={(e) => setPageIndex(Math.min(Math.max(Number(e.target.value) - 1, 0), pageCount - 1))}
            />
          </div>
          <div>
            <Label htmlFor="form-type">Field type</Label>
            <Select id="form-type" value={fieldType} onChange={(e) => setFieldType(e.target.value as FieldType)}>
              <option value="text">Text field</option>
              <option value="checkbox">Checkbox</option>
              <option value="dropdown">Dropdown</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="form-name">Field name</Label>
            <Input id="form-name" value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
          </div>
          {fieldType === "dropdown" && (
            <div>
              <Label htmlFor="form-options">Options (comma-separated)</Label>
              <Input id="form-options" placeholder="Yes, No, Maybe" value={fieldOptions} onChange={(e) => setFieldOptions(e.target.value)} />
            </div>
          )}
        </div>
        <p className="text-xs text-slate">Drag on the page below to place this field, then click Add field.</p>
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
        <Button variant="secondary" onClick={addField} disabled={!box}>
          Add field
        </Button>
        {pending.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-xs">
            {pending.map((f, i) => (
              <div key={i} className="flex items-center justify-between">
                <span>
                  <span className="mono text-slate">p.{f.pageIndex + 1}</span> {f.name} ({f.type})
                </span>
                <button type="button" className="text-brass" onClick={() => removeField(i)}>
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
          <Button onClick={apply} disabled={applying || pending.length === 0}>
            {applying ? "Creating…" : `Create ${pending.length || ""} field${pending.length === 1 ? "" : "s"}`.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Attach file: embeds any file inside the PDF as a real attachment (Catalog/Names/EmbeddedFiles),
// the way Acrobat's "Attach a File" tool works — a reference spreadsheet or source data can travel
// with the PDF itself instead of as a separate email attachment.

export function AttachFileModal({
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
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setFile(null);
      setDescription("");
      setError(null);
    }
  }, [open]);

  async function apply() {
    if (!pdfDoc || !file) return;
    setApplying(true);
    setError(null);
    try {
      const bytes = await file.arrayBuffer();
      await pdfDoc.attach(bytes, file.name, { mimeType: file.type || "application/octet-stream", description });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach this file.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Attach a file">
      <div className="space-y-4">
        <p className="text-xs text-slate">Embeds any file inside this PDF — it travels with the document from now on.</p>
        <div>
          <Label>File</Label>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-ink" />
        </div>
        <div>
          <Label htmlFor="attach-desc">Description (optional)</Label>
          <Input id="attach-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || !file}>
            {applying ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Manage attachments: lists, downloads, and removes files embedded with Attach a file (or already
// carried by a PDF from another program) — reads the Catalog/Names/EmbeddedFiles name tree directly
// since pdf-lib has no high-level attachments API. Only the common flat-array form of that tree is
// supported; a document with an unusually large number of attachments (rare) uses a nested "Kids"
// structure this doesn't walk, and is reported as such rather than silently showing nothing.

type Attachment = { name: string; description: string; bytes: Uint8Array };

function readAttachments(doc: PDFDocument): { attachments: Attachment[]; unsupported: boolean } {
  const namesRef = doc.catalog.get(PDFName.of("Names"));
  if (!namesRef) return { attachments: [], unsupported: false };
  let efTree: PDFDict;
  try {
    const namesDict = doc.context.lookup(namesRef, PDFDict);
    efTree = namesDict.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  } catch {
    return { attachments: [], unsupported: false };
  }
  let flatNames: PDFArray;
  try {
    flatNames = efTree.lookup(PDFName.of("Names"), PDFArray);
  } catch {
    return { attachments: [], unsupported: efTree.get(PDFName.of("Kids")) !== undefined };
  }
  const attachments: Attachment[] = [];
  for (let i = 0; i < flatNames.size(); i += 2) {
    try {
      const nameObj = flatNames.get(i);
      const name = nameObj instanceof PDFHexString || nameObj instanceof PDFString ? nameObj.decodeText() : `attachment-${i / 2 + 1}`;
      const fileSpec = doc.context.lookup(flatNames.get(i + 1), PDFDict);
      const descObj = fileSpec.lookup(PDFName.of("Desc"));
      const description = descObj instanceof PDFHexString || descObj instanceof PDFString ? descObj.decodeText() : "";
      const ef = fileSpec.lookup(PDFName.of("EF"), PDFDict);
      const resolved = doc.context.lookup(ef.get(PDFName.of("F")), PDFStream);
      if (!(resolved instanceof PDFRawStream)) continue;
      const bytes = decodePDFRawStream(resolved).decode();
      attachments.push({ name, description, bytes });
    } catch {
      // an unreadable entry is skipped rather than aborting the whole list
    }
  }
  return { attachments, unsupported: false };
}

export function ManageAttachmentsModal({
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
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    const { attachments: found, unsupported: u } = readAttachments(pdfDoc);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- scans this document's current attachments each time the modal (re)opens, not reacting to external state
    setAttachments(found);
    setUnsupported(u);
    setError(null);
  }, [open, pdfDoc]);

  function download(a: Attachment) {
    const blob = new Blob([toArrayBuffer(a.bytes)]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = a.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function remove(index: number) {
    if (!pdfDoc || !attachments) return;
    try {
      const namesRef = pdfDoc.catalog.get(PDFName.of("Names"));
      if (!namesRef) return;
      const namesDict = pdfDoc.context.lookup(namesRef, PDFDict);
      const efTree = namesDict.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
      const flatNames = efTree.lookup(PDFName.of("Names"), PDFArray);
      const kept: ReturnType<PDFArray["get"]>[] = [];
      for (let i = 0; i < flatNames.size(); i += 2) {
        if (i / 2 === index) continue;
        kept.push(flatNames.get(i), flatNames.get(i + 1));
      }
      if (kept.length === 0) {
        namesDict.delete(PDFName.of("EmbeddedFiles"));
      } else {
        efTree.set(PDFName.of("Names"), pdfDoc.context.obj(kept));
      }
      setAttachments((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove this attachment.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Manage attachments">
      <div className="space-y-4">
        {attachments === null ? (
          <p className="text-sm text-slate">Scanning…</p>
        ) : attachments.length === 0 ? (
          <p className="text-sm text-slate">
            {unsupported ? "This document has attachments in a structure this tool doesn't support." : "No attachments found."}
          </p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-line p-2 text-sm">
            {attachments.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-ink">{a.name}</p>
                  {a.description && <p className="truncate text-xs text-slate">{a.description}</p>}
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button type="button" className="text-signal-dim underline" onClick={() => download(a)}>
                    Download
                  </button>
                  <button type="button" className="text-brass" onClick={() => remove(i)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Accessibility check: reports the handful of accessibility fields Acrobat's own checker leads
// with — a set document title, a set language, and whether a structure tree exists — with one-click
// fixes for the first two. Full tagging (a real structure tree mapping content to headings,
// paragraphs, and alt text) is a much deeper authoring task this doesn't attempt; reporting that as
// done via a fake flag would be worse than just saying it's missing.

const LANGUAGES = { "en-US": "English (US)", "en-GB": "English (UK)", "de-DE": "German", "fr-FR": "French", "es-ES": "Spanish" } as const;

export function AccessibilityCheckModal({
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
  const [titleDraft, setTitleDraft] = useState("");
  const [lang, setLang] = useState<keyof typeof LANGUAGES>("en-US");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && pdfDoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-fills from this document's current state each time the modal (re)opens
      setTitleDraft(pdfDoc.getTitle() ?? "");
      setError(null);
    }
  }, [open, pdfDoc]);

  if (!pdfDoc) return null;
  const hasTitle = !!pdfDoc.getTitle()?.trim();
  const langObj = pdfDoc.catalog.get(PDFName.of("Lang"));
  const hasLang = !!langObj;
  const markInfoObj = pdfDoc.catalog.get(PDFName.of("MarkInfo"));
  const hasTags = !!markInfoObj;

  function setTitle() {
    try {
      pdfDoc!.setTitle(titleDraft.trim());
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the title.");
    }
  }

  function setLanguage() {
    try {
      pdfDoc!.catalog.set(PDFName.of("Lang"), PDFString.of(lang));
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the language.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Accessibility check">
      <div className="space-y-4 text-sm">
        <p className="text-xs text-slate">
          Checks the handful of accessibility fields most screen readers rely on. This isn&apos;t a full tagging
          pass — a real structure tree (headings, paragraphs, alt text) needs dedicated authoring software.
        </p>
        <div className="space-y-3 rounded-md border border-line p-3">
          <div className="flex items-center justify-between">
            <span>{hasTitle ? "✓" : "✕"} Document title</span>
            {!hasTitle && <span className="text-xs text-brass">Missing</span>}
          </div>
          {!hasTitle && (
            <div className="flex gap-2">
              <Input placeholder="Document title" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
              <Button variant="secondary" onClick={setTitle} disabled={!titleDraft.trim()}>
                Set
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>{hasLang ? "✓" : "✕"} Document language</span>
            {!hasLang && <span className="text-xs text-brass">Missing</span>}
          </div>
          {!hasLang && (
            <div className="flex gap-2">
              <Select value={lang} onChange={(e) => setLang(e.target.value as keyof typeof LANGUAGES)}>
                {Object.entries(LANGUAGES).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" onClick={setLanguage}>
                Set
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>{hasTags ? "✓" : "✕"} Structure tags</span>
            {!hasTags && <span className="text-xs text-slate">Not present — needs dedicated authoring software</span>}
          </div>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Remove JavaScript: strips the document-level script actions carried in Catalog/Names/JavaScript —
// the part of Acrobat's "Remove Hidden Information" sweep aimed at scripts, split out on its own
// since Clear Metadata (round 3) already covers the document-info fields.

export function RemoveJavaScriptModal({
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
    try {
      const namesRef = pdfDoc.catalog.get(PDFName.of("Names"));
      if (!namesRef) {
        setError("This document has no JavaScript to remove.");
        return;
      }
      const namesDict = pdfDoc.context.lookup(namesRef, PDFDict);
      if (!namesDict.get(PDFName.of("JavaScript"))) {
        setError("This document has no JavaScript to remove.");
        return;
      }
      namesDict.delete(PDFName.of("JavaScript"));
      if (namesDict.keys().length === 0) pdfDoc.catalog.delete(PDFName.of("Names"));
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove JavaScript from this document.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Remove JavaScript">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Removes document-level scripts (Catalog/Names/JavaScript) — a security-relevant cleanup before sharing a
          document from an unfamiliar source. Scripts attached to individual form fields or annotations aren&apos;t
          covered by this pass.
        </p>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply}>
            Remove JavaScript
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------
// Measure: a calibrated distance tool for scanned drawings/plans — the same idea as Acrobat Pro's
// Measure tool. Draw a reference line over a known dimension once to set the scale (skip this to
// measure in raw PDF points/inches), then every further line reports a real-world distance, with
// the option to stamp it onto the page as a permanent label.

type LinePoints = { start: { x: number; y: number }; end: { x: number; y: number } };

export function MeasureToolModal({
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
  const [line, setLine] = useState<LinePoints | null>(null);
  const [drawing, setDrawing] = useState<LinePoints | null>(null);
  const [dims, setDims] = useState<{ canvasW: number; canvasH: number; pdfW: number; pdfH: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [unitsPerPoint, setUnitsPerPoint] = useState(1 / 72); // default: report in inches
  const [unitLabel, setUnitLabel] = useState("in");
  const [calibrateLength, setCalibrateLength] = useState(1);
  const [calibrateUnit, setCalibrateUnit] = useState("in");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the form each time the modal (re)opens
      setPageIndex(0);
      setLine(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function render() {
      setLoading(true);
      setLine(null);
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
    const current = drawing ?? line;
    if (current) {
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(current.start.x, current.start.y);
      ctx.lineTo(current.end.x, current.end.y);
      ctx.stroke();
    }
  }, [line, drawing]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    setDrawing({ start: pointFromEvent(e), end: pointFromEvent(e) });
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    setDrawing({ ...drawing, end: pointFromEvent(e) });
  }

  function onPointerUp() {
    if (drawing) setLine(drawing);
    setDrawing(null);
  }

  function pdfDistance(): number | null {
    if (!line || !dims) return null;
    const p1 = canvasPointToPdf(line.start.x, line.start.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
    const p2 = canvasPointToPdf(line.end.x, line.end.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  function calibrate() {
    const dist = pdfDistance();
    if (!dist || dist === 0 || calibrateLength <= 0) return;
    setUnitsPerPoint(calibrateLength / dist);
    setUnitLabel(calibrateUnit);
    setLine(null);
  }

  async function stampLabel() {
    if (!pdfDoc || !line || !dims) return;
    setApplying(true);
    setError(null);
    try {
      const p1 = canvasPointToPdf(line.start.x, line.start.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
      const p2 = canvasPointToPdf(line.end.x, line.end.y, dims.canvasW, dims.canvasH, dims.pdfW, dims.pdfH);
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const label = `${(dist * unitsPerPoint).toFixed(2)} ${unitLabel}`;
      const page = pdfDoc.getPage(pageIndex);
      page.drawLine({ start: p1, end: p2, thickness: 1, color: rgb(0.8, 0.1, 0.1) });
      page.drawText(label, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 + 4, size: 9, color: rgb(0.8, 0.1, 0.1) });
      onApplied();
      setLine(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this measurement to the page.");
    } finally {
      setApplying(false);
    }
  }

  const distance = pdfDistance();

  return (
    <Modal open={open} onClose={onClose} title="Measure">
      <div className="space-y-4">
        <p className="text-xs text-slate">
          Draw a line to measure a distance on a scanned drawing or plan. By default distances are reported in
          PDF inches (72pt = 1in) — calibrate against a known dimension for real-world units.
        </p>
        <div>
          <Label htmlFor="measure-page">Page</Label>
          <Input
            id="measure-page"
            type="number"
            min={1}
            max={pageCount}
            value={pageIndex + 1}
            onChange={(e) => setPageIndex(Math.min(Math.max(Number(e.target.value) - 1, 0), pageCount - 1))}
          />
        </div>
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
        {distance !== null && <p className="text-sm text-ink">Measured: {(distance * unitsPerPoint).toFixed(2)} {unitLabel}</p>}
        <div className="grid grid-cols-3 gap-2 rounded-md border border-line p-2">
          <div className="col-span-3 text-xs text-slate">Calibrate: the line above equals —</div>
          <Input type="number" min={0.01} step={0.01} value={calibrateLength} onChange={(e) => setCalibrateLength(Number(e.target.value))} />
          <Input value={calibrateUnit} onChange={(e) => setCalibrateUnit(e.target.value)} placeholder="ft, m, mi…" />
          <Button variant="secondary" onClick={calibrate} disabled={!line}>
            Set scale
          </Button>
        </div>
        {error && <p className="text-sm text-brass">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={stampLabel} disabled={!line || applying}>
            {applying ? "Adding…" : "Add measurement to page"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
