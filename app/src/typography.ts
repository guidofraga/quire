// The document's built-in typography: what text and math look like where its styles say nothing.
// See docs/02-file-format.md §3 (`styles.typography`).
import type { Doc } from "./types";

/**
 * Typeset documents (`styles.typography` 2, which new documents and the built-in templates get
 * from the engine, quire-service `TYPOGRAPHY`) set text in Quire Text at 10.5 pt and math at the
 * text's size, with a heading scale. Documents without it keep the look they were made with:
 * the system's sans-serif at 10 pt, math drawn at 1.2 times its size, headings at text size.
 */
export function typeset(doc: Doc): boolean {
  const t = doc.styles?.typography;
  return typeof t === "number" && t >= 2;
}

/** The body text's size in points when the document doesn't set one. */
export function defaultBodySize(doc: Doc): number {
  return typeset(doc) ? 10.5 : 10;
}

/** The body text's size in points. */
export function bodySize(doc: Doc): number {
  return doc.styles?.body?.size ?? defaultBodySize(doc);
}

/** Math's size in points: typeset, the text's size, so their x-heights match. */
export function mathSize(doc: Doc): number {
  return doc.styles?.math?.size ?? (typeset(doc) ? bodySize(doc) : 10);
}
