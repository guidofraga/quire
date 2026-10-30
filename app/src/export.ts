// PDF export helpers: images are embedded at the resolution they are printed at, not
// at whatever resolution they were pasted in, and the PDF learns the document's details,
// headings and link targets from the page view.

import { isLinux, isMac, isTauri } from "./api";
import { layout, localized, type Placed, state } from "./store";
import type { Doc, Localized } from "./types";

/**
 * The desktop app writes the PDF itself on macOS and Linux. Windows (and the browser)
 * save it from the system print dialog ("Save as PDF").
 */
export const directPdf = isMac || (isTauri && isLinux);

async function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function opaque(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
  return true;
}

async function resample(img: HTMLImageElement, w: number, h: number): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const png = await encode(canvas, "image/png");
  // photos compress far better as JPEG; drawings and text stay lossless
  const jpeg = opaque(ctx, w, h) ? await encode(canvas, "image/jpeg", 0.9) : null;
  const best = jpeg && (!png || jpeg.size < png.size * 0.6) ? jpeg : png;
  if (!best) return null;
  // the app's content security policy allows data: images, not blob:
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(best);
  });
}

/**
 * Swap every printed image for a copy at `dpi` (0 keeps the originals).
 * Returns a function that puts the originals back.
 */
export async function shrinkImages(dpi: number): Promise<() => void> {
  const restore: [HTMLImageElement, string][] = [];
  if (dpi > 0) {
    for (const img of document.querySelectorAll<HTMLImageElement>(".sheet img")) {
      await img.decode().catch(() => {});
      // CSS pixels are 1/96 in
      const w = Math.ceil((img.clientWidth * dpi) / 96);
      const h = Math.ceil((img.clientHeight * dpi) / 96);
      if (!w || !h || img.naturalWidth <= w * 1.25) continue;
      const url = await resample(img, w, h);
      if (!url) continue;
      restore.push([img, img.src]);
      img.src = url;
      await img.decode().catch(() => {});
    }
  }
  return () => {
    for (const [img, src] of restore) img.src = src;
  };
}

// ---------------------------------------------------------------------------
// What the PDF gets besides the pages: details, bookmarks and where links lead.
// The print engine knows none of it; the page view knows all of it.
// ---------------------------------------------------------------------------

/** PDFs measure in points, the page view in CSS pixels. */
const PT = 72 / 96;
/** Bookmarks and links land this far (px) above what they point at, so it is not flush with the window's edge. */
const LEAD = 6;

/** A place on paper: page index from 0, points from the top of the sheet. */
export interface PdfSpot {
  page: number;
  top: number;
}

export interface PdfHeading extends PdfSpot {
  /** With its number when headings are numbered: "2.1 Bending". */
  title: string;
  level: number;
}

/** A box (points from the sheet's top-left corner) that jumps to the region `to`. */
export interface PdfLink extends PdfSpot {
  left: number;
  width: number;
  height: number;
  to: string;
}

export interface PdfInfo {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  company: string;
  lang: string;
  /** The number printed on the first page. */
  firstPage: number;
  outline: PdfHeading[];
  /** Region id → where it starts. */
  targets: Record<string, PdfSpot>;
  links: PdfLink[];
}

const joined = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" ? v : "");

/** The document's details, as the PDF's properties show them. */
export function pdfMeta(doc: Doc, fallbackTitle: string): Omit<PdfInfo, "outline" | "targets" | "links"> {
  const meta = doc.meta ?? {};
  const start = (doc.page?.pageNumber as { start?: number } | undefined)?.start;
  return {
    title: localized(meta.title, meta.lang).trim() || fallbackTitle,
    author: joined(meta.authors),
    subject: localized(meta.subject as Localized | undefined, meta.lang),
    keywords: joined(meta.keywords),
    company: String(meta.company ?? ""),
    lang: meta.lang ?? "",
    firstPage: typeof start === "number" ? start : 1,
  };
}

export const spotOf = (p: Placed): PdfSpot => ({ page: p.page, top: Math.max(0, p.top - LEAD) * PT });

/** The text of the first heading in rendered text, or the source's first line before it is rendered. */
function headingText(html: string | undefined, source: string): string {
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = (doc.querySelector("h1, h2, h3, h4, h5, h6") ?? doc.body).textContent;
    if (text?.trim()) return text.replace(/\s+/g, " ").trim();
  }
  return (source.replace(/^\{[^}\n]*\}\n/, "").split("\n")[0] ?? "").replace(/^#+\s+/, "").trim();
}

/** Bookmarks: the numbered headings in reading order, with their level and place. */
export function pdfOutline(
  list: Placed[],
  html: Record<string, string>,
  numbered: boolean,
  lang?: string,
): PdfHeading[] {
  const out: PdfHeading[] = [];
  for (const p of list) {
    if (p.hidden || !p.number || p.region.kind !== "text") continue;
    const text = headingText(html[p.region.id], localized(p.region.text, lang));
    if (!text) continue;
    out.push({ title: numbered ? `${p.number} ${text}` : text, level: p.number.split(".").length, ...spotOf(p) });
  }
  return out;
}

/**
 * Link boxes, measured on the sheets as printed: contents-list rows (`[data-ref]`), and on
 * Linux also the cross-references in text (`<a href="#ref:…">`), because WebKitGTK's PDF
 * print drops the links it makes on macOS. On macOS the print engine keeps those itself.
 */
export function pdfLinks(paperW: number, root: ParentNode = document): PdfLink[] {
  const out: PdfLink[] = [];
  const selector = isMac ? "[data-ref]:not(a)" : '[data-ref]:not(a), a[href^="#ref:"]';
  for (const sheet of root.querySelectorAll<HTMLElement>(".sheet[data-page]")) {
    const box = sheet.getBoundingClientRect();
    if (!box.width) continue;
    // screen pixels → points, whatever the zoom
    const s = (paperW / box.width) * PT;
    const page = Number(sheet.dataset.page) - 1;
    for (const el of sheet.querySelectorAll<HTMLElement>(selector)) {
      const to = el.dataset.ref ?? (el.getAttribute("href") ?? "").slice(5);
      // a cross-reference that wraps over lines gets one box per line
      for (const r of el.getClientRects()) {
        if (!r.width || !r.height) continue;
        out.push({
          page,
          left: (r.left - box.left) * s,
          top: (r.top - box.top) * s,
          width: r.width * s,
          height: r.height * s,
          to,
        });
      }
    }
  }
  return out;
}

/** Everything the PDF needs from the page view, collected while it is laid out for print. */
export function pdfInfo(fallbackTitle: string): PdfInfo {
  const l = layout();
  const links = pdfLinks(l.geom.paperW);
  const ids = new Set(links.map((k) => k.to));
  for (const a of document.querySelectorAll('.sheet a[href^="#ref:"]')) ids.add(a.getAttribute("href")!.slice(5));
  const targets: Record<string, PdfSpot> = {};
  for (const id of ids) {
    const p = l.byId.get(id);
    if (p && !p.hidden) targets[id] = spotOf(p);
  }
  const numbered = state.doc.styles?.numbering?.headings !== "";
  const outline = pdfOutline(l.list, state.report?.html ?? {}, numbered, state.doc.meta?.lang);
  return { ...pdfMeta(state.doc, fallbackTitle), outline, targets, links };
}
