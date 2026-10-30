// The notebook sidebar: switch notebooks, search every note, and arrange sections and
// notes by dragging, as in OneNote, Notion and Obsidian.
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { announce } from "./a11y";
import { api, DOC_EXT, isMac, pickNewNotebookPath, pickNotebookFolder } from "./api";
import { closeMenu, type MenuItems, setMenu } from "./menu";
import {
  closeNotebook,
  duplicate,
  find,
  forgetNotebook,
  type Hit,
  moveTo,
  nb,
  type NbNode,
  newNote,
  newSection,
  openNote,
  openNotebook,
  parentOf,
  recentNotebooks,
  rename,
  setExpanded,
  setNb,
  setQuery,
  setSidebarOpen,
  setSidebarWidth,
  setStyle,
  sidebarWidth,
  titleOf,
  trail,
  trashItem,
  walk,
} from "./notebook";
import { flash } from "./store";

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

export async function openNotebookDialog() {
  const path = await pickNotebookFolder();
  if (path) await openNotebookAt(path);
}

export async function openNotebookAt(path: string) {
  try {
    await openNotebook(path);
  } catch (e) {
    flash(`Could not open ${folderName(path)}: ${(e as Error).message}`);
    forgetNotebook(path);
  }
}

export async function newNotebookDialog() {
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
    ...others.map((p) => ({ label: folderName(p), run: () => (closeMenu(), void openNotebookAt(p)) })),
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

function itemMenu(node: NbNode | null, x: number, y: number) {
  const go = (fn: () => void) => () => (closeMenu(), fn());
  let items: MenuItems;
  if (!node) {
    items = [
      { label: "New Note", shortcut: `${mod}N`, run: go(() => void newNote("")) },
      { label: "New Section", shortcut: `⌥${mod}N`, run: go(() => void newSection("")) },
    ];
  } else if (node.kind === "section") {
    items = [
      { label: "New Note in Section", run: go(() => void newNote(node.rel)) },
      { label: "New Section Inside", run: go(() => void newSection(node.rel)) },
      null,
      { label: "Rename", shortcut: "F2", run: go(() => setNb("renaming", node.rel)) },
      null,
      { label: "No Colour", checked: !node.color, run: go(() => void setStyle(node.rel, { color: null })) },
      ...COLORS.map(([name, c]) => ({
        label: name,
        swatch: c,
        checked: node.color === c,
        run: go(() => void setStyle(node.rel, { color: c })),
      })),
      null,
      { label: "Move to Trash", shortcut: `${mod}⌫`, run: go(() => void trashItem(node.rel)) },
    ];
  } else {
    items = [
      { label: "Open", run: go(() => void openNote(node.rel)) },
      { label: "Rename", shortcut: "F2", run: go(() => setNb("renaming", node.rel)) },
      { label: "Duplicate", run: go(() => void duplicate(node.rel)) },
      null,
      { label: "Move to Trash", shortcut: `${mod}⌫`, run: go(() => void trashItem(node.rel)) },
    ];
  }
  setMenu({ x, y, items });
}

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

type Where = "before" | "after" | "inside";
const [dragging, setDragging] = createSignal<string | null>(null);
const [drop, setDrop] = createSignal<{ rel: string; where: Where } | null>(null);

function dropAllowed(from: string, onto: string, where: Where) {
  const dest = where === "inside" ? onto : parentOf(onto);
  return from !== onto && dest !== from && !dest.startsWith(`${from}/`);
}

async function dropOn(onto: string | null, where: Where) {
  const from = dragging();
  setDragging(null);
  setDrop(null);
  if (!from) return;
  if (onto === null) return void moveTo(from, "", undefined); // empty space: the end of the notebook
  if (!dropAllowed(from, onto, where)) return;
  if (where === "inside") return void moveTo(from, onto, undefined);
  const dir = parentOf(onto);
  const siblings = (dir ? (find(dir)?.children ?? []) : (nb.book?.children ?? []))
    .map((n) => n.rel)
    .filter((r) => r !== from);
  const at = siblings.indexOf(onto) + (where === "after" ? 1 : 0);
  await moveTo(from, dir, at);
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

function Row(props: { node: NbNode; depth: number }) {
  const n = () => props.node;
  const open = () => !!nb.expanded[n().rel];
  const isSection = () => n().kind === "section";
  const current = () => nb.current === n().rel;
  const marker = () => (drop()?.rel === n().rel ? drop()!.where : null);
  const activate = () => (isSection() ? setExpanded(n().rel, !open()) : void openNote(n().rel));
  return (
    <li role="none">
      <div
        class="nb-row"
        classList={{
          section: isSection(),
          current: current(),
          "drop-before": marker() === "before",
          "drop-after": marker() === "after",
          "drop-inside": marker() === "inside",
          dragging: dragging() === n().rel,
        }}
        role="treeitem"
        aria-level={props.depth + 1}
        aria-expanded={isSection() ? open() : undefined}
        aria-selected={current()}
        aria-label={isSection() ? `${n().name}, section` : n().name}
        data-rel={n().rel}
        tabIndex={current() ? 0 : -1}
        style={{ "padding-left": `${8 + props.depth * 16}px`, "--nb-color": n().color ?? "" }}
        draggable={nb.renaming !== n().rel}
        onClick={activate}
        onDblClick={() => !isSection() && setNb("renaming", n().rel)}
        onContextMenu={(e) => {
          e.preventDefault();
          itemMenu(n(), e.clientX, e.clientY);
        }}
        onDragStart={(e) => {
          setDragging(n().rel);
          e.dataTransfer?.setData("text/plain", n().name);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => (setDragging(null), setDrop(null))}
        onDragOver={(e) => {
          const from = dragging();
          if (!from) return;
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = (e.clientY - box.top) / box.height;
          const where: Where = isSection()
            ? y < 0.28
              ? "before"
              : y > 0.72 && !open()
                ? "after"
                : "inside"
            : y < 0.5
              ? "before"
              : "after";
          if (!dropAllowed(from, n().rel, where)) return setDrop(null);
          e.preventDefault();
          e.stopPropagation();
          setDrop({ rel: n().rel, where });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const d = drop();
          void dropOn(n().rel, d?.rel === n().rel ? d.where : "after");
        }}
      >
        <span
          class="nb-chevron"
          classList={{ open: open(), none: !isSection() }}
          aria-hidden="true"
          onClick={(e) => {
            if (!isSection()) return;
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
        {/* an empty section offers its first note, as an item of its own in the tree */}
        <ul role="group" class="nb-group">
          <li role="none">
            <div
              class="nb-empty-section"
              role="treeitem"
              aria-level={props.depth + 2}
              aria-label={`Add a note to ${n().name}`}
              data-add={n().rel}
              tabIndex={-1}
              style={{ "padding-left": `${30 + (props.depth + 1) * 16}px` }}
              onClick={() => void newNote(n().rel)}
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
    rows.forEach((x) => (x.tabIndex = -1));
    r.tabIndex = 0;
    r.focus();
  };
  const cmd = isMac ? e.metaKey : e.ctrlKey;
  switch (e.key) {
    case "ArrowDown":
      focus(at + 1);
      break;
    case "ArrowUp":
      focus(at - 1);
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
      if (node.kind === "section") setExpanded(node.rel, !nb.expanded[node.rel]);
      else {
        // opened from the keyboard, focus stays in the tree for the next arrow key; the page
        // is a Tab or Esc away
        const rel = node.rel;
        void openNote(rel).then(() =>
          setTimeout(() =>
            root.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)?.focus({ preventScroll: true }),
          ),
        );
      }
      break;
    case "F2":
      if (node) setNb("renaming", node.rel);
      break;
    case "Backspace":
    case "Delete":
      // plain Backspace does nothing here, but is kept from the browser, which would go back a page
      if (node && (e.key === "Delete" || cmd)) void trashItem(node.rel);
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
                <button class="nb-hit" title={p} onClick={() => void openNotebookAt(p)}>
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
              onDragOver={(e) => {
                if (!dragging() || (e.target as HTMLElement).closest(".nb-row")) return;
                e.preventDefault();
                setDrop(null);
              }}
              onDrop={(e) => {
                if ((e.target as HTMLElement).closest(".nb-row")) return;
                e.preventDefault();
                void dropOn(null, "after");
              }}
            >
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
                  role="tree"
                  aria-label={book().name}
                  onKeyDown={(e) => tree && treeKeys(e, tree)}
                >
                  <For each={book().children}>{(n) => <Row node={n} depth={0} />}</For>
                </ul>
                <Show when={count() === 0 && !book().children.length}>
                  <p class="nb-hint">This notebook is empty.</p>
                </Show>
              </Show>
            </div>
            <div class="sidebar-foot">
              <button class="nb-new" onClick={() => void newNote()}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                New note
              </button>
              <button
                class="sb-icon"
                onClick={() => void newSection("")}
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
