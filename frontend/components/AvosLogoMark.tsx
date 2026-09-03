// The square AVOS Leaf product mark — follows the finalized AVOS product logo family shape (see
// brand/SPEC.md in avos-solutions): the tile, wash, and palette are byte-identical to every sibling
// product's own AvosLogoMark (avos-deck's triangle, avos-quill's feather, etc.) — only the glyph
// inside changes per product. This one is Leaf's own: a simple leaf outline with a center vein,
// reading clearly at 24x24 next to the others in the family.
export function AvosLogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="#161225" />
      <path
        d="M4.23 4.23A2.5 2.5 0 0 1 6 3.5H18A2.5 2.5 0 0 1 20.5 6V18A2.5 2.5 0 0 1 19.77 19.77Z"
        fill="#e0a437"
        opacity="0.22"
      />
      <g fill="none" stroke="#e0a437" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 16.5C7.2 11 10.6 7 16.5 7C16.5 12.9 12.5 16.3 8 16.5Z" />
        <path d="M8 16.5C10 13.6 12.4 11 15 9" stroke="#f4c04d" strokeWidth="0.75" />
      </g>
    </svg>
  );
}
