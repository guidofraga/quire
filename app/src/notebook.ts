// Notebooks: a folder of sections and notes, shown in the sidebar. Notes save themselves
// as you work (there is no Save in a notebook); the folder layout is in
// crates/quire-service/src/notebook.rs.
import { batch, createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
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
  query: string;
  hits: Hit[] | null;
}

export const [nb, setNb] = createStore<NbState>({
  book: null,
  current: null,
  expanded: {},
  renaming: null,
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

/** Save the current note now if it has changes; resolves once it is on disk. */
export function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  const rel = nb.current;
  const path = state.path;
  if (!rel || !path || !state.dirty) return saving;
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
          if (!nb.current || !state.dirty) return;
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
  } catch {
    // the folder went away (a disconnected drive): keep what is shown
  }
}

export async function openNotebook(path: string, note?: string | null) {
  await flushSave();
  const book = await api.notebook<Notebook>("list", { root: path });
  batch(() => {
    setNb({ book, current: null, renaming: null, query: "", hits: null, expanded: read(expandedKey(book.path), {}) });
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
  setNb({ book: null, current: null, renaming: null, query: "", hits: null, expanded: {} });
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
  setNb("current", rel && find(rel) ? rel : null);
  if (nb.current) {
    write(lastNoteKey(), nb.current);
    expandTo(nb.current);
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** After `from` became `to`, the open note follows if it was it or lay inside it. */
function follow(from: string, to: string) {
  // open sections stay open under their new name
  const exp = { ...unwrap(nb.expanded) };
  for (const k of Object.keys(exp))
    if (k === from || k.startsWith(`${from}/`)) {
      exp[to + k.slice(from.length)] = exp[k];
      delete exp[k];
    }
  setNb("expanded", reconcile(exp));
  if (nb.book) write(expandedKey(nb.book.path), exp);
  const cur = nb.current;
  const moved = !cur ? null : cur === from ? to : cur.startsWith(`${from}/`) ? to + cur.slice(from.length) : null;
  if (!moved) return;
  setNb("current", moved);
  setState("path", absPath(moved));
  setState("doc", "meta", "title", titleOf(moved));
  write(lastNoteKey(), moved);
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

/** A new note in section `dir`, opened with its name ready to type. */
export async function newNote(dir = nb.current ? parentOf(nb.current) : "", index?: number) {
  if (!nb.book) return;
  const rel = await run("make a note", () => call<string>("create_note", { dir, ext: DOC_EXT, index }));
  if (!rel) return;
  if (dir) setExpanded(dir, true);
  await openNote(rel);
  setNb("renaming", rel);
}

export async function newSection(dir = "", index?: number) {
  if (!nb.book) return;
  const rel = await run("make a section", () => call<string>("create_section", { dir, index }));
  if (!rel) return;
  if (dir) setExpanded(dir, true);
  setExpanded(rel, true);
  setNb("renaming", rel);
}

export async function rename(rel: string, name: string) {
  setNb("renaming", null);
  const current = find(rel);
  if (!current || name.trim() === current.name) return;
  if (nb.current === rel || nb.current?.startsWith(`${rel}/`)) await flushSave();
  await run(
    "rename it",
    () => call<string>("rename", { rel, name }),
    (to) => follow(rel, to),
  );
}

/** Move into section `to` (`""` is the notebook itself) at `index` there. */
export async function moveTo(rel: string, to: string, index?: number) {
  if (nb.current === rel || nb.current?.startsWith(`${rel}/`)) await flushSave();
  const moved = await run(
    "move it",
    () => call<string>("move", { rel, to, index }),
    (m) => follow(rel, m),
  );
  if (moved && to) setExpanded(to, true);
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
export async function trashItem(rel: string) {
  const node = find(rel);
  if (!node) return;
  const holdsCurrent = nb.current === rel || !!nb.current?.startsWith(`${rel}/`);
  const list = notes().map((n) => n.rel);
  const gone = (r: string) => r === rel || r.startsWith(`${rel}/`);
  const at = list.findIndex(gone);
  const next =
    list.slice(at).find((r) => !gone(r)) ??
    list
      .slice(0, Math.max(0, at))
      .reverse()
      .find((r) => !gone(r));
  // edits to what is being trashed must not be saved back while it goes (that would make the
  // file again), but they stay marked if it stays
  const unsaved = holdsCurrent && state.dirty;
  if (holdsCurrent) {
    clearTimeout(saveTimer);
    await saving;
    setState({ dirty: false });
  }
  const ok = await run("move it to the Trash", () => call("trash", { rel }).then(() => true));
  if (!ok) {
    if (unsaved && nb.current) {
      setState({ dirty: true });
      void flushSave();
    }
    return;
  }
  flash(`Moved ${node.name} to the Trash`);
  if (holdsCurrent) {
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
