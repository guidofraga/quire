// ⌘K: one box for every command, variable and symbol. The order is commands.ts's.
import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { useModal } from "./a11y";
import { isMac, isWeb } from "./api";
import { type Area, arrange, type Command, type Item, recentCommands, rememberCommand } from "./commands";
import { Icon, type IconName } from "./icons";
import { insertSnippet } from "./insert";
import { activeView } from "./richtext";
import { layout, revealRegion, state } from "./store";
import { isTemplate, STRUCTURES, SYMBOLS } from "./symbols";
import { baseName } from "./trace";
import { nb, notes, openNote, trail } from "./notebook";

export const [paletteOpen, setPaletteOpen] = createSignal(false);

const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";
const alt = isMac ? "⌥" : "Alt+";

type Row = [id: string, label: string, keys: string, icon: IconName];
const area = (a: Area, rows: Row[]): Command[] =>
  rows.map(([id, label, keys, icon]) => ({ id, label, keys, icon, area: a }));

/** Menu commands by area, as the menus have them. Formatting and arranging appear only when they apply. */
const COMMANDS: Command[] = [
  ...area("File", [
    ["new_document", "New Document", "", "newDoc"],
    ["new_from_template", "New from Template…", `${shift}${mod}N`, "template"],
    ["open", "Open…", `${mod}O`, "folder"],
    ["save", "Save", `${mod}S`, "save"],
    ["save_as", "Save As…", `${shift}${mod}S`, "save"],
    ["save_template", "Save as Template…", "", "template"],
    ["export_pdf", "Export as PDF…", `${mod}E`, "export"],
    ["export_docx", "Export as Word…", "", "export"],
    ["share_link", "Share Link…", "", "link"],
    ["print", "Print…", `${mod}P`, "print"],
    ["document_settings", "Document Settings…", `${alt}${mod},`, "doc"],
    ["page_setup", "Page Setup…", "", "page"],
    ["edit_header", "Edit Header", "", "header"],
    ["edit_footer", "Edit Footer", "", "footer"],
    ["settings", "Settings…", `${mod},`, "settings"],
  ]),
  ...area("Edit", [
    ["undo", "Undo", `${mod}Z`, "undo"],
    ["redo", "Redo", `${shift}${mod}Z`, "redo"],
    ["duplicate", "Duplicate", `${mod}D`, "duplicate"],
    ["select_all", "Select All", `${mod}A`, "selectAll"],
    ["find", "Find…", `${mod}F`, "find"],
    ["find_replace", "Find and Replace…", `${alt}${mod}F`, "find"],
  ]),
  ...area("Insert", [
    ["insert_math", "Insert Math", `${shift}${mod}M`, "math"],
    ["insert_text", "Insert Text Region", `${shift}${mod}T`, "text"],
    ["insert_image", "Insert Image…", `${shift}${mod}I`, "image"],
    ["insert_table", "Insert Table", `${alt}${mod}T`, "table"],
    ["import_csv", "Insert Table from CSV…", "", "table"],
    ["insert_plot", "Insert Plot", `${alt}${mod}P`, "plot"],
    ["insert_plot3d", "Insert 3D Plot", "", "plot3d"],
    ["insert_sketch", "Insert Sketch", "", "sketch"],
    ["insert_area", "Insert Area", "", "area"],
    ["insert_solve", "Insert Solve Block", "", "solve"],
    ["insert_pagebreak", "Insert Page Break", `${mod}↩`, "pageBreak"],
    ["insert_ref", "Insert Cross-Reference…", `${shift}${mod}R`, "ref"],
    ["insert_toc", "Insert Table of Contents", "", "list"],
    ["insert_figures", "Insert List of Figures", "", "list"],
    ["insert_tables", "Insert List of Tables", "", "list"],
    ["insert_checks", "Insert Summary of Checks", "", "check"],
  ]),
  ...area("View", [
    ["page_view", "Toggle Page View", `${shift}${mod}P`, "page"],
    ["toggle_page_guides", "Show or Hide Page Guides", "", "guides"],
    ["toggle_inspector", "Show Inspector", `${alt}${mod}I`, "inspector"],
    ["region_properties", "Region Properties", "", "inspector"],
    ["zoom_in", "Zoom In", `${mod}=`, "zoomIn"],
    ["zoom_out", "Zoom Out", `${mod}-`, "zoomOut"],
    ["zoom_reset", "Actual Size", `${mod}0`, "find"],
    ["zoom_fit_width", "Zoom to Width", "", "fitWidth"],
    ["zoom_fit_page", "Zoom to Page", "", "fitPage"],
    ["next_error", "Next Error", `${mod}'`, "error"],
  ]),
  ...area("Notebook", [
    ["new_section", "New Section", `${alt}${mod}N`, "newFolder"],
    ["new_notebook", "New Notebook…", "", "notebook"],
    ["open_notebook", "Open Notebook…", `${shift}${mod}O`, "notebook"],
    ["search_notebook", "Search Notebook…", `${shift}${mod}F`, "find"],
    ["toggle_sidebar", "Show or Hide Sidebar", `${mod}\\`, "sidebar"],
  ]),
  ...area("Help", [
    ["help", "Quire Help", isMac ? "⌘?" : "F1", "help"],
    ["welcome", "Welcome Screen", "", "home"],
    ["check_updates", "Check for Updates…", "", "update"],
  ]),
];

/** ⌘N: a new note in a notebook, else a new document (where New Document is then the same). */
const NEW_NOTE: Command = { id: "new", label: "New Note", keys: `${mod}N`, area: "Notebook", icon: "note" };
const NEW_DOC: Command = { id: "new", label: "New Document", keys: `${mod}N`, area: "File", icon: "newDoc" };

/** Commands that need files on disk: notebooks and templates of your own. */
const WEB_HIDDEN = new Set([
  "new_section",
  "new_notebook",
  "open_notebook",
  "search_notebook",
  "toggle_sidebar",
  "save_template",
]);

const TEXT_COMMANDS: Command[] = area("Format", [
  ["fmt_bold", "Bold", `${mod}B`, "format"],
  ["fmt_italic", "Italic", `${mod}I`, "format"],
  ["fmt_underline", "Underline", `${mod}U`, "format"],
  ["fmt_strike", "Strikethrough", "", "format"],
  ["fmt_bullets", "Bulleted List", "", "list"],
  ["fmt_numbers", "Numbered List", "", "list"],
  ["fmt_align_left", "Align Text Left", "", "align"],
  ["fmt_align_center", "Center Text", "", "align"],
  ["fmt_align_right", "Align Text Right", "", "align"],
  ["fmt_align_justify", "Justify Text", "", "align"],
]);

const ARRANGE_COMMANDS: Command[] = area("Format", [
  ["arrange_left", "Align Left Edges", "", "arrange"],
  ["arrange_hcenter", "Align Centres", "", "arrange"],
  ["arrange_right", "Align Right Edges", "", "arrange"],
  ["arrange_top", "Align Tops", "", "arrange"],
  ["arrange_vcenter", "Align Middles", "", "arrange"],
  ["arrange_bottom", "Align Bottoms", "", "arrange"],
  ["distribute_x", "Distribute Horizontally", "", "arrange"],
  ["distribute_y", "Distribute Vertically", "", "arrange"],
]);

const SNIPPETS = [...SYMBOLS, ...STRUCTURES].flatMap((c) =>
  c.items.filter((x) => !x.textOnly).map((x) => ({ x, category: c.title })),
);

function items(runCommand: (id: string) => void): Item[] {
  const book = !!nb.book;
  const cmds = [
    book ? NEW_NOTE : NEW_DOC,
    ...COMMANDS.filter(({ id }) => !(isWeb && WEB_HIDDEN.has(id)) && !(id === "new_document" && !book)),
    ...(activeView() ? TEXT_COMMANDS : []),
    ...(state.selection.length > 1 ? ARRANGE_COMMANDS : []),
  ];
  const out: Item[] = cmds.map((c) => ({
    label: c.label,
    hint: c.keys,
    group: c.area,
    icon: c.icon,
    command: c.id,
    run: () => {
      rememberCommand(c.id);
      runCommand(c.id);
    },
  }));
  // every note of the notebook, with its section ("Kinematics — Mechanics")
  for (const n of book ? notes() : []) {
    const where = trail(n.rel)
      .map((s) => s.name)
      .join(" › ");
    out.push({
      label: where ? `${n.name} — ${where}` : n.name,
      hint: "note",
      group: "Go to",
      icon: "note",
      run: () => void openNote(n.rel),
    });
  }
  // each variable once, at its first definition
  const seen = new Set<string>();
  for (const p of layout().list) {
    const name = baseName(state.views[p.region.id]?.defines);
    if (!name || seen.has(name) || p.hidden) continue;
    seen.add(name);
    const id = p.region.id;
    out.push({ label: name, hint: "definition", group: "Go to", icon: "variable", run: () => revealRegion(id) });
  }
  for (const { x, category } of SNIPPETS) {
    const shown = x.label ?? x.insert.replace(/\?/g, "□");
    out.push({
      label: `${shown}  ${x.name}`,
      hint: category,
      group: "Symbols",
      icon: "math",
      run: () => insertSnippet(x.insert, { template: isTemplate(x) }),
    });
  }
  return out;
}

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
  const recent = recentCommands();
  const sections = createMemo(() => arrange(all(), query(), recent, !!nb.book));
  // every row in order, and where each section's rows start
  const rows = createMemo(() => sections().flatMap((s) => s.items));
  const starts = createMemo(() => {
    let n = 0;
    return sections().map((s) => ((n += s.items.length), n - s.items.length));
  });
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  const close = (then?: () => void) => {
    setPaletteOpen(false);
    if (previous?.isConnected) previous.focus();
    then?.();
  };
  const choose = (i: number) => {
    const item = rows()[i];
    if (item) close(item.run);
  };
  const move = (by: number) => {
    const n = rows().length;
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
  let el!: HTMLDivElement;
  useModal(() => el);

  return (
    <div class="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={el}>
        <div class="palette-search">
          <Icon name="find" class="palette-search-icon" />
          <input
            ref={input}
            class="palette-input"
            role="combobox"
            aria-label="Command, variable or symbol"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={rows().length ? `palette-item-${active()}` : undefined}
            placeholder="Search commands, variables and symbols"
            value={query()}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
              list.scrollTop = 0;
            }}
            onKeyDown={onKey}
          />
        </div>
        <div class="palette-list" ref={list} role="listbox" id="palette-list" aria-label="Results">
          <Show when={rows().length} fallback={<div class="palette-empty">Nothing matches</div>}>
            <For each={sections()}>
              {(section, k) => (
                // a group a screen reader names as it moves into it
                <div class="palette-section" role="group" aria-label={section.group}>
                  <div class="palette-group" aria-hidden="true">
                    {section.group}
                  </div>
                  <Index each={section.items}>
                    {(item, j) => {
                      const i = () => starts()[k()] + j;
                      return (
                        <div
                          class="palette-item"
                          classList={{ active: i() === active() }}
                          id={`palette-item-${i()}`}
                          data-i={i()}
                          role="option"
                          aria-selected={i() === active()}
                          onPointerMove={() => setActive(i())}
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={() => choose(i())}
                        >
                          <span class="palette-icon">
                            <Icon name={item().icon} />
                          </span>
                          <span class="palette-label">{item().label}</span>
                          <span class="palette-hint">{item().hint}</span>
                        </div>
                      );
                    }}
                  </Index>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
