// Export as Word: the engine writes the .docx (crates/quire-service/src/docx), from the document
// and its report. It can't draw plots, which this page draws (SVG, and a canvas for 3D), so each
// plot goes along drawn to PNG at print resolution, as do images Word can't show as they are
// (SVG, WebP). The page also knows where things landed: heights for the reading order, and pages
// for the contents list.
import { localized, pagedLayout, state, heights, widths } from "./store";
import { prefs } from "./settings";

/** What `DocxOptions::from_json` reads. */
export interface DocxOptions {
  /** Region id → PNG as a data URL. */
  pictures: Record<string, string>;
  heights: Record<string, number>;
  widths: Record<string, number>;
  /** Region id → page (from 0). */
  pages: Record<string, number>;
  pageCount: number;
  file: string;
  date: string;
  time: string;
  flatUnits: boolean;
}

/** Print resolution: 300 dpi, against CSS's 96. */
const SCALE = 300 / 96;

/** Properties that give a plot its look; they come from the stylesheet, which a lone SVG lacks. */
const SVG_STYLE = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  // labels have a white halo drawn under their letters
  "paint-order",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "font-variant-numeric",
];

function inlineStyles(from: Element, to: Element) {
  const cs = getComputedStyle(from);
  to.setAttribute("style", SVG_STYLE.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  for (let i = 0; i < from.children.length && i < to.children.length; i++)
    inlineStyles(from.children[i], to.children[i]);
}

async function rasterize(src: string, w: number, h: number): Promise<string | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * SCALE));
  canvas.height = Math.max(1, Math.round(h * SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // the paper is white: transparent parts print on it
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** A plot's SVG as a PNG, with the stylesheet's look written into it. */
export async function svgPng(svg: SVGSVGElement): Promise<string | null> {
  const w = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const h = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  if (!w || !h) return null;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, copy);
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(w));
  copy.setAttribute("height", String(h));
  const xml = new XMLSerializer().serializeToString(copy);
  return rasterize(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, w, h);
}

/** A 3D plot's canvas as a PNG (it is drawn at twice its resolution while printing). */
function canvasPng(canvas: HTMLCanvasElement): string | null {
  try {
    return canvas.width ? canvas.toDataURL("image/png") : null;
  } catch {
    return null;
  }
}

const rasterOk = (src: string) => /\.(png|jpe?g|gif)$/i.test(src);

/** The pictures the engine can't make: plots, and images in a format Word doesn't show. */
async function pictures(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of pagedLayout().list) {
    if (p.hidden) continue;
    const r = p.region;
    const el = document.querySelector<HTMLElement>(`[data-region="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    let png: string | null = null;
    if (r.kind === "plot2d") {
      const svg = el.querySelector<SVGSVGElement>(".plot svg");
      if (svg) png = await svgPng(svg);
    } else if (r.kind === "plot3d") {
      const canvas = el.querySelector<HTMLCanvasElement>(".plot3d canvas");
      if (canvas) png = canvasPng(canvas);
    } else if (r.kind === "image" && typeof r.src === "string" && !rasterOk(r.src)) {
      const img = el.querySelector<HTMLImageElement>("img");
      const size = (r.size as number[] | undefined) ?? [img?.width ?? 0, img?.height ?? 0];
      if (img?.src) png = await rasterize(img.src, size[0], size[1]);
    }
    if (png) out[r.id] = png;
  }
  return out;
}

/** Everything the page adds to the export. `file` is the document's name, for `{file}`. */
export async function docxOptions(file: string): Promise<DocxOptions> {
  const l = pagedLayout();
  const pages: Record<string, number> = {};
  for (const p of l.list) if (!p.hidden) pages[p.region.id] = p.page;
  const lang = state.doc.meta?.lang;
  const now = new Date();
  return {
    pictures: await pictures(),
    heights: { ...heights },
    widths: { ...widths },
    pages,
    pageCount: l.contentPages,
    file: file || localized(state.doc.meta?.title, lang) || "Untitled",
    date: now.toLocaleDateString(lang),
    time: now.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }),
    flatUnits: prefs.flatUnits,
  };
}

/** A Word file's bytes (base64) as a download, in a browser. */
export function downloadDocx(base64: string, name: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
