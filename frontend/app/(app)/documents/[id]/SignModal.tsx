"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { renderPageToCanvas } from "@/lib/pdfClient";
import { Button, Select } from "@/components/ui";

type Point = { x: number; y: number };

const STAMP_WIDTH_PT = 160;
const STAMP_HEIGHT_PT = 60;

/** Draw-a-signature-and-stamp-it flow: the left canvas is a free signature pad (mouse/touch), the
 *  right canvas is a small preview of the target page — clicking it sets the stamp's anchor point.
 *  Applying embeds the signature drawing as a PNG at that point, sized in PDF points so it comes out
 *  the same physical size regardless of the preview's zoom level. */
export function SignModal({
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
  const padRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const [hasStroke, setHasStroke] = useState(false);
  const [pageIndex, setPageIndex] = useState(pageCount - 1);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [pageDims, setPageDims] = useState<{ canvasW: number; canvasH: number; pdfW: number; pdfH: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to the last page whenever the modal (re)opens, not reacting to pdfDoc's own state
    if (open) setPageIndex(pageCount - 1);
  }, [open, pageCount]);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function render() {
      setLoading(true);
      setAnchor(null);
      setError(null);
      try {
        const page = pdfDoc!.getPage(pageIndex);
        const pdfW = page.getWidth();
        const pdfH = page.getHeight();
        const scale = Math.min(360 / pdfW, 1);
        const bytes = await pdfDoc!.save();
        const { canvas } = await renderPageToCanvas(bytes, pageIndex + 1, scale);
        if (cancelled) return;
        const preview = previewRef.current;
        if (!preview) return;
        preview.width = canvas.width;
        preview.height = canvas.height;
        preview.getContext("2d")?.drawImage(canvas, 0, 0);
        setPageDims({ canvasW: canvas.width, canvasH: canvas.height, pdfW, pdfH });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not render that page.");
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
    if (!open) {
      clearPad();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the pad's own dirty flag when the modal closes, not reacting to pdfDoc's state
      setHasStroke(false);
    }
  }, [open]);

  function padPoint(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = padRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = true;
    lastPointRef.current = padPoint(e);
  }

  function moveStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = padRef.current?.getContext("2d");
    const p = padPoint(e);
    if (!ctx || !lastPointRef.current) return;
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPointRef.current = p;
    setHasStroke(true);
  }

  function endStroke() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearPad() {
    const canvas = padRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
  }

  function pickAnchor(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = previewRef.current!.getBoundingClientRect();
    setAnchor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  async function apply() {
    if (!pdfDoc || !pageDims || !anchor || !hasStroke) return;
    setApplying(true);
    setError(null);
    try {
      const padCanvas = padRef.current!;
      const pngBytes = await new Promise<Uint8Array>((resolve, reject) => {
        padCanvas.toBlob(async (blob) => {
          if (!blob) return reject(new Error("Could not capture the signature."));
          resolve(new Uint8Array(await blob.arrayBuffer()));
        }, "image/png");
      });
      const image = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.getPage(pageIndex);
      const x = (anchor.x / pageDims.canvasW) * pageDims.pdfW;
      const y = pageDims.pdfH - (anchor.y / pageDims.canvasH) * pageDims.pdfH;
      page.drawImage(image, { x, y: y - STAMP_HEIGHT_PT, width: STAMP_WIDTH_PT, height: STAMP_HEIGHT_PT });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not place your signature.");
    } finally {
      setApplying(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg border border-line bg-white p-5 shadow-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg">Sign document</h2>
          <button className="mono text-xs text-slate hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-brass">{error}</p>}

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="eyebrow mb-1.5">1. Draw your signature</p>
            <canvas
              ref={padRef}
              width={320}
              height={140}
              className="touch-none rounded border border-line bg-white"
              onPointerDown={startStroke}
              onPointerMove={moveStroke}
              onPointerUp={endStroke}
              onPointerLeave={endStroke}
            />
            <Button variant="secondary" className="mt-2" onClick={clearPad} disabled={!hasStroke}>
              Clear
            </Button>
          </div>

          <div>
            <p className="eyebrow mb-1.5">2. Choose page and click to place</p>
            <Select className="mb-2" value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))}>
              {Array.from({ length: pageCount }, (_, i) => (
                <option key={i} value={i}>
                  Page {i + 1}
                </option>
              ))}
            </Select>
            {loading ? (
              <p className="text-sm text-slate">Rendering…</p>
            ) : (
              <div className="relative inline-block border border-line">
                <canvas ref={previewRef} className="block cursor-crosshair" onClick={pickAnchor} />
                {anchor && (
                  <div
                    className="pointer-events-none absolute rounded border-2 border-signal"
                    style={{ left: anchor.x - 4, top: anchor.y - 4, width: 8, height: 8 }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || loading || !hasStroke || !anchor}>
            {applying ? "Placing…" : "Place signature"}
          </Button>
        </div>
      </div>
    </div>
  );
}
