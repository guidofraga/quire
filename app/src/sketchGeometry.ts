// Pure geometry and accessible description for parametric engineering sketches (docs/02-file-format.md §4.11).
// Coordinates arrive evaluated in SI metres in model space (x right, y up); this file maps them
// onto the paper SVG box with isotropic scaling, reserves margins for supports, loads and
// dimension lines, and builds textbook structural symbols (ISO 128 three-weight hierarchy).
import type { SketchElement, SketchView } from "./types";

export const DEFAULT_SKETCH_SIZE: [number, number] = [480, 220];

export type StrokeWeight = "heavy" | "medium" | "thin";

export interface SketchStroke {
  d: string;
  weight: StrokeWeight;
  fill?: "paper" | "ink" | "none";
}

export interface SketchCircle {
  cx: number;
  cy: number;
  r: number;
  weight: StrokeWeight;
  fill: "paper" | "ink" | "none";
}

export interface SketchText {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  rotate?: number;
  /** White backing box behind a dimension label so the dimension line breaks cleanly across spaces. */
  backdrop?: { w: number; h: number };
}

export interface SketchItem {
  index: number;
  type: SketchElement["type"];
  strokes: SketchStroke[];
  circles: SketchCircle[];
  texts: SketchText[];
}

export interface SketchFit {
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  scale: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
}

export interface SketchScene {
  fit: SketchFit;
  items: SketchItem[];
  errors: { index: number; message: string }[];
}

const f2 = (n: number) => Number(n.toFixed(2));

function pt(view: SketchView | undefined, key0: string, key1: string): [number, number] | null {
  const a = view?.values[key0]?.si;
  const b = view?.values[key1]?.si;
  return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) ? [a, b] : null;
}

function spanPts(view: SketchView | undefined, i: number): [[number, number], [number, number]] | null {
  const p0 = pt(view, `${i}.from.0`, `${i}.from.1`);
  const p1 = pt(view, `${i}.to.0`, `${i}.to.1`);
  return p0 && p1 ? [p0, p1] : null;
}

function atPt(view: SketchView | undefined, i: number): [number, number] | null {
  return pt(view, `${i}.at.0`, `${i}.at.1`);
}

function arrowHead(tipX: number, tipY: number, ux: number, uy: number, len = 7.5, halfW = 2.8): string {
  const bx = tipX - ux * len;
  const by = tipY - uy * len;
  const nx = -uy;
  const ny = ux;
  return `M${f2(tipX)} ${f2(tipY)}L${f2(bx + nx * halfW)} ${f2(by + ny * halfW)}L${f2(bx - nx * halfW)} ${f2(by - ny * halfW)}Z`;
}

function rotatePt(x: number, y: number, cx: number, cy: number, degScreen: number): [number, number] {
  if (!degScreen) return [x, y];
  const r = (degScreen * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Auto-detect fixed support wall angle (model degrees CCW; 0 = wall on left, 180 = wall on right, -90 = floor). */
function inferFixedAngle(at: [number, number], members: [[number, number], [number, number]][]): number {
  for (const [a, b] of members) {
    const d0 = Math.hypot(a[0] - at[0], a[1] - at[1]);
    const d1 = Math.hypot(b[0] - at[0], b[1] - at[1]);
    const eps = 1e-6;
    if (d0 <= eps || d1 <= eps) {
      const other = d0 <= eps ? b : a;
      const dx = other[0] - at[0];
      const dy = other[1] - at[1];
      if (Math.hypot(dx, dy) > eps) {
        return (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }
  }
  return 0;
}

/** Fit model coordinates into `[width, height]` with isotropic scale and room for symbols/annotations. */
export function fitSketch(
  elements: SketchElement[],
  view: SketchView | undefined,
  width: number,
  height: number,
): SketchFit {
  let left = 34;
  let right = 34;
  let top = 26;
  let bottom = 26;

  const points: [number, number][] = [];
  const members: [[number, number], [number, number]][] = [];

  elements.forEach((el, i) => {
    if (view?.errors[String(i)]) return;
    if (el.type === "member" || el.type === "udl" || el.type === "dimension") {
      const sp = spanPts(view, i);
      if (sp) {
        points.push(sp[0], sp[1]);
        if (el.type === "member") members.push(sp);
      }
    } else {
      const p = atPt(view, i);
      if (p) points.push(p);
    }
  });

  elements.forEach((el, i) => {
    if (view?.errors[String(i)]) return;
    const hasLabel = Boolean(view?.labels[String(i)]);
    switch (el.type) {
      case "support": {
        const p = atPt(view, i);
        if (!p) break;
        if (el.kind === "fixed") {
          const ang = el.angle ?? inferFixedAngle(p, members);
          const rad = (ang * Math.PI) / 180;
          const wx = -Math.cos(rad);
          const wy = Math.sin(rad);
          if (wx < -0.3) left = Math.max(left, 38);
          if (wx > 0.3) right = Math.max(right, 38);
          if (wy < -0.3) top = Math.max(top, 34);
          if (wy > 0.3) bottom = Math.max(bottom, 34);
        } else {
          const deg = -(el.angle ?? 0);
          const [, dy] = rotatePt(0, 26 + (hasLabel ? 16 : 0), 0, 0, deg);
          if (dy > 0) bottom = Math.max(bottom, dy + 12);
          if (dy < 0) top = Math.max(top, -dy + 12);
        }
        break;
      }
      case "udl": {
        const sp = spanPts(view, i);
        if (!sp) break;
        const dx = sp[1][0] - sp[0][0];
        const dy = -(sp[1][1] - sp[0][1]);
        const len = Math.hypot(dx, dy) || 1;
        const nx = dy / len;
        const ny = -dx / len;
        const reach = hasLabel ? 50 : 34;
        if (ny < 0) top = Math.max(top, Math.ceil(-ny * reach) + 8);
        if (ny > 0) bottom = Math.max(bottom, Math.ceil(ny * reach) + 8);
        if (nx < 0) left = Math.max(left, Math.ceil(-nx * reach) + 16);
        if (nx > 0) right = Math.max(right, Math.ceil(nx * reach) + 16);
        break;
      }
      case "point": {
        const ang = el.angle ?? -90;
        const rad = (ang * Math.PI) / 180;
        const tx = -Math.cos(rad);
        const ty = Math.sin(rad);
        const reach = hasLabel ? 68 : 52;
        if (ty < 0) top = Math.max(top, Math.ceil(-ty * reach) + 8);
        if (ty > 0) bottom = Math.max(bottom, Math.ceil(ty * reach) + 8);
        if (tx < 0) left = Math.max(left, Math.ceil(-tx * reach) + 18);
        if (tx > 0) right = Math.max(right, Math.ceil(tx * reach) + 18);
        break;
      }
      case "moment": {
        top = Math.max(top, hasLabel ? 42 : 28);
        bottom = Math.max(bottom, 28);
        left = Math.max(left, 34);
        right = Math.max(right, 34);
        break;
      }
      case "dimension": {
        const sp = spanPts(view, i);
        if (!sp) break;
        const off = el.offset ?? -40;
        const dx = sp[1][0] - sp[0][0];
        const dy = -(sp[1][1] - sp[0][1]);
        const len = Math.hypot(dx, dy) || 1;
        const nx = (dy / len) * off;
        const ny = (-dx / len) * off;
        const extra = 22;
        if (ny > 0) bottom = Math.max(bottom, Math.ceil(ny + extra));
        if (ny < 0) top = Math.max(top, Math.ceil(-ny + extra));
        if (nx > 0) right = Math.max(right, Math.ceil(nx + extra + 12));
        if (nx < 0) left = Math.max(left, Math.ceil(-nx + extra + 12));
        break;
      }
      case "label": {
        const anchor = el.anchor ?? "above";
        if (anchor === "left") left = Math.max(left, 56);
        if (anchor === "right") right = Math.max(right, 56);
        if (anchor === "above") top = Math.max(top, 30);
        if (anchor === "below") bottom = Math.max(bottom, 30);
        break;
      }
    }
  });

  // Clamp margins so small sketch boxes still keep a positive drawing area
  const maxHPad = Math.max(16, (width - 48) / 2);
  const maxVPad = Math.max(14, (height - 36) / 2);
  left = Math.min(left, maxHPad);
  right = Math.min(right, maxHPad);
  top = Math.min(top, maxVPad);
  bottom = Math.min(bottom, maxVPad);

  const availW = Math.max(32, width - left - right);
  const availH = Math.max(24, height - top - bottom);

  let xMin = 0;
  let xMax = 1;
  let yMin = 0;
  let yMax = 0;
  if (points.length > 0) {
    xMin = Math.min(...points.map((p) => p[0]));
    xMax = Math.max(...points.map((p) => p[0]));
    yMin = Math.min(...points.map((p) => p[1]));
    yMax = Math.max(...points.map((p) => p[1]));
  }
  const spanX = xMax - xMin;
  const spanY = yMax - yMin;
  const scale =
    spanX > 1e-12 && spanY > 1e-12
      ? Math.min(availW / spanX, availH / spanY)
      : spanX > 1e-12
        ? availW / spanX
        : spanY > 1e-12
          ? availH / spanY
          : 60;

  const cx = left + availW / 2;
  const cy = top + availH / 2;
  const mx = (xMin + xMax) / 2;
  const my = (yMin + yMax) / 2;

  return {
    width,
    height,
    left,
    top,
    right,
    bottom,
    scale,
    sx: (x: number) => cx + (x - mx) * scale,
    sy: (y: number) => cy - (y - my) * scale,
  };
}

/** Build every vector path, circle and label in screen coordinates for `Sketch.tsx`. */
export function buildSketchScene(
  elements: SketchElement[],
  view: SketchView | undefined,
  width: number,
  height: number,
): SketchScene {
  const fit = fitSketch(elements, view, width, height);
  const items: SketchItem[] = [];
  const errors: { index: number; message: string }[] = [];

  const members: [[number, number], [number, number]][] = [];
  elements.forEach((el, i) => {
    if (el.type === "member" && !view?.errors[String(i)]) {
      const sp = spanPts(view, i);
      if (sp) members.push(sp);
    }
  });

  elements.forEach((el, i) => {
    const err = view?.errors[String(i)];
    if (err) {
      errors.push({ index: i, message: err });
      return;
    }
    const label = view?.labels[String(i)] ?? "";
    const strokes: SketchStroke[] = [];
    const circles: SketchCircle[] = [];
    const texts: SketchText[] = [];

    switch (el.type) {
      case "member": {
        const sp = spanPts(view, i);
        if (!sp) return;
        const [x0, y0] = [fit.sx(sp[0][0]), fit.sy(sp[0][1])];
        const [x1, y1] = [fit.sx(sp[1][0]), fit.sy(sp[1][1])];
        strokes.push({ d: `M${f2(x0)} ${f2(y0)}L${f2(x1)} ${f2(y1)}`, weight: "heavy", fill: "none" });
        if (label) {
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len = Math.hypot(dx, dy) || 1;
          const nx = dy / len;
          const ny = -dx / len;
          texts.push({
            x: f2((x0 + x1) / 2 + nx * 11),
            y: f2((y0 + y1) / 2 + ny * 11 + 4),
            text: label,
            anchor: "middle",
          });
        }
        break;
      }

      case "support": {
        const p = atPt(view, i);
        if (!p) return;
        const [px, py] = [fit.sx(p[0]), fit.sy(p[1])];
        if (el.kind === "pin" || el.kind === "roller") {
          const deg = -(el.angle ?? 0);
          const R = (x: number, y: number) => rotatePt(x, y, px, py, deg);
          const triH = el.kind === "pin" ? 14 : 11;
          const halfW = el.kind === "pin" ? 8 : 7;
          const [a0, a1] = R(px, py);
          const [b0, b1] = R(px - halfW, py + triH);
          const [c0, c1] = R(px + halfW, py + triH);
          strokes.push({
            d: `M${f2(a0)} ${f2(a1)}L${f2(b0)} ${f2(b1)}L${f2(c0)} ${f2(c1)}Z`,
            weight: "medium",
            fill: "paper",
          });
          let groundY = py + triH;
          if (el.kind === "roller") {
            for (const dx of [-4, 4]) {
              const [rcx, rcy] = R(px + dx, py + triH + 2.7);
              circles.push({ cx: f2(rcx), cy: f2(rcy), r: 2.3, weight: "medium", fill: "paper" });
            }
            groundY = py + triH + 5.3;
          }
          const [g0x, g0y] = R(px - 12, groundY);
          const [g1x, g1y] = R(px + 12, groundY);
          strokes.push({ d: `M${f2(g0x)} ${f2(g0y)}L${f2(g1x)} ${f2(g1y)}`, weight: "medium", fill: "none" });
          let hatch = "";
          for (let hx = -8; hx <= 10; hx += 4.5) {
            const [s0x, s0y] = R(px + hx, groundY);
            const [s1x, s1y] = R(px + hx - 3.5, groundY + 5);
            hatch += `M${f2(s0x)} ${f2(s0y)}L${f2(s1x)} ${f2(s1y)}`;
          }
          strokes.push({ d: hatch, weight: "thin", fill: "none" });
          if (label) {
            const [lx, ly] = R(px, groundY + 15);
            texts.push({ x: f2(lx), y: f2(ly), text: label, anchor: "middle" });
          }
        } else {
          // Fixed wall: perpendicular to the connected member direction (default: wall on left, member going right)
          const modelAng = el.angle ?? inferFixedAngle(p, members);
          const deg = -modelAng;
          const R = (x: number, y: number) => rotatePt(x, y, px, py, deg);
          const [w0x, w0y] = R(px, py - 15);
          const [w1x, w1y] = R(px, py + 15);
          strokes.push({ d: `M${f2(w0x)} ${f2(w0y)}L${f2(w1x)} ${f2(w1y)}`, weight: "heavy", fill: "none" });
          let hatch = "";
          for (let hy = -12; hy <= 14; hy += 5) {
            const [s0x, s0y] = R(px, py + hy);
            const [s1x, s1y] = R(px - 6, py + hy + 4);
            hatch += `M${f2(s0x)} ${f2(s0y)}L${f2(s1x)} ${f2(s1y)}`;
          }
          strokes.push({ d: hatch, weight: "thin", fill: "none" });
          if (label) {
            const [lx, ly] = R(px - 14, py + 4);
            texts.push({ x: f2(lx), y: f2(ly), text: label, anchor: "end" });
          }
        }
        break;
      }

      case "udl": {
        const sp = spanPts(view, i);
        if (!sp) return;
        const [x0, y0] = [fit.sx(sp[0][0]), fit.sy(sp[0][1])];
        const [x1, y1] = [fit.sx(sp[1][0]), fit.sy(sp[1][1])];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return;
        const ux = dx / len;
        const uy = dy / len;
        // Screen-up normal for left-to-right spans; arrows point -n onto the member
        const nx = uy;
        const ny = -ux;
        const gap = 2.5;
        const barH = 24;
        const bx0 = x0 + nx * (barH + gap);
        const by0 = y0 + ny * (barH + gap);
        const bx1 = x1 + nx * (barH + gap);
        const by1 = y1 + ny * (barH + gap);
        let shafts = `M${f2(bx0)} ${f2(by0)}L${f2(bx1)} ${f2(by1)}`;
        let heads = "";
        const count = Math.max(3, Math.round(len / 38) + 1);
        for (let k = 0; k < count; k++) {
          const t = count === 1 ? 0.5 : k / (count - 1);
          const sx = x0 + dx * t + nx * (barH + gap);
          const sy = y0 + dy * t + ny * (barH + gap);
          const tx = x0 + dx * t + nx * gap;
          const ty = y0 + dy * t + ny * gap;
          shafts += `M${f2(sx)} ${f2(sy)}L${f2(tx - -nx * 5)} ${f2(ty - -ny * 5)}`;
          heads += arrowHead(tx, ty, -nx, -ny, 6.5, 2.5);
        }
        strokes.push({ d: shafts, weight: "medium", fill: "none" });
        strokes.push({ d: heads, weight: "thin", fill: "ink" });
        if (label) {
          texts.push({
            x: f2((bx0 + bx1) / 2 + nx * 9),
            y: f2((by0 + by1) / 2 + ny * 9 + (ny < 0 ? 0 : 8)),
            text: label,
            anchor: "middle",
          });
        }
        break;
      }

      case "point": {
        const p = atPt(view, i);
        if (!p) return;
        const [px, py] = [fit.sx(p[0]), fit.sy(p[1])];
        const ang = el.angle ?? -90;
        const rad = (ang * Math.PI) / 180;
        const ux = Math.cos(rad);
        const uy = -Math.sin(rad);
        const gap = 2;
        const shaftLen = 46;
        const tipX = px - ux * gap;
        const tipY = py - uy * gap;
        const tailX = px - ux * (shaftLen + gap);
        const tailY = py - uy * (shaftLen + gap);
        strokes.push({
          d: `M${f2(tailX)} ${f2(tailY)}L${f2(tipX - ux * 6)} ${f2(tipY - uy * 6)}`,
          weight: "medium",
          fill: "none",
        });
        strokes.push({ d: arrowHead(tipX, tipY, ux, uy, 8, 3.1), weight: "thin", fill: "ink" });
        if (label) {
          const lx = tailX - ux * 8;
          const ly = tailY - uy * 8 + (Math.abs(ux) > 0.6 ? 4 : uy > 0 ? -1 : 10);
          const anchor = Math.abs(ux) > 0.5 ? (ux > 0 ? "end" : "start") : "middle";
          texts.push({ x: f2(lx), y: f2(ly), text: label, anchor });
        }
        break;
      }

      case "moment": {
        const p = atPt(view, i);
        if (!p) return;
        const [px, py] = [fit.sx(p[0]), fit.sy(p[1])];
        circles.push({ cx: f2(px), cy: f2(py), r: 2.2, weight: "thin", fill: "ink" });
        const r = 15;
        const ccw = (el.sense ?? "ccw") === "ccw";
        // Screen angles (y down): CCW in model space is sweep-flag 0 in SVG screen coordinates
        const a0 = ccw ? (50 * Math.PI) / 180 : (130 * Math.PI) / 180;
        const a1 = ccw ? (-190 * Math.PI) / 180 : (370 * Math.PI) / 180;
        const x0 = px + r * Math.cos(a0);
        const y0 = py + r * Math.sin(a0);
        const x1 = px + r * Math.cos(a1);
        const y1 = py + r * Math.sin(a1);
        const sweep = ccw ? 0 : 1;
        strokes.push({
          d: `M${f2(x0)} ${f2(y0)}A${r} ${r} 0 1 ${sweep} ${f2(x1)} ${f2(y1)}`,
          weight: "medium",
          fill: "none",
        });
        const tx = ccw ? Math.sin(a1) : -Math.sin(a1);
        const ty = ccw ? -Math.cos(a1) : Math.cos(a1);
        strokes.push({ d: arrowHead(x1, y1, tx, ty, 7, 2.7), weight: "thin", fill: "ink" });
        if (label) {
          texts.push({ x: f2(px), y: f2(py - r - 7), text: label, anchor: "middle" });
        }
        break;
      }

      case "dimension": {
        const sp = spanPts(view, i);
        if (!sp) return;
        const [x0, y0] = [fit.sx(sp[0][0]), fit.sy(sp[0][1])];
        const [x1, y1] = [fit.sx(sp[1][0]), fit.sy(sp[1][1])];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return;
        const ux = dx / len;
        const uy = dy / len;
        const nx = uy;
        const ny = -ux;
        const off = el.offset ?? -40;
        const sgn = off >= 0 ? 1 : -1;
        const d0x = x0 + nx * off;
        const d0y = y0 + ny * off;
        const d1x = x1 + nx * off;
        const d1y = y1 + ny * off;
        const eGap = 5 * sgn;
        const eOver = 5 * sgn;
        const ext =
          `M${f2(x0 + nx * eGap)} ${f2(y0 + ny * eGap)}L${f2(d0x + nx * eOver)} ${f2(d0y + ny * eOver)}` +
          `M${f2(x1 + nx * eGap)} ${f2(y1 + ny * eGap)}L${f2(d1x + nx * eOver)} ${f2(d1y + ny * eOver)}`;
        if (len >= 36) {
          strokes.push({
            d: `${ext}M${f2(d0x + ux * 5)} ${f2(d0y + uy * 5)}L${f2(d1x - ux * 5)} ${f2(d1y - uy * 5)}`,
            weight: "thin",
            fill: "none",
          });
          strokes.push({
            d: arrowHead(d0x, d0y, -ux, -uy, 6.5, 2.2) + arrowHead(d1x, d1y, ux, uy, 6.5, 2.2),
            weight: "thin",
            fill: "ink",
          });
        } else {
          // Tight dimension span: 45° architectural tick marks
          const tx = (ux + nx) * 3.5;
          const ty = (uy + ny) * 3.5;
          strokes.push({
            d:
              `${ext}M${f2(d0x)} ${f2(d0y)}L${f2(d1x)} ${f2(d1y)}` +
              `M${f2(d0x - tx)} ${f2(d0y - ty)}L${f2(d0x + tx)} ${f2(d0y + ty)}` +
              `M${f2(d1x - tx)} ${f2(d1y - ty)}L${f2(d1x + tx)} ${f2(d1y + ty)}`,
            weight: "thin",
            fill: "none",
          });
        }
        if (label) {
          let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (deg > 90) deg -= 180;
          if (deg < -90) deg += 180;
          texts.push({
            x: f2((d0x + d1x) / 2),
            y: f2((d0y + d1y) / 2 + 4),
            text: label,
            anchor: "middle",
            rotate: Math.abs(deg) < 0.5 ? undefined : f2(deg),
            backdrop: { w: f2(label.length * 6.5 + 8), h: 14 },
          });
        }
        break;
      }

      case "label": {
        const p = atPt(view, i);
        if (!p || !label) return;
        const [px, py] = [fit.sx(p[0]), fit.sy(p[1])];
        const anchor = el.anchor ?? "above";
        const spec: Record<NonNullable<typeof el.anchor>, { dx: number; dy: number; a: SketchText["anchor"] }> = {
          above: { dx: 0, dy: -8, a: "middle" },
          below: { dx: 0, dy: 15, a: "middle" },
          left: { dx: -8, dy: 4, a: "end" },
          right: { dx: 8, dy: 4, a: "start" },
          center: { dx: 0, dy: 4, a: "middle" },
        };
        const s = spec[anchor];
        texts.push({ x: f2(px + s.dx), y: f2(py + s.dy), text: label, anchor: s.a });
        break;
      }
    }

    items.push({ index: i, type: el.type, strokes, circles, texts });
  });

  return { fit, items, errors };
}

/** Short spoken summary for `aria-label` and `describeRegion`. */
export function describeSketch(elements: SketchElement[], view: SketchView | undefined): string {
  if (!elements.length) return "Empty engineering sketch";
  const parts: string[] = [];

  let xMin = Infinity;
  let xMax = -Infinity;
  elements.forEach((_, i) => {
    if (view?.errors[String(i)]) return;
    const sp = spanPts(view, i);
    if (sp) {
      xMin = Math.min(xMin, sp[0][0], sp[1][0]);
      xMax = Math.max(xMax, sp[0][0], sp[1][0]);
    }
    const p = atPt(view, i);
    if (p) {
      xMin = Math.min(xMin, p[0]);
      xMax = Math.max(xMax, p[0]);
    }
  });

  const memberIndices = elements.map((e, i) => (e.type === "member" ? i : -1)).filter((i) => i >= 0);
  const dimLabel = elements.map((e, i) => (e.type === "dimension" ? view?.labels[String(i)] : undefined)).find(Boolean);

  if (memberIndices.length === 1) {
    parts.push(dimLabel ? `Beam ${dimLabel} long` : "Beam");
  } else if (memberIndices.length > 1) {
    parts.push(`${memberIndices.length} members${dimLabel ? ` (${dimLabel})` : ""}`);
  }

  elements.forEach((el, i) => {
    if (view?.errors[String(i)]) return;
    const lbl = view?.labels[String(i)];
    if (el.type === "support") {
      const p = atPt(view, i);
      let where = "";
      if (p && Number.isFinite(xMin) && xMax > xMin + 1e-9) {
        if (Math.abs(p[0] - xMin) < 1e-6) where = " at left";
        else if (Math.abs(p[0] - xMax) < 1e-6) where = " at right";
      }
      parts.push(`${el.kind}${where}${lbl ? ` (${lbl})` : ""}`);
    } else if (el.type === "udl") {
      parts.push(lbl ? `uniform load ${lbl}` : "uniform load");
    } else if (el.type === "point") {
      parts.push(lbl ? `point load ${lbl}` : "point load");
    } else if (el.type === "moment") {
      parts.push(lbl ? `moment ${lbl}` : "moment");
    } else if (el.type === "label" && lbl) {
      parts.push(lbl);
    }
  });

  return parts.join(", ") || "Engineering sketch";
}
