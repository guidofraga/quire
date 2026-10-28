// 2D plots (docs/02-file-format.md §4.7): drawn as SVG so they print as vectors.
// The engine samples each series where the plot sits in reading order and returns the
// values in the axis units; this file only lays them out.
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { prettyValue } from "./math";
import { Check, Field, Num, Select, Text } from "./Inspector";
import { closePopover, openPopover } from "./Popover";
import { contentBottom, flash, heights, insertRegion, layout, LINE, setState, snap, state, updateRegion } from "./store";
import type { PlotView, Region } from "./types";
import type { Placed } from "./store";

type Style = NonNullable<Series["style"]>;

export interface Series {
  y: string;
  x?: string;
  range?: string;
  label?: string;
  style?: { color?: string; width?: number; dash?: "dashed" | "dotted"; draw?: "line" | "points" | "line+points" };
}

interface AxisSpec {
  unit?: string;
  label?: string;
  min?: number;
  max?: number;
  /** Logarithmic scale (positive values only). */
  log?: boolean;
}

/** Fixed categorical order; series keep their colour when others are added or removed. */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

export const DEFAULT_SIZE: [number, number] = [440, 260];

export const seriesOf = (r: Region) => (Array.isArray(r.series) ? (r.series as Series[]) : []);
export const axesOf = (r: Region) => (r.axes ?? {}) as { x?: AxisSpec; y?: AxisSpec };

/** Round steps (1, 2, 5 × 10ⁿ) covering [lo, hi] with about `count` ticks. */
function ticks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** A tick number: as many decimals as the step needs, no float noise (a point, like results). */
function fmt(v: number, step = Math.abs(v) / 1000 || 1): string {
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  return String(Number(v.toFixed(decimals)));
}

/** A readout value: four significant figures. */
const sig = (v: number) => String(Number(v.toPrecision(4)));

const unitText = (u: string) => (u ? prettyValue(u) : "");

function extent(values: number[], spec: AxisSpec | undefined): [number, number] {
  const finite = values.filter(Number.isFinite);
  let lo = spec?.min ?? Math.min(...finite);
  let hi = spec?.max ?? Math.max(...finite);
  if (!finite.length && spec?.min === undefined) lo = 0;
  if (!finite.length && spec?.max === undefined) hi = 1;
  if (lo === hi) [lo, hi] = lo === 0 ? [-1, 1] : [lo - Math.abs(lo) / 2, hi + Math.abs(hi) / 2];
  return [lo, hi];
}

interface Layout {
  w: number;
  h: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The data range shown on each axis. */
  x: [number, number];
  y: [number, number];
  xTicks: number[];
  yTicks: number[];
  xLabel: (t: number) => string;
  yLabel: (t: number) => string;
  /** Data value → pixel (NaN off a log axis's domain), and back. */
  sx: (v: number) => number;
  sy: (v: number) => number;
  ix: (px: number) => number;
  iy: (py: number) => number;
}

const SUPER: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/** One axis's scale: linear or logarithmic, between `lo` and `hi` (data values). */
function scale(lo: number, hi: number, log: boolean, count: number) {
  const t = (v: number) => (log ? (v > 0 ? Math.log10(v) : NaN) : v);
  const inv = (u: number) => (log ? 10 ** u : u);
  if (!log) {
    const tk = ticks(lo, hi, count);
    const step = tk[1] - tk[0];
    return { t, inv, ticks: tk, label: (v: number) => fmt(v, step) };
  }
  // decades: 1, 10, 100…, written 10⁴ from four digits on
  const k0 = Math.ceil(Math.log10(lo) - 1e-9);
  const k1 = Math.floor(Math.log10(hi) + 1e-9);
  const tk: number[] = [];
  for (let k = k0; k <= k1; k++) tk.push(10 ** k);
  const label = (v: number) => {
    const k = Math.round(Math.log10(v));
    return Math.abs(k) < 4 ? String(Number(v.toPrecision(1))) : `10${[...String(k)].map((c) => SUPER[c]).join("")}`;
  };
  return { t, inv, ticks: tk, label };
}

export function PlotBody(props: { r: Region }) {
  const r = () => props.r;
  const view = () => state.views[r().id]?.plot as PlotView | undefined;
  const size = () => r().size ?? DEFAULT_SIZE;
  const series = () => seriesOf(r());
  const axes = () => axesOf(r());
  const drawn = () => (view()?.series ?? []).map((s, i) => ({ ...s, i, spec: series()[i] })).filter((s) => !s.error && s.xs.length);

  // a temporary zoomed or panned view (⌥ + scroll, ⌥ + drag, the + − buttons); not saved
  const [zoomed, setZoomed] = createSignal<{ x: [number, number]; y: [number, number] } | null>(null);

  const layout = createMemo((): Layout => {
    const [w, h] = size();
    const all = drawn();
    const logX = !!axes().x?.log;
    const logY = !!axes().y?.log;
    const usable = (vs: (number | null)[], log: boolean) => (vs as number[]).filter((v) => Number.isFinite(v) && (!log || v > 0));
    let x = extent(usable(all.flatMap((s) => s.xs), logX), axes().x);
    let y = extent(usable(all.flatMap((s) => s.ys), logY), axes().y);
    // printing shows the plot as saved, never a temporary zoom
    const z = state.printing ? null : zoomed();
    if (z) {
      x = z.x;
      y = z.y;
    } else if (logY) {
      // a log axis widens to whole decades
      y = [axes().y?.min ?? 10 ** Math.floor(Math.log10(y[0])), axes().y?.max ?? 10 ** Math.ceil(Math.log10(y[1]))];
    } else {
      // a little air above and below the data, unless the author fixed the limits
      const pad = (y[1] - y[0]) * 0.06;
      y = [axes().y?.min ?? (y[0] === 0 ? 0 : y[0] - pad), axes().y?.max ?? y[1] + pad];
      const yTicks = ticks(y[0], y[1], Math.max(2, Math.round(h / 50)));
      // snap the axes out to whole ticks when the data leaves them free
      if (axes().y?.min === undefined && yTicks[0] > y[0]) y = [yTicks[0] - (yTicks[1] - yTicks[0]), y[1]];
      if (axes().y?.max === undefined && yTicks.at(-1)! < y[1]) y = [y[0], yTicks.at(-1)! + (yTicks[1] - yTicks[0])];
    }
    if (logX && !z) x = [axes().x?.min ?? 10 ** Math.floor(Math.log10(x[0])), axes().x?.max ?? 10 ** Math.ceil(Math.log10(x[1]))];
    const X = scale(x[0], x[1], logX, Math.max(2, Math.round(w / 90)));
    const Y = scale(y[0], y[1], logY, Math.max(2, Math.round(h / 50)));
    const longest = Math.max(...Y.ticks.map((t) => Y.label(t).length));
    const left = 18 + longest * 6.6 + 8;
    const top = 10;
    const right = 14;
    const bottom = 40;
    const [tx0, tx1, ty0, ty1] = [X.t(x[0]), X.t(x[1]), Y.t(y[0]), Y.t(y[1])];
    const sx = (v: number) => left + ((X.t(v) - tx0) / (tx1 - tx0)) * (w - left - right);
    const sy = (v: number) => h - bottom - ((Y.t(v) - ty0) / (ty1 - ty0)) * (h - top - bottom);
    const ix = (px: number) => X.inv(tx0 + ((px - left) / (w - left - right)) * (tx1 - tx0));
    const iy = (py: number) => Y.inv(ty0 + ((h - bottom - py) / (h - top - bottom)) * (ty1 - ty0));
    return { w, h, left, top, right, bottom, x, y, xTicks: X.ticks, yTicks: Y.ticks, xLabel: X.label, yLabel: Y.label, sx, sy, ix, iy };
  });

  /** Zoom the view by `f` (< 1 zooms in) around a pixel, in each axis's own scale. */
  const zoomBy = (f: number, px?: number, py?: number) => {
    const L = layout();
    const cx = px ?? (L.left + L.w - L.right) / 2;
    const cy = py ?? (L.top + L.h - L.bottom) / 2;
    const around = (lo: number, hi: number, c: number, log: boolean): [number, number] => {
      const T = (v: number) => (log ? Math.log10(v) : v);
      const I = (u: number) => (log ? 10 ** u : u);
      const tc = T(c);
      return [I(tc + (T(lo) - tc) * f), I(tc + (T(hi) - tc) * f)];
    };
    setZoomed({ x: around(L.x[0], L.x[1], L.ix(cx), !!axes().x?.log), y: around(L.y[0], L.y[1], L.iy(cy), !!axes().y?.log) });
  };
  /** Move the view by a pixel offset (⌥ + drag). */
  const panBy = (dx: number, dy: number, from: Layout) => {
    setZoomed({
      x: [from.ix(from.left - dx), from.ix(from.w - from.right - dx)],
      y: [from.iy(from.h - from.bottom - dy), from.iy(from.top - dy)],
    });
  };
  const toLocal = (e: MouseEvent) => {
    const box = (e.currentTarget as Element).closest(".plot")!.querySelector("svg")!.getBoundingClientRect();
    const L = layout();
    return [((e.clientX - box.left) / box.width) * L.w, ((e.clientY - box.top) / box.height) * L.h] as const;
  };
  /** Keep the zoomed view: it becomes the axes' limits (which print). */
  const keepView = () => {
    const z = zoomed();
    if (!z) return;
    const round = (v: number) => Number(v.toPrecision(4));
    setAxis(r().id, "x", { min: round(z.x[0]), max: round(z.x[1]) });
    setAxis(r().id, "y", { min: round(z.y[0]), max: round(z.y[1]) });
    setZoomed(null);
  };

  const path = (xs: (number | null)[], ys: (number | null)[]) => {
    const L = layout();
    let d = "";
    let pen = false;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      const y = ys[k];
      const px = x === null ? NaN : L.sx(x);
      const py = y === null ? NaN : L.sy(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`;
      pen = true;
    }
    return d;
  };

  const inside = (x: number | null, y: number | null) => {
    const L = layout();
    const within = (v: number, [a, b]: [number, number]) => v >= Math.min(a, b) - 1e-9 * Math.abs(b - a) && v <= Math.max(a, b) + 1e-9 * Math.abs(b - a);
    return x !== null && y !== null && Number.isFinite(L.sx(x)) && Number.isFinite(L.sy(y)) && within(x, L.x) && within(y, L.y);
  };
  /** How a series is drawn: a line (solid, dashed, dotted), points, or both. */
  const drawAs = (i: number) => series()[i]?.style?.draw ?? (isData(i) ? "line+points" : "line");
  const DASHES: Record<string, string> = { dashed: "7 5", dotted: "1.5 4" };
  const dash = (i: number) => DASHES[series()[i]?.style?.dash ?? ""];
  /**
   * Which samples get a marker: every data point, but only about 20 evenly spaced ones
   * along a function (its 241 samples as dots read as a heavy beaded line).
   */
  const markers = (s: { i: number; xs: (number | null)[]; ys: (number | null)[] }) => {
    const all = s.xs.map((_, k) => k).filter((k) => inside(s.xs[k], s.ys[k]));
    if (isData(s.i)) return all;
    const step = Math.max(1, Math.round(all.length / 20));
    return all.filter((_, n) => n % step === 0 || n === all.length - 1);
  };
  const color = (i: number) => series()[i]?.style?.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
  const name = (i: number) => series()[i]?.label || series()[i]?.y || `Series ${i + 1}`;
  const isData = (i: number) => !series()[i]?.range;

  /** The variable of the functions, or the name of the data's x values. */
  const xName = () => {
    const f = series().find((s) => s.range);
    if (f) return f.x || "x";
    const data = series().find((s) => s.x && /^[\p{L}][\p{L}\p{N}_.]*$/u.test(s.x));
    return data?.x ?? "";
  };
  const xTitle = () => {
    const label = axes().x?.label ?? xName();
    const u = unitText(view()?.xUnit ?? "");
    return [label, u && `(${u})`].filter(Boolean).join(" ");
  };
  const yTitle = () => {
    const label = axes().y?.label ?? (series().length === 1 ? name(0) : "");
    const u = unitText(view()?.yUnit ?? "");
    return label ? [label, u && `(${u})`].filter(Boolean).join(" ") : u;
  };

  // ---- hover: a crosshair at the nearest sample, with every series' value there ----
  const [hoverX, setHoverX] = createSignal<number | null>(null);
  const readout = createMemo(() => {
    const px = hoverX();
    if (px === null || state.printing) return null;
    const L = layout();
    const xv = L.ix(px);
    const rows: { i: number; x: number; y: number }[] = [];
    for (const s of drawn()) {
      let best = -1;
      for (let k = 0; k < s.xs.length; k++) {
        const x = s.xs[k];
        const y = s.ys[k];
        if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (best < 0 || Math.abs(x - xv) < Math.abs((s.xs[best] as number) - xv)) best = k;
      }
      if (best >= 0) rows.push({ i: s.i, x: s.xs[best] as number, y: s.ys[best] as number });
    }
    if (!rows.length) return null;
    return { x: rows[0].x, rows };
  });

  const extrema = (s: { xs: (number | null)[]; ys: (number | null)[] }) => {
    let lo = -1;
    let hi = -1;
    s.ys.forEach((y, k) => {
      if (y === null || !Number.isFinite(y)) return;
      if (lo < 0 || y < (s.ys[lo] as number)) lo = k;
      if (hi < 0 || y > (s.ys[hi] as number)) hi = k;
    });
    // a zero at either end (a support) is not worth a label
    const last = s.ys.length - 1;
    const worth = (k: number) => k >= 0 && !((k === 0 || k === last) && s.ys[k] === 0);
    return [hi, lo].filter((k, n, a) => worth(k) && a.indexOf(k) === n);
  };

  return (
    <div class="plot" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }}>
      <svg
        width={size()[0]}
        height={size()[1]}
        viewBox={`0 0 ${size()[0]} ${size()[1]}`}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const L = layout();
          const px = ((e.clientX - box.left) / box.width) * L.w;
          setHoverX(px >= L.left && px <= L.w - L.right ? px : null);
        }}
        onPointerLeave={() => setHoverX(null)}
        onWheel={(e) => {
          // ⌥ + scroll zooms the plot at the pointer (plain scroll still moves the page)
          if (!e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          const [px, py] = toLocal(e);
          zoomBy(Math.exp(e.deltaY * 0.01), px, py);
        }}
        onPointerDown={(e) => {
          // ⌥ + drag pans the plot instead of moving it on the page
          if (!e.altKey || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const start = layout();
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const k = start.w / box.width;
          const [x0, y0] = [e.clientX, e.clientY];
          const move = (ev: PointerEvent) => panBy((ev.clientX - x0) * k, (ev.clientY - y0) * k, start);
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onDblClick={(e) => {
          // empty space: the nearest curve if one is close, else the whole plot
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const L = layout();
          const px = ((e.clientX - box.left) / box.width) * L.w;
          const py = ((e.clientY - box.top) / box.height) * L.h;
          let best: [number, number] | null = null;
          for (const d of drawn()) {
            d.xs.forEach((x, k) => {
              const y = d.ys[k];
              if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return;
              const dist = Math.hypot(L.sx(x) - px, L.sy(y) - py);
              if (!best || dist < best[0]) best = [dist, d.i];
            });
          }
          const near = best as [number, number] | null;
          if (near && near[0] < 18) editSeries(e, r().id, near[1]);
          else editWholePlot(e, r().id);
        }}
      >
        {/* grid and axes */}
        <g class="plot-grid">
          <Show when={r().grid !== false}>
            <For each={layout().yTicks}>
              {(t) => <line x1={layout().left} x2={layout().w - layout().right} y1={layout().sy(t)} y2={layout().sy(t)} />}
            </For>
            <For each={layout().xTicks}>
              {(t) => <line y1={layout().top} y2={layout().h - layout().bottom} x1={layout().sx(t)} x2={layout().sx(t)} />}
            </For>
          </Show>
        </g>
        <g class="plot-axis">
          <line x1={layout().left} x2={layout().w - layout().right} y1={layout().h - layout().bottom} y2={layout().h - layout().bottom} />
          <line x1={layout().left} x2={layout().left} y1={layout().top} y2={layout().h - layout().bottom} />
          <Show when={layout().y[0] < 0 && layout().y[1] > 0}>
            <line class="zero" x1={layout().left} x2={layout().w - layout().right} y1={layout().sy(0)} y2={layout().sy(0)} />
          </Show>
        </g>
        {/* double-click an axis (its numbers or title) to edit it */}
        <rect
          class="plot-axis-hit"
          x={layout().left}
          y={layout().h - layout().bottom}
          width={layout().w - layout().left - layout().right}
          height={layout().bottom}
          onDblClick={(e) => editAxis(e, r().id, "x")}
        />
        <rect
          class="plot-axis-hit"
          x={0}
          y={layout().top}
          width={layout().left}
          height={layout().h - layout().top - layout().bottom}
          onDblClick={(e) => editAxis(e, r().id, "y")}
        />
        <g class="plot-ticks">
          <For each={layout().xTicks}>
            {(t) => (
              <text x={layout().sx(t)} y={layout().h - layout().bottom + 14} text-anchor="middle">
                {layout().xLabel(t)}
              </text>
            )}
          </For>
          <For each={layout().yTicks}>
            {(t) => (
              <text x={layout().left - 6} y={layout().sy(t) + 3.5} text-anchor="end">
                {layout().yLabel(t)}
              </text>
            )}
          </For>
        </g>
        <g class="plot-titles">
          <text
            x={(layout().left + layout().w - layout().right) / 2}
            y={layout().h - 6}
            text-anchor="middle"
            onDblClick={(e) => editAxis(e, r().id, "x")}
          >
            {xTitle()}
          </text>
          <text
            transform={`translate(11 ${(layout().top + layout().h - layout().bottom) / 2}) rotate(-90)`}
            text-anchor="middle"
            onDblClick={(e) => editAxis(e, r().id, "y")}
          >
            {yTitle()}
          </text>
        </g>
        {/* the series, clipped to the plot area */}
        <clipPath id={`clip-${r().id}`}>
          <rect x={layout().left} y={layout().top} width={layout().w - layout().left - layout().right} height={layout().h - layout().top - layout().bottom} />
        </clipPath>
        <g clip-path={`url(#clip-${r().id})`}>
          <For each={drawn()}>
            {(s) => (
              <>
                <Show when={drawAs(s.i) !== "points"}>
                  <path
                    class="plot-line"
                    d={path(s.xs, s.ys)}
                    stroke={color(s.i)}
                    stroke-width={series()[s.i]?.style?.width ?? 2}
                    stroke-dasharray={dash(s.i)}
                  />
                </Show>
                {/* a wide invisible stroke: double-click the curve to edit its series */}
                <path class="plot-hit" d={path(s.xs, s.ys)} onDblClick={(e) => editSeries(e, r().id, s.i)} />
              </>
            )}
          </For>
        </g>
        {/* points, whole even on the edge of the plot */}
        <For each={drawn().filter((s) => drawAs(s.i) !== "line")}>
          {(s) => (
            <For each={markers(s)}>
              {(k) => (
                <circle
                  class="plot-dot"
                  classList={{ dense: markers(s).length > 40 }}
                  cx={layout().sx(s.xs[k] as number)}
                  cy={layout().sy(s.ys[k] as number)}
                  r={markers(s).length > 40 ? 2.5 : 3.5}
                  fill={color(s.i)}
                />
              )}
            </For>
          )}
        </For>
        {/* maximum and minimum, labelled */}
        <Show when={r().extrema}>
          <For each={drawn()}>
            {(s) => (
              <For each={extrema(s)}>
                {(k) => {
                  const cx = () => layout().sx(s.xs[k] as number);
                  const cy = () => layout().sy(s.ys[k] as number);
                  const below = () => cy() < layout().top + 16;
                  return (
                    <g class="plot-extremum">
                      <circle cx={cx()} cy={cy()} r={4} fill={color(s.i)} />
                      <text
                        x={Math.min(Math.max(cx(), layout().left + 30), layout().w - layout().right - 30)}
                        y={below() ? cy() + 16 : cy() - 8}
                        text-anchor="middle"
                      >
                        {`${sig(s.ys[k] as number)}${view()?.yUnit ? ` ${unitText(view()!.yUnit)}` : ""}`}
                      </text>
                    </g>
                  );
                }}
              </For>
            )}
          </For>
        </Show>
        {/* legend: inside the drawing, so copied images and PDFs keep it */}
        <Show when={drawn().length > 1 && r().legend !== "none"}>
          {(() => {
            const rows = () => drawn();
            const boxW = () => 30 + Math.max(...rows().map((s) => name(s.i).length)) * 6.3;
            const boxH = () => rows().length * 16 + 8;
            const pos = () => {
              const L = layout();
              const where = (r().legend as string | undefined) ?? "top-left";
              const x = where.endsWith("right") ? L.w - L.right - boxW() - 8 : L.left + 8;
              const y = where.startsWith("bottom") ? L.h - L.bottom - boxH() - 6 : L.top + 6;
              return { x, y };
            };
            return (
              <g class="plot-legend" transform={`translate(${pos().x} ${pos().y})`}>
                <rect width={boxW()} height={boxH()} rx={4} />
                <For each={rows()}>
                  {(s, k) => (
                    <g transform={`translate(8 ${12 + k() * 16})`} onDblClick={(e) => editSeries(e, r().id, s.i)}>
                      <line x1={0} x2={14} y1={0} y2={0} stroke={color(s.i)} stroke-width={2.5} stroke-dasharray={dash(s.i)} />
                      <text x={20} y={4}>
                        {name(s.i)}
                      </text>
                    </g>
                  )}
                </For>
              </g>
            );
          })()}
        </Show>
        {/* hover */}
        <Show when={readout()}>
          {(h) => (
            <g class="plot-hover">
              <line x1={layout().sx(h().x)} x2={layout().sx(h().x)} y1={layout().top} y2={layout().h - layout().bottom} />
              <For each={h().rows}>
                {(row) => <circle cx={layout().sx(row.x)} cy={layout().sy(row.y)} r={4} fill={color(row.i)} />}
              </For>
            </g>
          )}
        </Show>
      </svg>
      {/* zoom: shown on hover, never printed */}
      <div class="plot-tools" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
        <button title="Zoom in (or ⌥ + scroll)" onClick={() => zoomBy(0.5)}>
          ＋
        </button>
        <button title="Zoom out" onClick={() => zoomBy(2)}>
          −
        </button>
        <Show when={zoomed()}>
          <button title="Back to the whole plot" onClick={() => setZoomed(null)}>
            ⤢
          </button>
          <button title="Keep this view: it becomes the axes' limits, which print" onClick={keepView}>
            Keep
          </button>
        </Show>
      </div>
      <Show when={readout()}>
        {(h) => {
          const L = layout();
          const px = L.sx(h().x);
          const flip = px > L.w * 0.6;
          return (
            <div
              class="plot-tip"
              style={{
                left: flip ? undefined : `${px + 10}px`,
                right: flip ? `${L.w - px + 10}px` : undefined,
                top: `${L.top + 4}px`,
              }}
            >
              <div class="plot-tip-x">
                {axes().x?.label || xName() || "x"} = {sig(h().x)} {unitText(view()?.xUnit ?? "")}
              </div>
              <For each={h().rows}>
                {(row) => (
                  <div class="plot-tip-row">
                    <span class="plot-swatch" style={{ background: color(row.i) }} />
                    <span class="plot-tip-name">{name(row.i)}</span>
                    <span class="plot-tip-val">
                      {sig(row.y)} {unitText(view()?.yUnit ?? "")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          );
        }}
      </Show>
      <Show when={!view() && series().length === 0}>
        <div class="plot-empty">No series yet: add one in the Inspector</div>
      </Show>
    </div>
  );
}

/**
 * A starting range for a function: up to a length it uses (`L := 6 m` gives `0 m..L`,
 * the span of a beam), else 0..10.
 */
function guessRange(definition: string, param: string): string {
  const body = definition.replace(/^[^=≔]*(?::=|≔)/, "");
  const names = new Set(body.match(/[\p{L}][\p{L}\p{N}_.]*/gu) ?? []);
  names.delete(param);
  for (const p of layout().list) {
    const m = /^\s*([\p{L}][\p{L}\p{N}_.]*)\s*(?::=|≔)(.*)$/u.exec(p.region.kind === "math" ? (p.region.expr ?? "") : "");
    const unit = m && names.has(m[1]) ? /(?:\d|\s|\*|')(mm|cm|m|km|in|ft)\s*$/.exec(m[2]) : null;
    if (unit) return `0 ${unit[1]}..${m![1]}`;
  }
  return "0..10";
}

/** Insert ▸ Plot: below the selected function (plotting it), or at the insertion point. */
const FUNCTION = /^\s*([\p{L}][\p{L}\p{N}_.]*)\(\s*([\p{L}][\p{L}\p{N}_.]*)\s*\)\s*(?::=|≔)/u;

/** The function defined nearest above a point, for Insert ▸ Plot with nothing selected. */
function functionAbove(y: number): Placed | undefined {
  return layout()
    .list.filter((q) => q.region.kind === "math" && q.y <= y + 1 && FUNCTION.test(q.region.expr ?? ""))
    .sort((a, b) => a.y - b.y)
    .at(-1);
}

export function insertPlot() {
  const selected = state.selection.length === 1 ? layout().byId.get(state.selection[0]) : undefined;
  // the selected line if it defines a function; otherwise (nothing selected, another
  // region, or the empty line `\plot` was typed on) the nearest function above
  const isFunction = (q: Placed | undefined) => q?.region.kind === "math" && FUNCTION.test(q.region.expr ?? "");
  const below = selected ? selected.y + (heights[selected.region.id] ?? 0) : (state.caret?.[1] ?? contentBottom());
  const p = isFunction(selected) ? selected : functionAbove(below);
  const fn = p ? FUNCTION.exec(p.region.expr ?? "") : null;
  // a vector (`d := [0; 4; 15] m`) is plotted as data
  const vector = p?.region.kind === "math" ? /^\s*([\p{L}][\p{L}\p{N}_.]*)\s*(?::=|≔)\s*(?:\[|range\()/u.exec(p.region.expr ?? "") : null;
  const series: Series[] = fn
    ? [{ y: `${fn[1]}(${fn[2]})`, x: fn[2], range: guessRange(p!.region.expr ?? "", fn[2]) }]
    : vector
      ? [{ y: vector[1] }]
      : [{ y: "sin(x)", x: "x", range: "0..2*π" }];
  // under the selected line; otherwise at the insertion point
  const at: [number, number] = selected
    ? [selected.x, snap(selected.y + (heights[selected.region.id] ?? 20) + LINE)]
    : (state.caret ?? [36, snap(contentBottom() + LINE)]);
  insertRegion({ kind: "plot2d", at, size: [...DEFAULT_SIZE], series, grid: true });
}

// ---------------------------------------------------------------------------
// Inspector ▸ Plot
// ---------------------------------------------------------------------------

/** Remove empty values so the file only holds what was set. */
function tidy<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

// Edits, shared by the Inspector and the panels opened on the plot itself

const regionOf = (id: string) => layout().byId.get(id)?.region;

function setSeries(id: string, i: number, patch: Partial<Series>) {
  updateRegion(id, (d) => {
    const list = seriesOf(d).map((s) => ({ ...s }));
    list[i] = tidy({ ...list[i], ...patch });
    d.series = list;
  });
}

function removeSeries(id: string, i: number) {
  updateRegion(id, (d) => {
    d.series = seriesOf(d).filter((_, k) => k !== i);
  });
}

/** A new series over the same range as the first function, ready to type in. */
function addSeries(id: string): number {
  let index = 0;
  updateRegion(id, (d) => {
    const list = seriesOf(d);
    const first = list.find((s) => s.range);
    d.series = [...list, first ? { y: "", x: first.x, range: first.range } : { y: "" }];
    index = list.length;
  });
  return index;
}

function setAxis(id: string, a: "x" | "y", patch: Partial<AxisSpec>) {
  // the x axis limits lead: functions are drawn across them (edit a series' own range
  // afterwards to cut it short)
  const unit = axesOf(regionOf(id) ?? ({} as Region)).x?.unit || viewOf(id)?.xUnit || "";
  const end = (v: number) => (unit ? `${v} ${unit}` : String(v));
  updateRegion(id, (d) => {
    const axes = { ...axesOf(d) };
    axes[a] = tidy({ ...axes[a], ...patch });
    if (!Object.keys(axes[a]!).length) delete axes[a];
    if (Object.keys(axes).length) d.axes = axes;
    else delete d.axes;
    if (a !== "x" || !("min" in patch || "max" in patch)) return;
    d.series = seriesOf(d).map((s) => {
      const at = s.range?.indexOf("..") ?? -1;
      if (!s.range || at < 0) return s;
      const from = patch.min !== undefined ? end(patch.min) : s.range.slice(0, at).trim();
      const to = patch.max !== undefined ? end(patch.max) : s.range.slice(at + 2).trim();
      return { ...s, range: `${from}..${to}` };
    });
  });
}

const viewOf = (id: string) => state.views[id]?.plot as PlotView | undefined;

/** One series: what is plotted, over what, and how it looks. */
export function SeriesEditor(props: { id: string; i: number; title?: boolean }) {
  const s = () => seriesOf(regionOf(props.id) ?? ({} as Region))[props.i] ?? { y: "" };
  const set = (patch: Partial<Series>) => setSeries(props.id, props.i, patch);
  const colour = () => s().style?.color ?? SERIES_COLORS[props.i % SERIES_COLORS.length];
  return (
    <div class="insp-sub plot-series">
      <Show when={props.title !== false}>
        <div class="insp-subtitle">
          <span class="plot-swatch" style={{ background: colour() }} />
          Series {props.i + 1}
          <button class="insp-mini" title="Remove this series" onClick={() => removeSeries(props.id, props.i)}>
            ✕
          </button>
        </div>
      </Show>
      <Field label="Plot" hint="An expression in the variable, like M(x), or a vector of values">
        <Text value={s().y} mono placeholder="M(x)" onCommit={(v) => set({ y: v })} />
      </Field>
      <div class="insp-row">
        <Field label={s().range ? "Variable" : "x values"}>
          <Text value={s().x} mono placeholder={s().range ? "x" : "1, 2, 3…"} onCommit={(v) => set({ x: v || undefined })} />
        </Field>
        <Field label="Range" hint="start..end; empty plots data">
          <Text value={s().range} mono placeholder="data" onCommit={(v) => set({ range: v || undefined })} />
        </Field>
      </div>
      <div class="insp-row">
        <Field label="Label">
          <Text value={s().label} placeholder={s().y || "Series"} onCommit={(v) => set({ label: v || undefined })} />
        </Field>
        <Field label="Colour">
          <input class="insp-color" type="color" value={colour()} onChange={(e) => set({ style: { ...s().style, color: e.currentTarget.value } })} />
        </Field>
      </div>
      <Field label="Draw as">
        <Select<string>
          value={`${s().style?.draw ?? (s().range ? "line" : "line+points")}${s().style?.dash ? `:${s().style!.dash}` : ""}`}
          options={[
            ["line", "Line"],
            ["line:dashed", "Dashed line"],
            ["line:dotted", "Dotted line"],
            ["points", "Points"],
            ["line+points", "Line and points"],
          ]}
          onChange={(v) => {
            const [draw, dash] = v.split(":") as [Style["draw"], Style["dash"]];
            const style = tidy({ ...s().style, draw, dash });
            set({ style: Object.keys(style).length ? style : undefined });
          }}
        />
      </Field>
      <Show when={viewOf(props.id)?.series[props.i]?.error}>
        <div class="err">{viewOf(props.id)!.series[props.i].error}</div>
      </Show>
    </div>
  );
}

/** One axis: its title, unit and limits. */
export function AxisEditor(props: { id: string; axis: "x" | "y"; title?: boolean }) {
  const spec = () => axesOf(regionOf(props.id) ?? ({} as Region))[props.axis];
  const set = (patch: Partial<AxisSpec>) => setAxis(props.id, props.axis, patch);
  const unit = () => (props.axis === "x" ? viewOf(props.id)?.xUnit : viewOf(props.id)?.yUnit);
  return (
    <div class="insp-sub">
      <Show when={props.title !== false}>
        <div class="insp-subtitle">{props.axis === "x" ? "Horizontal axis" : "Vertical axis"}</div>
      </Show>
      <div class="insp-row">
        <Field label="Title">
          <Text value={spec()?.label} placeholder="automatic" onCommit={(v) => set({ label: v || undefined })} />
        </Field>
        <Field label="Unit" hint="e.g. m, kN*m">
          <Text value={spec()?.unit} mono placeholder={unit() || "automatic"} onCommit={(v) => set({ unit: v || undefined })} />
        </Field>
      </div>
      <div class="insp-row">
        <Field label="From">
          <Num value={spec()?.min} placeholder="auto" step={0.1} onCommit={(v) => set({ min: v })} />
        </Field>
        <Field label="To">
          <Num value={spec()?.max} placeholder="auto" step={0.1} onCommit={(v) => set({ max: v })} />
        </Field>
      </div>
      <Check checked={!!spec()?.log} label="Logarithmic scale" onChange={(on) => set({ log: on || undefined })} />
    </div>
  );
}

/** Grid, legend and the maximum/minimum labels. */
export function OptionsEditor(props: { id: string }) {
  const r = () => regionOf(props.id) ?? ({} as Region);
  return (
    <>
      <Check checked={r().grid !== false} label="Grid" onChange={(on) => updateRegion(props.id, { grid: on ? true : false })} />
      <Field label="Legend" hint="Shown with two or more series">
        <Select<string>
          value={(r().legend as string | undefined) ?? "top-left"}
          options={[
            ["top-left", "Top left"],
            ["top-right", "Top right"],
            ["bottom-left", "Bottom left"],
            ["bottom-right", "Bottom right"],
            ["none", "None"],
          ]}
          onChange={(v) => updateRegion(props.id, { legend: v === "top-left" ? undefined : v })}
        />
      </Field>
      <Check checked={!!r().extrema} label="Mark maximum and minimum" onChange={(on) => updateRegion(props.id, { extrema: on || undefined })} />
    </>
  );
}

/** Inspector ▸ Plot: everything at once. */
export function PlotFields(props: { r: Region }) {
  return (
    <>
      <Index each={seriesOf(props.r)}>{(_, i) => <SeriesEditor id={props.r.id} i={i} />}</Index>
      <button class="btn insp-add" onClick={() => addSeries(props.r.id)}>
        Add Series
      </button>
      <AxisEditor id={props.r.id} axis="x" />
      <AxisEditor id={props.r.id} axis="y" />
      <OptionsEditor id={props.r.id} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Editing on the plot: double-click an axis, the legend, a curve or the plot
// ---------------------------------------------------------------------------

export function editAxis(e: MouseEvent, id: string, axis: "x" | "y") {
  openPopover(e, axis === "x" ? "Horizontal axis" : "Vertical axis", () => <AxisEditor id={id} axis={axis} title={false} />);
}

export function editSeries(e: MouseEvent, id: string, i: number) {
  const name = () => seriesOf(regionOf(id) ?? ({} as Region))[i]?.label || `Series ${i + 1}`;
  openPopover(e, name(), () => (
    <>
      <SeriesEditor id={id} i={i} title={false} />
      <button
        class="btn insp-add"
        onClick={() => {
          removeSeries(id, i);
          closePopover();
        }}
      >
        Remove Series
      </button>
    </>
  ));
}

/** The whole plot: its series (each opens on a click), a new one, and the options. */
export function editWholePlot(e: MouseEvent, id: string) {
  openPopover(e, "Plot", () => (
    <>
      <Index each={seriesOf(regionOf(id) ?? ({} as Region))}>
        {(s, i) => (
          <button class="plot-series-link" onClick={(ev) => editSeries(ev, id, i)}>
            <span class="plot-swatch" style={{ background: s().style?.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {s().label || s().y || `Series ${i + 1}`}
          </button>
        )}
      </Index>
      <button class="btn insp-add" onClick={(ev) => editSeries(ev, id, addSeries(id))}>
        Add Series
      </button>
      <OptionsEditor id={id} />
    </>
  ));
}

/** Double-click or Enter on a plot: its series, ready to type in. */
export function editPlot(id: string) {
  setState({ selection: [id], caret: null, inspector: true });
  setTimeout(() => document.querySelector<HTMLInputElement>(".plot-series input")?.focus(), 30);
}

const INLINED = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "stroke-linecap", "paint-order", "font-size", "font-family", "font-weight", "opacity"];

/** Right-click ▸ Copy as Image: the plot as a PNG at twice its size, for Word or e-mail. */
export async function copyPlotImage(id: string) {
  const svg = document.querySelector<SVGSVGElement>(`[data-region="${CSS.escape(id)}"] .plot svg`);
  if (!svg) return;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.querySelector(".plot-hover")?.remove();
  // the page's stylesheet does not travel with the image: copy the computed styles in
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, k) => {
    const cs = getComputedStyle(el);
    const style = INLINED.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    to[k]?.setAttribute("style", style);
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const [w, h] = [svg.width.baseVal.value, svg.height.baseVal.value];
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  // drawn inside the clipboard item, so the write starts while the click still counts
  const png = (async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png"));
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flash("Copied the plot as an image");
  } catch (e) {
    flash(`Could not copy the plot: ${(e as Error).message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
