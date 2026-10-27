import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { openRegionMenu } from "./menu";
import { SHEET_GAP } from "./pages";
import { forwardTyping, RegionBox } from "./Region";
import { Sheet } from "./Sheet";
import { prefs } from "./settings";
import {
  checkpoint,
  commitEditing,
  contentBottom,
  deleteRegions,
  GRID,
  insertAtCaret,
  LINE,
  shiftBelow,
  returnToLeftBox,
  type Placed,
  layout,
  moveTo,
  nudge,
  originsOf,
  PAGE_WIDTH,
  heights,
  setRevealHandler,
  widths,
  setState,
  snap,
  startEditing,
  state,
  toggleArea,
} from "./store";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

let viewportEl: HTMLDivElement | undefined;

export function zoomAt(clientX: number, clientY: number, factor: number) {
  if (!viewportEl) return;
  const rect = viewportEl.getBoundingClientRect();
  const { x, y, zoom } = state.view;
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  setState("view", { zoom: z, x: lx - ((lx - x) * z) / zoom, y: ly - ((ly - y) * z) / zoom });
}

export function zoomCenter(factor: number | "reset") {
  if (!viewportEl) return;
  const rect = viewportEl.getBoundingClientRect();
  const f = factor === "reset" ? 1 / state.view.zoom : factor;
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 3, f);
}

/** A window point in document coordinates (for drops). */
export function clientToDoc(cx: number, cy: number): [number, number] {
  if (!viewportEl) return [0, 0];
  const rect = viewportEl.getBoundingClientRect();
  const sx = (cx - rect.left - state.view.x) / state.view.zoom;
  const sy = (cy - rect.top - state.view.y) / state.view.zoom;
  const [x, y] = layout().fromScene(sx, sy);
  return [Math.max(0, snap(x)), Math.max(0, snap(y))];
}

/** Scroll so a region is in view and select it. */
export function reveal(id: string) {
  // open any collapsed areas around it first (undoable, like a manual expand)
  let parent = layout().byId.get(id)?.parent ?? null;
  while (parent) {
    if (parent.collapsed) toggleArea(parent.id);
    parent = layout().byId.get(parent.id)?.parent ?? null;
  }
  const p = layout().byId.get(id);
  if (!p || !viewportEl) return;
  const rect = viewportEl.getBoundingClientRect();
  const z = state.view.zoom;
  const [sx, sy] = layout().toScene(p.x, p.y);
  setState("view", { x: rect.width / 3 - sx * z, y: rect.height / 3 - sy * z });
  setState({ selection: [id], caret: null });
}

setRevealHandler(reveal);

/**
 * The scene is zoomed with CSS `zoom`, which lays it out at size, rather than a scale
 * transform: WebKit draws a scaled scene as a bitmap while a text field inside it has the
 * caret, so editing went blurry, and switching between the two on every edit flickered.
 * Engines that report zoomed boxes differently from transforms keep the transform (checked
 * once).
 */
const zoomKeepsCoordinates = (() => {
  const outer = document.createElement("div");
  outer.style.cssText = "position:absolute;visibility:hidden;zoom:2";
  const inner = document.createElement("div");
  inner.style.width = "10px";
  outer.append(inner);
  document.body.append(outer);
  const w = inner.getBoundingClientRect().width;
  outer.remove();
  return Math.abs(w - 20) < 0.5;
})();

function sceneStyle(): Record<string, string> {
  const { x, y, zoom } = state.view;
  if (zoomKeepsCoordinates && !state.printing) return { transform: `translate(${x / zoom}px, ${y / zoom}px)`, zoom: String(zoom) };
  return { transform: `translate(${x}px, ${y}px) scale(${zoom})` };
}

/** Smart guides shown while dragging: a vertical and/or horizontal line, in scene px. */
const [guides, setGuides] = createSignal<{ v?: [number, number, number]; h?: [number, number, number] }>({});

const SNAP_PX = 6;

/**
 * Snap the dragged group to edges and centres of the other regions.
 * Returns the adjusted delta per axis, or null when nothing is close enough.
 */
function smartSnap(ids: Set<string>, origins: Map<string, [number, number]>, dx: number, dy: number) {
  const l = layout();
  const box = (id: string, x: number, y: number) => ({ x, y, w: widths[id] ?? 40, h: heights[id] ?? 20 });
  const moving = [...origins.keys()].map((id) => {
    const p = l.byId.get(id)!;
    return box(id, p.x + dx, p.y + dy);
  });
  if (!moving.length) return { dx: null, dy: null };
  const g = {
    x0: Math.min(...moving.map((b) => b.x)),
    x1: Math.max(...moving.map((b) => b.x + b.w)),
    y0: Math.min(...moving.map((b) => b.y)),
    y1: Math.max(...moving.map((b) => b.y + b.h)),
  };
  const others = l.list
    .filter((p) => !p.hidden && !ids.has(p.region.id) && p.region.kind !== "area" && !(p.parent && ids.has(p.parent.id)))
    .map((p) => box(p.region.id, p.x, p.y));
  const tol = SNAP_PX / state.view.zoom;
  let bestX: { d: number; at: number; other: (typeof others)[number] } | null = null;
  let bestY: { d: number; at: number; other: (typeof others)[number] } | null = null;
  const mineX = [g.x0, (g.x0 + g.x1) / 2, g.x1];
  const mineY = [g.y0, (g.y0 + g.y1) / 2, g.y1];
  for (const o of others) {
    for (const t of [o.x, o.x + o.w / 2, o.x + o.w])
      for (const m of mineX) if (Math.abs(t - m) < tol && (!bestX || Math.abs(t - m) < Math.abs(bestX.d))) bestX = { d: t - m, at: t, other: o };
    for (const t of [o.y, o.y + o.h / 2, o.y + o.h])
      for (const m of mineY) if (Math.abs(t - m) < tol && (!bestY || Math.abs(t - m) < Math.abs(bestY.d))) bestY = { d: t - m, at: t, other: o };
  }
  const lines: { v?: [number, number, number]; h?: [number, number, number] } = {};
  if (bestX) {
    const [sx, sy0] = l.toScene(bestX.at, Math.min(g.y0, bestX.other.y));
    const [, sy1] = l.toScene(bestX.at, Math.max(g.y1, bestX.other.y + bestX.other.h));
    lines.v = [sx, sy0 - 8, sy1 + 8];
  }
  if (bestY) {
    const [sx0, sy] = l.toScene(Math.min(g.x0, bestY.other.x), bestY.at);
    const [sx1] = l.toScene(Math.max(g.x1, bestY.other.x + bestY.other.w), bestY.at);
    lines.h = [sy, sx0 - 8, sx1 + 8];
  }
  setGuides(lines);
  return { dx: bestX ? dx + bestX.d : null, dy: bestY ? dy + bestY.d : null };
}

/** Paper size in px (96/in) from the document's page settings, for page-break guides. */
function pageContentHeight(): number | null {
  const page = state.doc.page;
  if (!page) return null;
  const toPx = (v: string | number | undefined, fallback: number) => {
    if (typeof v === "number") return v;
    const m = /^([\d.]+)(mm|cm|in|pt|px)?$/.exec(v ?? "");
    if (!m) return fallback;
    const n = parseFloat(m[1]);
    return { mm: (n * 96) / 25.4, cm: (n * 96) / 2.54, in: n * 96, pt: (n * 96) / 72, px: n }[m[2] ?? "px"] ?? fallback;
  };
  const heights: Record<string, number> = { A4: 297, A3: 420, A5: 210, Letter: 279.4, Legal: 355.6 };
  const paperH =
    typeof page.paper === "string" ? ((heights[page.paper] ?? 297) * 96) / 25.4 : toPx(page.paper?.[1], 1122.5);
  const h = paperH - toPx(page.margins?.top, 96) - toPx(page.margins?.bottom, 96);
  return h > 100 ? h : null;
}

export function Canvas() {
  const [marquee, setMarquee] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [panning, setPanning] = createSignal(false);
  let spaceDown = false;
  let sink!: HTMLTextAreaElement;

  // A hidden field at the insertion point receives typing, so dead keys (á, ã, ç),
  // IME composition, dictation and paste all start a region — not just plain keydowns.
  createEffect(() => {
    if (state.caret && !state.editing) sink.focus({ preventScroll: true });
  });

  function onSinkInput(e: InputEvent) {
    if (e.isComposing) return;
    takeSink();
  }

  function takeSink() {
    const text = sink.value;
    sink.value = "";
    if (!text) return;
    if (state.editing) {
      forwardTyping(text);
      return;
    }
    if (!state.caret) return;
    if (text.startsWith('"')) insertAtCaret("text", text.slice(1));
    else insertAtCaret("math", text);
  }

  /** Screen point → scene point (undo pan and zoom). */
  const toScene = (cx: number, cy: number): [number, number] => {
    const rect = viewportEl!.getBoundingClientRect();
    return [(cx - rect.left - state.view.x) / state.view.zoom, (cy - rect.top - state.view.y) / state.view.zoom];
  };

  const pageBreaks = createMemo(() => {
    if (layout().pageView) return [];
    const h = pageContentHeight();
    if (!h) return [];
    const count = Math.max(1, Math.ceil(contentBottom() / h));
    return Array.from({ length: count }, (_, i) => (i + 1) * h);
  });

  function startPan(e: PointerEvent) {
    const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
    setPanning(true);
    const move = (ev: PointerEvent) => setState("view", { x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y });
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.button === 1 || spaceDown) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    commitEditing();
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) dragging = true;
      if (dragging) setMarquee({ x0: start.x, y0: start.y, x1: ev.clientX, y1: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const box = marquee();
      setMarquee(null);
      if (!dragging || !box) {
        const [x, y] = layout().fromScene(...toScene(ev.clientX, ev.clientY));
        setState({ caret: [Math.max(0, snap(x)), Math.max(0, snap(y))], selection: [] });
        return;
      }
      const [l, r] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      const [t, b] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
      const hit: string[] = [];
      for (const el of viewportEl!.querySelectorAll<HTMLElement>("[data-region]")) {
        const rc = el.getBoundingClientRect();
        if (rc.width && rc.right > l && rc.left < r && rc.bottom > t && rc.top < b) hit.push(el.dataset.region!);
      }
      const ids = hit.filter((id) => layout().byId.get(id)?.region.kind !== "area");
      setState({ selection: e.shiftKey ? [...new Set([...state.selection, ...ids])] : ids, caret: null });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onRegionDown(id: string, e: PointerEvent) {
    if (e.button === 1 || spaceDown) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEditing();
    if (e.shiftKey) {
      const sel = state.selection.includes(id) ? state.selection.filter((s) => s !== id) : [...state.selection, id];
      setState({ selection: sel, caret: null });
      return;
    }
    const wasOnlySelection = state.selection.length === 1 && state.selection[0] === id;
    if (!state.selection.includes(id)) setState({ selection: [id], caret: null });
    const origins = originsOf(state.selection);
    const start = { x: e.clientX, y: e.clientY };
    // deltas are measured in document space, so dragging across a page gap works
    const anchor = layout().fromScene(...toScene(e.clientX, e.clientY));
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      if (!moved) {
        moved = true;
        checkpoint();
      }
      const [x, y] = layout().fromScene(...toScene(ev.clientX, ev.clientY));
      const raw = [x - anchor[0], y - anchor[1]];
      // edges and centres of other regions win over the grid; ⌘ disables snapping
      const s = ev.metaKey ? { dx: raw[0], dy: raw[1] } : smartSnap(new Set(origins.keys()), origins, raw[0], raw[1]);
      if (ev.metaKey) setGuides({});
      moveTo(origins, Math.round(s.dx ?? snap(raw[0])), Math.round(s.dy ?? snap(raw[1])));
    };
    const up = (ev: PointerEvent) => {
      setGuides({});
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // a second click on a selected box edits it, with the caret where it was clicked
      if (!moved && wasOnlySelection && ["text", "math"].includes(layout().byId.get(id)?.region.kind ?? "")) {
        startEditing(id, [ev.clientX, ev.clientY]);
      }
      if (moved) setState({ dirty: true, rev: state.rev + 1 });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else setState("view", { x: state.view.x - e.deltaX, y: state.view.y - e.deltaY });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (state.editing) return;
    const target = e.target as HTMLElement;
    if (target !== sink && target.closest?.("input, textarea, button, select")) return;
    const sel = state.selection;
    if (e.key === " " && !e.repeat) {
      spaceDown = true;
      setPanning(true);
      e.preventDefault();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && sel.length) {
      e.preventDefault();
      deleteRegions(sel);
      return;
    }
    if (e.key === "Enter" && sel.length === 1) {
      e.preventDefault();
      startEditing(sel[0]);
      return;
    }
    if (e.key === "Escape") {
      setState({ selection: [], caret: null });
      return;
    }
    // SMath: on empty space, Enter opens a line and Backspace/Delete close one
    if (state.caret && !sel.length && prefs.shiftContent && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const y = state.caret[1];
      if (e.key === "Enter") {
        e.preventDefault();
        shiftBelow(y, LINE * (e.shiftKey ? 5 : 1));
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        shiftBelow(y, -LINE * (e.shiftKey ? 5 : 1));
        return;
      }
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      if (e.key === "ArrowUp" && !sel.length && !e.shiftKey && returnToLeftBox()) return;
      const step = GRID * (e.shiftKey ? 5 : 1);
      const [dx, dy] = arrows[e.key];
      if (sel.length) nudge(sel, dx * step, dy * step);
      else if (state.caret) setState("caret", [Math.max(0, state.caret[0] + dx * step), Math.max(0, state.caret[1] + dy * step)]);
      return;
    }
    // Printable keys fall through to the hidden field (SMath behaviour: typing at the
    // insertion point creates a math region; " starts a text region).
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === " ") {
      spaceDown = false;
      setPanning(false);
    }
  }

  onMount(() => {
    viewportEl!.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  });

  const sheets = createMemo(() => {
    const l = layout();
    if (!l.pageView) return [];
    const byPage: Placed[][] = Array.from({ length: l.pages }, () => []);
    for (const p of l.list) if (!p.hidden) byPage[Math.min(p.page, l.pages - 1)].push(p);
    return byPage;
  });

  const caretScene = () => (state.caret ? layout().toScene(state.caret[0], state.caret[1]) : null);

  const gridStyle = () => {
    if (layout().pageView) return {};
    const z = state.view.zoom;
    const step = GRID * 2 * z;
    return {
      "background-size": z < 0.5 ? "0 0" : `${step}px ${step}px`,
      "background-position": `${state.view.x}px ${state.view.y}px`,
    };
  };

  return (
    <div
      ref={viewportEl}
      class="viewport"
      classList={{ panning: panning(), "page-view": layout().pageView }}
      style={gridStyle()}
      onPointerDown={onBackgroundDown}
      onScroll={(e) => {
        // focusing an editor can make the browser scroll this (overflow: hidden) box to
        // reveal it; turn that into a normal pan so the scene and the view stay in sync
        const el = e.currentTarget;
        if (!el.scrollLeft && !el.scrollTop) return;
        setState("view", { x: state.view.x - el.scrollLeft, y: state.view.y - el.scrollTop });
        el.scrollLeft = 0;
        el.scrollTop = 0;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const [x, y] = layout().fromScene(...toScene(e.clientX, e.clientY));
        setState({ caret: [Math.max(0, snap(x)), Math.max(0, snap(y))], selection: [] });
        openRegionMenu(e, null);
      }}
    >
      <div
        class="scene"
        style={sceneStyle()}
      >
        <For each={pageBreaks()}>
          {(y, i) => (
            <div class="page-break" style={{ top: `${y}px`, width: `${PAGE_WIDTH}px` }}>
              <span>page {i() + 2}</span>
            </div>
          )}
        </For>
        <Show
          when={layout().pageView}
          fallback={
            <For each={layout().list.map((p) => p.region)}>
              {(region) => <RegionBox region={region} onDragStart={onRegionDown} />}
            </For>
          }
        >
          <div class="pages" style={{ gap: `${SHEET_GAP}px` }}>
            {/* keyed by page number: a sheet stays mounted while its contents change */}
            <Index each={sheets()}>{(regions, k) => <Sheet k={k} regions={regions()} onDragStart={onRegionDown} />}</Index>
          </div>
        </Show>
        <Show when={guides().v}>
          {(v) => <div class="guide v" style={{ left: `${v()[0]}px`, top: `${v()[1]}px`, height: `${v()[2] - v()[1]}px` }} />}
        </Show>
        <Show when={guides().h}>
          {(h) => <div class="guide h" style={{ top: `${h()[0]}px`, left: `${h()[1]}px`, width: `${h()[2] - h()[1]}px` }} />}
        </Show>
        <Show when={caretScene()}>
          <div class="caret" style={{ left: `${caretScene()![0]}px`, top: `${caretScene()![1]}px` }} />
        </Show>
        <textarea
          ref={sink}
          class="key-sink"
          aria-label="Type to insert"
          autocomplete="off"
          spellcheck={false}
          style={{ left: `${caretScene()?.[0] ?? 0}px`, top: `${caretScene()?.[1] ?? 0}px` }}
          onInput={onSinkInput}
          onCompositionEnd={takeSink}
        />
      </div>
      <Show when={marquee()}>
        {(m) => {
          const rect = () => viewportEl!.getBoundingClientRect();
          return (
            <div
              class="marquee"
              style={{
                left: `${Math.min(m().x0, m().x1) - rect().left}px`,
                top: `${Math.min(m().y0, m().y1) - rect().top}px`,
                width: `${Math.abs(m().x1 - m().x0)}px`,
                height: `${Math.abs(m().y1 - m().y0)}px`,
              }}
            />
          );
        }}
      </Show>
    </div>
  );
}
