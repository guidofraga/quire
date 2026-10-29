// Word-like formatting of spreadsheet tables: per-cell bold, italic, alignment, shading and
// merged cells (`cellFormat`, keyed by A1 name), borders, and a width that fits the text column.
// Pure functions over the region's fields, so they are easy to test and to keep in step with
// row/column inserts and deletes.
import type { Region } from "./types";

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";
export type Borders = "all" | "outer" | "none";

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  align?: HAlign;
  valign?: VAlign;
  /** Shading, `#rrggbb`. */
  fill?: string;
  /** A merged cell: this one (the top-left) spans rowSpan × colSpan cells. */
  rowSpan?: number;
  colSpan?: number;
}

export type CellFormats = Record<string, CellFormat>;

const colName = (c: number): string => (c < 26 ? "" : colName(Math.floor(c / 26) - 1)) + String.fromCharCode(65 + (c % 26));
export const a1 = (r: number, c: number) => `${colName(c)}${r + 1}`;
export function parseA1(name: string): [number, number] | null {
  const m = /^([A-Z]{1,3})([1-9]\d*)$/.exec(name);
  if (!m) return null;
  const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [Number(m[2]) - 1, c];
}

export const formatsOf = (r: Region): CellFormats => (r.cellFormat as CellFormats | undefined) ?? {};
export const formatAt = (r: Region, i: number, j: number): CellFormat => formatsOf(r)[a1(i, j)] ?? {};
export const bordersOf = (r: Region): Borders => (r.borders as Borders | undefined) ?? "all";
/** Word's "AutoFit to window": the table is as wide as the text column. */
export const fitsColumn = (r: Region) => r.fit === true;

/** Drop empty formats and an empty map, so the file only holds what was set (`bold: false` stays: a header cell set plain). */
export function tidyFormats(f: CellFormats): CellFormats | undefined {
  const out: CellFormats = {};
  for (const [k, v] of Object.entries(f)) {
    const c: CellFormat = { ...v };
    for (const key of Object.keys(c) as (keyof CellFormat)[]) if (c[key] === undefined || c[key] === "") delete c[key];
    if ((c.rowSpan ?? 1) <= 1) delete c.rowSpan;
    if ((c.colSpan ?? 1) <= 1) delete c.colSpan;
    if (Object.keys(c).length) out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Merged cells: which cells are hidden under another, and where each one's anchor is. */
export interface Spans {
  /** "i,j" of a hidden cell → its anchor [i, j]. */
  covered: Map<string, [number, number]>;
  span: (i: number, j: number) => [number, number];
}

export function spansOf(r: Region, h: number, w: number): Spans {
  const covered = new Map<string, [number, number]>();
  const f = formatsOf(r);
  for (const [name, c] of Object.entries(f)) {
    const at = parseA1(name);
    if (!at || ((c.rowSpan ?? 1) <= 1 && (c.colSpan ?? 1) <= 1)) continue;
    const [i0, j0] = at;
    for (let i = i0; i < Math.min(h, i0 + (c.rowSpan ?? 1)); i++)
      for (let j = j0; j < Math.min(w, j0 + (c.colSpan ?? 1)); j++) if (i !== i0 || j !== j0) covered.set(`${i},${j}`, [i0, j0]);
  }
  return {
    covered,
    span: (i, j) => {
      const c = f[a1(i, j)];
      return [Math.max(1, Math.min(c?.rowSpan ?? 1, h - i)), Math.max(1, Math.min(c?.colSpan ?? 1, w - j))];
    },
  };
}

/** The cell a position belongs to: itself, or the merged cell covering it. */
export function anchorOf(s: Spans, i: number, j: number): [number, number] {
  return s.covered.get(`${i},${j}`) ?? [i, j];
}

/** Grow a range [r0..r1]×[c0..c1] until no merged cell sticks out of it (Word merges rectangles). */
export function expandRange(s: Spans, rg: { r0: number; r1: number; c0: number; c1: number }) {
  let { r0, r1, c0, c1 } = rg;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = r0; i <= r1; i++)
      for (let j = c0; j <= c1; j++) {
        const [ai, aj] = anchorOf(s, i, j);
        const [h, w] = s.span(ai, aj);
        const n = { r0: Math.min(r0, ai), r1: Math.max(r1, ai + h - 1), c0: Math.min(c0, aj), c1: Math.max(c1, aj + w - 1) };
        if (n.r0 !== r0 || n.r1 !== r1 || n.c0 !== c0 || n.c1 !== c1) {
          ({ r0, r1, c0, c1 } = n);
          changed = true;
        }
      }
  }
  return { r0, r1, c0, c1 };
}

/**
 * Rows or columns inserted (delta > 0) or deleted (delta < 0) at `at`: formats follow their
 * cells, a merged cell grows when rows are inserted inside it and shrinks when some of its
 * rows are deleted.
 */
export function shiftFormats(f: CellFormats, axis: "row" | "col", at: number, delta: number): CellFormats {
  const move = (k: number) => (k < at ? k : delta < 0 && k < at - delta ? null : k + delta);
  const out: CellFormats = {};
  for (const [name, c] of Object.entries(f)) {
    const pos = parseA1(name);
    if (!pos) continue;
    const [i, j] = pos;
    const k0 = axis === "row" ? i : j;
    const n = axis === "row" ? (c.rowSpan ?? 1) : (c.colSpan ?? 1);
    const kept: number[] = [];
    for (let k = k0; k < k0 + n; k++) {
      const m = move(k);
      if (m !== null) kept.push(m);
    }
    if (!kept.length) continue;
    const first = kept[0];
    const span = kept[kept.length - 1] - first + 1;
    const next: CellFormat = { ...c, ...(axis === "row" ? { rowSpan: span } : { colSpan: span }) };
    out[axis === "row" ? a1(first, j) : a1(i, first)] = next;
  }
  return tidyFormats(out) ?? {};
}

/** Set (or with `undefined`, clear) a property on every cell of a range. */
export function applyFormat(f: CellFormats, cells: [number, number][], patch: Partial<CellFormat>): CellFormats {
  const out = { ...f };
  for (const [i, j] of cells) {
    const k = a1(i, j);
    out[k] = { ...out[k], ...patch };
  }
  return tidyFormats(out) ?? {};
}

/** Merge a range into its top-left cell; the others' text joins it, as in Word. */
export function mergeCells(rows: string[][], f: CellFormats, rg: { r0: number; r1: number; c0: number; c1: number }): CellFormats {
  const out: CellFormats = { ...f };
  const parts: string[] = [];
  for (let i = rg.r0; i <= rg.r1; i++)
    for (let j = rg.c0; j <= rg.c1; j++) {
      const v = rows[i]?.[j] ?? "";
      if (v.trim()) parts.push(v);
      if (i !== rg.r0 || j !== rg.c0) {
        if (rows[i]) rows[i][j] = "";
        delete out[a1(i, j)];
      }
    }
  // a formula stays as it is; text from several cells joins
  if (rows[rg.r0]) rows[rg.r0][rg.c0] = parts.length > 1 && !parts[0].startsWith("=") ? parts.join(" ") : (parts[0] ?? "");
  out[a1(rg.r0, rg.c0)] = { ...out[a1(rg.r0, rg.c0)], rowSpan: rg.r1 - rg.r0 + 1, colSpan: rg.c1 - rg.c0 + 1 };
  return tidyFormats(out) ?? {};
}

/** Split every merged cell that starts in a range back into single cells. */
export function splitCells(f: CellFormats, rg: { r0: number; r1: number; c0: number; c1: number }): CellFormats {
  const out: CellFormats = { ...f };
  for (const [name, c] of Object.entries(f)) {
    const pos = parseA1(name);
    if (!pos) continue;
    const [i, j] = pos;
    if (i >= rg.r0 && i <= rg.r1 && j >= rg.c0 && j <= rg.c1) out[name] = { ...c, rowSpan: undefined, colSpan: undefined };
  }
  return tidyFormats(out) ?? {};
}

/** Formats that move with rows reordered (sorting): `order[k]` is the old row now at k. */
export function reorderFormats(f: CellFormats, order: number[]): CellFormats {
  const newRow = new Map(order.map((old, k) => [old, k]));
  const out: CellFormats = {};
  for (const [name, c] of Object.entries(f)) {
    const pos = parseA1(name);
    if (!pos) continue;
    // merged cells don't move: sorting them apart would break the merge
    const to = (c.rowSpan ?? 1) > 1 ? pos[0] : (newRow.get(pos[0]) ?? pos[0]);
    out[a1(to, pos[1])] = c;
  }
  return out;
}

/** Shading presets offered on the table toolbar, light enough for black text. */
export const SHADES: [string, string][] = [
  ["", "No shading"],
  ["#f2f2f2", "Light grey"],
  ["#d9d9d9", "Grey"],
  ["#deeaf6", "Light blue"],
  ["#e2efd9", "Light green"],
  ["#fff2cc", "Light yellow"],
  ["#fbe4d5", "Light orange"],
  ["#f4cccc", "Light red"],
];
