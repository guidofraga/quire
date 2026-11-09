// The notebook sidebar: switch notebooks, search every note, and arrange sections and
// notes by dragging, as in OneNote, Notion and Obsidian.
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { announce } from "./a11y";
import { api, confirmDiscard, DOC_EXT, isMac, pickNewNotebookPath, pickNotebookFolder } from "./api";
import { closeMenu, type MenuItems, setMenu } from "./menu";
import {
  childrenOf,
  closeNotebook,
  dropPlace,
  duplicate,
  find,
  flushSave,
  forgetNotebook,
  type Hit,
  lastMove,
  moveItems,
  nb,
  type NbNode,
  newNote,
  newSection,
  newSectionWith,
  openNote,
  openNotebook,
  parentOf,
  rangeTo,
  recentNotebooks,
  rename,
  select,
  setExpanded,
  setLastMove,
  setNb,
  setQuery,
  setSidebarOpen,
  setSidebarWidth,
  setStyle,
  sidebarWidth,
  titleOf,
  topmost,
  trail,
  undoMove,
  visible,
  walk,
  type Where,
  within,
} from "./notebook";
import { askMove, askTrash, SidebarDialogs } from "./SidebarDialogs";
import { flash, state } from "./store";

const mod = isMac ? "⌘" : "Ctrl+";

/** Section colours, as OneNote's coloured tabs. */
export const COLORS: [string, string][] = [
  ["Red", "#e5484d"],
  ["Orange", "#f76b15"],
  ["Yellow", "#e2a336"],
  ["Green", "#30a46c"],
  ["Teal", "#12a594"],
  ["Blue", "#3e63dd"],
  ["Purple", "#8e4ec6"],
  ["Pink", "#d6409f"],
  ["Grey", "#8b8d98"],
];

const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

// ---------------------------------------------------------------------------
// Opening and making notebooks
// ---------------------------------------------------------------------------

/**
 * Before a document is replaced: a note in a notebook saves itself, so there is nothing to ask;
 * an unsaved plain document asks first. Welcome, App and this sidebar all use it, so it lives here.
 */
export async function guardUnsaved(): Promise<boolean> {
  // a note in a notebook saves itself: finish that, nothing to ask
  if (nb.current) return flushSave().then(() => true);
  return !state.dirty || (await confirmDiscard());
}

// The dialogs ask before they show a picker, so a cancelled discard never opens one.
export async function openNotebookDialog() {
  if (!(await guardUnsaved())) return;
  const path = await pickNotebookFolder();
  if (path) await openNotebookAt(path);
}

/** Startup opens the last notebook without asking; a notebook the user picks asks first. */
export async function openNotebookAt(path: string) {
  try {
    await openNotebook(path);
  } catch (e) {
    flash(`Could not open ${folderName(path)}: ${(e as Error).message}`);
    forgetNotebook(path);
  }
}

export async function openRecentNotebook(path: string) {
  if (await guardUnsaved()) await openNotebookAt(path);
}

export async function newNotebookDialog() {
  if (!(await guardUnsaved())) return;
  const path = await pickNewNotebookPath();
  if (!path) return;
  try {
    await api.notebook("create_notebook", { path, ext: DOC_EXT });
    await openNotebook(path);
  } catch (e) {
    flash(`Could not make the notebook: ${(e as Error).message}`);
  }
}

function openSwitcher(e: MouseEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const others = recentNotebooks().filter((p) => p !== nb.book?.path);
  const items: MenuItems = [
    ...others.map((p) => ({ label: folderName(p), run: () => (closeMenu(), void openRecentNotebook(p)) })),
    ...(others.length ? [null] : []),
    { label: "New Notebook…", run: () => (closeMenu(), void newNotebookDialog()) },
    { label: "Open Notebook…", shortcut: `⇧${mod}O`, run: () => (closeMenu(), void openNotebookDialog()) },
  ];
  if (nb.book) items.push(null, { label: "Close Notebook", run: () => (closeMenu(), void closeNotebook()) });
  setMenu({ x: box.left, y: box.bottom + 4, items });
}

// ---------------------------------------------------------------------------
// Item menus
// ---------------------------------------------------------------------------

const trashKey = isMac ? "⌫" : "Del";
const plural = (n: number) => (n === 1 ? "1 Item" : `${n} Items`);

/** The selection a command on `rel` acts on: all of it when `rel` is in it, else `rel` alone. */
function actOn(rel: string): string[] {
  return nb.selected.includes(rel) ? topmost(nb.selected) : [rel];
}

function itemMenu(node: NbNode | null, x: number, y: number) {
  const go = (fn: () => void) => () => (closeMenu(), fn());
  let items: MenuItems;
  // right-clicking outside the selection picks that item, as in the Finder and Obsidian
  if (node && !nb.selected.includes(node.rel)) select([node.rel]);
  const many = node ? actOn(node.rel) : [];
  if (!node) {
    items = [
      { label: "New Note", shortcut: `${mod}N`, run: go(() => void newNote("")) },
      { label: "New Section", shortcut: `⌥${mod}N`, run: go(() => void newSection("")) },
    ];
  } else if (many.length > 1) {
    items = [
      { label: `Move ${plural(many.length)} to…`, run: go(() => askMove(many)) },
      { label: `New Section with ${plural(many.length)}`, run: go(() => void newSectionWith(many)) },
      null,
      { label: `Move ${plural(many.length)} to Trash…`, shortcut: trashKey, run: go(() => askTrash(many)) },
    ];
  } else if (node.kind === "section") {
    items = [
      { label: "New Note in Section", run: go(() => void newNote(node.rel)) },
      { label: "New Section Inside", run: go(() => void newSection(node.rel)) },
      null,
      { label: "Rename", shortcut: "F2", run: go(() => setNb("renaming", node.rel)) },
      { label: "Move to…", run: go(() => askMove([node.rel])) },
      null,
      { label: "No Colour", checked: !node.color, run: go(() => void setStyle(node.rel, { color: null })) },
      ...COLORS.map(([name, c]) => ({
        label: name,
        swatch: c,
        checked: node.color === c,
        run: go(() => void setStyle(node.rel, { color: c })),
      })),
      null,
      { label: "Move to Trash…", shortcut: trashKey, run: go(() => askTrash([node.rel])) },
    ];
  } else {
    items = [
      { label: "Open", run: go(() => void openNote(node.rel)) },
      { label: "Rename", shortcut: "F2", run: go(() => setNb("renaming", node.rel)) },
      { label: "Duplicate", run: go(() => void duplicate(node.rel)) },
      { label: "Move to…", run: go(() => askMove([node.rel])) },
      null,
      { label: "Move to Trash…", shortcut: trashKey, run: go(() => askTrash([node.rel])) },
    ];
  }
  setMenu({ x, y, items });
}

// ---------------------------------------------------------------------------
// Dragging: with the pointer rather than HTML drag and drop, which the desktop app's
// webview hands to the system on some platforms, and which can't scroll the list, open a
// section held over, or show a line exactly where the items will land
// ---------------------------------------------------------------------------

/** Where a drop would land: on a row (`null` is the end of the notebook), and how. */
interface Target {
  onto: string | null;
  where: Where;
}

const [dragged, setDragged] = createSignal<string[] | null>(null);
const [target, setTarget] = createSignal<Target | null>(null);
const [ghostAt, setGhostAt] = createSignal<[number, number]>([0, 0]);
/** Where the drop line is drawn, in the list's own coordinates. */
const [line, setLine] = createSignal<{ top: number; left: number } | null>(null);

const isDragged = (rel: string) => !!dragged()?.some((d) => within(rel, d));
const rowOf = (rel: string) => document.querySelector<HTMLElement>(`.nb-tree [data-rel="${CSS.escape(rel)}"]`);
/** The indent of a row at `depth` (`.nb-row` padding plus the chevron), where its line starts. */
const indent = (depth: number) => 8 + depth * 16 + 18;
const depthOf = (rel: string | null) => (rel ? rel.split("/").length - 1 : 0);

/** The drop under the pointer, from the row it is over and how far down that row it is. */
function targetAt(x: number, y: number): Target | null | undefined {
  const scroll = document.querySelector<HTMLElement>(".nb-scroll");
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!scroll || !el || !scroll.contains(el)) return null;
  const add = el.closest<HTMLElement>("[data-add]");
  // an empty section's "Add a note" is that section's inside
  if (add) return { onto: add.dataset.add!, where: "inside" };
  const row = el.closest<HTMLElement>(".nb-row[data-rel]");
  if (!row) {
    // below the last row: the end of the notebook; in a gap between rows: as before
    const rows = scroll.querySelectorAll(".nb-tree .nb-row, .nb-tree [data-add]");
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    return !last || y > last.bottom ? { onto: null, where: "after" } : undefined;
  }
  const rel = row.dataset.rel!;
  const node = find(rel);
  if (!node) return undefined;
  const box = row.getBoundingClientRect();
  const fy = (y - box.top) / box.height;
  if (node.kind === "section") {
    const open = !!nb.expanded[rel];
    if (fy < 0.25) return { onto: rel, where: "before" };
    if (fy <= 0.75) return { onto: rel, where: "inside" };
    // the lower edge of an open section is the top of what is in it
    const first = node.children?.[0];
    if (open) return first ? { onto: first.rel, where: "before" } : { onto: rel, where: "inside" };
    return outdent({ onto: rel, where: "after" }, x, box.left);
  }
  return fy < 0.5 ? { onto: rel, where: "before" } : outdent({ onto: rel, where: "after" }, x, box.left);
}

/** Below the last item of a section, moving the pointer left drops after the section instead:
 *  each indent further left climbs out one level. */
function outdent(t: Target, x: number, left: number): Target {
  let rel = t.onto!;
  for (;;) {
    const dir = parentOf(rel);
    if (!dir) return { onto: rel, where: "after" };
    const siblings = find(dir)?.children ?? [];
    if (siblings[siblings.length - 1]?.rel !== rel || x - left >= indent(depthOf(rel)) - 4)
      return { onto: rel, where: "after" };
    rel = dir;
  }
}

/** The line for a drop before or after a row, at that row's indent. */
function placeLine(t: Target | null) {
  const scroll = document.querySelector<HTMLElement>(".nb-scroll");
  if (!t || !scroll || t.where === "inside") return setLine(null);
  const at = (el: HTMLElement | null | undefined, bottom: boolean) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const s = scroll.getBoundingClientRect();
    return (bottom ? box.bottom : box.top) - s.top + scroll.scrollTop;
  };
  let top: number | null;
  let depth: number;
  if (t.onto === null) {
    const rows = scroll.querySelectorAll<HTMLElement>(".nb-tree .nb-row, .nb-tree [data-add]");
    top = at(rows[rows.length - 1], true);
    depth = 0;
  } else if (t.where === "before") {
    top = at(rowOf(t.onto), false);
    depth = depthOf(t.onto);
  } else {
    // after a section: below the last row shown inside it
    const rows = [...scroll.querySelectorAll<HTMLElement>(".nb-tree .nb-row[data-rel], .nb-tree [data-add]")].filter(
      (r) => within(r.dataset.rel ?? r.dataset.add ?? "", t.onto!),
    );
    top = at(rows[rows.length - 1], true);
    depth = depthOf(t.onto);
  }
  setLine(top === null ? null : { top: top - 1, left: indent(depth) - 6 });
}

let press: { x: number; y: number; rel: string; additive: boolean } | null = null;
let justDragged = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let held: string | null = null;
let scrollFrame = 0;
let pointer: [number, number] = [0, 0];

function beginDrag(rel: string, additive: boolean) {
  if (!nb.selected.includes(rel)) select(additive ? [...nb.selected, rel] : [rel], rel);
  const rels = topmost(nb.selected.includes(rel) ? nb.selected : [rel]);
  setDragged(rels);
  closeMenu();
  document.body.classList.add("nb-dragging");
  window.addEventListener("keydown", dragKeys, true);
  scrollFrame = requestAnimationFrame(autoScroll);
}

function endDrag() {
  setDragged(null);
  setTarget(null);
  setLine(null);
  clearTimeout(holdTimer);
  held = null;
  cancelAnimationFrame(scrollFrame);
  document.body.classList.remove("nb-dragging");
  window.removeEventListener("keydown", dragKeys, true);
  // the click that ends a drag isn't a click on the row
  justDragged = true;
  setTimeout(() => (justDragged = false));
}

/** Esc cancels a drag, leaving everything where it was. */
function dragKeys(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  endDrag();
  announce("Move cancelled");
}

function track(x: number, y: number) {
  const rels = dragged();
  if (!rels) return;
  pointer = [x, y];
  setGhostAt([x, y]);
  const t = targetAt(x, y);
  if (t === undefined) return; // a gap between rows: keep the last place
  const ok = t && dropPlace(rels, t.onto, t.where) ? t : null;
  const prev = target();
  if (ok?.onto !== prev?.onto || ok?.where !== prev?.where) {
    setTarget(ok);
    // a closed section held under the pointer opens, to drop deeper
    clearTimeout(holdTimer);
    held = ok?.where === "inside" && ok.onto && !nb.expanded[ok.onto] ? ok.onto : null;
    if (held) {
      const rel = held;
      holdTimer = setTimeout(() => held === rel && setExpanded(rel, true), 650);
    }
  }
  placeLine(ok);
}

/** Near the top or bottom edge of the list while dragging, the list scrolls, faster nearer. */
function autoScroll() {
  const scroll = document.querySelector<HTMLElement>(".nb-scroll");
  if (scroll && dragged()) {
    const box = scroll.getBoundingClientRect();
    const [x, y] = pointer;
    const edge = 36;
    const speed = y < box.top + edge ? -(box.top + edge - y) : y > box.bottom - edge ? y - (box.bottom - edge) : 0;
    if (speed && x >= box.left && x <= box.right) {
      const before = scroll.scrollTop;
      scroll.scrollTop += Math.max(-14, Math.min(14, speed / 2.5));
      if (scroll.scrollTop !== before) track(x, y);
    }
  }
  if (dragged()) scrollFrame = requestAnimationFrame(autoScroll);
}

async function drop() {
  const rels = dragged();
  const t = target();
  endDrag();
  if (!rels || !t) return;
  const place = dropPlace(rels, t.onto, t.where);
  if (!place) return;
  await moveItems(rels, place.to, place.index);
}

function onPointerDown(e: PointerEvent, rel: string) {
  if (e.button !== 0 || nb.renaming === rel || (e.target as HTMLElement).closest("input, .nb-act")) return;
  press = { x: e.clientX, y: e.clientY, rel, additive: isMac ? e.metaKey : e.ctrlKey };
  const move = (m: PointerEvent) => {
    if (press && !dragged() && Math.hypot(m.clientX - press.x, m.clientY - press.y) > 4)
      beginDrag(press.rel, press.additive);
    if (dragged()) {
      m.preventDefault();
      track(m.clientX, m.clientY);
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    press = null;
    if (dragged()) void drop();
  };
  const cancel = () => {
    up();
    if (dragged()) endDrag();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** What follows the pointer while dragging: the item, or how many. */
function Ghost() {
  const first = () => find(dragged()?.[0] ?? "");
  return (
    <Show when={dragged()}>
      {(rels) => (
        <Portal>
          <div
            class="nb-ghost"
            classList={{ many: rels().length > 1, none: !target() }}
            style={{ transform: `translate(${ghostAt()[0] + 14}px, ${ghostAt()[1] + 10}px)` }}
            aria-hidden="true"
          >
            <Show when={first()}>{(n) => <Glyph node={n()} />}</Show>
            <span class="nb-ghost-name">{first()?.name}</span>
            <Show when={rels().length > 1}>
              <span class="nb-ghost-count">{rels().length}</span>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** The rows a keyboard moves through, in order. */
const visibleRows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];

function NameInput(props: { value: string; onDone: (name: string | null) => void; class?: string }) {
  let input!: HTMLInputElement;
  let done = false;
  const finish = (v: string | null) => {
    if (done) return;
    done = true;
    props.onDone(v);
  };
  return (
    <input
      ref={(el) => {
        input = el;
        // focused as soon as it is in the page
        queueMicrotask(() => {
          el.focus();
          el.select();
        });
      }}
      class={`nb-rename ${props.class ?? ""}`}
      value={props.value}
      aria-label="Name"
      spellcheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(input.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function Glyph(props: { node: NbNode }) {
  return (
    <span class="nb-glyph" aria-hidden="true">
      <Switch>
        <Match when={props.node.icon}>{props.node.icon}</Match>
        <Match when={props.node.kind === "section"}>
          <span class="nb-dot" style={{ background: props.node.color ?? "var(--nb-section)" }} />
        </Match>
        <Match when={true}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.15">
            <path d="M3.5 1.75h4.8l2.7 2.7v7.8H3.5z" stroke-linejoin="round" />
            <path d="M8.2 1.9v2.7h2.7" stroke-linejoin="round" />
          </svg>
        </Match>
      </Switch>
    </span>
  );
}

/** A click on a row: ⌘/Ctrl adds or removes it, Shift picks the range from the last one,
 *  a plain click picks it alone and opens it (a section opens or closes). */
function clickRow(e: MouseEvent, node: NbNode) {
  if (justDragged) return;
  const rel = node.rel;
  (e.currentTarget as HTMLElement).focus({ preventScroll: true });
  if (isMac ? e.metaKey : e.ctrlKey) {
    const on = nb.selected.includes(rel);
    select(on ? nb.selected.filter((r) => r !== rel) : [...nb.selected, rel], rel);
    return;
  }
  if (e.shiftKey) {
    setNb("selected", rangeTo(rel));
    return;
  }
  select([rel]);
  if (node.kind === "section") setExpanded(rel, !nb.expanded[rel]);
  else void openNote(rel);
}

function Row(props: { node: NbNode; depth: number }) {
  const n = () => props.node;
  const open = () => !!nb.expanded[n().rel];
  const isSection = () => n().kind === "section";
  const current = () => nb.current === n().rel;
  const picked = () => nb.selected.includes(n().rel);
  const inside = () => target()?.where === "inside" && target()?.onto === n().rel;
  return (
    <li role="none">
      <div
        class="nb-row"
        classList={{
          section: isSection(),
          current: current(),
          // the open note alone is shown as open, not also as picked
          selected: picked() && !(current() && nb.selected.length === 1),
          "drop-inside": inside(),
          dragging: isDragged(n().rel),
        }}
        role="treeitem"
        aria-level={props.depth + 1}
        aria-expanded={isSection() ? open() : undefined}
        aria-selected={picked()}
        aria-current={current() ? "page" : undefined}
        aria-label={isSection() ? `${n().name}, section` : n().name}
        data-rel={n().rel}
        tabIndex={current() ? 0 : -1}
        style={{ "padding-left": `${8 + props.depth * 16}px`, "--nb-color": n().color ?? "" }}
        onPointerDown={(e) => onPointerDown(e, n().rel)}
        onClick={(e) => clickRow(e, n())}
        onDblClick={(e) => !isSection() && !e.metaKey && !e.ctrlKey && !e.shiftKey && setNb("renaming", n().rel)}
        onFocus={(e) => {
          // one row of the tree is reached with Tab: the one last focused
          for (const r of e.currentTarget.closest(".nb-tree")?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
            r.tabIndex = r === e.currentTarget ? 0 : -1;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          itemMenu(n(), e.clientX, e.clientY);
        }}
      >
        <span
          class="nb-chevron"
          classList={{ open: open(), none: !isSection() }}
          aria-hidden="true"
          onClick={(e) => {
            if (!isSection() || justDragged) return;
            e.stopPropagation();
            setExpanded(n().rel, !open());
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M3.5 2l3 3-3 3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <Glyph node={n()} />
        <Show when={nb.renaming === n().rel} fallback={<span class="nb-name">{n().name}</span>}>
          <NameInput
            value={n().name}
            onDone={(v) => (v === null ? setNb("renaming", null) : void rename(n().rel, v))}
          />
        </Show>
        <span class="nb-actions">
          <Show when={isSection()}>
            <button
              class="nb-act"
              tabIndex={-1}
              title="New note in this section"
              aria-label={`New note in ${n().name}`}
              onClick={(e) => {
                e.stopPropagation();
                void newNote(n().rel);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </Show>
          <button
            class="nb-act"
            tabIndex={-1}
            title="More"
            aria-label={`More for ${n().name}`}
            onClick={(e) => {
              e.stopPropagation();
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              itemMenu(n(), box.left, box.bottom + 4);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
              <circle cx="2.5" cy="6" r="1.1" />
              <circle cx="6" cy="6" r="1.1" />
              <circle cx="9.5" cy="6" r="1.1" />
            </svg>
          </button>
        </span>
      </div>
      <Show when={isSection() && open() && (n().children?.length ?? 0) > 0}>
        <ul role="group" class="nb-group">
          <For each={n().children}>{(c) => <Row node={c} depth={props.depth + 1} />}</For>
        </ul>
      </Show>
      <Show when={isSection() && open() && !(n().children?.length ?? 0)}>
        {/* an empty section offers its first note, as an item of its own in the tree; dropped
            on, it is the section's inside */}
        <ul role="group" class="nb-group">
          <li role="none">
            <div
              class="nb-empty-section"
              classList={{ "drop-inside": inside() }}
              role="treeitem"
              aria-level={props.depth + 2}
              aria-label={`Add a note to ${n().name}`}
              data-add={n().rel}
              tabIndex={-1}
              style={{ "padding-left": `${30 + (props.depth + 1) * 16}px` }}
              onClick={() => !justDragged && void newNote(n().rel)}
            >
              <span class="nb-link">Add a note</span>
            </div>
          </li>
        </ul>
      </Show>
    </li>
  );
}

function treeKeys(e: KeyboardEvent, root: HTMLElement) {
  const rows = visibleRows(root);
  const el = document.activeElement as HTMLElement | null;
  const at = el ? rows.indexOf(el) : -1;
  const rel = el?.dataset.rel;
  const node = rel ? find(rel) : undefined;
  const focus = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    r.focus();
    r.scrollIntoView({ block: "nearest" });
    // the selection follows the keyboard; with Shift it grows from where it started
    const to = r.dataset.rel;
    if (!to) return;
    if (e.shiftKey) setNb("selected", rangeTo(to));
    else select([to]);
  };
  const cmd = isMac ? e.metaKey : e.ctrlKey;
  /** Up or down one place among its neighbours (⌥↑, ⌥↓), for reordering from the keyboard. */
  const nudge = (by: number) => {
    if (!node) return;
    const items = actOn(node.rel);
    const dir = parentOf(items[0]);
    if (items.some((r) => parentOf(r) !== dir)) return;
    const all = childrenOf(dir).map((c) => c.rel);
    const first = all.indexOf(items[0]);
    const stay = all.filter((r) => !items.includes(r));
    const index = Math.max(0, Math.min(stay.length, all.slice(0, first).filter((r) => !items.includes(r)).length + by));
    void moveItems(items, dir, index).then(() => rowOf(node.rel)?.focus());
  };
  switch (e.key) {
    case "ArrowDown":
      if (e.altKey) nudge(1);
      else focus(at + 1);
      break;
    case "ArrowUp":
      if (e.altKey) nudge(-1);
      else focus(at - 1);
      break;
    case "Home":
      focus(0);
      break;
    case "End":
      focus(rows.length - 1);
      break;
    case "ArrowRight":
      if (node?.kind !== "section") return;
      if (!nb.expanded[node.rel]) setExpanded(node.rel, true);
      else focus(at + 1);
      break;
    case "ArrowLeft":
      if (node?.kind === "section" && nb.expanded[node.rel]) setExpanded(node.rel, false);
      else if (el?.dataset.add !== undefined) focus(rows.findIndex((r) => r.dataset.rel === el.dataset.add));
      else if (node && parentOf(node.rel)) focus(rows.findIndex((r) => r.dataset.rel === parentOf(node.rel)));
      else return;
      break;
    case "Enter":
    case " ":
      if (el?.dataset.add !== undefined) {
        void newNote(el.dataset.add);
        break;
      }
      if (!node) return;
      // on a Mac, Return on the open note renames it, as in the Finder
      if (isMac && e.key === "Enter" && node.rel === nb.current) setNb("renaming", node.rel);
      else if (node.kind === "section") setExpanded(node.rel, !nb.expanded[node.rel]);
      else {
        // opened from the keyboard, focus stays in the tree for the next arrow key; the page
        // is a Tab or Esc away
        const rel = node.rel;
        void openNote(rel).then(() => setTimeout(() => rowOf(rel)?.focus({ preventScroll: true })));
      }
      break;
    case "F2":
      if (node) setNb("renaming", node.rel);
      break;
    case "Backspace":
    case "Delete":
      if (node) askTrash(actOn(node.rel));
      break;
    case "a":
    case "A":
      if (!cmd) return;
      select(
        visible().map((n) => n.rel),
        rel ?? null,
      );
      break;
    case "z":
    case "Z":
      if (!cmd || e.shiftKey) return;
      void undoMove().then((done) => !done && flash("Nothing to undo in the notebook"));
      break;
    case "Escape":
      // a selection of several drops back to the focused item; the page is a Tab away
      if (nb.selected.length > 1 && rel) select([rel]);
      else return;
      break;
    case "ContextMenu":
    case "F10":
      if (e.key === "F10" && !e.shiftKey) return;
      if (!el) return;
      itemMenu(node ?? null, el.getBoundingClientRect().left + 24, el.getBoundingClientRect().bottom);
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** The last move, with Undo, at the foot of the sidebar for a few seconds. */
function UndoBar() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(lastMove, (m) => {
      clearTimeout(timer);
      if (m) timer = setTimeout(() => lastMove()?.seq === m.seq && setLastMove(null), 7000);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={lastMove()}>
      {(m) => (
        <div class="nb-undo" role="status">
          <span class="nb-undo-text">{m().what}</span>
          <button class="nb-undo-btn" onClick={() => void undoMove()} title={`Undo (${mod}Z in the sidebar)`}>
            Undo
          </button>
        </div>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function Snippet(props: { hit: Hit }) {
  const parts = () => {
    const s = [...props.hit.snippet];
    const m = props.hit.mark;
    if (!m) return { before: props.hit.snippet, mark: "", after: "" };
    return { before: s.slice(0, m[0]).join(""), mark: s.slice(m[0], m[1]).join(""), after: s.slice(m[1]).join("") };
  };
  return (
    <span class="nb-snippet">
      {parts().before}
      <mark>{parts().mark}</mark>
      {parts().after}
    </span>
  );
}

function Results(props: { onOpen: () => void }) {
  return (
    <Show
      when={nb.hits}
      fallback={
        <p class="nb-hint" aria-live="polite">
          Searching…
        </p>
      }
    >
      {(hits) => (
        <Show when={hits().length} fallback={<p class="nb-hint">No notes contain “{nb.query.trim()}”.</p>}>
          <ul class="nb-results" role="listbox" aria-label="Search results">
            <For each={hits()}>
              {(h) => (
                <li role="none">
                  <button
                    class="nb-hit"
                    role="option"
                    aria-selected={nb.current === h.rel}
                    classList={{ current: nb.current === h.rel }}
                    onClick={() => {
                      void openNote(h.rel, h.region);
                      props.onOpen();
                    }}
                  >
                    <span class="nb-hit-title">{h.title}</span>
                    <Show when={h.section}>
                      <span class="nb-hit-section">{h.section}</span>
                    </Show>
                    <Show when={h.snippet}>
                      <Snippet hit={h} />
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

let searchInput: HTMLInputElement | undefined;

/** ⇧⌘F: search every note in the notebook. */
export function focusNotebookSearch() {
  setSidebarOpen(true);
  queueMicrotask(() => {
    searchInput?.focus();
    searchInput?.select();
  });
}

function NoNotebook() {
  const recent = recentNotebooks();
  return (
    <div class="nb-welcome">
      <p class="nb-welcome-title">Notebooks</p>
      <p class="nb-welcome-text">Folders of notes that save themselves.</p>
      <button class="nb-primary" onClick={() => void newNotebookDialog()}>
        New Notebook…
      </button>
      <button class="nb-secondary" onClick={() => void openNotebookDialog()}>
        Open Notebook…
      </button>
      <Show when={recent.length}>
        <p class="nb-welcome-head">Recent</p>
        <ul class="nb-recent">
          <For each={recent}>
            {(p) => (
              <li>
                <button class="nb-hit" title={p} onClick={() => void openRecentNotebook(p)}>
                  <span class="nb-hit-title">{folderName(p)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function Sidebar(props: { collapsed?: boolean }) {
  let tree: HTMLUListElement | undefined;
  const searching = () => nb.query.trim().length > 0;

  // the open note's row stays in view as it changes (opened from search, a new note)
  createEffect(
    on(
      () => nb.current,
      (rel) => {
        if (!rel || !tree) return;
        queueMicrotask(() =>
          tree?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: "nearest" }),
        );
      },
    ),
  );
  // the screen reader hears which note opened
  createEffect(
    on(
      () => nb.current,
      (rel) => rel && announce(`${titleOf(rel)} opened`),
      { defer: true },
    ),
  );

  const onResize = (e: PointerEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const from = sidebarWidth();
    const move = (m: PointerEvent) => setSidebarWidth(from + m.clientX - start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-sidebar");
    };
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  onCleanup(() => document.body.classList.remove("resizing-sidebar"));

  const count = createMemo(() => walk().filter((n) => n.kind === "note").length);

  return (
    <nav
      class="sidebar"
      classList={{ collapsed: !!props.collapsed }}
      aria-label="Notebook"
      aria-hidden={props.collapsed || undefined}
      inert={props.collapsed || undefined}
      style={{ width: `${sidebarWidth()}px`, "--sb-width": `${sidebarWidth()}px` }}
    >
      <div class="sidebar-top" data-tauri-drag-region>
        <button
          class="sb-icon"
          onClick={() => setSidebarOpen(false)}
          title={`Hide the sidebar (${mod}\\)`}
          aria-label="Hide the sidebar"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            aria-hidden="true"
          >
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M6 2.5v11" />
          </svg>
        </button>
        <Show when={nb.book}>
          <button class="sb-icon" onClick={() => void newNote()} title={`New note (${mod}N)`} aria-label="New note">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              aria-hidden="true"
            >
              <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6" stroke-linecap="round" />
              <path d="M12.2 1.8l2 2L8.6 9.4l-2.6.6.6-2.6z" stroke-linejoin="round" />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={nb.book} fallback={<NoNotebook />}>
        {(book) => (
          <>
            <button class="nb-switcher" onClick={openSwitcher} aria-haspopup="menu" title={book().path}>
              <span class="nb-book" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
                  <path d="M2.5 2.2h7.2a1.3 1.3 0 0 1 1.3 1.3v8.3H3.8a1.3 1.3 0 0 1-1.3-1.3z" stroke-linejoin="round" />
                  <path d="M2.5 10.5a1.3 1.3 0 0 1 1.3-1.3H11" />
                </svg>
              </span>
              <span class="nb-book-name">{book().name}</span>
              <svg class="chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" stroke-width="1.2" />
              </svg>
            </button>
            <div class="nb-search">
              <svg
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
              >
                <circle cx="5.6" cy="5.6" r="3.9" />
                <path d="M8.6 8.6l2.9 2.9" stroke-linecap="round" />
              </svg>
              <input
                ref={searchInput}
                type="search"
                placeholder="Search notes"
                aria-label="Search notes"
                value={nb.query}
                spellcheck={false}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    if (nb.query) setQuery("");
                    else e.currentTarget.blur();
                  } else if (e.key === "Enter") {
                    const first = nb.hits?.[0];
                    if (first) void openNote(first.rel, first.region);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    (
                      e.currentTarget
                        .closest(".sidebar")
                        ?.querySelector(searching() ? ".nb-hit" : '[role="treeitem"]') as HTMLElement | null
                    )?.focus();
                  }
                }}
              />
              <Show when={!nb.query}>
                <kbd class="nb-kbd" aria-hidden="true">
                  ⇧{mod}F
                </kbd>
              </Show>
            </div>
            <div
              class="nb-scroll"
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest(".nb-row")) return;
                e.preventDefault();
                itemMenu(null, e.clientX, e.clientY);
              }}
              classList={{ "drop-end": target()?.onto === null }}
            >
              <Show when={line()}>
                {(l) => (
                  <div
                    class="nb-drop-line"
                    style={{ transform: `translateY(${l().top}px)`, left: `${l().left}px` }}
                    aria-hidden="true"
                  />
                )}
              </Show>
              <Show
                when={!searching()}
                fallback={
                  <Results
                    onOpen={() => {
                      /* results stay, so the next hit is one click away */
                    }}
                  />
                }
              >
                <ul
                  ref={tree}
                  class="nb-tree"
                  classList={{ dragging: !!dragged() }}
                  role="tree"
                  aria-label={book().name}
                  aria-multiselectable="true"
                  onKeyDown={(e) => tree && treeKeys(e, tree)}
                >
                  <For each={book().children}>{(n) => <Row node={n} depth={0} />}</For>
                </ul>
                <Show when={count() === 0 && !book().children.length}>
                  <p class="nb-hint">This notebook is empty.</p>
                </Show>
              </Show>
            </div>
            <UndoBar />
            <div class="sidebar-foot">
              <button class="nb-new" onClick={() => void newNote()}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                New note
              </button>
              <button
                class="sb-icon"
                onClick={() => void newSection()}
                title={`New section (⌥${mod}N)`}
                aria-label="New section"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  aria-hidden="true"
                >
                  <path
                    d="M1.8 4.2a1 1 0 0 1 1-1h3.4l1.4 1.6h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"
                    stroke-linejoin="round"
                  />
                  <path d="M8 7.2v3.6M6.2 9h3.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </>
        )}
      </Show>
      <Ghost />
      <SidebarDialogs />
      <div
        class="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        onPointerDown={onResize}
      />
    </nav>
  );
}

/** Show the sidebar again (⌘\, or the button where it was). */
export function SidebarToggle() {
  return (
    <button
      class="icon-btn sb-show"
      onClick={() => setSidebarOpen(true)}
      title={`Show the sidebar (${mod}\\)`}
      aria-label="Show the sidebar"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
      >
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </svg>
    </button>
  );
}

/** The note's place in the notebook at the top of the window; click the title to rename it. */
export function NoteTitle() {
  const [editing, setEditing] = createSignal(false);
  const rel = () => nb.current!;
  return (
    <span class="note-title">
      <For each={trail(rel())}>
        {(s) => (
          <>
            <span class="crumb" title={s.name}>
              {s.name}
            </span>
            <span class="crumb-sep" aria-hidden="true">
              ›
            </span>
          </>
        )}
      </For>
      <Show
        when={editing()}
        fallback={
          <button class="crumb-note" title="Rename" onClick={() => setEditing(true)} data-tauri-drag-region={false}>
            {titleOf(rel())}
          </button>
        }
      >
        <NameInput
          class="crumb-input"
          value={titleOf(rel())}
          onDone={(v) => {
            setEditing(false);
            if (v !== null) void rename(rel(), v);
          }}
        />
      </Show>
    </span>
  );
}
