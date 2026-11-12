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

export type HfSlot = "left" | "center" | "right";

/** A picture in a header or footer slot (a company logo), from the bundle's `assets/`. */
export interface BandImage {
  src: string;
  /** Default "left". */
  slot?: HfSlot;
  /** Default: half the band's height. Never taller than the band. */
  height?: string | number;
}

/** What a band shows: three slots of text and an image. Even pages may have their own. */
export interface BandContent {
  left?: string;
  center?: string;
  right?: string;
  image?: BandImage;
}

export interface BandRule {
  /** Default 0.5pt. */
  width?: string | number;
  /** Default: the band's text colour. */
  color?: string;
}

export interface HeaderFooter extends BandContent {
  color?: string;
  /** Font size in points; default 8. */
  size?: number;
  bold?: boolean;
  /** A thin line under the header, or over the footer. */
  rule?: BandRule;
  /** From the paper's edge to the band's text; default: centred in the margin. */
  distance?: string | number;
  /** Different odd and even pages: what even pages show instead of the slots above. */
  even?: BandContent;
}

export const HF_DEFAULT_SIZE = 8;
/** Header and footer text when no colour is set: 4.5:1 on white paper, the WCAG AA minimum. */
export const HF_DEFAULT_COLOR = "#6e737c";
export const HF_DEFAULT_RULE = "0.5pt";
const PT = 96 / 72;
/** Between the text (or image) and the rule. */
export const HF_RULE_GAP = 3;

/** Whether page `k` (0-based) is an even page: by its printed number, as in a word processor. */
export const evenPage = (k: number, start = 1) => (start + k) % 2 === 0;

/**
 * What a band shows on page `k`: nothing on a first page set apart, the even-page content
 * on even pages when the band has its own, else the band's slots.
 */
export function contentOn(hf: HeaderFooter | undefined, k: number, start = 1, firstBlank = false) {
  if (!hf || (k === 0 && firstBlank)) return undefined;
  return hf.even && evenPage(k, start) ? hf.even : (hf as BandContent);
}

const MIRROR: Record<HfSlot, HfSlot> = { left: "right", center: "center", right: "left" };

/** Even pages start as the odd ones seen in a mirror: a page number stays on the outer edge. */
export function mirrored(c: BandContent): BandContent {
  const out: BandContent = {};
  for (const s of ["left", "center", "right"] as HfSlot[]) if (c[s]) out[MIRROR[s]] = c[s];
  if (c.image) out.image = { ...c.image, slot: MIRROR[c.image.slot ?? "left"] };
  return out;
}

export interface BandLayout {
  fontPx: number;
  /** Height of the line the slots sit on: the text, or the image when it is taller. */
  rowH: number;
  imageH: number;
  ruleW: number;
  /** From the paper's edge to the near side of the row. */
  offset: number;
}

/**
 * Where a band's row sits in its margin (`room` px high). With no distance it is centred, as
 * before these settings existed; an image is as tall as asked, but never taller than the band.
 */
export function bandLayout(hf: HeaderFooter | undefined, content: BandContent | undefined, room: number): BandLayout {
  const fontPx = (hf?.size && hf.size > 0 ? hf.size : HF_DEFAULT_SIZE) * PT;
  const lineH = Math.round(fontPx * 1.25);
  const ruleW = hf?.rule ? Math.max(0.5, toPx(hf.rule.width ?? HF_DEFAULT_RULE, PT / 2)) : 0;
  const ruleSpace = hf?.rule ? HF_RULE_GAP + ruleW : 0;
  const distance = hf?.distance === undefined ? undefined : Math.max(0, toPx(hf.distance, 0));
  const edge = 2;
  const maxImage = Math.max(lineH, room - (distance ?? edge) - ruleSpace - edge);
  const asked = content?.image
    ? content.image.height === undefined
      ? room / 2
      : toPx(content.image.height, room / 2)
    : 0;
  const imageH = content?.image ? Math.round(Math.min(Math.max(asked, 4), maxImage)) : 0;
  const rowH = Math.max(lineH, imageH);
  const offset = distance === undefined ? (room - rowH) / 2 : Math.max(0, Math.min(distance, room - rowH - ruleSpace));
  return { fontPx, rowH, imageH, ruleW, offset };
}

/** Which pages an edit on page `k` reaches, in words. */
export function scopeLabel(k: number, o: { firstBlank: boolean; oddEven: boolean; start?: number }): string {
  if (k === 0 && o.firstBlank) return "First page";
  const butFirst = (group: boolean) => (o.firstBlank && group ? " but the first" : "");
  if (!o.oddEven) return `All pages${butFirst(true)}`;
  const even = evenPage(k, o.start);
  const firstInGroup = evenPage(0, o.start) === even;
  return `${even ? "Even" : "Odd"} pages${butFirst(firstInGroup)}`;
}

/** The images the page decorations use: backgrounds, and pictures in headers and footers. */
export function pageAssets(doc: Doc): string[] {
  const page = doc.page ?? {};
  const out = ((page.backgrounds as Background[] | undefined) ?? []).map((b) => b.src);
  for (const band of ["header", "footer"]) {
    const hf = page[band] as HeaderFooter | undefined;
    for (const c of [hf, hf?.even]) if (c?.image?.src) out.push(c.image.src);
  }
  return out.filter(Boolean);
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
  /** The first-level heading the page is in. */
  section?: string;
  lang?: string;
  now: Date;
}

/** Replace {page} {pages} {date} {time} {file} {title} {author} {company} {section}. */
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
    section: c.section ?? "",
  };
  return text.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

/** Paper size in points for the print engine. */
export function paperPoints(g: PageGeom) {
  return { widthPt: (g.paperW * 72) / 96, heightPt: (g.paperH * 72) / 96 };
}
