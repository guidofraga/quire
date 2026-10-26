// Page geometry and page decorations (docs/02-file-format.md §3 "page").
// Document coordinates are content coordinates: page k shows the content band
// [k·H, (k+1)·H) inside the margins, where H is the content height.
import type { Doc } from "./types";

export const PX_PER_MM = 96 / 25.4;
/** Gap between sheets in page view (scene px). */
export const SHEET_GAP = 28;

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageGeom {
  paperW: number;
  paperH: number;
  margins: Margins;
  contentW: number;
  contentH: number;
}

const PAPER_MM: Record<string, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
};

export function toPx(v: string | number | undefined, fallback: number): number {
  if (typeof v === "number") return v;
  const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(v ?? "");
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const scale = { mm: PX_PER_MM, cm: PX_PER_MM * 10, in: 96, pt: 96 / 72, px: 1 }[m[2] ?? "px"] ?? 1;
  return n * scale;
}

export function pageGeom(doc: Doc): PageGeom {
  const page = doc.page ?? {};
  let [w, h] = [210 * PX_PER_MM, 297 * PX_PER_MM];
  if (typeof page.paper === "string" && PAPER_MM[page.paper]) {
    [w, h] = PAPER_MM[page.paper].map((mm) => mm * PX_PER_MM) as [number, number];
  } else if (Array.isArray(page.paper)) {
    [w, h] = [toPx(page.paper[0], w), toPx(page.paper[1], h)];
  }
  if (page.orientation === "landscape") [w, h] = [h, w];
  const m = page.margins ?? {};
  const d = 20 * PX_PER_MM;
  const margins = { top: toPx(m.top, d), right: toPx(m.right, d), bottom: toPx(m.bottom, d), left: toPx(m.left, d) };
  return {
    paperW: w,
    paperH: h,
    margins,
    contentW: Math.max(100, w - margins.left - margins.right),
    contentH: Math.max(100, h - margins.top - margins.bottom),
  };
}

export interface HeaderFooter {
  left?: string;
  center?: string;
  right?: string;
  color?: string;
}

export interface Background {
  pages?: string;
  src: string;
  fit?: "page" | "margins";
}

/** "all" | "1" | "2-4" | "1,3" | "odd" | "even" — `n` is 1-based. */
export function pageMatches(spec: string | undefined, n: number): boolean {
  const s = (spec ?? "all").trim().toLowerCase();
  if (s === "all") return true;
  if (s === "odd") return n % 2 === 1;
  if (s === "even") return n % 2 === 0;
  return s.split(",").some((part) => {
    const [a, b] = part.split("-").map((x) => parseInt(x, 10));
    return Number.isFinite(b) ? n >= a && n <= b : n === a;
  });
}

export interface FieldContext {
  page: number;
  pages: number;
  file: string;
  title: string;
  author: string;
  company: string;
  lang?: string;
  now: Date;
}

/** Replace {page} {pages} {date} {time} {file} {title} {author} {company}. */
export function fillFields(text: string, c: FieldContext): string {
  const values: Record<string, string> = {
    page: String(c.page),
    pages: String(c.pages),
    date: c.now.toLocaleDateString(c.lang),
    time: c.now.toLocaleTimeString(c.lang, { hour: "2-digit", minute: "2-digit" }),
    file: c.file,
    title: c.title,
    author: c.author,
    company: c.company,
  };
  return text.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

/** Paper size in points for the print engine. */
export function paperPoints(g: PageGeom) {
  return { widthPt: (g.paperW * 72) / 96, heightPt: (g.paperH * 72) / 96 };
}
