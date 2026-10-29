// A 2D plot drawn in polar coordinates (Inspector ▸ Plot ▸ Polar): the series are r(θ),
// sampled by the engine exactly like y(x); circles mark r and rays mark θ every 30°.
import { createMemo, createSignal, For, Show } from "solid-js";
import { prettyValue } from "./math";
import { axesOf, DEFAULT_SIZE, editSeries, SERIES_COLORS, seriesOf } from "./Plot";
import { angleFactor, nearest, RAYS, rings, toPlane } from "./polar";
import { state } from "./store";
import type { PlotView, Region } from "./types";

const sig = (v: number) => String(Number(v.toPrecision(4)));

export function PolarPlotBody(props: { r: Region }) {
  const r = () => props.r;
  const view = () => state.views[r().id]?.plot as PlotView | undefined;
  const size = () => r().size ?? DEFAULT_SIZE;
  const series = () => seriesOf(r());
  const factor = () => angleFactor(view()?.xUnit ?? "");
  const drawn = () => (view()?.series ?? []).map((s, i) => ({ ...s, i })).filter((s) => !s.error && s.xs.length);

  const layout = createMemo(() => {
    const [w, h] = size();
    const radii = drawn().flatMap((s) => s.ys.filter((v): v is number => v !== null && Number.isFinite(v)).map(Math.abs));
    const rMax = axesOf(r()).y?.max ?? Math.max(0, ...radii);
    const circles = rings(rMax || 1);
    const outer = circles.at(-1)!;
    const R = Math.max(20, Math.min(w, h) / 2 - 26);
    const cx = w / 2;
    const cy = h / 2;
    const k = R / outer;
    return { w, h, cx, cy, R, circles, sx: (x: number) => cx + x * k, sy: (y: number) => cy - y * k, inv: (px: number, py: number) => [(px - cx) / k, (cy - py) / k] as const };
  });

  const path = (xs: (number | null)[], ys: (number | null)[]) => {
    const L = layout();
    let d = "";
    let pen = false;
    for (let k = 0; k < xs.length; k++) {
      const t = xs[k];
      const rr = ys[k];
      if (t === null || rr === null || !Number.isFinite(t) || !Number.isFinite(rr)) {
        pen = false;
        continue;
      }
      const [x, y] = toPlane(t, rr, factor());
      d += `${pen ? "L" : "M"}${L.sx(x).toFixed(2)} ${L.sy(y).toFixed(2)}`;
      pen = true;
    }
    return d;
  };
  const color = (i: number) => series()[i]?.style?.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
  const name = (i: number) => series()[i]?.label || series()[i]?.y || `Series ${i + 1}`;
  const rUnit = () => (view()?.yUnit ? ` ${prettyValue(view()!.yUnit)}` : "");

  // hover: the nearest sample, with its θ and r
  const [hover, setHover] = createSignal<{ s: number; k: number } | null>(null);
  const onMove = (e: MouseEvent) => {
    const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const L = layout();
    const [x, y] = L.inv(((e.clientX - box.left) / box.width) * L.w, ((e.clientY - box.top) / box.height) * L.h);
    const all = drawn();
    const hit = nearest(all, factor(), x, y);
    setHover(hit && { s: all[hit.s].i, k: hit.k });
  };
  const tip = createMemo(() => {
    const h = hover();
    if (!h || state.printing) return null;
    const s = view()?.series[h.s];
    const t = s?.xs[h.k];
    const rr = s?.ys[h.k];
    if (t == null || rr == null) return null;
    const [x, y] = toPlane(t, rr, factor());
    const deg = (t * factor() * 180) / Math.PI;
    return { i: h.s, x: layout().sx(x), y: layout().sy(y), text: `θ = ${sig(deg)}°   r = ${sig(rr)}${rUnit()}` };
  });

  return (
    <div class="plot plot-polar" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }}>
      <svg
        role="img"
        aria-label={`Polar plot of ${series().map((_, i) => name(i)).join(", ") || "nothing yet"}`}
        viewBox={`0 0 ${layout().w} ${layout().h}`}
        width={layout().w}
        height={layout().h}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <g class="plot-grid">
          <For each={layout().circles}>{(c) => <circle cx={layout().cx} cy={layout().cy} r={(c / layout().circles.at(-1)!) * layout().R} fill="none" />}</For>
          <For each={RAYS}>
            {(a) => {
              const rad = (a * Math.PI) / 180;
              return <line x1={layout().cx} y1={layout().cy} x2={layout().cx + layout().R * Math.cos(rad)} y2={layout().cy - layout().R * Math.sin(rad)} />;
            }}
          </For>
        </g>
        <g class="plot-ticks">
          <For each={RAYS}>
            {(a) => {
              const rad = (a * Math.PI) / 180;
              const d = layout().R + 13;
              return (
                <text x={layout().cx + d * Math.cos(rad)} y={layout().cy - d * Math.sin(rad) + 4} text-anchor="middle">
                  {a}°
                </text>
              );
            }}
          </For>
          {/* radii along 15°, between the 0° and 30° rays, clear of the angle labels */}
          <For each={layout().circles}>
            {(c) => {
              const d = (c / layout().circles.at(-1)!) * layout().R;
              const a = (15 * Math.PI) / 180;
              return (
                <text x={layout().cx + d * Math.cos(a) + 2} y={layout().cy - d * Math.sin(a) - 2}>
                  {sig(c)}
                </text>
              );
            }}
          </For>
        </g>
        <For each={drawn()}>
          {(s) => (
            <>
              <path class="plot-line" d={path(s.xs, s.ys)} stroke={color(s.i)} fill="none" />
              <path class="plot-hit" d={path(s.xs, s.ys)} onDblClick={(e) => editSeries(e, r().id, s.i)} />
            </>
          )}
        </For>
        <Show when={tip()}>
          {(t) => (
            <g class="plot-hover">
              <circle cx={t().x} cy={t().y} r={3.5} fill={color(t().i)} />
            </g>
          )}
        </Show>
        <Show when={drawn().length > 1 && r().legend !== "none"}>
          <g class="plot-legend">
            <For each={drawn()}>
              {(s, n) => (
                <text x={8} y={14 + n() * 15}>
                  <tspan style={{ fill: color(s.i) }}>━</tspan> {name(s.i)}
                </text>
              )}
            </For>
          </g>
        </Show>
      </svg>
      <Show when={tip()}>{(t) => <div class="plot-tip polar-tip">{t().text}</div>}</Show>
      <Show when={rUnit()}>
        <div class="polar-unit">r{rUnit() && ` (${rUnit().trim()})`}</div>
      </Show>
    </div>
  );
}
