// Editor state: the document (as the JSON it is on disk), evaluation results,
// selection/editing, viewport, and undo history.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { pageGeom, type PageGeom, SHEET_GAP } from "./pages";
import type { Doc, Localized, Region, Report, RegionView } from "./types";

/** SMath's grid: imported coordinates are multiples of 9 px. */
export const GRID = 9;
export const AREA_COLLAPSED_HEIGHT = 18;

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
  /** The header or footer being edited on the page (HeaderFooterBand.tsx), and on which page. */
  hfEditing: { band: "header" | "footer"; page: number } | null;
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
  hfEditing: null,
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
  edited = true;
  setState({ dirty: true, rev: state.rev + 1 });
}

/** The document as it was at `rev` is on disk: it is clean unless it changed while being written. */
export function markSaved(rev: number) {
  if (state.rev === rev) setState({ dirty: false });
}

/**
 * Steps that shifted the whole document back to the origin (`normalizeOrigin`), by the
 * snapshot before the step (`undone`: after it, for redo), with the shift. Undo and redo pan
 * the canvas by the same amount, so what the step didn't move stays put on screen.
 */
const shifted = new Map<string, [number, number]>();
const undone = new Map<string, [number, number]>();
/** The shift made while a region is being typed; it joins the edit's step when that is recorded. */
let editShift: [number, number] | null = null;

const addShift = (map: Map<string, [number, number]>, key: string, [dx, dy]: [number, number]) => {
  const [x, y] = map.get(key) ?? [0, 0];
  map.set(key, [x + dx, y + dy]);
};

/** Pan the canvas so a document shifted by (dx, dy) shows where it was. */
function panBy(dx: number, dy: number) {
  if (isPageView()) return;
  const z = state.view.zoom;
  setState("view", { x: state.view.x - dx * z, y: state.view.y - dy * z });
}

/** Record the document as it was before a change. */
function record(before: string) {
  if (undoStack[undoStack.length - 1] === before) return; // an earlier step that changed nothing
  undoStack.push(before);
  undoChars += before.length;
  while (undoStack.length > MAX_STEPS || (undoChars > MAX_CHARS && undoStack.length > MIN_STEPS)) {
    const gone = undoStack.shift()!;
    undoChars -= gone.length;
    shifted.delete(gone);
  }
  redoStack.length = 0;
  undone.clear();
}

export function checkpoint() {
  record(snapshot());
}

/**
 * Gather many small changes into one undo step (a header typed on the page): make them with
 * `mutate(fn, false)`, then call what this returns.
 */
export function undoSession(): () => void {
  const before = snapshot();
  const loaded = loads;
  return () => {
    // another document opened meanwhile: the step belongs to the one that was closed
    if (loaded === loads && before !== snapshot()) record(before);
  };
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
  const shift = shifted.get(prev);
  if (shift) {
    shifted.delete(prev);
    undone.set(now, shift);
    panBy(-shift[0], -shift[1]);
  }
}

export function redo() {
  const next = redoStack.pop();
  if (next === undefined) return;
  const now = snapshot();
  undoStack.push(now);
  undoChars += now.length;
  restore(next);
  const shift = undone.get(next);
  if (shift) {
    undone.delete(next);
    shifted.set(now, shift);
    panBy(shift[0], shift[1]);
  }
}

/** `origin`: where images come from until the first save (a template's file). */
/** Documents loaded so far: an undo session ends quietly in a document other than its own. */
let loads = 0;

export function loadDoc(doc: Doc, path: string | null, origin: string | null = null) {
  importSettle = null;
  loads++;
  edited = false;
  settled.clear();
  // nothing held back from the last document may show in this one
  forgetReport();
  undoStack.length = 0;
  redoStack.length = 0;
  undoChars = 0;
  shifted.clear();
  undone.clear();
  editShift = null;
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
    hfEditing: null,
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
  /**
   * Page view: how far left of its document position it is drawn, so that something placed
   * past the printable column on the canvas still sits on the paper (`pullOnPaper`). The
   * document keeps its position; 0 when it is drawn where it is.
   */
  pulled: number;
}

/**
 * The translation that is shown, and so the one an edit changes: the document's language, else
 * English, else the first one written (SMath worksheets carry several translations and no
 * document language, often with Russian first); as in Rust.
 */
export function langKey(v: Record<string, string>, lang?: string): string | undefined {
  const keys = Object.keys(v);
  return keys.find((k) => lang?.startsWith(k)) ?? keys.find((k) => k === "en") ?? keys[0];
}

export function localized(v: Localized | undefined, lang?: string): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  const key = langKey(v, lang);
  return key ? v[key] : "";
}

/** `v` with the shown translation replaced by `text`; the other translations are kept. */
export function withLocalized(v: Localized | undefined, text: string, lang?: string): Localized {
  if (typeof v !== "object" || v === null) return text;
  const key = langKey(v, lang);
  return key ? { ...v, [key]: text } : text;
}

function headingLevel(text: string): number {
  // a Title ({.title}) is a heading that is neither numbered nor listed
  if (/^\{[^}\n]*\.title\b[^}\n]*\}\n/.test(text)) return 0;
  const m = /^(#{1,6})\s/.exec(text.replace(/^\{[^}\n]*\}\n/, ""));
  return m ? m[1].length : 0;
}

/**
 * What `{section}` shows on page `k` (0-based): the last first-level heading on that page or
 * before it, as plain words.
 */
export function sectionOn(l: Layout, k: number, lang?: string): string {
  let found = "";
  for (const p of l.list) {
    if (p.page > k || p.hidden || p.region.kind !== "text") continue;
    const text = localized(p.region.text, lang);
    if (headingLevel(text) !== 1) continue;
    found = text
      .replace(/^\{[^}\n]*\}\n/, "")
      .replace(/^#\s+/, "")
      .split("\n")[0]
      .replace(/\{[^}]*\}/g, "")
      .trim();
  }
  return found;
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
  /** Pages shown without blank ones added with + New page (a final page break shows one more). */
  needed: number;
  /** Document point → scene point (where it is drawn). */
  toScene(x: number, y: number): [number, number];
  /** Scene point → document point. */
  fromScene(x: number, y: number): [number, number];
  /**
   * Page view: where each page's content area starts, as a visible ("effective") y of the
   * document, the canvas's own vertical coordinate: page k shows what is at or below
   * `pageStarts[k]` (and above `pageStarts[k + 1]`). Empty in canvas view.
   */
  pageStarts: number[];
}

const DEFAULT_HEIGHT = 22;
/** The narrowest a region may be left with at the right edge of the content area (as `availableWidth`). */
const MIN_ROOM = 120;
/** A page break's marker: one line, the same in every view so pagination doesn't depend on it. */
export const PAGE_BREAK_HEIGHT = 2 * GRID;

/** The height a region takes in pagination: a collapsed area's header for an area. */
function regionHeight(r: Region, measured: Record<string, number>): number {
  if (r.kind === "area") return AREA_COLLAPSED_HEIGHT;
  if (r.kind === "pagebreak") return PAGE_BREAK_HEIGHT;
  return measured[r.id] ?? DEFAULT_HEIGHT;
}

/** A text region that is a heading (`#`…) or a Title. */
function isHeading(r: Region, lang?: string): boolean {
  return r.kind === "text" && /^#{1,6}\s/.test(localized(r.text, lang).replace(/^\{[^}\n]*\}\n/, ""));
}

/**
 * Page view: where to draw a region `w` px wide that starts `x` px into a column `contentW`
 * wide, with `margin` px of paper to its right. What would run off the paper, or starts where
 * page view itself would not place anything (`maxContentX`), is drawn with its right edge on
 * the column's (its left edge at the latest), as a drag in page view stops it. Everything else
 * stays where it is, margin overhang included, so documents that fit on paper print as before.
 */
export function pullOnPaper(x: number, w: number, contentW: number, margin: number): number {
  if (x + w <= contentW + margin && x <= contentW - MIN_ROOM) return x;
  return Math.max(0, Math.min(x, contentW - w));
}

export function computeLayout(
  doc: Doc,
  measured: Record<string, number>,
  pageView: boolean,
  printing: boolean,
  wanted = 0,
  measuredWidths: Record<string, number> = {},
): Layout {
  const list: Placed[] = [];
  const walk = (regions: Region[], ox: number, oy: number, parent: Region | null, hidden: boolean) => {
    for (const r of regions) {
      const x = ox + r.at[0];
      const y = oy + r.at[1];
      list.push({ region: r, x, y, shift: 0, hidden, parent, page: 0, left: x, top: y, pulled: 0 });
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
    for (const a of collapsed)
      if (y >= a.y + (a.region.height ?? 0)) s += (a.region.height ?? 0) - AREA_COLLAPSED_HEIGHT;
    return s;
  };
  // inverse: a visible ("effective") y back to a document y
  const effToDoc = (eff: number) => {
    let y = eff;
    for (const a of collapsed)
      if (eff >= a.y - a.shift + AREA_COLLAPSED_HEIGHT)
        y = eff + a.shift + (a.region.height ?? 0) - AREA_COLLAPSED_HEIGHT;
    return y;
  };

  const geom = pageGeom(doc);
  const H = geom.contentH;
  const stride = geom.paperH + SHEET_GAP;
  // pushAt[k]: extra offset in effect on page k, from regions moved to a later page
  const pushAt: number[] = [0];
  let push = 0;
  let lastPage = 0;
  // the page a manual page break sends what follows it to
  let breakTo = 0;
  if (pageView) {
    const lang = doc.meta?.lang;
    // the region placed just before, in reading order: a heading there may move with this one
    let prev: { p: Placed; y: number } | null = null;
    for (const p of list) {
      if (p.hidden) continue;
      const base = p.y - p.shift;
      let y = base + push;
      let k = Math.floor(y / H);
      while (pushAt.length <= k) pushAt.push(push);
      const h = regionHeight(p.region, measured);
      // after a page break, everything starts on the next page
      if (k < breakTo) {
        push += breakTo * H - y;
        y = breakTo * H;
        k = breakTo;
        while (pushAt.length <= k) pushAt.push(push);
        pushAt[k] = push;
      }
      const top = y - k * H;
      const brk = p.region.kind === "pagebreak";
      // keep regions whole: one that would cross the bottom margin starts the next page (not a
      // page break's mark, which doesn't print: moved on its own, it would leave a blank page)
      if (top > 0 && top + h > H && h <= H && !brk) {
        push += (k + 1) * H - y;
        y = (k + 1) * H;
        k += 1;
        pushAt[k] = push;
      }
      // keep a heading with what follows: when this region starts the page after a heading,
      // the heading moves to the top of this page too, with this region at its distance below it
      if (!brk && prev && prev.p.page === k - 1 && prev.y > (k - 1) * H && isHeading(prev.p.region, lang)) {
        const gap = base - (prev.p.y - prev.p.shift);
        if (gap >= 0 && gap + h <= H) {
          push = k * H - (prev.p.y - prev.p.shift);
          pushAt[k] = push;
          prev.p.page = k;
          prev.p.top = geom.margins.top;
          y = base + push;
        }
      }
      p.page = k;
      // an area spans the column
      const w = p.region.kind === "area" ? geom.contentW : (measuredWidths[p.region.id] ?? 0);
      const drawn = pullOnPaper(p.x, w, geom.contentW, geom.margins.right);
      p.pulled = p.x - drawn;
      p.left = geom.margins.left + drawn;
      p.top = geom.margins.top + y - k * H;
      lastPage = Math.max(lastPage, k);
      prev = { p, y };
      if (brk) {
        // what follows starts at the top of the next page, keeping its distance from the break
        breakTo = k + 1;
        push = Math.max(push, breakTo * H - (base + h));
        while (pushAt.length <= breakTo) pushAt.push(push);
        pushAt[breakTo] = push;
      }
    }
  } else {
    for (const p of list) p.top = p.y - p.shift;
  }
  const contentPages = lastPage + 1;
  // a page break at the end shows the page it starts, ready to type on, but doesn't print it
  const needed = pageView && !printing ? Math.max(contentPages, breakTo + 1) : contentPages;
  const pages = Math.max(needed, pageView && !printing ? wanted : 0);
  while (pushAt.length < pages) pushAt.push(push);
  const pageStarts = pageView ? pushAt.slice(0, pages).map((pk, k) => k * H - pk) : [];

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
  return {
    list,
    byId: new Map(list.map((p) => [p.region.id, p])),
    pageView,
    geom,
    pages,
    contentPages,
    needed,
    toScene,
    fromScene,
    pageStarts,
  };
}

export const layout = createRoot(() =>
  createMemo(() => computeLayout(state.doc, heights, isPageView(), state.printing, state.pagesWanted, widths)),
);

/** How the document falls into pages, also while it is shown as a free canvas. */
export const pagedLayout = createRoot(() =>
  createMemo(() => (isPageView() ? layout() : computeLayout(state.doc, heights, true, false, 0, widths))),
);

export function contentBottom(): number {
  let bottom = 0;
  for (const p of layout().list)
    if (!p.hidden) bottom = Math.max(bottom, p.y - p.shift + (heights[p.region.id] ?? DEFAULT_HEIGHT));
  return bottom;
}

/** In page view, the furthest right a region can start and still sit on the paper; canvas view is free. */
export function maxContentX(): number {
  const l = layout();
  return l.pageView ? Math.max(0, l.geom.contentW - MIN_ROOM) : Infinity;
}

/**
 * A scene point as a document point to place something at. In page view the point is pulled to
 * the nearest spot inside the content area (not the margins, not the grey between sheets), so
 * nothing is created off the paper; canvas view places it where it is.
 */
export function placeAt(sx: number, sy: number): [number, number] {
  const l = layout();
  if (l.pageView) {
    const { margins, paperH, contentW, contentH } = l.geom;
    const stride = paperH + SHEET_GAP;
    const k = Math.min(l.pages - 1, Math.max(0, Math.floor(sy / stride)));
    const top = k * stride + margins.top;
    const bottom = top + contentH - GRID;
    // the grey gap under a sheet is nearer the next one's top margin than this one's bottom
    const next = sy - (k * stride + paperH) > SHEET_GAP / 2 && k + 1 < l.pages ? k + 1 : k;
    const [lo, hi] = next === k ? [top, bottom] : [top + stride, bottom + stride];
    sy = Math.min(hi, Math.max(lo, sy));
    sx = Math.min(margins.left + Math.max(0, contentW - MIN_ROOM), Math.max(margins.left, sx));
  }
  const [x, y] = l.fromScene(sx, sy);
  // the free canvas goes on above and left of the start: the document shifts once something
  // is put there (`normalizeOrigin`)
  return l.pageView ? [Math.max(0, snap(x)), Math.max(0, snap(y))] : [snap(x), snap(y)];
}

/**
 * Width available to a region starting at x (text wraps here). In page view, up to the
 * printable column's right edge; on the free canvas there is no edge, so text wraps at the
 * column's width measured from wherever the box starts, and a box keeps its shape as it moves.
 */
export function availableWidth(x: number): number {
  const l = layout();
  if (!l.pageView) return l.geom.contentW;
  // past where the page view places anything, it is drawn pulled onto the paper (`pullOnPaper`)
  // at the width it has on the canvas, not squeezed into the little room left
  return x > l.geom.contentW - MIN_ROOM ? l.geom.contentW : l.geom.contentW - x;
}

/**
 * How wide a region's error note may be: up to the next region to its right whose rows it
 * shares, and within the printable width (`available`), so a long note wraps instead of
 * running into its neighbour.
 */
export function noteRoom(
  p: Placed,
  list: readonly Placed[],
  measured: Record<string, number>,
  available: number,
): number {
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

/** The insertion point, as `pushBelow` moves it: a point that follows what is above it. */
const CARET_ID = "\0caret";

/**
 * Regions that grew after an edit (a fraction, a result, an error or a matrix appearing) push
 * what is directly below them in their column down, to a grid step under their new bottom. A
 * region that moves takes what is below it in its column along, so the spacing that follows is
 * kept. Only ever down, and only as far as needed: what already has room doesn't move, and a
 * region beside the one that grew (not overlapping it horizontally) stays. An expanded area
 * grows to hold its children when they need more room, and pushes what is below it in turn.
 *
 * `grown`: the regions that grew, with the height they had before. `caret`, in document
 * coordinates, moves like a region of no height; its new place is under `CARET_ID`.
 * Works on a copy; the input is not changed.
 */
export function pushBelow(
  regions: Region[],
  heights: Record<string, number>,
  widths: Record<string, number>,
  grown: Map<string, number>,
  caret?: [number, number] | null,
): Settling {
  const work = structuredClone(regions);
  const point: Region | null = caret ? { id: CARET_ID, kind: "math", at: [caret[0], caret[1]] } : null;
  if (point) work.push(point);
  const width = (r: Region) => (r === point ? 1 : (widths[r.id] ?? 40));
  const extent = (r: Region): number | undefined =>
    r === point ? undefined : r.kind === "area" ? r.height : heights[r.id];
  /** Heights before the growth, for areas grown by their children here too. */
  const before = new Map(grown);

  const settleList = (list: Region[]): boolean => {
    let changed = false;
    // what is inside expanded areas first: an area that must grow then pushes at this level
    for (const r of list) {
      if (r.kind !== "area" || r.collapsed || r.height === undefined || !r.regions) continue;
      if (!settleList(r.regions)) continue;
      changed = true;
      let bottom = 0;
      for (const c of r.regions) bottom = Math.max(bottom, c.at[1] + (extent(c) ?? 0));
      const want = Math.ceil(bottom / GRID) * GRID + GRID;
      if (want > r.height + 0.5) {
        before.set(r.id, r.height);
        r.height = want;
      }
    }
    const order = [...list].sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
    const top = new Map(order.map((r) => [r, r.at[1]]));
    const moved = new Map<Region, number>();
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      const y = top.get(r)!;
      let dy = 0;
      for (let j = 0; j < i; j++) {
        const p = order[j];
        const h = extent(p);
        if (h === undefined) continue;
        const old = before.get(p.id) ?? h;
        // only what starts below p (not beside it) and shares its column
        const py = top.get(p)!;
        if (y < py + old - 0.5 || !(r.at[0] < p.at[0] + width(p) && r.at[0] + width(r) > p.at[0])) continue;
        const pdy = moved.get(p) ?? 0;
        dy = Math.max(dy, pdy);
        if (h > old + 0.5) dy = Math.max(dy, Math.ceil((py + pdy + h) / GRID) * GRID + GRID - y);
      }
      if (dy > 0.5) {
        moved.set(r, dy);
        r.at = [r.at[0], y + dy];
        changed = true;
      }
    }
    return changed;
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
  if (point && caret && point.at[1] !== caret[1]) changes.set(CARET_ID, { at: point.at });
  const compare = (list: Region[]) => {
    for (const r of list) {
      const old = original.get(r.id);
      if (old) {
        const change: { at?: [number, number]; height?: number } = {};
        if (old.at[1] !== r.at[1]) change.at = [r.at[0], r.at[1]];
        if (r.kind === "area" && r.height !== old.height) change.height = r.height;
        if (change.at || change.height !== undefined) changes.set(r.id, change);
      }
      if (r.regions) compare(r.regions);
    }
  };
  compare(work.filter((r) => r !== point));
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
  if (!wasDirty) {
    setState({ dirty: false });
    edited = false;
  }
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
      if (!loc) continue;
      const [gone] = loc.list.splice(loc.index, 1);
      // an area takes its band with it: what is below it at its level moves up by its height,
      // so it stays where it was seen (below a collapsed area it would otherwise drop far down)
      if (gone.kind === "area" && gone.height) {
        const bottom = gone.at[1] + gone.height;
        for (const r of loc.list) if (r.at[1] >= bottom) r.at = [r.at[0], r.at[1] - gone.height];
      }
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
      // page view keeps everything on the paper. The free canvas goes on above and left of
      // the start (the document shifts back on drop, `normalizeOrigin`); a region in an area
      // stays within its left edge, and one moved above its top leaves it (`regroup`)
      const free = !isPageView();
      for (const [id, [ox, oy]] of origins) {
        const loc = locate(d.regions, id);
        if (!loc) continue;
        const top = loc.list === d.regions;
        loc.list[loc.index].at = [free && top ? ox + dx : Math.max(0, ox + dx), free ? oy + dy : Math.max(0, oy + dy)];
      }
    }),
  );
}

/**
 * Where moving regions starts from. A region drawn pulled onto the paper in page view starts
 * from where it is seen, so it follows the pointer from there (and only then takes that place).
 */
export function originsOf(ids: string[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const id of movable(ids)) {
    const p = layout().byId.get(id);
    if (p) out.set(id, [p.region.at[0] - p.pulled, p.region.at[1]]);
  }
  return out;
}

export function nudge(ids: string[], dx: number, dy: number) {
  const origins = originsOf(ids);
  if (!origins.size) return;
  checkpoint();
  moveTo(origins, dx, dy);
  regroup(ids);
  touch();
}

/**
 * After a move or an insertion, each region belongs where it now sits, as in SMath: inside the open area
 * whose band holds its top (the innermost one), otherwise at the top level. Without this a
 * region dragged out of an area still belonged to it, and collapsing or deleting the area took
 * it along. Collapsed areas take nothing in: their content is out of sight.
 */
export function regroup(ids: string[]) {
  regroupInto(ids);
  normalizeOrigin();
}

function regroupInto(ids: string[]) {
  const l = layout();
  const moving = movable(ids);
  const inMoved = (p: Placed): boolean => {
    for (let q: Region | null = p.region; q; q = l.byId.get(q.id)?.parent ?? null)
      if (moving.includes(q.id)) return true;
    return false;
  };
  const areas = l.list.filter(
    (p) => p.region.kind === "area" && !p.hidden && !p.region.collapsed && p.region.height && !inMoved(p),
  );
  const moves: { id: string; to: string | null; at: [number, number] }[] = [];
  for (const id of moving) {
    const p = l.byId.get(id);
    if (!p) continue;
    const holder = areas
      .filter((a) => a.y <= p.y && p.y < a.y + a.region.height!)
      .sort((a, b) => a.region.height! - b.region.height!)[0];
    const to = holder?.region.id ?? null;
    if (to === (p.parent?.id ?? null)) continue;
    moves.push({ id, to, at: holder ? [p.x - holder.x, p.y - holder.y] : [p.x, p.y] });
  }
  if (!moves.length) return;
  setState(
    "doc",
    produce((d) => {
      for (const m of moves) {
        const loc = locate(d.regions, m.id);
        if (!loc) continue;
        const [r] = loc.list.splice(loc.index, 1);
        r.at = m.at;
        const area = m.to ? findDraft(d, m.to) : undefined;
        if (area) (area.regions ??= []).push(r);
        else d.regions.push(r);
      }
    }),
  );
}

/**
 * How far to shift a document so nothing in it is above or left of the origin: how far the
 * topmost and leftmost regions are past it, rounded up to the grid so what is on the grid
 * stays on it. [0, 0] when everything is at or after the origin.
 */
export function originShift(regions: readonly Region[]): [number, number] {
  if (!regions.length) return [0, 0];
  const minX = Math.min(...regions.map((r) => r.at[0]));
  const minY = Math.min(...regions.map((r) => r.at[1]));
  const up = (v: number) => (v < 0 ? Math.ceil(-v / GRID - 1e-9) * GRID : 0);
  return [up(minX), up(minY)];
}

/**
 * Something was moved or put above or left of the start of the free canvas: shift the whole
 * document back so nothing is (coordinates on disk stay >= 0), the insertion point with it,
 * and pan the view by the same amount so nothing moves on screen. Part of the change that
 * caused it, so one undo step. True when it shifted.
 */
export function normalizeOrigin(): boolean {
  const [dx, dy] = originShift(state.doc.regions);
  if (!dx && !dy) return false;
  setState(
    "doc",
    produce((d) => {
      for (const r of d.regions) r.at = [r.at[0] + dx, r.at[1] + dy];
    }),
  );
  if (state.caret) setState("caret", [state.caret[0] + dx, state.caret[1] + dy]);
  // canvas scene coordinates are document coordinates (collapsed areas move along)
  panBy(dx, dy);
  // the step this belongs to: the region being typed (recorded when the edit ends), else the
  // move or insertion that has just recorded its checkpoint
  if (editSnapshot !== null) editShift = [(editShift?.[0] ?? 0) + dx, (editShift?.[1] ?? 0) + dy];
  else if (undoStack.length) addShift(shifted, undoStack[undoStack.length - 1], [dx, dy]);
  touch();
  return true;
}

/** One blank line, as inserted or removed by Enter / Backspace on empty space. */
export const LINE = 2 * GRID;

/**
 * SMath-style spacing: move every top-level region starting at or below `y` by `dy`.
 * Pulling up never overlaps what is above: it stops a grid step short of it.
 * Returns how far they moved (0: nothing moved).
 */
export function shiftBelow(y: number, dy: number): number {
  const top = layout().list.filter((p) => !p.parent);
  const below = top.filter((p) => p.region.at[1] >= y);
  if (!below.length) return 0;
  if (dy < 0) {
    const highest = Math.min(...below.map((p) => p.region.at[1]));
    let floor = 0;
    for (const p of top)
      if (p.region.at[1] < y) floor = Math.max(floor, p.region.at[1] + (heights[p.region.id] ?? DEFAULT_HEIGHT) + GRID);
    const room = Math.floor((highest - floor) / GRID) * GRID;
    dy = Math.max(dy, -room);
    if (dy >= 0) return 0;
  }
  checkpoint();
  moveTo(new Map(below.map((p) => [p.region.id, [p.region.at[0], p.region.at[1]] as [number, number]])), 0, dy);
  touch();
  return dy;
}

/** The page a document point is on, in the page view. */
export function pageAt(l: Layout, y: number): number {
  return Math.min(l.pages - 1, Math.max(0, Math.floor(l.toScene(0, y)[1] / (l.geom.paperH + SHEET_GAP))));
}

/**
 * How many pages to show (`pagesWanted`) once the insertion point is at `y` (null: none):
 * blank pages added with + New page last only while the insertion point is on one, so a page
 * left without anything on it goes. The blank page with the insertion point, and those before
 * it, stay.
 */
export function keptPages(l: Layout, y: number | null): number {
  if (!l.pageView || l.pages <= l.needed || y === null) return 0;
  const k = pageAt(l, y);
  return k >= l.needed ? k + 1 : 0;
}

/**
 * Backspace on the blank last page (added with + New page, with nothing on it): remove it,
 * with the insertion point after the content of the page before (or at its top). Never a page
 * that holds a region; the document doesn't change, as blank pages aren't saved.
 */
export function removeBlankPage(y: number): boolean {
  const l = layout();
  if (!l.pageView) return false;
  const k = pageAt(l, y);
  if (k < 1 || k !== l.pages - 1 || k < l.needed) return false;
  const before = l.list.filter((p) => !p.hidden && p.page === k - 1);
  let caret: [number, number];
  if (before.length) {
    const bottom = (p: Placed) => p.y + regionHeight(p.region, heights);
    const last = before.reduce((a, b) => (bottom(b) > bottom(a) ? b : a));
    caret = [last.x, Math.ceil(bottom(last) / GRID) * GRID + GRID];
  } else {
    const [x, top] = l.fromScene(l.geom.margins.left, (k - 1) * (l.geom.paperH + SHEET_GAP) + l.geom.margins.top);
    caret = [Math.max(0, snap(x)), Math.max(0, snap(top))];
  }
  setState({ pagesWanted: k, caret, selection: [] });
  return true;
}

/**
 * Whether a document point is at the top of a page after the first, in the page view: on
 * that page, at or above the first region on it. What starts the page may be there only
 * because it was pushed there, so Backspace pulls it back (`pullToPreviousPage`).
 */
export function atPageTop(y: number): boolean {
  const l = layout();
  if (!l.pageView) return false;
  const k = pageAt(l, y);
  if (k < 1) return false;
  const on = l.list.filter((p) => !p.hidden && p.page === k);
  return on.length > 0 && y <= Math.min(...on.map((p) => p.y));
}

/**
 * Backspace at the top of a page, as in a word processor: close the whole gap above what
 * starts at `y`, so it flows back onto the previous page as far as there is room. The
 * regions move in the document (one undo step), never over what is above, and the insertion
 * point goes to where they now start.
 */
export function pullToPreviousPage(y: number): boolean {
  const below = layout().list.filter((p) => !p.parent && p.region.at[1] >= y);
  if (!below.length) return false;
  const highest = Math.min(...below.map((p) => p.region.at[1]));
  const dy = shiftBelow(y, -Infinity);
  if (!dy) return false;
  if (state.caret) setState("caret", [state.caret[0], Math.max(0, Math.min(y, highest + dy))]);
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
  if (!p || !(["math", "text", "solve"].includes(p.region.kind) || table)) return;
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
  // the first report of a document just opened: say once what this version couldn't read
  if (!state.report && report.warnings?.length) {
    const n = report.warnings.length;
    flash(
      n === 1
        ? report.warnings[0]
        : `${n} parts of this document aren't understood by this version of Quire; they are kept as they are`,
    );
  }
  latest = report;
  const editing = state.editing;
  let hidden = 0;
  const block = !!editing && layout().byId.get(editing)?.region.kind === "solve";
  const views = report.regions.map((v): RegionView => {
    if (!editing || !v.error) return v;
    // a solve block's lines are reported as `<id>:c0` and so on
    if (v.id === editing || (block && v.id.startsWith(`${editing}:`))) {
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

function forgetReport() {
  clearTimeout(pauseTimer);
  latest = null;
  typing = false;
}

/** The edit ended or paused: show what was held back. */
export function releaseErrors() {
  clearTimeout(pauseTimer);
  typing = false;
  if (latest) showReport(latest);
}

/** Typing in progress (an editor that writes the document itself, as a solve block's lines do). */
export function noteTyping() {
  typed();
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
      r.text = withLocalized(r.text, text, state.doc.meta?.lang);
    }
  }, false);
}

/** The unit typed after `=` in the math being edited, which may not be shown yet. */
let typedUnit: { id: string; unit: string | undefined } | null = null;

/** Editors that hold typing outside the document until it is committed (a table cell). */
const drafts = new Set<() => void>();

/** `write` puts such typing into the document; it runs whenever an edit ends through `commitEditing`. */
export function onCommitEditing(write: () => void) {
  drafts.add(write);
}

export function commitEditing() {
  const id = state.editing;
  if (!id) return;
  // Save, export or a click elsewhere end the edit: what is half typed goes in, not away
  for (const write of drafts) write();
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
  const empty = !r || (r.kind === "math" ? !(r.expr ?? "").trim() : r.kind === "text" ? !editText(r).trim() : false);
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
  if (editSnapshot !== null && editSnapshot !== snapshot()) {
    record(editSnapshot);
    if (editShift) addShift(shifted, editSnapshot, editShift);
  }
  editSnapshot = null;
  editShift = null;
  setState({ editing: null });
  // its rendering may now be taller than the editor was
  scheduleGrowth();
}

// ---------------------------------------------------------------------------
// Growth: a region that becomes taller after an edit pushes what is below it down
// ---------------------------------------------------------------------------

/** Each region's height when growth was last settled (layout px). */
const settled = new Map<string, number>();
/**
 * Whether the document changed since it was opened. Until then a region that grows (fonts or
 * the first results arriving) only records its height, so opening a document never moves it.
 */
let edited = false;
let growthQueued = false;

/** A region's measured height changed, or an edit ended: settle growth once the measuring is done. */
export function scheduleGrowth() {
  if (growthQueued) return;
  growthQueued = true;
  queueMicrotask(settleGrowth);
}

/**
 * Push down what is below the regions that grew since the last time (`pushBelow`), and the
 * insertion point with it, as part of the edit's undo step. The region being typed in doesn't
 * push: its editor isn't its height, and lines must not jump while typing. It pushes once the
 * edit ends. Pushing only moves regions, which changes no height, so this settles in one pass.
 */
function settleGrowth() {
  growthQueued = false;
  const editing = state.editing;
  const now: Record<string, number> = { ...unwrap(heights) };
  const grown = new Map<string, number>();
  for (const p of layout().list) {
    const id = p.region.id;
    if (p.hidden) continue;
    // what is on screen now: right after an edit ends, before the next measurement reports it.
    // A region drawn but not measured yet counts too: on a slow machine its first measurement
    // can come after its result has made it taller, and that would then be taken for its
    // starting height, so the growth would never push the line placed under it.
    const el = document.querySelector<HTMLElement>(`[data-region="${CSS.escape(id)}"]`);
    if (el?.offsetHeight) now[id] = el.offsetHeight;
    if (now[id] === undefined) continue;
    const was = settled.get(id);
    if (id === editing) {
      if (was === undefined) settled.set(id, now[id]);
      else now[id] = was;
    } else if (was === undefined || now[id] < was) settled.set(id, now[id]);
    else if (now[id] > was + 0.5) grown.set(id, was);
  }
  if (!grown.size) return;
  for (const id of grown.keys()) settled.set(id, now[id]);
  if (!edited) return;
  const changes = pushBelow(unwrap(state.doc).regions, now, widths, grown, state.caret);
  const caret = changes.get(CARET_ID)?.at;
  changes.delete(CARET_ID);
  // no checkpoint: the push belongs to the edit that made the region grow
  if (changes.size)
    mutate((d) => {
      for (const [id, c] of changes) {
        const r = findDraft(d, id);
        if (!r) continue;
        if (c.at) r.at = c.at;
        if (c.height !== undefined) r.height = c.height;
      }
    }, false);
  if (caret && state.caret) {
    const old = state.caret;
    if (leftBox && leftBox.caret[0] === old[0] && leftBox.caret[1] === old[1]) leftBox.caret = caret;
    setState({ caret });
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
  // the rendering that replaced the editor, error line included: not a fixed line height
  const h = el.offsetHeight;
  // on the paper in page view, as placeAt keeps a click; the page breaks below by itself
  const caret: [number, number] = [Math.min(p.x, maxContentX()), Math.ceil((p.y + h) / GRID) * GRID + GRID];
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
  regroup([id]);
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
  // a solve block defines `x, y`
  for (const v of state.report?.regions ?? [])
    for (const name of v.defines?.split(", ") ?? []) names.add(name.replace(/\(.*$/, ""));
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
    .map((p) => ({
      id: p.region.id,
      x: p.x - p.pulled,
      pulled: p.pulled,
      y: p.y,
      w: widths[p.region.id] ?? 40,
      h: heights[p.region.id] ?? 20,
    }));
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
      const dx =
        { left: left - r.x, right: right - r.w - r.x, hcenter: (left + right) / 2 - r.w / 2 - r.x }[mode as string] ??
        0;
      const dy =
        { top: top - r.y, bottom: bottom - r.h - r.y, vcenter: (top + bottom) / 2 - r.h / 2 - r.y }[mode as string] ??
        0;
      reg.at = [Math.max(0, Math.round(reg.at[0] - r.pulled + dx)), Math.max(0, Math.round(reg.at[1] + dy))];
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
        reg.at = axis === "x" ? [reg.at[0] - r.pulled + delta, reg.at[1]] : [reg.at[0], reg.at[1] + delta];
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
  const title = {
    headings: "Contents",
    figures: "List of Figures",
    tables: "List of Tables",
    checks: "Summary of Checks",
  }[of];
  const id = newId();
  mutate((d) => {
    d.regions.push({ id, kind: "toc", at: [x, y], of, title });
  });
  regroup([id]);
}

export function insertRegion(region: Omit<Region, "id">) {
  commitEditing();
  const id = newId();
  mutate((d) => {
    d.regions.push({ ...region, id } as Region);
  });
  regroup([id]);
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

/** The document's title, as typed in the Inspector: a title in several languages keeps the others. */
export function setDocTitle(text: string) {
  mutate((d) => {
    const meta = (d.meta ??= {});
    const title = withLocalized(meta.title, text, meta.lang);
    if (title === "") delete meta.title;
    else meta.title = title;
  });
}

export function insertArea() {
  commitEditing();
  const y = state.caret?.[1] ?? snap(contentBottom() + GRID);
  const id = newId();
  mutate((d) => {
    d.regions.push({ id, kind: "area", at: [0, y], height: 90, title: "Area", regions: [] });
  });
  regroup([id]);
}

/**
 * A manual page break at the insertion point (else below the selection, else at the end):
 * what follows starts on the next page. What is right under it moves down to make room for
 * the marker, and the insertion point goes below the marker, at the top of the new page.
 */
export function insertPageBreak() {
  commitEditing();
  const l = layout();
  const sel = state.selection.map((id) => l.byId.get(id)).filter((p): p is Placed => !!p);
  const y = state.caret
    ? state.caret[1]
    : sel.length
      ? snap(Math.max(...sel.map((p) => p.y + (heights[p.region.id] ?? DEFAULT_HEIGHT))) + GRID)
      : snap(contentBottom() + GRID);
  const id = newId();
  const top = l.list.filter((p) => !p.parent && p.region.at[1] >= y);
  const highest = top.length ? Math.min(...top.map((p) => p.region.at[1])) : Infinity;
  const room = Math.max(0, Math.ceil((y + PAGE_BREAK_HEIGHT - highest) / GRID) * GRID);
  mutate((d) => {
    if (room)
      for (const p of top) {
        const r = findDraft(d, p.region.id);
        if (r) r.at = [r.at[0], r.at[1] + room];
      }
    d.regions.push({ id, kind: "pagebreak", at: [0, y] });
  });
  setState({ selection: [], caret: [state.caret?.[0] ?? 0, y + PAGE_BREAK_HEIGHT] });
  normalizeOrigin();
}

export function selectAll() {
  setState({
    selection: layout()
      .list.filter((p) => !p.hidden && !p.parent)
      .map((p) => p.region.id),
    caret: null,
  });
}
