// True in-place PDF text editing: pdf-lib only knows how to *add* new content to a page, never to
// find and rewrite text that's already there — that's a content-stream-level operation pdf-lib
// deliberately doesn't expose (it's a PDF *writer*, not an editor). Everything in this file exists
// to fill that gap: a minimal content-stream tokenizer that locates existing Tj/TJ/'/" text-showing
// operators (tracking the graphics/text state needed to know where each one lands on the page), and
// a byte-splice rewrite that swaps one operator's text for new text without touching anything else
// in the stream.
//
// Scope, stated up front: this only handles *simple* fonts (Type1/TrueType/MMType1 — one byte per
// character), and only characters representable in WinAnsiEncoding (see winAnsiEncoding.ts) — which
// covers plain Latin text in the large majority of real-world PDFs, including every PDF this app
// itself produces. Composite/Type0 fonts (common from browser "Print to PDF" and CJK/complex-script
// text) are detected and marked non-editable rather than guessed at, since re-encoding into a
// subsetted CID font can silently produce garbage or glyphs the font doesn't even contain. Even for
// a simple font, this doesn't know for certain whether the font's actual built-in encoding really
// is WinAnsi — many are — so every extracted run is round-trip verified (decode then re-encode and
// compare bytes) before being offered as editable; a mismatch means our WinAnsi assumption is wrong
// for that font, and the run is left read-only instead of risking corruption.
//
// One more deliberate simplification: editing a run replaces its whole Tj/TJ/'/" operator with a
// single new Tj using the same font/size/position. Original per-glyph kerning (TJ's number entries)
// is dropped — reasonable, since the kerning for the *old* text wouldn't be correct for new text of
// a different length anyway — and surrounding lines are never reflowed.

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { decodeWinAnsi, encodeWinAnsi } from "./winAnsiEncoding";

// ---------------------------------------------------------------------------------------------
// Byte/string helpers — content-stream bytes are handled as "Latin-1 strings" (one JS char per
// byte) throughout, the same convention pdf-lib's own core objects use internally.

function latin1Decode(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function latin1Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function nameString(name: PDFName): string {
  return name.asString().replace(/^\//, "");
}

// ---------------------------------------------------------------------------------------------
// 2D affine matrices, PDF's row-vector convention: [x y 1] * [[a,b,0],[c,d,0],[e,f,1]].

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** The matrix that represents applying `first`, then `second`. */
function compose(first: Matrix, second: Matrix): Matrix {
  return {
    a: first.a * second.a + first.b * second.c,
    b: first.a * second.b + first.b * second.d,
    c: first.c * second.a + first.d * second.c,
    d: first.c * second.b + first.d * second.d,
    e: first.e * second.a + first.f * second.c + second.e,
    f: first.e * second.b + first.f * second.d + second.f,
  };
}

function applyPoint(m: Matrix, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// ---------------------------------------------------------------------------------------------
// Content-stream tokenizer. Deliberately minimal: it fully parses the handful of syntactic shapes
// that matter for tracking text position (numbers, names, strings, arrays-of-string/number) and
// silently skips everything else (inline dictionaries, inline images) rather than modeling it, since
// this only ever needs to *locate* text-showing operators, not represent the whole stream as an AST.

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

type ArrayItem = { kind: "num"; value: number } | { kind: "str"; bytes: Uint8Array };
type NumToken = { kind: "num"; value: number; start: number; end: number };
type NameToken = { kind: "name"; value: string; start: number; end: number };
type StrToken = { kind: "str"; bytes: Uint8Array; start: number; end: number };
type ArrToken = { kind: "arr"; items: ArrayItem[]; start: number; end: number };
type OpToken = { kind: "op"; name: string; start: number; end: number };
type Token = NumToken | NameToken | StrToken | ArrToken | OpToken;

class Scanner {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  done() {
    return this.pos >= this.bytes.length;
  }
  peek(offset = 0) {
    return this.bytes[this.pos + offset];
  }
  slice(start: number, end: number) {
    return this.bytes.slice(start, end);
  }
  skipWhitespaceAndComments() {
    while (!this.done()) {
      const b = this.peek();
      if (WHITESPACE.has(b)) {
        this.pos++;
        continue;
      }
      if (b === 0x25) {
        while (!this.done() && this.peek() !== 0x0a && this.peek() !== 0x0d) this.pos++;
        continue;
      }
      break;
    }
  }
}

function readLiteralString(s: Scanner): StrToken {
  const start = s.pos;
  s.pos++;
  const contentStart = s.pos;
  let depth = 1;
  while (!s.done() && depth > 0) {
    const b = s.peek();
    if (b === 0x5c) {
      s.pos++;
      if (!s.done()) s.pos++;
      continue;
    }
    if (b === 0x28) depth++;
    else if (b === 0x29) {
      depth--;
      if (depth === 0) break;
    }
    s.pos++;
  }
  const raw = s.slice(contentStart, s.pos);
  if (!s.done()) s.pos++; // consume closing ')'
  const bytes = PDFString.of(latin1Decode(raw)).asBytes();
  return { kind: "str", bytes, start, end: s.pos };
}

function readHexString(s: Scanner): StrToken {
  const start = s.pos;
  s.pos++;
  const contentStart = s.pos;
  while (!s.done() && s.peek() !== 0x3e) s.pos++;
  const raw = s.slice(contentStart, s.pos);
  if (!s.done()) s.pos++; // consume closing '>'
  const hex = latin1Decode(raw).replace(/\s+/g, "");
  const bytes = PDFHexString.of(hex).asBytes();
  return { kind: "str", bytes, start, end: s.pos };
}

function readName(s: Scanner): NameToken {
  const start = s.pos;
  s.pos++;
  const bytes: number[] = [];
  while (!s.done()) {
    const b = s.peek();
    if (WHITESPACE.has(b) || DELIMITERS.has(b)) break;
    if (b === 0x23) {
      const hex = String.fromCharCode(s.peek(1) ?? 0, s.peek(2) ?? 0);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        s.pos += 3;
        continue;
      }
    }
    bytes.push(b);
    s.pos++;
  }
  return { kind: "name", value: latin1Decode(Uint8Array.from(bytes)), start, end: s.pos };
}

function readNumber(s: Scanner): NumToken {
  const start = s.pos;
  let text = "";
  if (s.peek() === 0x2b || s.peek() === 0x2d) {
    text += String.fromCharCode(s.peek());
    s.pos++;
  }
  while (!s.done() && ((s.peek() >= 0x30 && s.peek() <= 0x39) || s.peek() === 0x2e)) {
    text += String.fromCharCode(s.peek());
    s.pos++;
  }
  return { kind: "num", value: parseFloat(text) || 0, start, end: s.pos };
}

function readKeyword(s: Scanner): OpToken {
  const start = s.pos;
  let text = "";
  while (!s.done()) {
    const b = s.peek();
    if (WHITESPACE.has(b) || DELIMITERS.has(b)) break;
    text += String.fromCharCode(b);
    s.pos++;
  }
  if (text.length === 0) s.pos++; // stray delimiter byte we don't otherwise handle — don't loop forever
  return { kind: "op", name: text, start, end: s.pos };
}

function skipDict(s: Scanner): void {
  s.pos += 2;
  let depth = 1;
  while (!s.done() && depth > 0) {
    s.skipWhitespaceAndComments();
    if (s.done()) break;
    const b = s.peek();
    if (b === 0x3c && s.peek(1) === 0x3c) {
      depth++;
      s.pos += 2;
    } else if (b === 0x3e && s.peek(1) === 0x3e) {
      depth--;
      s.pos += 2;
    } else if (b === 0x28) {
      readLiteralString(s);
    } else if (b === 0x3c) {
      s.pos++;
      while (!s.done() && s.peek() !== 0x3e) s.pos++;
      s.pos++;
    } else if (b === 0x5b) {
      readArray(s);
    } else if (b === 0x2f) {
      readName(s);
    } else {
      s.pos++;
    }
  }
}

function readArray(s: Scanner): ArrToken {
  const start = s.pos;
  s.pos++;
  const items: ArrayItem[] = [];
  for (;;) {
    s.skipWhitespaceAndComments();
    if (s.done()) break;
    const b = s.peek();
    if (b === 0x5d) {
      s.pos++;
      break;
    }
    if (b === 0x28) {
      items.push({ kind: "str", bytes: readLiteralString(s).bytes });
    } else if (b === 0x3c && s.peek(1) === 0x3c) {
      skipDict(s);
    } else if (b === 0x3c) {
      items.push({ kind: "str", bytes: readHexString(s).bytes });
    } else if (b === 0x2d || b === 0x2b || b === 0x2e || (b >= 0x30 && b <= 0x39)) {
      items.push({ kind: "num", value: readNumber(s).value });
    } else if (b === 0x2f) {
      readName(s);
    } else if (b === 0x5b) {
      readArray(s);
    } else {
      s.pos++;
    }
  }
  return { kind: "arr", items, start, end: s.pos };
}

function readToken(s: Scanner): Token | null {
  for (;;) {
    s.skipWhitespaceAndComments();
    if (s.done()) return null;
    const b = s.peek();
    if (b === 0x28) return readLiteralString(s);
    if (b === 0x3c) {
      if (s.peek(1) === 0x3c) {
        skipDict(s);
        continue;
      }
      return readHexString(s);
    }
    if (b === 0x5b) return readArray(s);
    if (b === 0x2f) return readName(s);
    if (b === 0x2d || b === 0x2b || b === 0x2e || (b >= 0x30 && b <= 0x39)) return readNumber(s);
    return readKeyword(s);
  }
}

// ---------------------------------------------------------------------------------------------
// Font metrics (simple fonts only — see the file header).

type SimpleFontInfo = { isType0: boolean; widths: number[]; firstChar: number; missingWidth: number };

function getFontInfo(resources: PDFDict, fontResourceName: string): SimpleFontInfo | null {
  const fontDict = resources.lookupMaybe(PDFName.Font, PDFDict)?.lookupMaybe(PDFName.of(fontResourceName), PDFDict);
  if (!fontDict) return null;
  const subtype = fontDict.lookupMaybe(PDFName.of("Subtype"), PDFName);
  const isType0 = subtype ? nameString(subtype) === "Type0" : false;
  if (isType0) return { isType0: true, widths: [], firstChar: 0, missingWidth: 0 };

  const firstChar = fontDict.lookupMaybe(PDFName.of("FirstChar"), PDFNumber)?.asNumber() ?? 0;
  const widthsArray = fontDict.lookupMaybe(PDFName.of("Widths"), PDFArray);
  const widths: number[] = [];
  if (widthsArray) {
    for (const item of widthsArray.asArray()) widths.push(item instanceof PDFNumber ? item.asNumber() : NaN);
  }
  const descriptor = fontDict.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
  const missingWidth = descriptor?.lookupMaybe(PDFName.of("MissingWidth"), PDFNumber)?.asNumber() ?? 0;
  return { isType0: false, widths, firstChar, missingWidth };
}

function glyphWidth(info: SimpleFontInfo, byte: number): number {
  const w = info.widths[byte - info.firstChar];
  return Number.isFinite(w) ? w : info.missingWidth || 500;
}

// ---------------------------------------------------------------------------------------------
// Text-run extraction: a single linear pass tracking just enough graphics/text state to place each
// text-showing operator on the page and compute its approximate on-page box.

export type TextRun = {
  /** Byte offsets into the page's concatenated content stream — the exact span replaceTextRun
   *  splices out and replaces. Never touched or reinterpreted by callers. */
  opStart: number;
  opEnd: number;
  text: string;
  editable: boolean;
  reason?: string;
  /** Axis-aligned bounding box in PDF page space (origin bottom-left, y-up) — a loose fit for
   *  rotated text, but adequate for a clickable overlay. */
  box: { x: number; y: number; width: number; height: number };
  fontSizePt: number;
};

export async function extractTextRuns(page: PDFPage): Promise<TextRun[]> {
  // pdf-lib defers embedding newly-added resources (a font from a Watermark/Sign/PageNumbers
  // action earlier in this same edit session, for instance) until PDFDocument.save() actually
  // runs — before that, the resource dictionary can already list a name pointing at a ref with
  // nothing registered there yet. Saving (and discarding the bytes) forces that embedding to
  // happen now, so every font this page's Resources references is actually resolvable below.
  await page.doc.save();

  const bytes = getPageContentBytes(page);
  if (!bytes) return [];
  const resources = page.node.Resources();
  if (!resources) return [];

  const runs: TextRun[] = [];
  const scanner = new Scanner(bytes);
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let fontResourceName: string | null = null;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizScale = 1;
  let leading = 0;

  const operands: Token[] = [];
  const num = (t: Token | undefined) => (t?.kind === "num" ? t.value : 0);

  function newLine() {
    tlm = compose({ a: 1, b: 0, c: 0, d: 1, e: 0, f: -leading }, tlm);
    tm = tlm;
  }

  function recordTextShow(opName: string, opStart: number, opEnd: number, textBytes: Uint8Array) {
    if (!fontResourceName || fontSize === 0 || textBytes.length === 0) return;
    const fontInfo = getFontInfo(resources!, fontResourceName);
    const trm = compose(tm, ctm);
    const origin = applyPoint(trm, 0, 0);

    if (!fontInfo || fontInfo.isType0) {
      runs.push({
        opStart,
        opEnd,
        text: "",
        editable: false,
        reason: "Complex (composite) font — not supported for editing.",
        box: { x: origin.x, y: origin.y - fontSize * 0.2, width: fontSize * 0.6 * textBytes.length, height: fontSize },
        fontSizePt: fontSize,
      });
      return;
    }

    let advance = 0;
    for (const byte of textBytes) {
      advance += ((glyphWidth(fontInfo, byte) / 1000) * fontSize + charSpacing + (byte === 0x20 ? wordSpacing : 0)) * horizScale;
    }

    const text = decodeWinAnsi(textBytes);
    const reEncoded = encodeWinAnsi(text);
    const roundTripOk = !!reEncoded && reEncoded.length === textBytes.length && reEncoded.every((b, i) => b === textBytes[i]);

    // Corners of the run's local box (baseline-relative, before the text-rendering matrix),
    // transformed through trm so rotated/skewed text still gets a sane bounding box.
    const corners = [
      applyPoint(trm, 0, -fontSize * 0.2),
      applyPoint(trm, advance, -fontSize * 0.2),
      applyPoint(trm, advance, fontSize * 0.8),
      applyPoint(trm, 0, fontSize * 0.8),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };

    runs.push({
      opStart,
      opEnd,
      text,
      editable: roundTripOk,
      reason: roundTripOk ? undefined : "This font's encoding couldn't be verified — editing it isn't safe.",
      box,
      fontSizePt: fontSize,
    });
  }

  for (;;) {
    const token = readToken(scanner);
    if (!token) break;
    if (token.kind !== "op") {
      operands.push(token);
      continue;
    }

    const opStart = operands.length > 0 ? operands[0].start : token.start;
    switch (token.name) {
      case "q":
        ctmStack.push(ctm);
        break;
      case "Q":
        ctm = ctmStack.pop() ?? IDENTITY;
        break;
      case "cm":
        ctm = compose({ a: num(operands[0]), b: num(operands[1]), c: num(operands[2]), d: num(operands[3]), e: num(operands[4]), f: num(operands[5]) }, ctm);
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "ET":
        break;
      case "Tf": {
        const nameTok = operands[0];
        fontResourceName = nameTok?.kind === "name" ? nameTok.value : fontResourceName;
        fontSize = num(operands[1]);
        break;
      }
      case "Tc":
        charSpacing = num(operands[0]);
        break;
      case "Tw":
        wordSpacing = num(operands[0]);
        break;
      case "Tz":
        horizScale = num(operands[0]) / 100;
        break;
      case "TL":
        leading = num(operands[0]);
        break;
      case "Td":
        tlm = compose({ a: 1, b: 0, c: 0, d: 1, e: num(operands[0]), f: num(operands[1]) }, tlm);
        tm = tlm;
        break;
      case "TD":
        leading = -num(operands[1]);
        tlm = compose({ a: 1, b: 0, c: 0, d: 1, e: num(operands[0]), f: num(operands[1]) }, tlm);
        tm = tlm;
        break;
      case "Tm":
        tlm = { a: num(operands[0]), b: num(operands[1]), c: num(operands[2]), d: num(operands[3]), e: num(operands[4]), f: num(operands[5]) };
        tm = tlm;
        break;
      case "T*":
        newLine();
        break;
      case "'":
        newLine();
        if (operands[0]?.kind === "str") recordTextShow(token.name, opStart, token.end, operands[0].bytes);
        break;
      case '"':
        wordSpacing = num(operands[0]);
        charSpacing = num(operands[1]);
        newLine();
        if (operands[2]?.kind === "str") recordTextShow(token.name, opStart, token.end, operands[2].bytes);
        break;
      case "Tj":
        if (operands[0]?.kind === "str") recordTextShow(token.name, opStart, token.end, operands[0].bytes);
        break;
      case "TJ": {
        if (operands[0]?.kind === "arr") {
          const parts: Uint8Array[] = [];
          let total = 0;
          for (const item of operands[0].items) {
            if (item.kind === "str") {
              parts.push(item.bytes);
              total += item.bytes.length;
            }
          }
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const part of parts) {
            merged.set(part, offset);
            offset += part.length;
          }
          recordTextShow(token.name, opStart, token.end, merged);
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }

  return runs;
}

// ---------------------------------------------------------------------------------------------
// Reading and rewriting the page's actual content stream bytes.

function isPDFContentStreamLike(obj: unknown): obj is { getUnencodedContents(): Uint8Array } {
  return !!obj && typeof (obj as { getUnencodedContents?: unknown }).getUnencodedContents === "function";
}

function streamBytes(obj: unknown): Uint8Array | null {
  if (isPDFContentStreamLike(obj)) return obj.getUnencodedContents();
  if (obj instanceof PDFRawStream) return decodePDFRawStream(obj).decode();
  return null;
}

function resolve(context: PDFContext, obj: unknown): unknown {
  return obj instanceof PDFRef ? context.lookup(obj) : obj;
}

/** The page's full content, as if every content-stream fragment (a page's Contents can be a single
 *  stream, or an array of several treated as if concatenated) were one buffer — per PDF spec,
 *  fragments are joined with whitespace between them so tokens never accidentally merge across a
 *  boundary. This also transparently picks up content this app itself already added earlier in the
 *  same edit session (annotations, watermarks, ...), which pdf-lib keeps as an unflushed in-memory
 *  stream object rather than page bytes until save() — see this file's PR description for why that
 *  matters here. */
function getPageContentBytes(page: PDFPage): Uint8Array | null {
  const context = page.doc.context;
  const contents = page.node.Contents();
  if (!contents) return null;

  const chunks: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (const item of contents.asArray()) {
      const bytes = streamBytes(resolve(context, item));
      if (bytes) chunks.push(bytes);
    }
  } else {
    const bytes = streamBytes(contents);
    if (bytes) chunks.push(bytes);
  }
  if (chunks.length === 0) return null;

  const separator = new Uint8Array([0x0a]);
  const total = chunks.reduce((sum, c) => sum + c.length, 0) + separator.length * (chunks.length - 1);
  const combined = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk, i) => {
    combined.set(chunk, offset);
    offset += chunk.length;
    if (i < chunks.length - 1) {
      combined.set(separator, offset);
      offset += separator.length;
    }
  });
  return combined;
}

/** Replaces one text run's Tj/TJ/'/" operator (identified by the byte span extractTextRuns gave it)
 *  with a single `<hex> Tj` operator carrying the new text, then writes the whole page content back
 *  as one consolidated stream. Everything outside that byte span — every other operator, all
 *  original formatting/whitespace — is copied through completely unchanged. Throws if `newText`
 *  contains a character this font's assumed WinAnsi encoding can't represent. */
export function replaceTextRun(page: PDFPage, run: TextRun, newText: string): void {
  const bytes = getPageContentBytes(page);
  if (!bytes) throw new Error("Could not read this page's content.");

  const encoded = encodeWinAnsi(newText);
  if (!encoded) throw new Error("This font can't represent one or more of those characters.");

  const hex = Array.from(encoded, (b) => b.toString(16).padStart(2, "0")).join("");
  const newOperator = latin1Encode(`<${hex}> Tj`);

  const rewritten = new Uint8Array(bytes.length - (run.opEnd - run.opStart) + newOperator.length);
  rewritten.set(bytes.subarray(0, run.opStart), 0);
  rewritten.set(newOperator, run.opStart);
  rewritten.set(bytes.subarray(run.opEnd), run.opStart + newOperator.length);

  const context = page.doc.context;
  const newStream = context.flateStream(rewritten);
  const ref = context.register(newStream);
  page.node.set(PDFName.Contents, ref);
}
