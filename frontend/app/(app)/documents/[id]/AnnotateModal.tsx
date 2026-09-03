"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocument, PDFPage } from "pdf-lib";
import { rgb, StandardFonts } from "pdf-lib";
import { Button } from "@/components/ui";
import { renderPageToCanvas } from "@/lib/pdfClient";

type Tool = "pen" | "highlighter" | "rect" | "arrow" | "text";
type Point = { x: number; y: number };
type Shape =
  | { kind: "path"; tool: "pen" | "highlighter"; points: Point[]; color: string }
  | { kind: "rect"; start: Point; end: Point; color: string }
  | { kind: "arrow"; start: Point; end: Point; color: string }
  | { kind: "text"; at: Point; text: string; color: string };

const COLORS = ["#dc2626", "#2563eb", "#16a34a", "#111111", "#f59e0b"];

/** Freehand/shape/text annotation on a single page — draws into an on-screen canvas for the
 *  interactive preview, then re-plays the same shapes as real pdf-lib draw operations at Apply
 *  time (canvas pixels never touch the saved PDF directly; only the vector shape data does, so the
 *  result stays crisp at any zoom). Coordinates are converted using the page's own pdf-lib
 *  dimensions (not pdf.js's, which reports a rotated viewport) — correct for the common unrotated
 *  case; a page with a non-zero Rotation will render its background correctly but the coordinate
 *  mapping used for freshly-drawn shapes isn't rotation-aware. */
export function AnnotateModal({
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
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [dims, setDims] = useState<{ canvasW: number; canvasH: number; pdfW: number; pdfH: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    let cancelled = false;
    async function render() {
      setLoading(true);
      setError(null);
      setShapes([]);
      try {
        const page = pdfDoc!.getPage(pageIndex);
        const pdfW = page.getWidth();
        const pdfH = page.getHeight();
        const scale = Math.min(900 / pdfW, 1.8);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-render only when the modal (re)opens on a page, not on every pdfDoc identity change
  }, [open, pageIndex]);

  function paintShape(ctx: CanvasRenderingContext2D, shape: Shape) {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (shape.kind === "path") {
      ctx.globalAlpha = shape.tool === "highlighter" ? 0.35 : 1;
      ctx.lineWidth = shape.tool === "highlighter" ? 16 : 3;
      ctx.beginPath();
      shape.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (shape.kind === "rect") {
      ctx.lineWidth = 2;
      ctx.strokeRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
    } else if (shape.kind === "arrow") {
      ctx.lineWidth = 2.5;
      drawArrowOnCanvas(ctx, shape.start, shape.end);
    } else {
      ctx.font = "16px sans-serif";
      ctx.fillText(shape.text, shape.at.x, shape.at.y);
    }
  }

  function drawArrowOnCanvas(ctx: CanvasRenderingContext2D, start: Point, end: Point) {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLen = 12;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  function redraw() {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const shape of drawing ? [...shapes, drawing] : shapes) paintShape(ctx, shape);
  }

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, drawing]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointFromEvent(e);
    if (tool === "pen" || tool === "highlighter") {
      setDrawing({ kind: "path", tool, points: [p], color });
    } else if (tool === "rect") {
      setDrawing({ kind: "rect", start: p, end: p, color });
    } else if (tool === "arrow") {
      setDrawing({ kind: "arrow", start: p, end: p, color });
    } else {
      const text = window.prompt("Note text");
      if (text) setShapes((prev) => [...prev, { kind: "text", at: p, text, color }]);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    const p = pointFromEvent(e);
    setDrawing((prev) => {
      if (!prev) return prev;
      if (prev.kind === "path") return { ...prev, points: [...prev.points, p] };
      if (prev.kind === "rect" || prev.kind === "arrow") return { ...prev, end: p };
      return prev;
    });
  }

  function onPointerUp() {
    if (drawing) setShapes((prev) => [...prev, drawing]);
    setDrawing(null);
  }

  function undo() {
    setShapes((prev) => prev.slice(0, -1));
  }

  async function apply() {
    if (!pdfDoc || !dims) return;
    setApplying(true);
    setError(null);
    try {
      const page = pdfDoc.getPage(pageIndex);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      for (const shape of shapes) bakeShape(page, shape, dims, font);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply your annotations.");
    } finally {
      setApplying(false);
    }
  }

  function bakeShape(
    page: PDFPage,
    shape: Shape,
    d: { canvasW: number; canvasH: number; pdfW: number; pdfH: number },
    font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  ) {
    const toPdf = (p: Point) => ({ x: (p.x / d.canvasW) * d.pdfW, y: d.pdfH - (p.y / d.canvasH) * d.pdfH });
    const col = hexToRgb(shape.color);
    if (shape.kind === "path") {
      const pts = shape.points.map(toPdf);
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: pts[i - 1],
          end: pts[i],
          thickness: shape.tool === "highlighter" ? (16 / d.canvasW) * d.pdfW : (3 / d.canvasW) * d.pdfW,
          color: rgb(col.r, col.g, col.b),
          opacity: shape.tool === "highlighter" ? 0.35 : 1,
        });
      }
    } else if (shape.kind === "rect") {
      const a = toPdf(shape.start);
      const b = toPdf(shape.end);
      page.drawRectangle({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
        borderColor: rgb(col.r, col.g, col.b),
        borderWidth: 2,
      });
    } else if (shape.kind === "arrow") {
      const a = toPdf(shape.start);
      const b = toPdf(shape.end);
      const thickness = 2;
      page.drawLine({ start: a, end: b, thickness, color: rgb(col.r, col.g, col.b) });
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const headLen = (12 / d.canvasW) * d.pdfW;
      const wing = Math.PI / 6;
      page.drawLine({
        start: b,
        end: { x: b.x - headLen * Math.cos(angle - wing), y: b.y - headLen * Math.sin(angle - wing) },
        thickness,
        color: rgb(col.r, col.g, col.b),
      });
      page.drawLine({
        start: b,
        end: { x: b.x - headLen * Math.cos(angle + wing), y: b.y - headLen * Math.sin(angle + wing) },
        thickness,
        color: rgb(col.r, col.g, col.b),
      });
    } else {
      const at = toPdf(shape.at);
      page.drawText(shape.text, { x: at.x, y: at.y - 12, size: 12, font, color: rgb(col.r, col.g, col.b) });
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg border border-line bg-white p-5 shadow-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Annotate page {pageIndex + 1}</h2>
          <button className="mono text-xs text-slate hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(["pen", "highlighter", "rect", "arrow", "text"] as Tool[]).map((t) => (
            <Button key={t} variant={tool === t ? "primary" : "secondary"} onClick={() => setTool(t)} className="capitalize">
              {t}
            </Button>
          ))}
          <div className="mx-2 flex gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-ink" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <Button variant="secondary" onClick={undo} disabled={shapes.length === 0}>
            Undo last
          </Button>
          <Button variant="secondary" onClick={() => setShapes([])} disabled={shapes.length === 0}>
            Clear all
          </Button>
        </div>

        {error && <p className="mb-3 text-sm text-brass">{error}</p>}
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

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || loading}>
            {applying ? "Applying…" : "Apply to page"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
