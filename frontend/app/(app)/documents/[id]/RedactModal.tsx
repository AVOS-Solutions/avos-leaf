"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { renderPageToCanvas } from "@/lib/pdfClient";
import { Button } from "@/components/ui";

type Point = { x: number; y: number };
type Box = { start: Point; end: Point };

/** True redaction, not a cosmetic overlay: the boxed regions are painted opaque black onto a
 *  freshly rendered raster of the page, and that raster becomes the *entire* replacement page — no
 *  vector text or paths survive underneath a box, unlike drawing a black rectangle over the
 *  existing page content (which still leaves the covered text selectable/extractable). Renders at
 *  2x scale so the replacement page still looks sharp on screen and in print. */
export function RedactModal({
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
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drawing, setDrawing] = useState<Box | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function render() {
      setLoading(true);
      setError(null);
      setBoxes([]);
      try {
        const page = pdfDoc!.getPage(pageIndex);
        const scale = Math.min(900 / page.getWidth(), 1.8);
        const bytes = await pdfDoc!.save();
        const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, scale);
        if (cancelled) return;
        const bg = bgCanvasRef.current;
        const overlay = overlayRef.current;
        if (!bg || !overlay) return;
        bg.width = overlay.width = canvas.width;
        bg.height = overlay.height = canvas.height;
        bg.getContext("2d")?.drawImage(canvas, 0, 0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not render this page.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    render();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageIndex]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.fillStyle = "#000000";
    for (const box of drawing ? [...boxes, drawing] : boxes) {
      ctx.fillRect(box.start.x, box.start.y, box.end.x - box.start.x, box.end.y - box.start.y);
    }
  }, [boxes, drawing]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): Point {
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
    if (drawing) setBoxes((prev) => [...prev, drawing]);
    setDrawing(null);
  }

  async function apply() {
    if (!pdfDoc || boxes.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const page = pdfDoc.getPage(pageIndex);
      const pdfW = page.getWidth();
      const pdfH = page.getHeight();
      const exportScale = 2;
      const bytes = await pdfDoc.save();
      const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, exportScale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare the redacted page.");

      const overlay = overlayRef.current!;
      const ratioX = canvas.width / overlay.width;
      const ratioY = canvas.height / overlay.height;
      ctx.fillStyle = "#000000";
      for (const box of boxes) {
        ctx.fillRect(
          box.start.x * ratioX,
          box.start.y * ratioY,
          (box.end.x - box.start.x) * ratioX,
          (box.end.y - box.start.y) * ratioY,
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

      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the redaction.");
    } finally {
      setApplying(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg border border-line bg-white p-5 shadow-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Redact page {pageIndex + 1}</h2>
          <button className="mono text-xs text-slate hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>
        <p className="mb-3 text-sm text-slate">
          Drag to draw black boxes over anything to permanently remove. Unlike a black rectangle drawn on top of the
          page, applying this replaces the page with a flat image — the text and shapes underneath a box are gone,
          not just hidden.
        </p>

        {error && <p className="mb-3 text-sm text-brass">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate">Rendering…</p>
        ) : (
          <div className="relative inline-block border border-line">
            <canvas ref={bgCanvasRef} className="block" />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 cursor-crosshair touch-none opacity-70"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setBoxes([])} disabled={boxes.length === 0}>
            Clear boxes
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={apply} disabled={applying || loading || boxes.length === 0}>
            {applying ? "Redacting…" : "Redact permanently"}
          </Button>
        </div>
      </div>
    </div>
  );
}
