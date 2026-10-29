// A 3D plot region (SMath's 3D graph): surfaces z(x, y), curves x(t), y(t), z(t) and data,
// sampled by the engine (crates/quire-eval/src/plot3d.rs) and drawn here on a canvas with
// an orthographic camera: drag to turn, ⌥ + scroll to zoom; the view is saved with the plot.
import { createEffect, createSignal, Index, onCleanup } from "solid-js";
import { Field, Text } from "./Inspector";
import { prettyValue } from "./math";
import { SERIES_COLORS } from "./Plot";
import { bounds, type Camera, DEFAULT_CAMERA, heat, normalize, project, ticks3, type Vec3 } from "./geom3d";
import { contentBottom, heights, insertRegion, layout, LINE, setState, snap, state, updateRegion } from "./store";
import type { Region } from "./types";

export const DEFAULT_SIZE_3D: [number, number] = [420, 340];

/** One series as saved in the document (docs/02-file-format.md). */
export interface Series3 {
  /** Height z(x, y) — or z(t) of a curve, or a matrix of heights. */
  z: string;
  x?: string;
  y?: string;
  xrange?: string;
  yrange?: string;
  t?: string;
  range?: string;
  label?: string;
}

interface View3 {
  units: [string, string, string];
  series: { shape: "surface" | "curve"; xs: (number | null)[]; ys: (number | null)[]; zs: (number | null)[]; error: string | null }[];
}

const series3Of = (r: Region) => (Array.isArray(r.series) ? (r.series as Series3[]) : []);
const cameraOf = (r: Region): Camera => ({ ...DEFAULT_CAMERA, ...((r.camera as Partial<Camera>) ?? {}) });
const fmt = (v: number) => String(Number(v.toPrecision(4)));

export function Plot3DBody(props: { r: Region }) {
  const r = () => props.r;
  const size = () => r().size ?? DEFAULT_SIZE_3D;
  const view = () => (state.views[r().id]?.plot as { three?: View3 } | undefined)?.three;
  // a view being turned; saved to the region when the drag ends
  const [live, setLive] = createSignal<Camera | null>(null);
  const cam = () => live() ?? cameraOf(r());
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
    const box = bounds(ok.map((s) => (s.shape === "surface" ? { xs: s.xs, ys: s.ys, zs: s.zs } : s)));
    const c = cam();
    const scale = (Math.min(w, h) / 3.4) * c.zoom;
    const screen = (p: Vec3): Vec3 => {
      const [sx, sy, d] = project(p, c);
      return [w / 2 + sx * scale, h / 2 + 8 - sy * scale, d];
    };
    const at = (x: number, y: number, z: number) => screen(normalize([x, y, z], box));

    // the box: its 12 edges, faint
    const corners: Vec3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
    g.strokeStyle = "#d9d8d4";
    g.lineWidth = 1;
    for (let i = 0; i < 8; i++)
      for (let j = i + 1; j < 8; j++) {
        const diff = corners[i].filter((v2, k) => v2 !== corners[j][k]).length;
        if (diff !== 1) continue;
        const [a, b] = [screen(corners[i]), screen(corners[j])];
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }

    // surfaces: quads coloured by height, the farthest drawn first
    const quads: { pts: Vec3[]; depth: number; t: number }[] = [];
    const [zlo, zhi] = [box[0][2], box[1][2]];
    for (const s of ok.filter((s) => s.shape === "surface")) {
      const nx = s.xs.length;
      const ny = s.ys.length;
      const z = (i: number, j: number) => s.zs[j * nx + i];
      for (let j = 0; j + 1 < ny; j++)
        for (let i = 0; i + 1 < nx; i++) {
          const cells: [number, number][] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
          const vals = cells.map(([a, b]) => [s.xs[a], s.ys[b], z(a, b)]);
          if (vals.some((p) => p.some((q) => q === null || !Number.isFinite(q)))) continue;
          const pts = vals.map((p) => at(p[0]!, p[1]!, p[2]!));
          const mean = vals.reduce((acc, p) => acc + p[2]!, 0) / 4;
          quads.push({ pts, depth: pts.reduce((acc, p) => acc + p[2], 0) / 4, t: (mean - zlo) / (zhi - zlo) });
        }
    }
    quads.sort((a, b) => b.depth - a.depth);
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

    // curves and data points
    ok.forEach((s, n) => {
      if (s.shape !== "curve") return;
      g.strokeStyle = SERIES_COLORS[n % SERIES_COLORS.length];
      g.lineWidth = 2;
      g.beginPath();
      let pen = false;
      s.xs.forEach((x, k) => {
        const y = s.ys[k];
        const z = s.zs[k];
        if ([x, y, z].some((q) => q === null || !Number.isFinite(q))) {
          pen = false;
          return;
        }
        const p = at(x!, y!, z!);
        if (pen) g.lineTo(p[0], p[1]);
        else g.moveTo(p[0], p[1]);
        pen = true;
      });
      g.stroke();
    });

    // ticks on the three edges nearest the viewer at the bottom of the box
    g.fillStyle = "#52514e";
    g.font = "10px -apple-system, system-ui, sans-serif";
    const names = ["x", "y", "z"];
    const units = v?.units ?? ["", "", ""];
    for (let a = 0; a < 3; a++) {
      // the edge along axis a nearest the viewer: x and y along the bottom of the box
      const others = [0, 1, 2].filter((k) => k !== a);
      let best: { p0: Vec3; d: number } | null = null;
      for (const s0 of [-1, 1])
        for (const s1 of [-1, 1]) {
          const p0: Vec3 = [0, 0, 0];
          p0[others[0]] = s0;
          p0[others[1]] = s1;
          if (a !== 2 && p0[2] !== -1) continue;
          // z: the leftmost vertical edge on the screen, clear of the drawing
          const d = a === 2 ? project(p0, c)[0] : project(p0, c)[2];
          if (!best || d < best.d) best = { p0, d };
        }
      if (!best) continue;
      const [lo, hi] = [box[0][a], box[1][a]];
      for (const t of ticks3(lo, hi, 4)) {
        const f = ((t - lo) / (hi - lo)) * 2 - 1;
        const p: Vec3 = [...best.p0];
        p[a] = f;
        const [sx, sy] = screen(p);
        const out = Math.hypot(sx - w / 2, sy - h / 2) || 1;
        g.textAlign = "center";
        g.fillText(fmt(t), sx + ((sx - w / 2) / out) * 14, sy + ((sy - h / 2) / out) * 12 + 3);
      }
      const mid: Vec3 = [...best.p0];
      mid[a] = 0;
      const [mx, my] = screen(mid);
      const out = Math.hypot(mx - w / 2, my - h / 2) || 1;
      g.font = "italic 11px -apple-system, system-ui, sans-serif";
      const label = names[a] + (units[a] ? ` (${prettyValue(units[a])})` : "");
      g.fillText(label, mx + ((mx - w / 2) / out) * 30, my + ((my - h / 2) / out) * 26 + 4);
      g.font = "10px -apple-system, system-ui, sans-serif";
    }
  };

  createEffect(() => {
    view();
    cam();
    size();
    state.printing;
    draw();
  });

  // drag to turn; ⌥ + scroll to zoom
  let from: { x: number; y: number; c: Camera } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    from = { x: e.clientX, y: e.clientY, c: cam() };
  };
  const onMove = (e: PointerEvent) => {
    if (!from) return;
    const el = Math.max(-89, Math.min(89, from.c.elevation + (e.clientY - from.y) * 0.5));
    setLive({ ...from.c, azimuth: ((from.c.azimuth - (e.clientX - from.x) * 0.5 + 540) % 360) - 180, elevation: el });
  };
  const onUp = () => {
    from = null;
    const c = live();
    if (c) updateRegion(r().id, { camera: { azimuth: Math.round(c.azimuth), elevation: Math.round(c.elevation), zoom: c.zoom } });
    setLive(null);
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.altKey) return;
    e.preventDefault();
    const c = cam();
    updateRegion(r().id, { camera: { ...c, zoom: Math.max(0.3, Math.min(4, c.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) } });
  };
  onCleanup(() => (from = null));

  return (
    <div class="plot plot3d" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={`3D plot of ${series3Of(r()).map((s) => s.label || s.z).join(", ") || "nothing yet"}`}
        style={{ width: `${size()[0]}px`, height: `${size()[1]}px`, cursor: "grab" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
      />
      {!state.printing && (
        <button class="plot3d-reset" title="Back to the standard view" onClick={() => updateRegion(r().id, { camera: undefined })}>
          ⟲
        </button>
      )}
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
    series: [{ z: "sin(x)*cos(y)", xrange: "-π..π", yrange: "-π..π" }],
  });
}

export function editPlot3d(id: string) {
  setState({ selection: [id], caret: null, inspector: true });
}

/** Inspector ▸ 3D Plot: each series, then the axis units. */
export function Plot3DFields(props: { r: Region }) {
  const list = () => series3Of(props.r);
  const set = (i: number, patch: Partial<Series3>) => {
    const next = list().map((s, k) => (k === i ? { ...s, ...patch } : s));
    for (const s of next) for (const k of Object.keys(s) as (keyof Series3)[]) if (s[k] === "") delete s[k];
    updateRegion(props.r.id, { series: next });
  };
  const axes = () => (props.r.axes ?? {}) as Record<string, { unit?: string }>;
  const setUnit = (a: string, unit: string) => updateRegion(props.r.id, { axes: { ...axes(), [a]: unit ? { ...axes()[a], unit } : undefined } });
  return (
    <>
      <Index each={list()}>
        {(s, i) => (
          <div class="plot-series">
            <Field label={`Series ${i + 1}: z`} hint="z(x, y); z(t) for a curve; or a matrix of heights">
              <Text value={s().z} mono onCommit={(v) => set(i, { z: v })} />
            </Field>
            <div class="insp-row">
              <Field label="x range" hint="surface: a..b">
                <Text value={s().xrange} mono placeholder="-2..2" onCommit={(v) => set(i, { xrange: v })} />
              </Field>
              <Field label="y range">
                <Text value={s().yrange} mono placeholder="-2..2" onCommit={(v) => set(i, { yrange: v })} />
              </Field>
            </div>
            <div class="insp-row">
              <Field label="x" hint="surface: variable (x); curve: x(t); data: vector">
                <Text value={s().x} mono onCommit={(v) => set(i, { x: v })} />
              </Field>
              <Field label="y">
                <Text value={s().y} mono onCommit={(v) => set(i, { y: v })} />
              </Field>
            </div>
            <Field label="t range" hint="curve: a..b (parameter t)">
              <Text value={s().range} mono placeholder="0..2*π" onCommit={(v) => set(i, { range: v })} />
            </Field>
          </div>
        )}
      </Index>
      <button class="btn insp-add" onClick={() => updateRegion(props.r.id, { series: [...list(), { z: "" }] })}>
        Add Series
      </button>
      <div class="insp-row">
        <Field label="x unit">
          <Text value={axes().x?.unit} mono onCommit={(v) => setUnit("x", v)} />
        </Field>
        <Field label="y unit">
          <Text value={axes().y?.unit} mono onCommit={(v) => setUnit("y", v)} />
        </Field>
        <Field label="z unit">
          <Text value={axes().z?.unit} mono onCommit={(v) => setUnit("z", v)} />
        </Field>
      </div>
    </>
  );
}
