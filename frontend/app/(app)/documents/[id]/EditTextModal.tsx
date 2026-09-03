"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { Button, Input } from "@/components/ui";
import { renderPageToCanvas } from "@/lib/pdfClient";
import { extractTextRuns, replaceTextRun, type TextRun } from "@/lib/pdfContentStream";

/** Click an existing line of text on the page to retype it in place — a real content-stream edit
 *  (see pdfContentStream.ts), not a white-box-and-retype trick. Only text in a simple font whose
 *  WinAnsi encoding round-trips cleanly is offered as editable; everything else is shown outlined
 *  but disabled, with a tooltip explaining why (see that file's header comment for the full story). */
export function EditTextModal({
  open,
  onClose,
  pdfDoc,
  pageIndex,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  pageIndex: number;
  onApplied: () => void;
}) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [dims, setDims] = useState<{ canvasW: number; canvasH: number; scale: number } | null>(null);
  const [selected, setSelected] = useState<TextRun | null>(null);
  const [draftText, setDraftText] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!pdfDoc) return;
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const page = pdfDoc.getPage(pageIndex);
      const scale = Math.min(900 / page.getWidth(), 1.8);
      const bytes = await pdfDoc.save();
      const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, scale);
      const bg = bgCanvasRef.current;
      if (!bg) return;
      bg.width = canvas.width;
      bg.height = canvas.height;
      bg.getContext("2d")?.drawImage(canvas, 0, 0);
      setDims({ canvasW: canvas.width, canvasH: canvas.height, scale });
      setRuns(await extractTextRuns(page));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this page's text.");
    } finally {
      setLoading(false);
    }
  }, [pdfDoc, pageIndex]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-reading this page's text runs whenever the modal (re)opens on it, not reacting to pdfDoc's own state
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageIndex]);

  function selectRun(run: TextRun) {
    if (!run.editable) return;
    setSelected(run);
    setDraftText(run.text);
    setError(null);
  }

  async function apply() {
    if (!pdfDoc || !selected) return;
    setApplying(true);
    setError(null);
    try {
      const page = pdfDoc.getPage(pageIndex);
      replaceTextRun(page, selected, draftText);
      onApplied();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that change.");
    } finally {
      setApplying(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg border border-line bg-white p-5 shadow-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Edit text on page {pageIndex + 1}</h2>
          <button className="mono text-xs text-slate hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>
        <p className="mb-3 text-sm text-slate">
          Click a highlighted line to retype it. Grayed-out lines use a font this editor can&apos;t safely rewrite.
        </p>

        {error && <p className="mb-3 text-sm text-brass">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate">Reading text…</p>
        ) : (
          <div className="relative inline-block border border-line">
            <canvas ref={bgCanvasRef} className="block" />
            {dims &&
              runs.map((run, i) => {
                const left = run.box.x * dims.scale;
                const top = dims.canvasH - (run.box.y + run.box.height) * dims.scale;
                const width = run.box.width * dims.scale;
                const height = run.box.height * dims.scale;
                const isSelected = selected === run;
                return (
                  <button
                    key={i}
                    type="button"
                    title={run.editable ? "Click to edit" : (run.reason ?? "Not editable")}
                    onClick={() => selectRun(run)}
                    className={
                      run.editable
                        ? `absolute border ${isSelected ? "border-signal bg-signal/20" : "border-signal/50 hover:bg-signal/10"}`
                        : "absolute cursor-not-allowed border border-dashed border-slate/40"
                    }
                    style={{ left, top, width, height }}
                  />
                );
              })}
          </div>
        )}

        {selected && (
          <div className="mt-4 space-y-2 rounded-md bg-paper-dim p-3">
            <label className="eyebrow mb-1 block">Replacement text</label>
            <Input value={draftText} onChange={(e) => setDraftText(e.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button onClick={apply} disabled={applying}>
                {applying ? "Saving…" : "Apply"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
