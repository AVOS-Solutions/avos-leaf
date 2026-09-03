// WinAnsiEncoding (== Windows-1252 for our purposes) byte<->Unicode table, per PDF spec Appendix D.
// This is the encoding assumption the in-place text editor (pdfContentStream.ts) uses for every
// simple font it touches — see that file's header comment for why, and for the round-trip check
// that catches fonts where this assumption is wrong instead of silently corrupting them.
//
// 0x00-0x7F and 0xA0-0xFF map to the identical Unicode code point (that's the defining property of
// CP1252/WinAnsi); only 0x80-0x9F remaps to printable characters. The five code points CP1252
// leaves undefined in that block (0x81, 0x8D, 0x8F, 0x90, 0x9D) map to themselves so the table stays
// a total bijection — those bytes essentially never appear in real text anyway.
const HIGH_BLOCK: Record<number, number> = {
  0x80: 0x20ac, // €
  0x82: 0x201a, // ‚
  0x83: 0x0192, // ƒ
  0x84: 0x201e, // „
  0x85: 0x2026, // …
  0x86: 0x2020, // †
  0x87: 0x2021, // ‡
  0x88: 0x02c6, // ˆ
  0x89: 0x2030, // ‰
  0x8a: 0x0160, // Š
  0x8b: 0x2039, // ‹
  0x8c: 0x0152, // Œ
  0x8e: 0x017d, // Ž
  0x91: 0x2018, // '
  0x92: 0x2019, // '
  0x93: 0x201c, // "
  0x94: 0x201d, // "
  0x95: 0x2022, // •
  0x96: 0x2013, // –
  0x97: 0x2014, // —
  0x98: 0x02dc, // ˜
  0x99: 0x2122, // ™
  0x9a: 0x0161, // š
  0x9b: 0x203a, // ›
  0x9c: 0x0153, // œ
  0x9e: 0x017e, // ž
  0x9f: 0x0178, // Ÿ
};

const BYTE_TO_UNICODE: number[] = new Array(256);
const UNICODE_TO_BYTE = new Map<number, number>();
for (let byte = 0; byte < 256; byte++) {
  const codePoint = byte >= 0x80 && byte <= 0x9f ? (HIGH_BLOCK[byte] ?? byte) : byte;
  BYTE_TO_UNICODE[byte] = codePoint;
  UNICODE_TO_BYTE.set(codePoint, byte);
}

export function decodeWinAnsi(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCodePoint(BYTE_TO_UNICODE[bytes[i]]);
  return out;
}

/** Returns null if any character in `text` has no WinAnsi byte — callers should surface that as a
 *  clear "this character can't be used here" error rather than silently dropping/mangling it. */
export function encodeWinAnsi(text: string): Uint8Array | null {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const byte = UNICODE_TO_BYTE.get(text.codePointAt(i)!);
    if (byte === undefined) return null;
    bytes[i] = byte;
  }
  return bytes;
}

export function firstUnencodableChar(text: string): string | null {
  for (const char of text) {
    if (!UNICODE_TO_BYTE.has(char.codePointAt(0)!)) return char;
  }
  return null;
}
