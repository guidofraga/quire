// 2D plots (docs/02-file-format.md §4.7): drawn as SVG so they print as vectors.
// The engine samples each series where the plot sits in reading order and returns the
// values in the axis units; this file only lays them out.
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { prettyValue } from "./math";
import { Check, Field, Num, Select, Text } from "./Inspector";
import { contentBottom, flash, heights, insertRegion, layout, LINE, setState, snap, state, updateRegion } from "./store";
import type { PlotView, Region } from "./types";

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
  x: [number, number];
  y: [number, number];
  xTicks: number[];
  yTicks: number[];
  sx: (v: number) => number;
  sy: (v: number) => number;
}

export function PlotBody(props: { r: Region }) {
  const r = () => props.r;
  const view = () => state.views[r().id]?.plot as PlotView | undefined;
  const size = () => r().size ?? DEFAULT_SIZE;
  const series = () => seriesOf(r());
  const axes = () => axesOf(r());
  const drawn = () => (view()?.series ?? []).map((s, i) => ({ ...s, i, spec: series()[i] })).filter((s) => !s.error && s.xs.length);

  const layout = createMemo((): Layout => {
    const [w, h] = size();
    const all = drawn();
    let x = extent(all.flatMap((s) => s.xs as number[]), axes().x);
    let y = extent(all.flatMap((s) => s.ys as number[]), axes().y);
    // a little air above and below the data, unless the author fixed the limits
    const pad = (y[1] - y[0]) * 0.06;
    y = [axes().y?.min ?? (y[0] === 0 ? 0 : y[0] - pad), axes().y?.max ?? y[1] + pad];
    const xTicks = ticks(x[0], x[1], Math.max(2, Math.round(w / 90)));
    const yTicks = ticks(y[0], y[1], Math.max(2, Math.round(h / 50)));
    // snap the axes out to whole ticks when the data leaves them free
    if (axes().y?.min === undefined && yTicks[0] > y[0]) y = [yTicks[0] - (yTicks[1] - yTicks[0]), y[1]];
    if (axes().y?.max === undefined && yTicks.at(-1)! < y[1]) y = [y[0], yTicks.at(-1)! + (yTicks[1] - yTicks[0])];
    const yt = ticks(y[0], y[1], Math.max(2, Math.round(h / 50)));
    const step = yt[1] - yt[0];
    const longest = Math.max(...yt.map((t) => fmt(t, step).length));
    const left = 18 + longest * 6.6 + 8;
    const top = 10;
    const right = 14;
    const bottom = 40;
    const sx = (v: number) => left + ((v - x[0]) / (x[1] - x[0])) * (w - left - right);
    const sy = (v: number) => h - bottom - ((v - y[0]) / (y[1] - y[0])) * (h - top - bottom);
    x = [x[0], x[1]];
    return { w, h, left, top, right, bottom, x, y, xTicks, yTicks: yt, sx, sy };
  });

  const path = (xs: (number | null)[], ys: (number | null)[]) => {
    const L = layout();
    let d = "";
    let pen = false;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      const y = ys[k];
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${L.sx(x).toFixed(2)} ${L.sy(y).toFixed(2)}`;
      pen = true;
    }
    return d;
  };

  const inside = (x: number | null, y: number | null) => {
    const L = layout();
    const within = (v: number, [a, b]: [number, number]) => v >= Math.min(a, b) - 1e-9 * Math.abs(b - a) && v <= Math.max(a, b) + 1e-9 * Math.abs(b - a);
    return x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y) && within(x, L.x) && within(y, L.y);
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
    const xv = L.x[0] + ((px - L.left) / (L.w - L.left - L.right)) * (L.x[1] - L.x[0]);
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
        <g class="plot-ticks">
          <For each={layout().xTicks}>
            {(t) => (
              <text x={layout().sx(t)} y={layout().h - layout().bottom + 14} text-anchor="middle">
                {fmt(t, layout().xTicks[1] - layout().xTicks[0])}
              </text>
            )}
          </For>
          <For each={layout().yTicks}>
            {(t) => (
              <text x={layout().left - 6} y={layout().sy(t) + 3.5} text-anchor="end">
                {fmt(t, layout().yTicks[1] - layout().yTicks[0])}
              </text>
            )}
          </For>
        </g>
        <g class="plot-titles">
          <text x={(layout().left + layout().w - layout().right) / 2} y={layout().h - 6} text-anchor="middle">
            {xTitle()}
          </text>
          <text transform={`translate(11 ${(layout().top + layout().h - layout().bottom) / 2}) rotate(-90)`} text-anchor="middle">
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
                    <g transform={`translate(8 ${12 + k() * 16})`}>
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
export function insertPlot() {
  const p = state.selection.length === 1 ? layout().byId.get(state.selection[0]) : undefined;
  const fn = p?.region.kind === "math" ? /^\s*([\p{L}][\p{L}\p{N}_.]*)\(\s*([\p{L}][\p{L}\p{N}_.]*)\s*\)\s*(?::=|≔)/u.exec(p.region.expr ?? "") : null;
  // a vector (`d := [0; 4; 15] m`) is plotted as data
  const vector = p?.region.kind === "math" ? /^\s*([\p{L}][\p{L}\p{N}_.]*)\s*(?::=|≔)\s*(?:\[|range\()/u.exec(p.region.expr ?? "") : null;
  const series: Series[] = fn
    ? [{ y: `${fn[1]}(${fn[2]})`, x: fn[2], range: guessRange(p!.region.expr ?? "", fn[2]) }]
    : vector
      ? [{ y: vector[1] }]
      : [{ y: "sin(x)", x: "x", range: "0..2*π" }];
  const at: [number, number] = p
    ? [p.x, snap(p.y + (heights[p.region.id] ?? 20) + LINE)]
    : (state.caret ?? [36, snap(contentBottom() + LINE)]);
  insertRegion({ kind: "plot2d", at, size: [...DEFAULT_SIZE], series, grid: true });
  setState({ inspector: true });
}

// ---------------------------------------------------------------------------
// Inspector ▸ Plot
// ---------------------------------------------------------------------------

/** Remove empty values so the file only holds what was set. */
function tidy<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

export function PlotFields(props: { r: Region }) {
  const r = () => props.r;
  const setSeries = (i: number, patch: Partial<Series>) =>
    updateRegion(r().id, (d) => {
      const list = seriesOf(d).map((s) => ({ ...s }));
      list[i] = tidy({ ...list[i], ...patch });
      d.series = list;
    });
  const removeSeries = (i: number) =>
    updateRegion(r().id, (d) => {
      d.series = seriesOf(d).filter((_, k) => k !== i);
    });
  const addSeries = () =>
    updateRegion(r().id, (d) => {
      const list = seriesOf(d);
      const first = list.find((s) => s.range);
      d.series = [...list, first ? { y: "", x: first.x, range: first.range } : { y: "" }];
    });
  const setAxis = (a: "x" | "y", patch: Partial<AxisSpec>) =>
    updateRegion(r().id, (d) => {
      const axes = { ...axesOf(d) };
      axes[a] = tidy({ ...axes[a], ...patch });
      if (!Object.keys(axes[a]!).length) delete axes[a];
      if (Object.keys(axes).length) d.axes = axes;
      else delete d.axes;
    });
  const view = () => state.views[r().id]?.plot as PlotView | undefined;
  return (
    <>
      <Index each={seriesOf(r())}>
        {(s, i) => (
          <div class="insp-sub plot-series">
            <div class="insp-subtitle">
              <span class="plot-swatch" style={{ background: s().style?.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />
              Series {i + 1}
              <button class="insp-mini" title="Remove this series" onClick={() => removeSeries(i)}>
                ✕
              </button>
            </div>
            <Field label="Plot" hint="An expression in the variable, like M(x), or a vector of values">
              <Text value={s().y} mono placeholder="M(x)" onCommit={(v) => setSeries(i, { y: v })} />
            </Field>
            <div class="insp-row">
              <Field label={s().range ? "Variable" : "x values"}>
                <Text value={s().x} mono placeholder={s().range ? "x" : "1, 2, 3…"} onCommit={(v) => setSeries(i, { x: v || undefined })} />
              </Field>
              <Field label="Range" hint="start..end; empty plots data">
                <Text value={s().range} mono placeholder="data" onCommit={(v) => setSeries(i, { range: v || undefined })} />
              </Field>
            </div>
            <div class="insp-row">
              <Field label="Label">
                <Text value={s().label} placeholder={s().y || "Series"} onCommit={(v) => setSeries(i, { label: v || undefined })} />
              </Field>
              <Field label="Colour">
                <input
                  class="insp-color"
                  type="color"
                  value={s().style?.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
                  onChange={(e) => setSeries(i, { style: { ...s().style, color: e.currentTarget.value } })}
                />
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
                  setSeries(i, { style: Object.keys(style).length ? style : undefined });
                }}
              />
            </Field>
            <Show when={view()?.series[i]?.error}>
              <div class="err">{view()!.series[i].error}</div>
            </Show>
          </div>
        )}
      </Index>
      <button class="btn insp-add" onClick={addSeries}>
        Add Series
      </button>
      <For each={["x", "y"] as const}>
        {(a) => (
          <div class="insp-sub">
            <div class="insp-subtitle">{a === "x" ? "Horizontal axis" : "Vertical axis"}</div>
            <div class="insp-row">
              <Field label="Unit" hint="e.g. m, kN*m">
                <Text
                  value={axesOf(r())[a]?.unit}
                  mono
                  placeholder={(a === "x" ? view()?.xUnit : view()?.yUnit) || "automatic"}
                  onCommit={(v) => setAxis(a, { unit: v || undefined })}
                />
              </Field>
              <Field label="Title">
                <Text value={axesOf(r())[a]?.label} placeholder="automatic" onCommit={(v) => setAxis(a, { label: v || undefined })} />
              </Field>
            </div>
            <div class="insp-row">
              <Field label="From">
                <Num value={axesOf(r())[a]?.min} placeholder="auto" step={0.1} onCommit={(v) => setAxis(a, { min: v })} />
              </Field>
              <Field label="To">
                <Num value={axesOf(r())[a]?.max} placeholder="auto" step={0.1} onCommit={(v) => setAxis(a, { max: v })} />
              </Field>
            </div>
          </div>
        )}
      </For>
      <Check checked={r().grid !== false} label="Grid" onChange={(on) => updateRegion(r().id, { grid: on ? true : false })} />
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
          onChange={(v) => updateRegion(r().id, { legend: v === "top-left" ? undefined : v })}
        />
      </Field>
      <Check checked={!!r().extrema} label="Mark maximum and minimum" onChange={(on) => updateRegion(r().id, { extrema: on || undefined })} />
    </>
  );
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
