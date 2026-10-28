// ⌘K: one box for every command, variable and symbol.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isMac } from "./api";
import { insertSnippet } from "./insert";
import { activeView } from "./richtext";
import { layout, revealRegion, state } from "./store";
import { isTemplate, STRUCTURES, SYMBOLS } from "./symbols";
import { baseName } from "./trace";

export const [paletteOpen, setPaletteOpen] = createSignal(false);

interface Item {
  label: string;
  /** Shortcut or what kind of item this is, shown on the right. */
  hint: string;
  group: "Commands" | "Go to" | "Insert";
  run: () => void;
}

const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";
const alt = isMac ? "⌥" : "Alt+";

/** Menu commands: id, label, shortcut. Formatting and arranging appear only when they apply. */
const COMMANDS: [string, string, string][] = [
  ["new", "New Document", `${mod}N`],
  ["new_from_template", "New from Template…", `${mod}${shift}N`],
  ["open", "Open…", `${mod}O`],
  ["save", "Save", `${mod}S`],
  ["save_as", "Save As…", `${mod}${shift}S`],
  ["save_template", "Save as Template…", ""],
  ["export_pdf", "Export as PDF…", `${mod}E`],
  ["print", "Print…", `${mod}P`],
  ["document_settings", "Document Settings…", `${mod}${alt},`],
  ["page_setup", "Page Setup…", ""],
  ["settings", "Settings…", `${mod},`],
  ["undo", "Undo", `${mod}Z`],
  ["redo", "Redo", `${mod}${shift}Z`],
  ["duplicate", "Duplicate", `${mod}D`],
  ["select_all", "Select All", `${mod}A`],
  ["find", "Find…", `${mod}F`],
  ["find_replace", "Find and Replace…", `${mod}${alt}F`],
  ["insert_math", "Insert Math", `${mod}${shift}M`],
  ["insert_text", "Insert Text Region", `${mod}${shift}T`],
  ["insert_image", "Insert Image…", `${mod}${shift}I`],
  ["insert_table", "Insert Table", `${mod}${alt}T`],
  ["insert_plot", "Insert Plot", `${mod}${alt}P`],
  ["insert_area", "Insert Area", ""],
  ["insert_ref", "Insert Cross-Reference…", `${mod}${shift}R`],
  ["insert_toc", "Insert Table of Contents", ""],
  ["insert_figures", "Insert List of Figures", ""],
  ["insert_tables", "Insert List of Tables", ""],
  ["page_view", "Toggle Page View", `${mod}${shift}P`],
  ["toggle_inspector", "Show Inspector", `${mod}${alt}I`],
  ["region_properties", "Region Properties", ""],
  ["zoom_in", "Zoom In", `${mod}=`],
  ["zoom_out", "Zoom Out", `${mod}-`],
  ["zoom_reset", "Actual Size", `${mod}0`],
  ["next_error", "Next Error", `${mod}'`],
  ["help", "Quire Help", isMac ? "⌘?" : "F1"],
  ["check_updates", "Check for Updates…", ""],
];

const TEXT_COMMANDS: [string, string, string][] = [
  ["fmt_bold", "Bold", `${mod}B`],
  ["fmt_italic", "Italic", `${mod}I`],
  ["fmt_underline", "Underline", `${mod}U`],
  ["fmt_strike", "Strikethrough", ""],
  ["fmt_bullets", "Bulleted List", ""],
  ["fmt_numbers", "Numbered List", ""],
  ["fmt_align_left", "Align Text Left", ""],
  ["fmt_align_center", "Center Text", ""],
  ["fmt_align_right", "Align Text Right", ""],
  ["fmt_align_justify", "Justify Text", ""],
];

const ARRANGE_COMMANDS: [string, string, string][] = [
  ["arrange_left", "Align Left Edges", ""],
  ["arrange_hcenter", "Align Centres", ""],
  ["arrange_right", "Align Right Edges", ""],
  ["arrange_top", "Align Tops", ""],
  ["arrange_vcenter", "Align Middles", ""],
  ["arrange_bottom", "Align Bottoms", ""],
  ["distribute_x", "Distribute Horizontally", ""],
  ["distribute_y", "Distribute Vertically", ""],
];

const SNIPPETS = [...SYMBOLS, ...STRUCTURES].flatMap((c) =>
  c.items.filter((x) => !x.textOnly).map((x) => ({ x, category: c.title })),
);

function items(runCommand: (id: string) => void): Item[] {
  const cmds = [...COMMANDS, ...(activeView() ? TEXT_COMMANDS : []), ...(state.selection.length > 1 ? ARRANGE_COMMANDS : [])];
  const out: Item[] = cmds.map(([id, label, hint]) => ({ label, hint, group: "Commands", run: () => runCommand(id) }));
  // each variable once, at its first definition
  const seen = new Set<string>();
  for (const p of layout().list) {
    const name = baseName(state.views[p.region.id]?.defines);
    if (!name || seen.has(name) || p.hidden) continue;
    seen.add(name);
    const id = p.region.id;
    out.push({ label: name, hint: "definition", group: "Go to", run: () => revealRegion(id) });
  }
  for (const { x, category } of SNIPPETS) {
    const shown = x.label ?? x.insert.replace(/\?/g, "□");
    out.push({
      label: `${shown}  ${x.name}`,
      hint: category,
      group: "Insert",
      run: () => insertSnippet(x.insert, { template: isTemplate(x) }),
    });
  }
  return out;
}

/** Lower is better; null when it doesn't match. */
function score(label: string, query: string): number | null {
  const l = label.toLowerCase();
  if (l.startsWith(query)) return 0;
  if (new RegExp(`(^|[\\s(—-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(l)) return 1;
  if (l.includes(query)) return 2;
  let i = 0;
  for (const ch of l) if (ch === query[i]) i++;
  return i === query.length ? 3 : null;
}

const GROUPS = ["Commands", "Go to", "Insert"] as const;

export function Palette(props: { runCommand: (id: string) => void }) {
  return (
    <Show when={paletteOpen()}>
      <Dialog {...props} />
    </Show>
  );
}

function Dialog(props: { runCommand: (id: string) => void }) {
  // the math or text being edited stays open: a symbol goes in at its caret
  const previous = document.activeElement as HTMLElement | null;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const all = createMemo(() => items(props.runCommand));
  const results = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return all().filter((i) => i.group !== "Insert").slice(0, 60);
    const scored = all().flatMap((item, order) => {
      const s = score(item.label, q);
      return s === null ? [] : [{ item, s, order }];
    });
    // groups stay together, the best-matching group first
    const best = new Map<string, number>();
    for (const x of scored) best.set(x.item.group, Math.min(best.get(x.item.group) ?? 9, x.s));
    const rank = (x: (typeof scored)[number]) => best.get(x.item.group)! * 10 + GROUPS.indexOf(x.item.group);
    scored.sort((a, b) => rank(a) - rank(b) || a.s - b.s || a.order - b.order);
    return scored.slice(0, 60).map((x) => x.item);
  });
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  const close = (then?: () => void) => {
    setPaletteOpen(false);
    if (previous?.isConnected) previous.focus();
    then?.();
  };
  const choose = (i: number) => {
    const item = results()[i];
    if (item) close(item.run);
  };
  const move = (by: number) => {
    const n = results().length;
    if (!n) return;
    setActive((active() + by + n) % n);
    list.querySelector(`[data-i="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    // the box's keys are its own (⌘A selects the query, not the document)
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") choose(active());
    else return;
    e.preventDefault();
  };
  onMount(() => input.focus());
  onCleanup(() => setActive(0));

  return (
    <div class="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          class="palette-input"
          placeholder="Search commands, variables and symbols"
          value={query()}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <div class="palette-list" ref={list} role="listbox">
          <For each={results()} fallback={<div class="palette-empty">Nothing matches</div>}>
            {(item, i) => (
              <>
                <Show when={i() === 0 || results()[i() - 1].group !== item.group}>
                  <div class="palette-group">{item.group}</div>
                </Show>
                <div
                  class="palette-item"
                  classList={{ active: i() === active() }}
                  data-i={i()}
                  role="option"
                  aria-selected={i() === active()}
                  onPointerMove={() => setActive(i())}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(i())}
                >
                  <span class="palette-label">{item.label}</span>
                  <span class="palette-hint">{item.hint}</span>
                </div>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
