// Editor state: the document (as the JSON it is on disk), evaluation results,
// selection/editing, viewport, and undo history.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { pageGeom, type PageGeom, SHEET_GAP } from "./pages";
import type { Doc, Localized, Region, Report, RegionView } from "./types";

/** SMath's grid: imported coordinates are multiples of 9 px. */
export const GRID = 9;
export const AREA_COLLAPSED_HEIGHT = 18;
export const PAGE_WIDTH = 700;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface State {
  doc: Doc;
  path: string | null;
  /** The file images are read from while `path` is not set yet (a template). */
  origin: string | null;
  dirty: boolean;
  /** Bumped on every document change; drives re-evaluation. */
  rev: number;
  report: Report | null;
  views: Record<string, RegionView>;
  selection: string[];
  editing: string | null;
  /** Insertion point (SMath's red cross), in document px. */
  caret: [number, number] | null;
  view: Viewport;
  assets: Record<string, string>;
  message: string | null;
  /** Rendering for print/PDF: page view, no selection chrome, no added blank pages. */
  printing: boolean;
  /** Page view: pages shown even if the content does not reach them yet (+ New page). */
  pagesWanted: number;
  /** The region being edited was just created by typing (enables math ⇄ text switching). */
  editingFresh: boolean;
  inspector: boolean;
}

const emptyDoc = (): Doc => ({ format: "quire/1", meta: { title: "Untitled" }, regions: [] });

export const [state, setState] = createStore<State>({
  doc: emptyDoc(),
  path: null,
  origin: null,
  dirty: false,
  rev: 0,
  report: null,
  views: {},
  selection: [],
  editing: null,
  caret: [36, 36],
  view: { x: 48, y: 24, zoom: 1 },
  assets: {},
  message: null,
  printing: false,
  pagesWanted: 0,
  editingFresh: false,
  inspector: false,
});

/** A short notice at the bottom of the window that goes away by itself. */
export function flash(message: string) {
  setState({ message });
  setTimeout(() => state.message === message && setState({ message: null }), 4000);
}

/** Measured region heights (layout px), reported by the rendered regions. */
export const [heights, setHeights] = createStore<Record<string, number>>({});
/** Measured region widths, for alignment and smart guides. */
export const [widths, setWidths] = createStore<Record<string, number>>({});

export const isPageView = () => state.printing || state.doc.page?.view === "pages";

export const snap = (v: number) => Math.round(v / GRID) * GRID;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const undoStack: string[] = [];
const redoStack: string[] = [];
const snapshot = () => JSON.stringify(unwrap(state.doc));

/** Undo keeps up to 300 steps, fewer for a long document: at most ~40 MB of snapshots, never under 20 steps. */
const MAX_STEPS = 300;
const MIN_STEPS = 20;
const MAX_CHARS = 20_000_000;
let undoChars = 0;

function touch() {
  setState({ dirty: true, rev: state.rev + 1 });
}

/** Record the document as it was before a change. */
function record(before: string) {
  if (undoStack[undoStack.length - 1] === before) return; // an earlier step that changed nothing
  undoStack.push(before);
  undoChars += before.length;
  while (undoStack.length > MAX_STEPS || (undoChars > MAX_CHARS && undoStack.length > MIN_STEPS))
    undoChars -= undoStack.shift()!.length;
  redoStack.length = 0;
}

export function checkpoint() {
  record(snapshot());
}

/** For tests: how much undo history is kept. */
export const undoDepth = () => ({ steps: undoStack.length, chars: undoChars });

/** Apply a change to the document; with `history`, it can be undone. */
export function mutate(fn: (d: Doc) => void, history = true) {
  if (history) checkpoint();
  setState("doc", produce(fn));
  touch();
}

function restore(json: string) {
  // undo and redo leave the view as it is (see togglePageView)
  const view = state.doc.page?.view;
  setState("doc", reconcile(JSON.parse(json) as Doc, { key: "id" }));
  if (view) setState("doc", "page", (p) => ({ ...(p ?? {}), view }));
  // a table stays open across undo (its cells are plain data); text editors don't
  const editing = state.editing ? layout().byId.get(state.editing)?.region : undefined;
  if (editing?.kind !== "table") setState({ editing: null });
  touch();
}

export function undo() {
  const now = snapshot();
  let prev = undoStack.pop();
  // a step whose change turned out to be nothing would make Undo look broken: skip it
  while (prev === now) prev = undoStack.pop();
  if (prev === undefined) return;
  undoChars = undoStack.reduce((n, s) => n + s.length, 0);
  redoStack.push(now);
  restore(prev);
}

export function redo() {
  const next = redoStack.pop();
  if (next === undefined) return;
  const now = snapshot();
  undoStack.push(now);
  undoChars += now.length;
  restore(next);
}

/** `origin`: where images come from until the first save (a template's file). */
export function loadDoc(doc: Doc, path: string | null, origin: string | null = null) {
  importSettle = null;
  undoStack.length = 0;
  redoStack.length = 0;
  undoChars = 0;
  setState({
    doc,
    path,
    origin,
    dirty: false,
    rev: state.rev + 1,
    report: null,
    views: {},
    selection: [],
    editing: null,
    caret: doc.regions.length ? null : [36, 36],
    view: { x: 48, y: 24, zoom: state.view.zoom },
    assets: {},
    pagesWanted: 0,
  });
}

// ---------------------------------------------------------------------------
// Layout: absolute positions, collapsed areas, numbering
// ---------------------------------------------------------------------------

export interface Placed {
  region: Region;
  /** Absolute document position (areas' children are stored relative). */
  x: number;
  y: number;
  /** Vertical offset from collapsed areas above. */
  shift: number;
  hidden: boolean;
  parent: Region | null;
  /** "1.2" for headings, "3" for captioned figures/tables. */
  number?: string;
  /** Page index in page view (0 in canvas view). */
  page: number;
  /** Where to draw it: scene coordinates in canvas view, sheet-local in page view. */
  left: number;
  top: number;
}

export function localized(v: Localized | undefined, lang?: string): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  // the document's language, else English, else the first one written (SMath worksheets carry
  // several translations and no document language, often with Russian first); as in Rust
  const keys = Object.keys(v);
  const key = keys.find((k) => lang?.startsWith(k)) ?? keys.find((k) => k === "en") ?? keys[0];
  return key ? v[key] : "";
}

function headingLevel(text: string): number {
  // a Title ({.title}) is a heading that is neither numbered nor listed
  if (/^\{[^}\n]*\.title\b[^}\n]*\}\n/.test(text)) return 0;
  const m = /^(#{1,6})\s/.exec(text.replace(/^\{[^}\n]*\}\n/, ""));
  return m ? m[1].length : 0;
}

let revealHandler: (id: string) => void = () => {};
/** Scroll to a region and select it (the canvas installs the real handler). */
export function revealRegion(id: string) {
  revealHandler(id);
}
export function setRevealHandler(fn: (id: string) => void) {
  revealHandler = fn;
}

export interface Layout {
  list: Placed[];
  byId: Map<string, Placed>;
  pageView: boolean;
  geom: PageGeom;
  /** Pages shown: those the content fills, and blank ones added with + New page. */
  pages: number;
  /** Pages the content fills: what prints, and what {pages} counts. */
  contentPages: number;
  /** Document point → scene point (where it is drawn). */
  toScene(x: number, y: number): [number, number];
  /** Scene point → document point. */
  fromScene(x: number, y: number): [number, number];
}

const DEFAULT_HEIGHT = 22;

export function computeLayout(
  doc: Doc,
  measured: Record<string, number>,
  pageView: boolean,
  printing: boolean,
  wanted = 0,
): Layout {
  const list: Placed[] = [];
  const walk = (regions: Region[], ox: number, oy: number, parent: Region | null, hidden: boolean) => {
    for (const r of regions) {
      const x = ox + r.at[0];
      const y = oy + r.at[1];
      list.push({ region: r, x, y, shift: 0, hidden, parent, page: 0, left: x, top: y });
      if (r.regions) walk(r.regions, x, y, r, hidden || !!r.collapsed);
    }
  };
  walk(doc.regions, 0, 0, null, false);
  list.sort((a, b) => a.y - b.y || a.x - b.x);

  // Collapsed areas hide their band: everything below moves up.
  const collapsed = list.filter((p) => p.region.kind === "area" && p.region.collapsed && !p.hidden);
  for (const p of list) {
    for (const a of collapsed) {
      if (p !== a && p.y >= a.y + (a.region.height ?? 0)) p.shift += (a.region.height ?? 0) - AREA_COLLAPSED_HEIGHT;
    }
  }
  const shiftAt = (y: number) => {
    let s = 0;
    for (const a of collapsed) if (y >= a.y + (a.region.height ?? 0)) s += (a.region.height ?? 0) - AREA_COLLAPSED_HEIGHT;
    return s;
  };
  // inverse: a visible ("effective") y back to a document y
  const effToDoc = (eff: number) => {
    let y = eff;
    for (const a of collapsed) if (eff >= a.y - a.shift + AREA_COLLAPSED_HEIGHT) y = eff + a.shift + (a.region.height ?? 0) - AREA_COLLAPSED_HEIGHT;
    return y;
  };

  const geom = pageGeom(doc);
  const H = geom.contentH;
  const stride = geom.paperH + SHEET_GAP;
  // pushAt[k]: extra offset in effect on page k, from regions moved to a later page
  const pushAt: number[] = [0];
  let push = 0;
  let lastPage = 0;
  if (pageView) {
    for (const p of list) {
      if (p.hidden) continue;
      let y = p.y - p.shift + push;
      let k = Math.floor(y / H);
      while (pushAt.length <= k) pushAt.push(push);
      const h = p.region.kind === "area" ? AREA_COLLAPSED_HEIGHT : (measured[p.region.id] ?? DEFAULT_HEIGHT);
      const top = y - k * H;
      // keep regions whole: one that would cross the bottom margin starts the next page
      if (top > 0 && top + h > H && h <= H) {
        push += (k + 1) * H - y;
        y = (k + 1) * H;
        k += 1;
        pushAt[k] = push;
      }
      p.page = k;
      p.left = geom.margins.left + p.x;
      p.top = geom.margins.top + y - k * H;
      lastPage = Math.max(lastPage, k);
    }
  } else {
    for (const p of list) p.top = p.y - p.shift;
  }
  const contentPages = lastPage + 1;
  const pages = pageView && !printing ? Math.max(contentPages, wanted) : contentPages;
  while (pushAt.length < pages) pushAt.push(push);

  const pageOfEff = (eff: number) => {
    let k = 0;
    while (k + 1 < pages && eff + pushAt[k + 1] >= (k + 1) * H) k++;
    return k;
  };
  const toScene = (x: number, y: number): [number, number] => {
    const eff = y - shiftAt(y);
    if (!pageView) return [x, eff];
    const k = pageOfEff(eff);
    return [geom.margins.left + x, k * stride + geom.margins.top + eff + pushAt[k] - k * H];
  };
  const fromScene = (x: number, y: number): [number, number] => {
    if (!pageView) return [x, effToDoc(y)];
    const k = Math.min(pages - 1, Math.max(0, Math.floor(y / stride)));
    const eff = k * H + (y - k * stride - geom.margins.top) - pushAt[k];
    return [x - geom.margins.left, effToDoc(eff)];
  };

  const lang = doc.meta?.lang;
  const heading = [0, 0, 0, 0, 0, 0];
  let figures = 0;
  let tables = 0;
  for (const p of list) {
    const r = p.region;
    if (r.kind === "text") {
      const level = headingLevel(localized(r.text, lang));
      if (level) {
        heading[level - 1]++;
        heading.fill(0, level);
        p.number = heading.slice(0, level).join(".");
      }
    } else if (r.caption) {
      p.number = String(r.kind === "table" ? ++tables : ++figures);
    }
  }
  return { list, byId: new Map(list.map((p) => [p.region.id, p])), pageView, geom, pages, contentPages, toScene, fromScene };
}

export const layout = createRoot(() =>
  createMemo(() => computeLayout(state.doc, heights, isPageView(), state.printing, state.pagesWanted)),
);

/** How the document falls into pages, also while it is shown as a free canvas. */
export const pagedLayout = createRoot(() =>
  createMemo(() => (isPageView() ? layout() : computeLayout(state.doc, heights, true, false))),
);

export function contentBottom(): number {
  let bottom = 0;
  for (const p of layout().list) if (!p.hidden) bottom = Math.max(bottom, p.y - p.shift + (heights[p.region.id] ?? DEFAULT_HEIGHT));
  return bottom;
}

/** Width available to a region starting at x (text wraps here). */
export function availableWidth(x: number): number {
  const l = layout();
  return Math.max(120, (l.pageView ? l.geom.contentW : PAGE_WIDTH) - x);
}

/**
 * How wide a region's error note may be: up to the next region to its right whose rows it
 * shares, and within the printable width (`available`), so a long note wraps instead of
 * running into its neighbour.
 */
export function noteRoom(p: Placed, list: readonly Placed[], measured: Record<string, number>, available: number): number {
  const height = (q: Placed) => measured[q.region.id] ?? DEFAULT_HEIGHT;
  const bottom = p.top + height(p);
  let room = available;
  for (const q of list) {
    if (q === p || q.hidden || q.page !== p.page || q.left <= p.left) continue;
    if (q.top < bottom && q.top + height(q) > p.top) room = Math.min(room, q.left - p.left - 12);
  }
  return Math.max(120, room);
}

// ---------------------------------------------------------------------------
// Imported SMath worksheets: settle the positions once
// ---------------------------------------------------------------------------

/** Changed positions and heights, by region id. */
export type Settling = Map<string, { at?: [number, number]; height?: number }>;

/**
 * SMath's pixel positions, made to fit Quire's taller maths: a region that overlaps one below
 * it pushes that one (and everything below it at its level) down to the next grid line below its
 * bottom, top to bottom so the pushes cascade. An area's height grows to hold its children, and
 * what is below the area moves down by the growth. Works on a copy; the input is not changed.
 *
 * `pushers`: the regions that may push (default: every measured region). Areas are always
 * re-fitted to their children, so running this again only changes what is new.
 */
export function settleRegions(
  regions: Region[],
  heights: Record<string, number>,
  widths: Record<string, number>,
  pushers?: Set<string>,
): Settling {
  const work = structuredClone(regions);
  const extent = (r: Region): number | undefined => (r.kind === "area" ? r.height : heights[r.id]);
  const width = (r: Region) => widths[r.id] ?? 40;

  /** The height an area needs to hold its children, with the grid padding SMath leaves below them. */
  const needed = (list: Region[]): number | undefined => {
    let bottom: number | undefined;
    for (const c of list) {
      const h = extent(c);
      if (h !== undefined) bottom = Math.max(bottom ?? 0, c.at[1] + h);
    }
    return bottom === undefined ? undefined : Math.ceil(bottom / GRID) * GRID + GRID;
  };

  const settleList = (list: Region[]) => {
    const order = [...list].sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      if (r.kind === "area") {
        // a collapsed area's children are not drawn, so they cannot be measured: it stays as it is
        if (r.collapsed || r.height === undefined) continue;
        settleList(r.regions ?? []);
        const want = needed(r.regions ?? []);
        if (want !== undefined && want > r.height + 0.5) {
          const grow = want - r.height;
          const bottom = r.at[1] + r.height;
          // everything below the area at its own level moves down by the growth
          for (const q of list) if (q !== r && q.at[1] >= bottom - 0.5) q.at[1] += grow;
          r.height = want;
        }
      }
      if (pushers && !pushers.has(r.id)) continue;
      const h = extent(r);
      if (h === undefined) continue;
      const bottom = r.at[1] + h;
      const target = Math.ceil(bottom / GRID) * GRID + GRID;
      const x0 = r.at[0];
      const x1 = x0 + width(r);
      for (let j = i + 1; j < order.length; j++) {
        const q = order[j];
        if (q.at[1] >= bottom + GRID) break;
        if (extent(q) === undefined || !(q.at[0] < x1 && q.at[0] + width(q) > x0)) continue;
        const dy = target - q.at[1];
        if (dy <= 0) continue;
        // q and everything after it (all at or below its top) keep their spacing
        for (const x of order.slice(j)) x.at[1] += dy;
      }
    }
  };
  settleList(work);

  const original = new Map<string, Region>();
  const collect = (list: Region[]) => {
    for (const r of list) {
      original.set(r.id, r);
      if (r.regions) collect(r.regions);
    }
  };
  collect(regions);
  const changes: Settling = new Map();
  const compare = (list: Region[]) => {
    for (const r of list) {
      const old = original.get(r.id);
      if (old) {
        const moved = old.at[0] !== r.at[0] || old.at[1] !== r.at[1];
        const grew = r.kind === "area" && r.height !== old.height;
        if (moved || grew) {
          const change: { at?: [number, number]; height?: number } = {};
          if (moved) change.at = [r.at[0], r.at[1]];
          if (grew) change.height = r.height;
          changes.set(r.id, change);
        }
      }
      if (r.regions) compare(r.regions);
    }
  };
  compare(work);
  return changes;
}

/** Ids of a region and everything inside it. */
function subtreeIds(r: Region, out: Set<string>): Set<string> {
  out.add(r.id);
  for (const c of r.regions ?? []) subtreeIds(c, out);
  return out;
}

function findRegion(regions: Region[], id: string): Region | undefined {
  for (const r of regions) {
    if (r.id === id) return r;
    const inner = r.regions ? findRegion(r.regions, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** State of an imported SMath document whose positions are still to be settled. */
interface ImportSettle {
  /** Collapsed areas: their children are settled the first time they are expanded. */
  collapsed: Set<string>;
  /** The first pass (everything drawn at open) has run. */
  openDone: boolean;
  /** When the layout last changed: a pass waits until it has been quiet for a moment. */
  lastChange: number;
}

const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_WAIT_MS = 3000;
let importSettle: ImportSettle | null = null;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let fontsReady = typeof document === "undefined" || !document.fonts;
const [settleTick, setSettleTick] = createSignal(0);
if (!fontsReady) {
  void document.fonts.ready.then(() => {
    fontsReady = true;
    setSettleTick((t) => t + 1);
  });
}

/** Call once an imported SMath document is in place (after `loadDoc`). */
export function settleImportedOnOpen() {
  importSettle = { collapsed: new Set(), openDone: false, lastChange: Date.now() };
  setSettleTick((t) => t + 1);
}

/** One undo step; the document stays unedited, as it was when opened. */
function applySettling(changes: Settling) {
  if (!changes.size) return;
  const wasDirty = state.dirty;
  mutate((d) => {
    for (const [id, c] of changes) {
      const r = findDraft(d, id);
      if (!r) continue;
      if (c.at) r.at = c.at;
      if (c.height !== undefined) r.height = c.height;
    }
  });
  if (!wasDirty) setState({ dirty: false });
}

function runImportSettle() {
  const s = importSettle;
  if (!s || !fontsReady) return;
  const unmeasured = layout().list.some((p) => !p.hidden && heights[p.region.id] === undefined);
  if (unmeasured && Date.now() - s.lastChange < SETTLE_MAX_WAIT_MS) {
    settleTimer = setTimeout(runImportSettle, 200);
    return;
  }
  const regions = unwrap(state.doc).regions;
  if (!s.openDone) {
    // the user started editing before the first pass: leave the worksheet as the user has it
    if (state.dirty) {
      importSettle = null;
      return;
    }
    const collect = (list: Region[]) => {
      for (const r of list) {
        if (r.kind === "area" && r.collapsed) s.collapsed.add(r.id);
        if (r.regions) collect(r.regions);
      }
    };
    collect(regions);
    applySettling(settleRegions(regions, heights, widths));
    s.openDone = true;
    return;
  }
  // areas expanded for the first time: the area and what is inside it settle now
  const pushers = new Set<string>();
  for (const id of [...s.collapsed]) {
    const area = findRegion(regions, id);
    if (!area) s.collapsed.delete(id);
    else if (!area.collapsed) {
      s.collapsed.delete(id);
      subtreeIds(area, pushers);
    }
  }
  if (pushers.size) applySettling(settleRegions(regions, heights, widths, pushers));
}

// Runs after each layout change (measured heights, edits, expanding an area), once fonts are ready.
createRoot(() =>
  createEffect(() => {
    layout();
    void state.rev;
    void settleTick();
    if (!importSettle) return;
    importSettle.lastChange = Date.now();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(runImportSettle, SETTLE_QUIET_MS);
  }),
);

/**
 * Pages or canvas. The choice is kept in the document, but it is a way of looking at it
 * rather than an edit: no undo step, and the document doesn't become "Edited".
 */
export function togglePageView() {
  setState("doc", "page", (p) => ({ ...(p ?? {}), view: p?.view === "pages" ? "canvas" : "pages" }));
}

// ---------------------------------------------------------------------------
// Region operations
// ---------------------------------------------------------------------------

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newId(): string {
  const taken = layout().byId;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

/** The array holding a region, inside a draft document. */
function locate(regions: Region[], id: string): { list: Region[]; index: number } | null {
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].id === id) return { list: regions, index: i };
    const inner = regions[i].regions;
    if (inner) {
      const found = locate(inner, id);
      if (found) return found;
    }
  }
  return null;
}

export function findDraft(d: Doc, id: string): Region | undefined {
  const loc = locate(d.regions, id);
  return loc ? loc.list[loc.index] : undefined;
}

export function addRegion(region: Region) {
  mutate((d) => {
    d.regions.push(region);
  }, false);
}

export function deleteRegions(ids: string[]) {
  if (!ids.length) return;
  mutate((d) => {
    for (const id of ids) {
      const loc = locate(d.regions, id);
      if (loc) loc.list.splice(loc.index, 1);
    }
  });
  setState({ selection: [] });
}

/** Selected regions whose area is not also selected (moving the area moves them). */
function movable(ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = layout().byId.get(id)?.parent;
    while (parent) {
      if (set.has(parent.id)) return false;
      parent = layout().byId.get(parent.id)?.parent ?? null;
    }
    return true;
  });
}

/** Move regions from their recorded origins by a grid-snapped delta (used while dragging). */
export function moveTo(origins: Map<string, [number, number]>, dx: number, dy: number) {
  setState(
    "doc",
    produce((d) => {
      for (const [id, [ox, oy]] of origins) {
        const r = findDraft(d, id);
        if (r) r.at = [Math.max(0, ox + dx), Math.max(0, oy + dy)];
      }
    }),
  );
}

export function originsOf(ids: string[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const id of movable(ids)) {
    const p = layout().byId.get(id);
    if (p) out.set(id, [p.region.at[0], p.region.at[1]]);
  }
  return out;
}

export function nudge(ids: string[], dx: number, dy: number) {
  const origins = originsOf(ids);
  if (!origins.size) return;
  checkpoint();
  moveTo(origins, dx, dy);
  touch();
}

/** One blank line, as inserted or removed by Enter / Backspace on empty space. */
export const LINE = 2 * GRID;

/**
 * SMath-style spacing: move every top-level region starting at or below `y` by `dy`.
 * Pulling up never overlaps what is above: it stops a grid step short of it.
 */
export function shiftBelow(y: number, dy: number): boolean {
  const top = layout().list.filter((p) => !p.parent);
  const below = top.filter((p) => p.region.at[1] >= y);
  if (!below.length) return false;
  if (dy < 0) {
    const highest = Math.min(...below.map((p) => p.region.at[1]));
    let floor = 0;
    for (const p of top) if (p.region.at[1] < y) floor = Math.max(floor, p.region.at[1] + (heights[p.region.id] ?? DEFAULT_HEIGHT) + GRID);
    const room = Math.floor((highest - floor) / GRID) * GRID;
    dy = Math.max(dy, -room);
    if (dy >= 0) return false;
  }
  checkpoint();
  moveTo(new Map(below.map((p) => [p.region.id, [p.region.at[0], p.region.at[1]] as [number, number]])), 0, dy);
  touch();
  return true;
}

export function toggleArea(id: string) {
  mutate((d) => {
    const r = findDraft(d, id);
    if (r) r.collapsed = !r.collapsed || undefined;
  });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

let editSnapshot: string | null = null;

/** Where the click that started editing landed, so the caret can go there. */
export let editClickPoint: [number, number] | null = null;

export function startEditing(id: string, at?: [number, number]) {
  editClickPoint = at ?? null;
  const p = layout().byId.get(id);
  const table = p?.region.kind === "table" && Array.isArray(p.region.rows);
  if (!p || !(["math", "text"].includes(p.region.kind) || table)) return;
  if (state.editing && state.editing !== id) commitEditing();
  if (state.editing === id) return;
  // a table records each change to its cells as its own undo step
  editSnapshot = table ? null : snapshot();
  setState({ editing: id, selection: [id], caret: null, editingFresh: false });
}

/**
 * Split SMath-style `=` ("show the result") from the typed text, with the unit to show it
 * in when one follows (`M = kN*m`).
 */
/** What a line asks to show: `= value` (in a unit, `= kN`) or `→` symbolically (`->` too). */
export function splitShow(text: string): { expr: string; show: false | "value" | "symbolic"; unit?: string } {
  const t = text.trimEnd();
  const arrow = /\s*(→|->)$/.exec(t);
  if (arrow) return { expr: t.slice(0, arrow.index).trimEnd(), show: "symbolic" };
  if (t.endsWith("=") && !/(==|:=|<=|>=|!=|≠=)$/.test(t)) return { expr: t.slice(0, -1).trimEnd(), show: "value" };
  const m = /^(.*[^=<>!:≠\s])\s*=\s*([\p{L}\p{N}_*/^()·.'°%\s-]*\p{L}[\p{L}\p{N}_*/^()·.'°%\s-]*)$/u.exec(t);
  if (m && !/=/.test(m[2])) return { expr: m[1].trimEnd(), show: "value", unit: m[2].trim() };
  return { expr: text, show: false };
}

export function editText(r: Region): string {
  if (r.kind === "math") {
    if (r.show === "symbolic") return `${r.expr ?? ""} →`;
    return (r.expr ?? "") + (r.show ? ` =${r.display?.unit ? ` ${r.display.unit}` : ""}` : "");
  }
  return localized(r.text, state.doc.meta?.lang);
}

// ---------------------------------------------------------------------------
// Errors wait while you type: `D`, `D:=` and `D/` are unfinished, not wrong. The line
// being edited shows its error once you pause or press Enter; lines that break only
// because of the edit keep their last result until the edit ends.
// ---------------------------------------------------------------------------

const PAUSE_MS = 1500;
let latest: Report | null = null;
let typing = false;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;

/** Show an engine report, holding back the errors the edit in progress would cause. */
export function showReport(report: Report) {
  latest = report;
  const editing = state.editing;
  let hidden = 0;
  const views = report.regions.map((v): RegionView => {
    if (!editing || !v.error) return v;
    if (v.id === editing) {
      if (!typing) return v;
      hidden++;
      return { ...v, error: null, syntaxError: false };
    }
    const before = state.views[v.id];
    if (!before || before.error) return v;
    hidden++;
    return structuredClone(unwrap(before));
  });
  setState("report", { ...report, errorCount: Math.max(0, report.errorCount - hidden) });
  setState("views", reconcile(Object.fromEntries(views.map((v) => [v.id, v]))));
}

/** The edit ended or paused: show what was held back. */
export function releaseErrors() {
  clearTimeout(pauseTimer);
  typing = false;
  if (latest) showReport(latest);
}

function typed() {
  typing = true;
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(releaseErrors, PAUSE_MS);
}

/** Write `to` in place of the name `from` in a math region (an error's fix). */
export function renameIn(id: string, from: string, to: string) {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_.'])${name}(?![\\p{L}\\p{N}_.])`, "gu");
  mutate((d) => {
    const r = findDraft(d, id);
    if (r?.kind === "math" && r.expr) r.expr = r.expr.replace(re, to);
  });
}

/** Live update while typing (not an undo step on its own). */
export function setLive(id: string, text: string) {
  typed();
  mutate((d) => {
    const r = findDraft(d, id);
    if (!r) return;
    if (r.kind === "math") {
      let { expr, show, unit } = splitShow(text);
      typedUnit = { id, unit };
      // `c` on the way to `cm`: keep the result as it was rather than flash "unknown unit";
      // what was typed is applied when the edit ends
      const choices = state.views[id]?.unitChoices ?? [];
      if (unit && !choices.some((c) => c.unit === unit) && choices.some((c) => c.unit.startsWith(unit!)))
        unit = r.display?.unit;
      r.expr = expr;
      if (show) r.show = show;
      else delete r.show;
      if (unit) r.display = { ...r.display, unit };
      else if (r.display?.unit) {
        delete r.display.unit;
        if (!Object.keys(r.display).length) delete r.display;
      }
    } else if (r.kind === "text") {
      if (typeof r.text === "object" && r.text !== null) {
        const lang = state.doc.meta?.lang;
        const key = Object.keys(r.text).find((k) => lang?.startsWith(k)) ?? Object.keys(r.text)[0];
        if (key) r.text[key] = text;
      } else {
        r.text = text;
      }
    }
  }, false);
}

/** The unit typed after `=` in the math being edited, which may not be shown yet. */
let typedUnit: { id: string; unit: string | undefined } | null = null;

export function commitEditing() {
  const id = state.editing;
  if (!id) return;
  if (typedUnit?.id === id) {
    const unit = typedUnit.unit;
    typedUnit = null;
    const r = layout().byId.get(id)?.region;
    if (r?.kind === "math" && r.show && (r.display?.unit ?? undefined) !== unit)
      mutate((d) => {
        const draft = findDraft(d, id);
        if (!draft) return;
        draft.display = { ...draft.display, unit };
        if (!unit) delete draft.display.unit;
        if (!Object.keys(draft.display).length) delete draft.display;
      }, false);
  }
  const r = layout().byId.get(id)?.region;
  const empty =
    !r || (r.kind === "math" ? !(r.expr ?? "").trim() : r.kind === "text" ? !editText(r).trim() : false);
  if (r && empty) {
    setState(
      "doc",
      produce((d) => {
        const loc = locate(d.regions, id);
        if (loc) loc.list.splice(loc.index, 1);
      }),
    );
    touch();
    setState({ selection: [] });
  }
  if (editSnapshot !== null && editSnapshot !== snapshot()) record(editSnapshot);
  editSnapshot = null;
  if (r && !empty) justCommitted = { id, until: Date.now() + 3000 };
  setState({ editing: null });
}

/** The region whose edit just ended: its new rendering may be taller than the editor was. */
let justCommitted: { id: string; until: number } | null = null;

/**
 * A region just committed grew (a fraction, a matrix, an error line under it) into what
 * sits below it: move everything below down, SMath-style, and the insertion point with it.
 * Only the region just edited does this, so opening a document never shuffles it.
 */
export function regionGrew(id: string, before: number, after: number) {
  if (!before || after <= before + 0.5 || justCommitted?.id !== id || Date.now() > justCommitted.until) return;
  const p = layout().byId.get(id);
  if (!p || p.parent) return;
  const [x0, y] = p.region.at;
  const x1 = x0 + (widths[id] ?? 40);
  const oldBottom = y + before;
  const newBottom = y + after;
  const top = layout().list.filter((q) => !q.parent && q.region.id !== id && q.region.at[1] >= oldBottom - 0.5);
  const overlaps = (q: Placed) => q.region.at[0] < x1 && q.region.at[0] + (widths[q.region.id] ?? 40) > x0;
  const hit = top.filter((q) => q.region.at[1] < newBottom + GRID && overlaps(q));
  const caret = state.caret;
  const caretHit = caret && caret[1] >= oldBottom - 0.5 && caret[1] < newBottom + GRID && caret[0] < x1 && caret[0] >= x0 - GRID;
  if (!hit.length && !caretHit) return;
  const highest = Math.min(...hit.map((q) => q.region.at[1]), caretHit ? caret[1] : Infinity);
  const dy = Math.ceil(newBottom / GRID) * GRID + GRID - highest;
  if (dy <= 0) return;
  if (top.length) {
    moveTo(new Map(top.map((q) => [q.region.id, [q.region.at[0], q.region.at[1]] as [number, number]])), 0, dy);
    touch();
  }
  if (caret && caret[1] >= oldBottom - 0.5) {
    const moved: [number, number] = [caret[0], caret[1] + dy];
    if (leftBox && leftBox.caret[0] === caret[0] && leftBox.caret[1] === caret[1]) leftBox.caret = moved;
    setState({ caret: moved });
  }
}

/** The box just left with Enter, and the insertion point placed under it: ↑ goes back. */
let leftBox: { id: string; caret: [number, number] } | null = null;

/** Finish editing and put the insertion point under the box, ready for the next line. */
export function commitBelow(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-region="${CSS.escape(id)}"]`);
  const p = layout().byId.get(id);
  commitEditing();
  if (!p || !el || !layout().byId.has(id)) return;
  const h = el.getBoundingClientRect().height / state.view.zoom;
  const caret: [number, number] = [p.x, Math.ceil((p.y + h) / GRID) * GRID + GRID];
  leftBox = { id, caret };
  setState({ caret, selection: [] });
}

/** ↑ right after leaving a box: edit it again, caret at the end. */
export function returnToLeftBox(): boolean {
  const back = leftBox;
  leftBox = null;
  if (!back || !state.caret || state.caret[0] !== back.caret[0] || state.caret[1] !== back.caret[1]) return false;
  if (!layout().byId.has(back.id)) return false;
  startEditing(back.id);
  return true;
}

/** Create a region at the caret and start editing it. */
export function insertAtCaret(kind: "math" | "text", initial = "") {
  commitEditing();
  editClickPoint = null; // a new region starts with the caret after what was typed
  const [x, y] = state.caret ?? [36, snap(contentBottom() + GRID)];
  const id = newId();
  editSnapshot = snapshot();
  let region: Region;
  if (kind === "math") {
    const { expr, show } = splitShow(initial);
    region = { id, kind: "math", at: [x, y], expr, ...(show ? { show } : {}) };
  } else {
    region = { id, kind: "text", at: [x, y], text: initial };
  }
  addRegion(region);
  setState({ editing: id, selection: [id], caret: null, editingFresh: true });
}

/** Switch the region being edited between math and text, keeping what was typed. */
export function convertEditing(kind: "math" | "text", text: string) {
  const id = state.editing;
  if (!id) return;
  editClickPoint = null; // the caret stays after the converted text
  setState(
    "doc",
    produce((d) => {
      const r = findDraft(d, id);
      if (!r) return;
      r.kind = kind;
      delete r.show;
      if (kind === "text") {
        delete r.expr;
        r.text = text;
      } else {
        delete r.text;
        const { expr, show } = splitShow(text);
        r.expr = expr;
        if (show) r.show = show;
      }
    }),
  );
  touch();
}

// The app's commands (App.tsx), for code that cannot import it: `\` commands.
let appCommand: (id: string) => void = () => {};
export const runAppCommand = (id: string) => appCommand(id);
export function setAppCommand(run: (id: string) => void) {
  appCommand = run;
}

/** Right-click ▸ Convert to Text / Convert to Math, for a region not being edited. */
export function convertRegion(id: string, kind: "math" | "text") {
  const r = layout().byId.get(id)?.region;
  if (!r || r.kind === kind) return;
  const text = kind === "text" ? editText(r) : localized(r.text, state.doc.meta?.lang).replace(/\\(.)/g, "$1");
  updateRegion(id, (d) => {
    d.kind = kind;
    delete d.show;
    if (kind === "text") {
      delete d.expr;
      delete d.display;
      d.text = text;
    } else {
      delete d.text;
      const { expr, show } = splitShow(text.trim());
      d.expr = expr;
      if (show) d.show = show;
    }
  });
}

/** Names defined anywhere in the document (variables and functions), from the last evaluation. */
export function definedNames(): Set<string> {
  const names = new Set<string>();
  for (const v of state.report?.regions ?? []) if (v.defines) names.add(v.defines.replace(/\(.*$/, ""));
  return names;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

function boxes(ids: string[]) {
  return movable(ids)
    .map((id) => layout().byId.get(id))
    .filter((p): p is Placed => !!p)
    .map((p) => ({ id: p.region.id, x: p.x, y: p.y, w: widths[p.region.id] ?? 40, h: heights[p.region.id] ?? 20 }));
}

export function alignRegions(ids: string[], mode: AlignMode) {
  const b = boxes(ids);
  if (b.length < 2) return;
  const left = Math.min(...b.map((r) => r.x));
  const right = Math.max(...b.map((r) => r.x + r.w));
  const top = Math.min(...b.map((r) => r.y));
  const bottom = Math.max(...b.map((r) => r.y + r.h));
  mutate((d) => {
    for (const r of b) {
      const reg = findDraft(d, r.id);
      if (!reg) continue;
      const dx = { left: left - r.x, right: right - r.w - r.x, hcenter: (left + right) / 2 - r.w / 2 - r.x }[mode as string] ?? 0;
      const dy = { top: top - r.y, bottom: bottom - r.h - r.y, vcenter: (top + bottom) / 2 - r.h / 2 - r.y }[mode as string] ?? 0;
      reg.at = [Math.max(0, Math.round(reg.at[0] + dx)), Math.max(0, Math.round(reg.at[1] + dy))];
    }
  });
}

/** Equal gaps between the selected regions, along one axis. */
export function distributeRegions(ids: string[], axis: "x" | "y") {
  const b = boxes(ids).sort((p, q) => p[axis] - q[axis]);
  if (b.length < 3) return;
  const size = (r: (typeof b)[number]) => (axis === "x" ? r.w : r.h);
  const span = b[b.length - 1][axis] + size(b[b.length - 1]) - b[0][axis];
  const gap = (span - b.reduce((s, r) => s + size(r), 0)) / (b.length - 1);
  mutate((d) => {
    let pos = b[0][axis];
    for (const r of b) {
      const reg = findDraft(d, r.id);
      if (reg) {
        const delta = Math.round(pos - r[axis]);
        reg.at = axis === "x" ? [reg.at[0] + delta, reg.at[1]] : [reg.at[0], reg.at[1] + delta];
      }
      pos += size(r) + gap;
    }
  });
}

// ---------------------------------------------------------------------------
// Inserting structure
// ---------------------------------------------------------------------------

export type ContentsKind = "headings" | "figures" | "tables" | "checks";

export function insertContents(of: ContentsKind) {
  commitEditing();
  const [x, y] = state.caret ?? [0, snap(contentBottom() + GRID)];
  const title = { headings: "Contents", figures: "List of Figures", tables: "List of Tables", checks: "Summary of Checks" }[of];
  mutate((d) => {
    d.regions.push({ id: newId(), kind: "toc", at: [x, y], of, title });
  });
}

export function insertRegion(region: Omit<Region, "id">) {
  commitEditing();
  const id = newId();
  mutate((d) => {
    d.regions.push({ ...region, id } as Region);
  });
  setState({ selection: [id], caret: null });
  return id;
}

export function updateRegion(id: string, patch: Partial<Region> | ((r: Region) => void)) {
  mutate((d) => {
    const r = findDraft(d, id);
    if (!r) return;
    if (typeof patch === "function") patch(r);
    else
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === "") delete (r as Record<string, unknown>)[k];
        else (r as Record<string, unknown>)[k] = v;
      }
  });
}

export function updateDoc(fn: (d: Doc) => void) {
  mutate(fn);
}

export function insertArea() {
  commitEditing();
  const y = state.caret?.[1] ?? snap(contentBottom() + GRID);
  mutate((d) => {
    d.regions.push({ id: newId(), kind: "area", at: [0, y], height: 90, title: "Area", regions: [] });
  });
}

export function selectAll() {
  setState({ selection: layout().list.filter((p) => !p.hidden && !p.parent).map((p) => p.region.id) });
}
