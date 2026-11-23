// A document's first page in miniature, for the template previews on the Welcome screen:
// the regions drawn as the shapes they make on paper (lines of text, rows of math, tables,
// plots), from the document alone. No engine call and nothing to download, so it is cheap,
// works offline and in the web version, and a template of your own gets one too.
import { noteSide } from "./notePosition";
import { pageGeom } from "./pages";
import type { Doc, Localized, Region } from "./types";

/** One shape on the miniature page, in page pixels (the SVG scales them down). */
export interface Shape {
  kind: "line" | "heading" | "title" | "math" | "note" | "box" | "fill" | "rule" | "curve";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Thumbnail {
  width: number;
  height: number;
  shapes: Shape[];
}

const text = (t: Localized | undefined) => (typeof t === "string" ? t : t ? (Object.values(t)[0] ?? "") : "");

/** Djot without its marks, roughly as many characters as it shows. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`{}^~]/g, "")
    .trim();

/** Wrap `chars` characters of `charW` pixels into bars no wider than `room`. */
function bars(
  out: Shape[],
  kind: Shape["kind"],
  x: number,
  y: number,
  chars: number,
  charW: number,
  lineH: number,
  room: number,
) {
  let left = chars * charW;
  let at = y;
  while (left > 0) {
    const w = Math.min(left, room);
    out.push({ kind, x, y: at + lineH * 0.22, w, h: lineH * 0.56 });
    left -= room;
    at += lineH;
  }
  return at;
}

function textRegion(out: Shape[], r: Region, room: number) {
  const [x, y0] = r.at;
  let y = y0;
  let cls = "";
  for (const block of text(r.text).split(/\n\s*\n/)) {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const attr = /^\{\.([\w-]+)\}$/.exec(line);
      if (attr) {
        cls = attr[1];
        continue;
      }
      const heading = /^(#+)\s+(.*)$/.exec(line);
      if (heading) {
        const title = cls === "title";
        const level = heading[1].length;
        const [charW, lineH] = title ? [13, 34] : level === 1 ? [9.5, 26] : [8.5, 22];
        y = bars(out, title ? "title" : "heading", x, y, plain(heading[2]).length, charW, lineH, room);
      } else {
        const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        const indent = item ? 18 : 0;
        y = bars(out, "line", x + indent, y, plain(item ? item[2] : line).length, 6.6, 18, room - indent);
      }
      cls = "";
    }
    y += 6;
  }
}

function table(out: Shape[], r: Region) {
  const [x, y] = r.at;
  const cols = Array.isArray(r.columns) ? (r.columns as { width?: number }[]) : [];
  const rows = Array.isArray(r.rows) ? r.rows.length : 3;
  const w = cols.reduce((n, c) => n + (c.width ?? 80), 0) || 240;
  const rowH = 22;
  const top = y + (r.caption ? 20 : 0);
  if (r.caption) out.push({ kind: "line", x: x + w / 4, y: y + 5, w: w / 2, h: 10 });
  if (r.header?.row) out.push({ kind: "fill", x, y: top, w, h: rowH });
  if (r.header?.column && cols.length) out.push({ kind: "fill", x, y: top, w: cols[0].width ?? 80, h: rows * rowH });
  out.push({ kind: "box", x, y: top, w, h: rows * rowH });
  for (let i = 1; i < rows; i++) out.push({ kind: "rule", x, y: top + i * rowH, w, h: 0 });
}

function plot(out: Shape[], r: Region) {
  const [x, y] = r.at;
  const [w, h] = r.size ?? [300, 180];
  out.push({ kind: "box", x, y, w, h });
  out.push({ kind: "curve", x: x + 12, y: y + 12, w: w - 24, h: h - 24 });
}

function solveBlock(out: Shape[], r: Region, room: number) {
  const [x, y] = r.at;
  const guesses = Array.isArray(r.guesses) ? r.guesses : [];
  const given = Array.isArray(r.given) ? r.given : [];
  const find = typeof r.find === "string" ? r.find : "";
  const w = Math.min(room, 280);
  const pad = 10;
  let cy = y + 8;
  for (const g of guesses) {
    out.push({ kind: "math", x: x + pad, y: cy + 5, w: Math.min(w - 2 * pad, String(g).length * 8), h: 11 });
    cy += 24;
  }
  out.push({ kind: "heading", x: x + pad, y: cy + 4, w: 38, h: 11 });
  cy += 22;
  for (const c of given) {
    out.push({ kind: "math", x: x + pad + 8, y: cy + 5, w: Math.min(w - 2 * pad - 8, String(c).length * 8), h: 11 });
    cy += 24;
  }
  out.push({ kind: "rule", x: x + pad, y: cy + 2, w: w - 2 * pad, h: 0 });
  cy += 8;
  out.push({
    kind: "math",
    x: x + pad,
    y: cy + 5,
    w: Math.min(w - 2 * pad, find.length * 8 + (r.show ? 40 : 0)),
    h: 11,
  });
  cy += 28;
  out.push({ kind: "box", x, y, w, h: cy - y });
}

function drawRegion(content: Shape[], r: Region, contentW: number, end: number) {
  const [x, y] = r.at;
  if (y >= end) return;
  const room = Math.max(60, contentW - x);
  switch (r.kind) {
    case "text":
      textRegion(content, r, room);
      break;
    case "math": {
      const w = Math.min(room, (r.expr ?? "").length * 8.5 + (r.show ? 40 : 0));
      const side = noteSide(r.notePosition);
      const nw = r.note ? Math.min(side === "above" || side === "below" ? room : room - w, r.note.length * 5.5) : 0;
      // the formula moves right of a note on the left, and down below one above it
      const mx = side === "left" && r.note ? x + nw + 10 : x;
      const my = side === "above" && r.note ? y + 12 : y;
      content.push({ kind: "math", x: mx, y: my + 5, w, h: 11 });
      if (r.note) {
        const at: Record<typeof side, [number, number]> = {
          right: [x + w + 10, y + 7],
          left: [x, y + 7],
          above: [x, y + 2],
          below: [x, y + 20],
        };
        content.push({ kind: "note", x: at[side][0], y: at[side][1], w: nw, h: 7 });
      }
      break;
    }
    case "table":
      table(content, r);
      break;
    case "toc": {
      content.push({ kind: "heading", x, y: y + 4, w: text(r.title).length * 8.5, h: 12 });
      for (let i = 0; i < 6; i++)
        content.push({ kind: "line", x: x + 14, y: y + 32 + i * 26, w: contentW - x - 14, h: 8 });
      break;
    }
    case "plot2d":
    case "plot3d":
      plot(content, r);
      break;
    case "solve":
      solveBlock(content, r, room);
      break;
    case "image": {
      const [w, h] = r.size ?? [r.width ?? 200, r.height ?? 140];
      content.push({ kind: "fill", x, y, w, h });
      break;
    }
    case "area": {
      const title = text(r.title);
      if (title)
        content.push({ kind: "heading", x: x + 18, y: y + 4, w: Math.min(room - 18, title.length * 8.5), h: 10 });
      if (!r.collapsed && Array.isArray(r.regions)) {
        for (const child of r.regions) {
          drawRegion(content, { ...child, at: [x + child.at[0], y + child.at[1]] }, contentW, end);
        }
      }
      break;
    }
  }
}

/** The first page of `doc` as shapes on a sheet of its paper size. */
export function thumbnail(doc: Doc): Thumbnail {
  const g = pageGeom(doc);
  const shapes: Shape[] = [];
  const page = doc.page ?? {};
  const band = (y: number) => {
    shapes.push({ kind: "line", x: g.margins.left, y, w: 90, h: 7 });
    shapes.push({ kind: "line", x: g.paperW - g.margins.right - 120, y, w: 120, h: 7 });
  };
  if (page.header) {
    band(g.margins.top - 34);
    shapes.push({ kind: "rule", x: g.margins.left, y: g.margins.top - 20, w: g.contentW, h: 0 });
  }
  if (page.footer) {
    shapes.push({ kind: "rule", x: g.margins.left, y: g.paperH - g.margins.bottom + 16, w: g.contentW, h: 0 });
    band(g.paperH - g.margins.bottom + 26);
  }
  // what is above the first page break, or the first page's height
  const breakAt = doc.regions.filter((r) => r.kind === "pagebreak").map((r) => r.at[1]);
  const end = Math.min(g.contentH, ...breakAt);
  const content: Shape[] = [];
  for (const r of doc.regions) {
    drawRegion(content, r, g.contentW, end);
  }
  // inside the printable column, and cut at the foot of the page
  for (const s of content) {
    if (s.y >= end) continue;
    shapes.push({
      ...s,
      x: s.x + g.margins.left,
      y: s.y + g.margins.top,
      w: Math.max(0, Math.min(s.w, g.contentW - s.x)),
      h: Math.min(s.h, end - s.y),
    });
  }
  return { width: g.paperW, height: g.paperH, shapes };
}
