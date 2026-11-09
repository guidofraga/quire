// Notebooks: a folder of sections and notes, shown in the sidebar. Notes save themselves
// as you work (there is no Save in a notebook); the folder layout is in
// crates/quire-service/src/notebook.rs.
import { batch, createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { announce } from "./a11y";
import { api, DOC_EXT } from "./api";
import { commitEditing, flash, loadDoc, markSaved, revealRegion, setState, state } from "./store";
import type { Doc } from "./types";

export interface NbNode {
  kind: "section" | "note";
  name: string;
  /** Path from the notebook's folder, `/`-separated: `Mechanics/Kinematics.quire`. */
  rel: string;
  modified?: number;
  color?: string;
  icon?: string;
  children?: NbNode[];
}

export interface Notebook {
  name: string;
  path: string;
  children: NbNode[];
}

export interface Hit {
  rel: string;
  title: string;
  section: string;
  snippet: string;
  mark: [number, number] | null;
  titleMatch: boolean;
  region: string | null;
}

interface NbState {
  book: Notebook | null;
  /** The note being edited, when it belongs to the notebook. */
  current: string | null;
  /** Sections shown open, by path. */
  expanded: Record<string, boolean>;
  /** The item whose name is being edited in the sidebar. */
  renaming: string | null;
  /** The items picked in the sidebar (⌘/Ctrl-click, Shift-click), to move or delete together. */
  selected: string[];
  /** Where a Shift-click range starts. */
  anchor: string | null;
  query: string;
  hits: Hit[] | null;
}

export const [nb, setNb] = createStore<NbState>({
  book: null,
  current: null,
  expanded: {},
  renaming: null,
  selected: [],
  anchor: null,
  query: "",
  hits: null,
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
export const titleOf = (rel: string) => baseOf(rel).replace(/\.quirez?$/i, "");
const sep = () => (nb.book?.path.includes("\\") && !nb.book.path.includes("/") ? "\\" : "/");
export const absPath = (rel: string) => `${nb.book!.path.replace(/[\\/]+$/, "")}${sep()}${rel.split("/").join(sep())}`;

/** A path on disk as a note of the open notebook, if it is one. */
export function relOf(path: string | null): string | null {
  const root = nb.book?.path.replace(/[\\/]+$/, "");
  if (!root || !path || !/\.quirez?$/i.test(path)) return null;
  const norm = (p: string) => p.replace(/\\/g, "/");
  const r = norm(root) + "/";
  return norm(path).startsWith(r) ? norm(path).slice(r.length) : null;
}

/** Every node, depth first, in sidebar order. */
export function walk(nodes: NbNode[] = nb.book?.children ?? []): NbNode[] {
  return nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);
}

export const notes = () => walk().filter((n) => n.kind === "note");
export const find = (rel: string) => walk().find((n) => n.rel === rel);

/** `rel` is `of` or lies inside it. */
export const within = (rel: string, of: string) => rel === of || rel.startsWith(`${of}/`);

/** The items of section `dir` (`""` is the notebook itself). */
export const childrenOf = (dir: string): NbNode[] => (dir ? (find(dir)?.children ?? []) : (nb.book?.children ?? []));

/** Items to move or delete together: in sidebar order, without what lies inside another of them
 *  (a section takes its notes along). */
export function topmost(rels: string[]): string[] {
  const order = walk().map((n) => n.rel);
  const known = rels.filter((r) => order.includes(r));
  return order.filter((r) => known.includes(r) && !known.some((o) => o !== r && within(r, o)));
}

/** The rows on screen, in order: every item whose sections are open. */
export function visible(nodes: NbNode[] = nb.book?.children ?? []): NbNode[] {
  return nodes.flatMap((n) => [n, ...(n.kind === "section" && nb.expanded[n.rel] ? visible(n.children ?? []) : [])]);
}

export type Where = "before" | "after" | "inside";

/**
 * Where items dropped `where` on `onto` end up: section `to` and the index there among the items
 * that stay (dragged ones left out), or null when the drop isn't allowed: a section into itself
 * or something inside it. `onto` null is the end of the notebook.
 */
export function dropPlace(rels: string[], onto: string | null, where: Where): { to: string; index: number } | null {
  const to = onto === null ? "" : where === "inside" ? onto : parentOf(onto);
  if (rels.some((r) => within(to, r))) return null;
  if (onto !== null && where !== "inside" && rels.includes(onto)) return null;
  const stay = childrenOf(to)
    .map((n) => n.rel)
    .filter((r) => !rels.includes(r));
  if (onto === null || where === "inside") return { to, index: stay.length };
  return { to, index: stay.indexOf(onto) + (where === "after" ? 1 : 0) };
}

/** Whether moving `rels` to `to` at `index` would leave everything where it is. */
export function changesNothing(rels: string[], to: string, index: number): boolean {
  const now = childrenOf(to).map((n) => n.rel);
  if (rels.some((r) => parentOf(r) !== to)) return false;
  const stay = now.filter((r) => !rels.includes(r));
  const after = [...stay.slice(0, index), ...rels, ...stay.slice(index)];
  return after.every((r, i) => r === now[i]);
}

/** Pick `rels` in the sidebar; `anchor` starts the next Shift-click range. */
export function select(rels: string[], anchor: string | null = rels[rels.length - 1] ?? null) {
  setNb({ selected: rels, anchor });
}

/** The visible rows from the anchor to `rel`, for a Shift-click. */
export function rangeTo(rel: string): string[] {
  const rows = visible().map((n) => n.rel);
  const a = rows.indexOf(nb.anchor ?? rel);
  const b = rows.indexOf(rel);
  if (a < 0 || b < 0) return [rel];
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The sections leading to `rel`, outermost first. */
export function trail(rel: string): NbNode[] {
  const out: NbNode[] = [];
  for (let p = parentOf(rel); p; p = parentOf(p)) {
    const n = find(p);
    if (n) out.unshift(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remembered per machine: recent notebooks, the last note, open sections, the sidebar
// ---------------------------------------------------------------------------

const RECENT = "quire.notebooks";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // blocked storage: it is only remembered for this session
  }
}

export const recentNotebooks = (): string[] => read<string[]>(RECENT, []).filter((p) => typeof p === "string");
const rememberNotebook = (path: string) =>
  write(RECENT, [path, ...recentNotebooks().filter((p) => p !== path)].slice(0, 8));
export const forgetNotebook = (path: string) =>
  write(
    RECENT,
    recentNotebooks().filter((p) => p !== path),
  );
export const lastNotebook = () => read<string | null>("quire.notebook.last", null);

const lastNoteKey = () => `quire.notebook.note:${nb.book?.path}`;
const expandedKey = (path: string) => `quire.notebook.open:${path}`;

export const [sidebarOpen, setSidebarOpenSignal] = createSignal(read("quire.sidebar.open", true));
export const [sidebarWidth, setSidebarWidthSignal] = createSignal(read("quire.sidebar.width", 248));

/** Asked for with no notebook open (⌘\\): it offers to make or open one. */
const [peek, setPeek] = createSignal(false);

/** Whether the sidebar is on screen: with a notebook unless hidden, without one only when asked for. */
export const sidebarShown = () => sidebarOpen() && (nb.book !== null || peek());

export function setSidebarOpen(open: boolean) {
  setSidebarOpenSignal(open);
  setPeek(open && !nb.book);
  write("quire.sidebar.open", open);
}

export function toggleSidebar() {
  setSidebarOpen(!sidebarShown());
}

export function setSidebarWidth(px: number) {
  const w = Math.round(Math.min(420, Math.max(190, px)));
  setSidebarWidthSignal(w);
  write("quire.sidebar.width", w);
}

export function setExpanded(rel: string, open: boolean) {
  setNb("expanded", rel, open);
  if (nb.book) write(expandedKey(nb.book.path), unwrap(nb.expanded));
}

/** Open the sections that lead to `rel`, so it shows. */
function expandTo(rel: string) {
  for (let p = parentOf(rel); p; p = parentOf(p)) if (!nb.expanded[p]) setExpanded(p, true);
}

// ---------------------------------------------------------------------------
// Saving as you go
// ---------------------------------------------------------------------------

const SAVE_DELAY = 600;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();
/** The note or section being moved to the Trash right now; nothing may write it back meanwhile. */
let leaving: string[] = [];
const isLeaving = (rel: string | null) => !!rel && leaving.some((l) => within(rel, l));

/** Save the current note now if it has changes; resolves once it is on disk. */
export function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  const rel = nb.current;
  const path = state.path;
  if (!rel || !path || !state.dirty || isLeaving(rel)) return saving;
  const rev = state.rev;
  // the title lives in the file name; the document carries it for headers and PDFs
  const doc: Doc = { ...structuredClone(unwrap(state.doc)) };
  doc.meta = { ...doc.meta, title: titleOf(rel) };
  saving = saving
    .then(() => api.save(path, doc, path))
    .then(() => {
      if (state.path === path) markSaved(rev);
    })
    .catch((e) => flash(`Could not save ${titleOf(rel)}: ${(e as Error).message}`));
  return saving;
}

/** Changes to a note in a notebook are saved shortly after you stop. */
export function installAutosave() {
  createRoot(() =>
    createEffect(
      on(
        () => state.rev,
        () => {
          if (!nb.current || !state.dirty || isLeaving(nb.current)) return;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => void flushSave(), SAVE_DELAY);
        },
      ),
    ),
  );
  // leaving the window (another app, a crash) shouldn't wait for the timer
  window.addEventListener("blur", () => void flushSave());
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => document.hidden && void flushSave());
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

function call<T>(op: string, args: Record<string, unknown> = {}) {
  return api.notebook<T>(op, { root: nb.book?.path, ...args });
}

/** Reread the folder: after a change, or when the window comes back (files changed in Finder). */
export async function refresh() {
  if (!nb.book) return;
  try {
    const book = await call<Notebook>("list");
    setNb("book", reconcile(book, { key: "rel" }));
    // the open note was moved or deleted outside Quire
    if (nb.current && !find(nb.current)) setNb("current", null);
    if (nb.selected.some((r) => !find(r)))
      select(
        nb.selected.filter((r) => find(r)),
        null,
      );
  } catch {
    // the folder went away (a disconnected drive): keep what is shown
  }
}

export async function openNotebook(path: string, note?: string | null) {
  await flushSave();
  const book = await api.notebook<Notebook>("list", { root: path });
  batch(() => {
    setNb({
      book,
      current: null,
      renaming: null,
      selected: [],
      anchor: null,
      query: "",
      hits: null,
      expanded: read(expandedKey(book.path), {}),
    });
    undoMoves.length = 0;
  });
  rememberNotebook(book.path);
  write("quire.notebook.last", book.path);
  setSidebarOpen(true);
  const wanted = note ?? read<string | null>(lastNoteKey(), null);
  const first = (wanted && find(wanted)) || notes()[0];
  if (first) await openNote(first.rel);
  else await newNote("");
}

export async function closeNotebook() {
  await flushSave();
  setNb({ book: null, current: null, renaming: null, selected: [], anchor: null, query: "", hits: null, expanded: {} });
  undoMoves.length = 0;
  write("quire.notebook.last", null);
  // the sidebar stays, offering to open another
  setPeek(sidebarOpen());
}

/** Open a note of the notebook; `region` scrolls to and selects that region. */
export async function openNote(rel: string, region?: string | null) {
  if (rel !== nb.current) {
    // a table cell being typed is not in the document until the edit ends
    commitEditing();
    await flushSave();
    const path = absPath(rel);
    let doc: Doc;
    try {
      doc = await api.open(path);
    } catch (e) {
      flash(`Could not open ${titleOf(rel)}: ${(e as Error).message}`);
      return void refresh();
    }
    loadDoc(doc, path);
    fadeInPage();
    // show the file's name as its title in headers, without counting it as an edit
    setState("doc", "meta", "title", titleOf(rel));
    setNb("current", rel);
    select([rel]);
    write(lastNoteKey(), rel);
    expandTo(rel);
  }
  if (region) setTimeout(() => revealRegion(region), 60);
}

/** Switching notes cross-fades the page instead of cutting to it. */
function fadeInPage() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelector(".canvas-pane")?.animate(
    [
      { opacity: 0.35, transform: "translateY(4px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
}

/** After a document was opened by its path (File ▸ Open, Recent): is it one of ours? */
export function adoptPath(path: string | null) {
  const rel = relOf(path);
  const was = nb.current;
  setNb("current", rel && find(rel) ? rel : null);
  // the note that was open, picked as the open one, isn't picked once another document is
  if (was && was !== nb.current && nb.selected.length === 1 && nb.selected[0] === was)
    select(nb.current ? [nb.current] : []);
  if (nb.current) {
    write(lastNoteKey(), nb.current);
    expandTo(nb.current);
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** After `from` became `to`, what followed it follows: the open note, open sections, the selection. */
function follow(from: string, to: string) {
  const moved = (r: string) => (within(r, from) ? to + r.slice(from.length) : r);
  // open sections stay open under their new name
  const exp = { ...unwrap(nb.expanded) };
  for (const k of Object.keys(exp))
    if (within(k, from)) {
      exp[moved(k)] = exp[k];
      if (moved(k) !== k) delete exp[k];
    }
  setNb("expanded", reconcile(exp));
  if (nb.book) write(expandedKey(nb.book.path), exp);
  setNb({ selected: nb.selected.map(moved), anchor: nb.anchor && moved(nb.anchor) });
  // a move still to undo finds its items, and their old places, under their new names
  for (const u of undoMoves)
    for (const it of u.items) {
      it.now = moved(it.now);
      it.dir = moved(it.dir);
    }
  const cur = nb.current;
  if (!cur || !within(cur, from)) return;
  setNb("current", moved(cur));
  setState("path", absPath(moved(cur)));
  setState("doc", "meta", "title", titleOf(moved(cur)));
  write(lastNoteKey(), moved(cur));
}

/** Do a change on disk, then reread the folder. `apply` runs in between, so the open note
 *  already follows a rename or move when the new listing arrives. */
async function run<T>(what: string, fn: () => Promise<T>, apply?: (v: T) => void): Promise<T | undefined> {
  try {
    const v = await fn();
    apply?.(v);
    return v;
  } catch (e) {
    flash(`Could not ${what}: ${(e as Error).message}`);
    return undefined;
  } finally {
    await refresh();
  }
}

/** Where a new item goes "where you are": beside the open note, in its section. */
function besideCurrent(): { dir: string; index?: number } {
  const cur = nb.current;
  if (!cur || !find(cur)) return { dir: "" };
  const dir = parentOf(cur);
  const at = childrenOf(dir).findIndex((n) => n.rel === cur);
  return { dir, index: at < 0 ? undefined : at + 1 };
}

/** A new note, opened with its name ready to type: in section `dir` at `index` there, or by
 *  default right after the open note. */
export async function newNote(dir?: string, index?: number) {
  if (!nb.book) return;
  if (dir === undefined) ({ dir, index } = besideCurrent());
  const at = dir;
  const rel = await run("make a note", () => call<string>("create_note", { dir: at, ext: DOC_EXT, index }));
  if (!rel) return;
  if (dir) setExpanded(dir, true);
  await openNote(rel);
  setNb("renaming", rel);
}

/** A new section with its name ready to type: in section `dir` at `index` there, or by default
 *  right after the section the open note is in (or after the note, at the top level). */
export async function newSection(dir?: string, index?: number) {
  if (!nb.book) return;
  if (dir === undefined) {
    const cur = nb.current && find(nb.current) ? nb.current : null;
    const beside = cur && parentOf(cur) ? parentOf(cur) : cur;
    dir = beside ? parentOf(beside) : "";
    const at = beside ? childrenOf(dir).findIndex((n) => n.rel === beside) : -1;
    index = at < 0 ? undefined : at + 1;
  }
  const at = dir;
  const rel = await run("make a section", () => call<string>("create_section", { dir: at, index }));
  if (!rel) return;
  if (dir) setExpanded(dir, true);
  setExpanded(rel, true);
  select([rel]);
  setNb("renaming", rel);
  return rel;
}

/** "New Section with 3 Items": a section where the first of them was, holding them all. */
export async function newSectionWith(rels: string[]) {
  const items = topmost(rels);
  const first = items[0];
  if (!nb.book || first === undefined) return;
  const dir = parentOf(first);
  const index = childrenOf(dir).findIndex((n) => n.rel === first);
  const sec = await run("make a section", () => call<string>("create_section", { dir, index: Math.max(0, index) }));
  if (!sec) return;
  await moveItems(items, sec, 0, { undo: false, quiet: true });
  if (dir) setExpanded(dir, true);
  setExpanded(sec, true);
  select([sec]);
  setNb("renaming", sec);
}

export async function rename(rel: string, name: string) {
  setNb("renaming", null);
  const current = find(rel);
  if (!current || name.trim() === current.name) return;
  if (nb.current && within(nb.current, rel)) await flushSave();
  await run(
    "rename it",
    () => call<string>("rename", { rel, name }),
    (to) => follow(rel, to),
  );
}

/** How to put a move back: each item, where it came from and its place there. */
interface Undo {
  items: { now: string; dir: string; index: number }[];
  what: string;
}
const undoMoves: Undo[] = [];
/** The last move, while it can still be undone (the sidebar offers Undo). */
export const [lastMove, setLastMove] = createSignal<{ what: string; seq: number } | null>(null);
let moveSeq = 0;

const labelOf = (rels: string[]) =>
  rels.length === 1 ? (find(rels[0])?.name ?? titleOf(rels[0])) : `${rels.length} items`;
const sectionName = (to: string) => (to ? (find(to)?.name ?? baseOf(to)) : (nb.book?.name ?? "the notebook"));

/**
 * Move sections and notes into section `to` (`""` is the notebook itself), side by side at
 * `index` among the items that stay there (the end by default), keeping their order in the
 * sidebar. A section takes everything in it along. The move can be undone (⌘Z in the sidebar).
 */
export async function moveItems(
  rels: string[],
  to: string,
  index?: number,
  opts: { undo?: boolean; quiet?: boolean } = {},
): Promise<string[] | undefined> {
  const items = topmost(rels);
  if (!items.length) return;
  if (index !== undefined && changesNothing(items, to, index)) return items;
  if (nb.current && items.some((r) => within(nb.current!, r))) await flushSave();
  // where each one is now, to put it back
  const back = items.map((r) => ({
    dir: parentOf(r),
    index: childrenOf(parentOf(r)).findIndex((n) => n.rel === r),
  }));
  const what = labelOf(items);
  const moved = await run(
    items.length > 1 ? "move them" : "move it",
    () => call<string[]>("move_many", { rels: items, to, index }),
    (now) => {
      batch(() => {
        items.forEach((r, i) => now[i] !== r && follow(r, now[i]));
        select(now);
      });
    },
  );
  if (!moved) return;
  if (to) setExpanded(to, true);
  if (opts.undo !== false) {
    undoMoves.push({ items: moved.map((now, i) => ({ now, ...back[i] })), what });
    if (undoMoves.length > 20) undoMoves.shift();
  }
  if (!opts.quiet) {
    const msg = `Moved ${what} to ${sectionName(to)}`;
    announce(msg);
    if (opts.undo !== false) setLastMove({ what: msg, seq: ++moveSeq });
  }
  return moved;
}

/** Move into section `to` (`""` is the notebook itself) at `index` there. */
export const moveTo = (rel: string, to: string, index?: number) => moveItems([rel], to, index);

/** Put the last move back (⌘Z in the sidebar, or Undo on its message). */
export async function undoMove() {
  const last = undoMoves.pop();
  setLastMove(null);
  if (!last) return false;
  // back to each section in turn, lowest place first, so every place is right as it is filled
  const byDir = new Map<string, { now: string; index: number }[]>();
  for (const it of last.items) byDir.set(it.dir, [...(byDir.get(it.dir) ?? []), it]);
  for (const [dir, list] of byDir) {
    list.sort((a, b) => a.index - b.index);
    for (const it of list) {
      const rel = it.now;
      if (!find(rel)) continue;
      await moveItems([rel], dir, Math.max(0, it.index), { undo: false, quiet: true });
    }
  }
  select(last.items.map((it) => (it.dir ? `${it.dir}/${baseOf(it.now)}` : baseOf(it.now))).filter((r) => find(r)));
  announce(`Undid: moved ${last.what}`);
  return true;
}

export async function duplicate(rel: string) {
  if (nb.current === rel) await flushSave();
  const copy = await run("duplicate it", () => call<string>("duplicate", { rel }));
  if (copy) await openNote(copy);
}

export async function setStyle(rel: string, style: { color?: string | null; icon?: string | null }) {
  const node = find(rel);
  await run("change it", () =>
    call("set_style", {
      rel,
      color: style.color === undefined ? node?.color : style.color,
      icon: style.icon === undefined ? node?.icon : style.icon,
    }),
  );
}

/** Move to the system's Trash; the open note moves on to its neighbour. */
export const trashItem = (rel: string) => trashItems([rel]);

/** Move several items to the system's Trash. If the open note goes, the note after them opens
 *  (or the one before; a new note when none is left). */
export async function trashItems(rels: string[]) {
  const items = topmost(rels);
  if (!items.length) return;
  const holdsCurrent = !!nb.current && items.some((r) => within(nb.current!, r));
  const gone = (r: string) => items.some((g) => within(r, g));
  const list = notes().map((n) => n.rel);
  const at = list.findIndex((r) => r === nb.current);
  const next =
    list.slice(Math.max(0, at)).find((r) => !gone(r)) ??
    list
      .slice(0, Math.max(0, at))
      .reverse()
      .find((r) => !gone(r));
  const names = labelOf(items);
  // edits to what is being trashed must not be saved back while it goes (that would make the
  // file again), but they stay marked if it stays
  leaving = items;
  let unsaved = false;
  if (holdsCurrent) {
    clearTimeout(saveTimer);
    await saving;
    unsaved = state.dirty;
    setState({ dirty: false });
  }
  let trashed = 0;
  const ok = await run("move it to the Trash", async () => {
    for (const rel of items) {
      await call("trash", { rel });
      trashed++;
    }
    return true;
  });
  leaving = [];
  const currentGone = holdsCurrent && !!nb.current && !find(nb.current);
  if (!ok && !currentGone) {
    // edits made while it was going are still in the note, so they are saved after all
    if (holdsCurrent && nb.current && (unsaved || state.dirty)) {
      setState({ dirty: true });
      void flushSave();
    }
    if (!trashed) return;
  }
  // a moved item's old place can't be put back once it is gone
  undoMoves.length = 0;
  setLastMove(null);
  select(nb.selected.filter((r) => !gone(r)));
  flash(ok ? `Moved ${names} to the Trash` : `Moved ${trashed} of ${items.length} items to the Trash`);
  if (holdsCurrent && (ok || currentGone)) {
    setNb("current", null);
    if (next) await openNote(next);
    else await newNote("");
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

export function setQuery(q: string) {
  setNb("query", q);
  clearTimeout(searchTimer);
  if (!q.trim()) return setNb("hits", null);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    await flushSave(); // so the note being written is found as it is now
    const hits = await call<Hit[]>("search", { query: q, limit: 60 }).catch(() => [] as Hit[]);
    if (seq === searchSeq && nb.query === q) setNb("hits", hits);
  }, 120);
}
