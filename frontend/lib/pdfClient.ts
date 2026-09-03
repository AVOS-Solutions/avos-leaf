// Shared pdf.js/pdf-lib plumbing used by the document editor and its tool modals (annotate,
// redact, sign, split, ...). Kept in one place so every caller resolves the pdf.js worker and
// converts bytes the same way — a mismatch here (e.g. two different worker URLs) is the kind of
// thing that only breaks in production builds, not dev.

/** pdf-lib's PDFDocument.save() returns a Uint8Array typed as Uint8Array<ArrayBufferLike> — Blob
 *  and pdf.js's getDocument({ data }) both want a plain ArrayBuffer-backed view, so this copies out
 *  a fresh ArrayBuffer to satisfy that (SharedArrayBuffer, which ArrayBufferLike also covers, could
 *  never actually appear here). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function loadPdfJs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  return pdfjsLib;
}

/** Renders one page (1-indexed, matching pdf.js's own convention) of the given PDF bytes to a
 *  canvas at the requested scale, returning both the canvas (for further compositing — e.g.
 *  painting redaction boxes on top before rasterizing) and the PDF-point page size pdf.js reports,
 *  which every tool modal needs to map screen/canvas pixel coordinates back to PDF coordinates. */
export async function renderPageToCanvas(bytes: Uint8Array, pageNumber: number, scale: number) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: toArrayBuffer(bytes) }).promise;
  const page = await doc.getPage(pageNumber);
  const unscaledViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2D canvas context.");
  await page.render({ canvasContext: context, viewport, canvas }).promise;
  return { canvas, pdfWidth: unscaledViewport.width, pdfHeight: unscaledViewport.height };
}

/** Converts a point in this canvas's own pixel space (origin top-left, y grows down — how every
 *  pointer/mouse event reports coordinates) into PDF point space (origin bottom-left, y grows up —
 *  what every pdf-lib draw call expects). */
export function canvasPointToPdf(x: number, y: number, canvasWidth: number, canvasHeight: number, pdfWidth: number, pdfHeight: number) {
  return { x: (x / canvasWidth) * pdfWidth, y: pdfHeight - (y / canvasHeight) * pdfHeight };
}
