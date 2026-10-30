// 3D plots (SMath's 3D graph): surfaces z(x, y), parametric curves and surfaces, and data,
// sampled by the engine (crates/quire-eval/src/plot3d.rs) and drawn here on a canvas with an
// orthographic camera (geom3d.ts). Drag a selected plot to turn it, ⌥ + scroll to zoom; the
// view is saved with the plot.
import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import { Field, Select, Text } from "./Inspector";
import { prettyValue } from "./math";
import { SERIES_COLORS, SMATH_COLORS } from "./Plot";
import { bounds, type Camera, cameraOf, faces, heat, normalize, project, ticks3, type Vec3, zoomOf } from "./geom3d";
import {
  contentBottom,
  flash,
  heights,
  insertRegion,
  layout,
  LINE,
  setState,
  snap,
  state,
  updateRegion,
} from "./store";
import type { Plot3View, Region } from "./types";

export const DEFAULT_SIZE_3D: [number, number] = [420, 340];

/** One series as saved in the document (docs/02-file-format.md §4.7). */
export interface Series3 {
  /** A height z(x, y) over `xrange` × `yrange`, or a matrix of heights. */
  surface?: string;
  /** x, y and z of `t` over `range`, of `u` and `v` over `urange` × `vrange`, or three vectors. */
  parametric?: [string, string, string];
  x?: string;
  y?: string;
  xrange?: string;
  yrange?: string;
  range?: string;
  urange?: string;
  vrange?: string;
  label?: string;
}

type Kind3 = "surface" | "curve" | "parametric";

/** The series, with the height Quire 0.2.0's importer wrote as `y` read as `surface`. */
export function series3Of(r: Region): Series3[] {
  const list = Array.isArray(r.series) ? (r.series as Series3[]) : [];
  return list.map((s) =>
    s.surface === undefined && s.parametric === undefined && s.y !== undefined
      ? { ...s, surface: s.y, y: undefined }
      : s,
  );
}

const kindOf = (s: Series3): Kind3 => (!s.parametric ? "surface" : s.urange || s.vrange ? "parametric" : "curve");
const fmt = (v: number) => String(Number(v.toPrecision(4)));
const view3Of = (id: string) => state.views[id]?.plot?.three as Plot3View | undefined;

export function Plot3DBody(props: { r: Region; selected: boolean }) {
  const r = () => props.r;
  const size = () => r().size ?? DEFAULT_SIZE_3D;
  const view = () => view3Of(r().id);
  // a view being turned; saved to the region when the drag ends
  const [live, setLive] = createSignal<Camera | null>(null);
  const cam = () => live() ?? cameraOf(r().camera);
  let canvas!: HTMLCanvasElement;

  const draw = () => {
    const v = view();
    const [w, h] = size();
    const dpr = Math.min(3, window.devicePixelRatio || 1) * (state.printing ? 2 : 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const ok = (v?.series ?? []).filter((s) => !s.error && s.xs.length);
    const box = bounds(ok);
    const c = cam();
    const scale = (Math.min(w, h) / 3.4) * zoomOf(c);
    const screen = (p: Vec3): Vec3 => {
      const [sx, sy, d] = project(p, c);
      return [w / 2 + sx * scale, h / 2 + 8 - sy * scale, d];
    };
    const at = (p: Vec3) => screen(normalize(p, box));

    // the box: its 12 edges, faint
    const corners: Vec3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
    g.strokeStyle = "#d9d8d4";
    g.lineWidth = 1;
    for (let i = 0; i < 8; i++)
      for (let j = i + 1; j < 8; j++) {
        if (corners[i].filter((q, k) => q !== corners[j][k]).length !== 1) continue;
        const [a, b] = [screen(corners[i]), screen(corners[j])];
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }

    // surfaces: faces coloured by height over each surface's own heights, the farthest drawn first
    const quads = ok
      .filter((s) => s.shape === "surface")
      .flatMap((s) => {
        const [lo, hi] = bounds([s]).map((b) => b[2]);
        return faces(s).map((f) => {
          const pts = f.map(at);
          return {
            pts,
            depth: pts.reduce((acc, p) => acc + p[2], 0) / 4,
            t: (f.reduce((acc, p) => acc + p[2], 0) / 4 - lo) / (hi - lo),
          };
        });
      })
      .sort((a, b) => b.depth - a.depth);
    g.lineWidth = 0.5;
    g.strokeStyle = "rgba(40, 40, 40, 0.28)";
    for (const q of quads) {
      g.beginPath();
      g.moveTo(q.pts[0][0], q.pts[0][1]);
      for (const p of q.pts.slice(1)) g.lineTo(p[0], p[1]);
      g.closePath();
      g.fillStyle = heat(q.t);
      g.fill();
      g.stroke();
    }

    // curves and lines through points, on top
    const palette = r().palette === "smath" ? SMATH_COLORS : SERIES_COLORS;
    ok.forEach((s, n) => {
      if (s.shape !== "curve") return;
      g.strokeStyle = palette[n % palette.length];
      g.lineWidth = 2;
      g.beginPath();
      let pen = false;
      s.xs.forEach((x, k) => {
        const p = [x, s.ys[k], s.zs[k]];
        if (!p.every((q) => typeof q === "number" && Number.isFinite(q))) {
          pen = false;
          return;
        }
        const [sx, sy] = at(p as Vec3);
        if (pen) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
        pen = true;
      });
      g.stroke();
    });

    // numbers along the edges nearest the viewer: x and y along the bottom of the box,
    // z up its leftmost vertical edge; axis names with their units
    g.fillStyle = "#52514e";
    g.textAlign = "center";
    const names = ["x", "y", "z"];
    const units = v?.units ?? ["", "", ""];
    for (let a = 0; a < 3; a++) {
      const others = [0, 1, 2].filter((k) => k !== a);
      let best: { p0: Vec3; d: number } | null = null;
      for (const s0 of [-1, 1])
        for (const s1 of [-1, 1]) {
          const p0: Vec3 = [0, 0, 0];
          p0[others[0]] = s0;
          p0[others[1]] = s1;
          if (a !== 2 && p0[2] !== -1) continue;
          const d = a === 2 ? project(p0, c)[0] : project(p0, c)[2];
          if (!best || d < best.d) best = { p0, d };
        }
      if (!best) continue;
      const outward = (p: Vec3, by: [number, number]) => {
        const [sx, sy] = screen(p);
        const len = Math.hypot(sx - w / 2, sy - h / 2) || 1;
        return [sx + ((sx - w / 2) / len) * by[0], sy + ((sy - h / 2) / len) * by[1]];
      };
      const [lo, hi] = [box[0][a], box[1][a]];
      g.font = "10px -apple-system, system-ui, sans-serif";
      for (const t of ticks3(lo, hi, 4)) {
        const p: Vec3 = [...best.p0];
        p[a] = ((t - lo) / (hi - lo)) * 2 - 1;
        const [tx, ty] = outward(p, [14, 12]);
        g.fillText(fmt(t), tx, ty + 3);
      }
      const mid: Vec3 = [...best.p0];
      mid[a] = 0;
      const [mx, my] = outward(mid, [30, 26]);
      g.font = "italic 11px -apple-system, system-ui, sans-serif";
      g.fillText(names[a] + (units[a] ? ` (${prettyValue(units[a])})` : ""), mx, my + 4);
    }
  };

  createEffect(() => {
    view();
    cam();
    size();
    void state.printing;
    draw();
  });

  // drag a selected plot to turn it (an unselected one is selected and moved as any region)
  let from: { x: number; y: number; c: Camera } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !props.selected) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    from = { x: e.clientX, y: e.clientY, c: cam() };
  };
  const onMove = (e: PointerEvent) => {
    if (!from) return;
    const elevation = Math.max(-89, Math.min(89, from.c.elevation + (e.clientY - from.y) * 0.5));
    setLive({ ...from.c, azimuth: ((from.c.azimuth - (e.clientX - from.x) * 0.5 + 540) % 360) - 180, elevation });
  };
  const onUp = () => {
    from = null;
    const c = live();
    if (c)
      updateRegion(r().id, {
        camera: { azimuth: Math.round(c.azimuth), elevation: Math.round(c.elevation), distance: c.distance },
      });
    setLive(null);
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.altKey) return;
    e.preventDefault();
    const c = cam();
    const distance = Math.max(0.75, Math.min(10, Number((c.distance * (e.deltaY > 0 ? 1.1 : 0.9)).toFixed(3))));
    updateRegion(r().id, { camera: { ...c, distance } });
  };
  onCleanup(() => (from = null));

  const what = () =>
    series3Of(r())
      .map((s) => s.label || s.surface || s.parametric?.join(", "))
      .filter(Boolean)
      .join("; ");
  return (
    <div class="plot plot3d" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`3D plot of ${what() || "nothing yet"}`}
        style={{ width: `${size()[0]}px`, height: `${size()[1]}px`, cursor: props.selected ? "grab" : undefined }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
      />
      <Show when={props.selected && !state.printing && r().camera !== undefined}>
        <button
          class="plot3d-reset"
          title="Back to the standard view"
          aria-label="Back to the standard view"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => updateRegion(r().id, { camera: undefined })}
        >
          ⟲
        </button>
      </Show>
    </div>
  );
}

/** Insert ▸ 3D Plot: a surface to start from, under the selection or at the insertion point. */
export function insertPlot3d() {
  const selected = state.selection.length === 1 ? layout().byId.get(state.selection[0]) : undefined;
  const at: [number, number] = selected
    ? [selected.x, snap(selected.y + (heights[selected.region.id] ?? 20) + LINE)]
    : (state.caret ?? [36, snap(contentBottom() + LINE)]);
  insertRegion({
    kind: "plot3d",
    at,
    size: [...DEFAULT_SIZE_3D],
    series: [{ surface: "sin(x)*cos(y)", xrange: "-π..π", yrange: "-π..π" }],
  });
}

/** Double-click or Enter on a 3D plot: its series, ready to type in. */
export function editPlot3d(id: string) {
  setState({ selection: [id], caret: null, inspector: true });
  setTimeout(() => document.querySelector<HTMLInputElement>(".plot-series input")?.focus(), 30);
}

/** Right-click ▸ Copy as Image: the plot as drawn, as a PNG. */
export async function copyPlot3dImage(id: string) {
  const canvas = document.querySelector<HTMLCanvasElement>(`[data-region="${CSS.escape(id)}"] .plot3d canvas`);
  if (!canvas) return;
  // drawn inside the clipboard item, so the write starts while the click still counts
  const png = new Promise<Blob>((ok, fail) => {
    const out = document.createElement("canvas");
    [out.width, out.height] = [canvas.width, canvas.height];
    const g = out.getContext("2d");
    if (!g) return fail(new Error("no image"));
    g.fillStyle = "#fff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    out.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png");
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flash("Copied the plot as an image");
  } catch (e) {
    flash(`Could not copy the image: ${e instanceof Error ? e.message : e}`);
  }
}

/** Inspector ▸ 3D Plot: each series, then the axis units. */
export function Plot3DFields(props: { r: Region }) {
  const list = () => series3Of(props.r);
  const write = (next: Series3[]) =>
    updateRegion(props.r.id, (d) => {
      d.series = next.map((s) => {
        const o = { ...s } as Record<string, unknown>;
        for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === "") delete o[k];
        return o;
      });
    });
  const set = (i: number, patch: Partial<Series3>) => write(list().map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const setPart = (i: number, axis: number, v: string) => {
    const p: [string, string, string] = [...(list()[i]?.parametric ?? ["", "", ""])];
    p[axis] = v;
    set(i, { parametric: p });
  };
  const setKind = (i: number, kind: Kind3) => {
    const s = list()[i] ?? {};
    const keep = { label: s.label };
    if (kind === "surface") set(i, { ...blank, ...keep, surface: "sin(x)*cos(y)", xrange: "-π..π", yrange: "-π..π" });
    else if (kind === "curve") set(i, { ...blank, ...keep, parametric: ["cos(t)", "sin(t)", "t"], range: "0..4*π" });
    else
      set(i, {
        ...blank,
        ...keep,
        parametric: ["cos(u)*cos(v)", "sin(u)*cos(v)", "sin(v)"],
        urange: "0..2*π",
        vrange: "-π/2..π/2",
      });
  };
  const axes = () =>
    (props.r.axes && typeof props.r.axes === "object" ? props.r.axes : {}) as Record<
      string,
      { unit?: string } | undefined
    >;
  const setUnit = (a: string, unit: string) =>
    updateRegion(props.r.id, (d) => {
      const all = { ...(d.axes && typeof d.axes === "object" ? d.axes : {}) } as Record<string, unknown>;
      const one = { ...(all[a] as object | undefined), unit: unit || undefined } as Record<string, unknown>;
      if (!unit) delete one.unit;
      if (Object.keys(one).length) all[a] = one;
      else delete all[a];
      if (Object.keys(all).length) d.axes = all;
      else delete d.axes;
    });
  const view = () => view3Of(props.r.id);
  return (
    <>
      <Index each={list()}>
        {(s, i) => (
          <div class="insp-sub plot-series">
            <div class="insp-subtitle">
              Series {i + 1}
              <button
                class="insp-mini"
                title="Remove this series"
                aria-label="Remove this series"
                onClick={() => write(list().filter((_, k) => k !== i))}
              >
                ✕
              </button>
            </div>
            <Field label="Kind">
              <Select<Kind3>
                value={kindOf(s())}
                options={[
                  ["surface", "Surface z(x, y) or matrix"],
                  ["curve", "Curve x(t), y(t), z(t)"],
                  ["parametric", "Parametric surface of u, v"],
                ]}
                onChange={(k) => setKind(i, k)}
              />
            </Field>
            <Show
              when={kindOf(s()) === "surface"}
              fallback={
                <>
                  <Index each={["x", "y", "z"]}>
                    {(name, a) => (
                      <Field
                        label={`${name()}(${kindOf(s()) === "curve" ? "t" : "u, v"})`}
                        hint="Empty ranges plot three vectors of points"
                      >
                        <Text value={s().parametric?.[a]} mono onCommit={(v) => setPart(i, a, v)} />
                      </Field>
                    )}
                  </Index>
                  <Show
                    when={kindOf(s()) === "curve"}
                    fallback={
                      <div class="insp-row">
                        <Field label="u range">
                          <Text value={s().urange} mono placeholder="0..2*π" onCommit={(v) => set(i, { urange: v })} />
                        </Field>
                        <Field label="v range">
                          <Text value={s().vrange} mono placeholder="0..π" onCommit={(v) => set(i, { vrange: v })} />
                        </Field>
                      </div>
                    }
                  >
                    <Field label="t range" hint="start..end; empty plots data">
                      <Text value={s().range} mono placeholder="data" onCommit={(v) => set(i, { range: v })} />
                    </Field>
                  </Show>
                </>
              }
            >
              <Field label="z(x, y)" hint="A height in x and y, or a matrix of heights">
                <Text value={s().surface} mono placeholder="x^2 - y^2" onCommit={(v) => set(i, { surface: v })} />
              </Field>
              <div class="insp-row">
                <Field label="x range" hint="start..end; empty plots a matrix">
                  <Text value={s().xrange} mono placeholder="matrix" onCommit={(v) => set(i, { xrange: v })} />
                </Field>
                <Field label="y range">
                  <Text value={s().yrange} mono placeholder="matrix" onCommit={(v) => set(i, { yrange: v })} />
                </Field>
              </div>
            </Show>
            <Field label="Label">
              <Text value={s().label} placeholder="Series" onCommit={(v) => set(i, { label: v })} />
            </Field>
            <Show when={view()?.series[i]?.error}>
              <div class="err">{view()!.series[i].error}</div>
            </Show>
          </div>
        )}
      </Index>
      <button class="btn insp-add" onClick={() => write([...list(), { surface: "" }])}>
        Add Series
      </button>
      <div class="insp-row">
        <Index each={["x", "y", "z"]}>
          {(a, k) => (
            <Field label={`${a()} unit`}>
              <Text
                value={axes()[a()]?.unit}
                mono
                placeholder={view()?.units[k] || "auto"}
                onCommit={(v) => setUnit(a(), v)}
              />
            </Field>
          )}
        </Index>
      </div>
    </>
  );
}

const blank: Series3 = {
  surface: undefined,
  parametric: undefined,
  x: undefined,
  y: undefined,
  xrange: undefined,
  yrange: undefined,
  range: undefined,
  urange: undefined,
  vrange: undefined,
};
