// The ribbon under the toolbar: one stable layout (Text · Paragraph · Equation · Arrange),
// each group enabled by context instead of swapping controls in and out.
import { AllSelection, type Command } from "prosemirror-state";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { arrowFocus, focusables, fromKeyboard, toolbarKeys } from "./a11y";
import { focusCanvas } from "./Canvas";
import { insertSnippet, library, loadLibrary, loadPreviews, previews, valueText } from "./insert";
import {
  activeView,
  type Align,
  type BlockStyle,
  commands,
  currentAlign,
  currentMarkAttr,
  currentStyle,
  listActive,
  markActive,
  run,
} from "./richtext";
import {
  type AlignMode,
  alignRegions,
  commitEditing,
  distributeRegions,
  layout,
  setState,
  startEditing,
  state,
} from "./store";
import { STRUCTURES, SYMBOLS, type Sym } from "./symbols";

const keep = (e: MouseEvent) => e.preventDefault(); // never steal focus from the editor

/** The name a screen reader gives a button: its tooltip without the shortcut. */
const nameOf = (title: string) => title.split("  ")[0];

function Btn(props: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: JSX.Element;
  hiddenLabel?: boolean;
}) {
  return (
    <button
      class="fb-btn"
      classList={{ on: !!props.active }}
      title={props.title}
      // content hidden from screen readers (x²) leaves the tooltip as the name
      aria-label={props.hiddenLabel ? undefined : nameOf(props.title)}
      aria-pressed={props.active === undefined ? undefined : !!props.active}
      disabled={props.disabled}
      onMouseDown={keep}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

let popSeq = 0;

/**
 * A button with a popover under it: a menu of choices (`kind: "menu"`) or a gallery.
 * From the keyboard, opening it moves focus in, arrows move between its items and Esc
 * closes it and returns to the button; with the mouse, focus stays in the editor.
 */
function Dropdown(props: {
  label: JSX.Element;
  title: string;
  /** What a screen reader calls the button (its text by default), and the popover. */
  name?: string;
  popName?: string;
  kind?: "menu" | "gallery";
  disabled?: boolean;
  class?: string;
  onOpen?: () => void;
  children: (close: () => void) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const popId = `fb-pop-${++popSeq}`;
  let root!: HTMLDivElement;
  let button!: HTMLButtonElement;
  let pop: HTMLDivElement | undefined;
  const items = () =>
    pop ? (props.kind === "menu" ? [...pop.querySelectorAll<HTMLElement>("[role^=menuitem]")] : focusables(pop)) : [];
  // where focus goes back to when it closes without a pick: the math or text being edited
  // when it was opened from there with the mouse, else the button
  let returnTo: HTMLElement | null = null;
  const back = () => {
    const el = returnTo?.isConnected && !root.contains(returnTo) ? returnTo : button;
    el.focus({ preventScroll: true });
  };
  const close = () => {
    const inside = root.contains(document.activeElement);
    setOpen(false);
    if (inside) back();
  };
  const show = () => {
    const active = document.activeElement;
    returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
    props.onOpen?.();
    setOpen(true);
    if (!fromKeyboard()) return;
    // the current choice (or selected tab) first, else the first item
    requestAnimationFrame(() =>
      (pop?.querySelector<HTMLElement>("[aria-checked=true], [aria-selected=true]") ?? items()[0])?.focus(),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open()) {
      if (e.key === "ArrowDown" && e.target === button) {
        e.preventDefault();
        e.stopPropagation();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      back();
    } else if (e.key === "Tab" && props.kind === "menu") {
      e.preventDefault();
      close();
    } else if (pop?.contains(e.target as Node)) {
      // a gallery with tabs: ←/→ between the tabs, ↓ into the tab's symbols, ↑ from the top row back
      const tabs = [...pop.querySelectorAll<HTMLElement>("[role=tab]")];
      const target = e.target as HTMLElement;
      if (target.matches("[role=tab]")) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          pop.querySelector<HTMLElement>("[role=tabpanel] button")?.focus();
        } else arrowFocus(e, tabs, "horizontal");
        return;
      }
      if (
        arrowFocus(
          e,
          items().filter((el) => !tabs.includes(el)),
          props.kind === "menu" ? "vertical" : "both",
        ) &&
        document.activeElement === target &&
        e.key === "ArrowUp"
      )
        pop.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
    }
  };
  const onDoc = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  };
  // opened with the mouse while typing, focus stayed in the editor: Esc closes this first,
  // and the editor keeps focus and its text
  const onEsc = (e: KeyboardEvent) => {
    if (!open() || e.key !== "Escape" || root.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setOpen(false);
  };
  onMount(() => {
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onEsc, true);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDoc);
    window.removeEventListener("keydown", onEsc, true);
  });
  return (
    <div
      class="fb-dropdown"
      ref={root}
      onKeyDown={onKey}
      onFocusOut={(e) => {
        // Tab out of a gallery closes it
        if (open() && e.relatedTarget && !root.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        class="fb-btn fb-select"
        classList={{ on: open() }}
        title={props.title}
        aria-label={props.name}
        aria-haspopup={props.kind === "menu" ? "menu" : "dialog"}
        aria-expanded={open()}
        aria-controls={open() ? popId : undefined}
        disabled={props.disabled}
        onMouseDown={keep}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        {props.label}
        <svg class="chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <Show when={open()}>
        <div
          id={popId}
          class={`fb-pop ${props.class ?? ""}`}
          role={props.kind === "menu" ? "menu" : "dialog"}
          aria-label={props.popName ?? props.name ?? props.title}
          onMouseDown={keep}
          ref={(el) => {
            pop = el;
            keepInWindow(el);
          }}
        >
          {props.children(close)}
        </div>
      </Show>
    </div>
  );
}

/** Slide a popover sideways so it stays inside a narrow window. */
function keepInWindow(el: HTMLElement) {
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    const margin = 8;
    const shift =
      r.left < margin
        ? margin - r.left
        : r.right > innerWidth - margin
          ? Math.max(margin - r.left, innerWidth - margin - r.right)
          : 0;
    if (!shift) return;
    el.style.left = `${el.offsetLeft + shift}px`;
    el.style.right = "auto";
  });
}

const icon = (d: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
  >
    <path d={d} />
  </svg>
);

// ---------------------------------------------------------------------------
// Text & paragraph
// ---------------------------------------------------------------------------

const STYLES: [BlockStyle, string][] = [
  ["body", "Body"],
  ["title", "Title"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
];
const COLORS = [
  "#1b1d22",
  "#6b7280",
  "#d1302a",
  "#e8730c",
  "#c79a00",
  "#2e8b3a",
  "#1d6fd1",
  "#6a3fc8",
  "#c2185b",
  "#0f766e",
];
const COLOR_NAMES = ["Automatic", "Grey", "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Pink", "Teal"];
const SIZES = [7, 8, 9, 10, 11, 12, 14, 16, 18, 24, 32];
const ALIGN_ICONS: Record<Align, string> = {
  left: "M2 3h12M2 6.5h8M2 10h12M2 13.5h8",
  center: "M2 3h12M4 6.5h8M2 10h12M4 13.5h8",
  right: "M2 3h12M6 6.5h8M2 10h12M6 13.5h8",
  justify: "M2 3h12M2 6.5h12M2 10h12M2 13.5h12",
};

/** The text region that formatting applies to when no text is being edited. */
const selectedText = () =>
  state.selection.length === 1 && !state.editing
    ? layout().byId.get(state.selection[0])?.region.kind === "text"
      ? state.selection[0]
      : null
    : null;

const textEnabled = () => !!activeView() || !!selectedText();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a text command; with a text box selected (not being edited), apply it to the whole box. */
async function applyText(cmd: Command) {
  if (activeView()) return run(cmd);
  const id = selectedText();
  if (!id) return;
  startEditing(id);
  for (let i = 0; i < 60 && !activeView(); i++) await sleep(10);
  const view = activeView();
  if (!view) return;
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  run(cmd);
  commitEditing();
  setState({ selection: [id] });
}

function TextGroup() {
  const editing = () => !!activeView();
  return (
    <div class="fb-group">
      <Dropdown
        title="Paragraph style"
        name={`Paragraph style${editing() ? `: ${STYLES.find(([s]) => s === currentStyle())?.[1] ?? ""}` : ""}`}
        kind="menu"
        disabled={!textEnabled()}
        label={<span class="fb-style">{editing() ? STYLES.find(([s]) => s === currentStyle())?.[1] : "Style"}</span>}
      >
        {(close) => (
          <For each={STYLES}>
            {([s, label]) => (
              <button
                class={`fb-item style-${s}`}
                classList={{ on: editing() && currentStyle() === s }}
                role="menuitemradio"
                aria-checked={editing() && currentStyle() === s}
                onClick={() => {
                  close();
                  void applyText(commands.style(s));
                }}
              >
                {label}
              </button>
            )}
          </For>
        )}
      </Dropdown>
      <Btn
        title="Bold  ⌘B"
        disabled={!textEnabled()}
        active={markActive("strong")}
        onClick={() => applyText(commands.bold)}
      >
        <b>B</b>
      </Btn>
      <Btn
        title="Italic  ⌘I"
        disabled={!textEnabled()}
        active={markActive("em")}
        onClick={() => applyText(commands.italic)}
      >
        <i class="serif">I</i>
      </Btn>
      <Btn
        title="Underline  ⌘U"
        disabled={!textEnabled()}
        active={markActive("underline")}
        onClick={() => applyText(commands.underline)}
      >
        <u>U</u>
      </Btn>
      <Btn
        title="Strikethrough"
        disabled={!textEnabled()}
        active={markActive("strike")}
        onClick={() => applyText(commands.strike)}
      >
        <s>S</s>
      </Btn>
      <Btn
        title="Superscript"
        hiddenLabel
        disabled={!textEnabled()}
        active={markActive("sup")}
        onClick={() => applyText(commands.sup)}
      >
        <span aria-hidden="true">
          x<sup>2</sup>
        </span>
      </Btn>
      <Btn
        title="Subscript"
        hiddenLabel
        disabled={!textEnabled()}
        active={markActive("sub")}
        onClick={() => applyText(commands.sub)}
      >
        <span aria-hidden="true">
          x<sub>2</sub>
        </span>
      </Btn>
      <Dropdown
        title="Text colour"
        name="Text colour"
        kind="menu"
        disabled={!textEnabled()}
        label={<span class="fb-swatch" style={{ background: (currentMarkAttr("color") as string) ?? "#1b1d22" }} />}
      >
        {(close) => (
          <div class="fb-swatches">
            <For each={COLORS}>
              {(c, i) => (
                <button
                  class="fb-swatch big"
                  style={{ background: c }}
                  title={COLOR_NAMES[i()]}
                  role="menuitemradio"
                  aria-label={COLOR_NAMES[i()]}
                  aria-checked={((currentMarkAttr("color") as string | null) ?? COLORS[0]) === c}
                  onClick={() => {
                    close();
                    void applyText(commands.color(c === COLORS[0] ? null : c));
                  }}
                />
              )}
            </For>
          </div>
        )}
      </Dropdown>
      <Dropdown
        title="Font size"
        name={`Font size${currentMarkAttr("size") ? `: ${currentMarkAttr("size")} pt` : ""}`}
        kind="menu"
        disabled={!textEnabled()}
        label={<span class="fb-num">{(currentMarkAttr("size") as number | null) ?? "Size"}</span>}
      >
        {(close) => (
          <>
            <button
              class="fb-item"
              role="menuitemradio"
              aria-checked={!currentMarkAttr("size")}
              onClick={() => {
                close();
                void applyText(commands.size(null));
              }}
            >
              Default
            </button>
            <For each={SIZES}>
              {(sz) => (
                <button
                  class="fb-item"
                  classList={{ on: currentMarkAttr("size") === sz }}
                  role="menuitemradio"
                  aria-checked={currentMarkAttr("size") === sz}
                  onClick={() => {
                    close();
                    void applyText(commands.size(sz));
                  }}
                >
                  {sz} pt
                </button>
              )}
            </For>
          </>
        )}
      </Dropdown>
    </div>
  );
}

function ParagraphGroup() {
  return (
    <div class="fb-group">
      <For each={["left", "center", "right", "justify"] as Align[]}>
        {(a) => (
          <Btn
            title={{ left: "Align left", center: "Centre", right: "Align right", justify: "Justify" }[a]}
            disabled={!textEnabled()}
            active={!!activeView() && currentAlign() === a}
            onClick={() => applyText(commands.align(a))}
          >
            {icon(ALIGN_ICONS[a])}
          </Btn>
        )}
      </For>
      <Btn
        title="Bulleted list"
        disabled={!textEnabled()}
        active={listActive("bullet")}
        onClick={() => applyText(commands.bulletList)}
      >
        {icon("M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5M2.5 4h.1M2.5 8h.1M2.5 12h.1")}
      </Btn>
      <Btn
        title="Numbered list"
        disabled={!textEnabled()}
        active={listActive("ordered")}
        onClick={() => applyText(commands.orderedList)}
      >
        {icon("M6 4h8M6 8h8M6 12h8M2 3.2l.9-.7v3M1.9 7.3c.3-.5 1.6-.5 1.6.3 0 .6-1.6 1.3-1.6 1.9h1.7")}
      </Btn>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equation: structures and symbols (Word's equation ribbon)
// ---------------------------------------------------------------------------

function StructuresGallery(props: { close: () => void }) {
  return (
    <div class="gallery">
      <For each={STRUCTURES}>
        {(cat) => (
          <section class="gallery-section" aria-label={cat.title}>
            <h4 aria-hidden="true">{cat.title}</h4>
            <div class="gallery-grid structures">
              <For each={cat.items}>
                {(item) => (
                  <button
                    class="gallery-tile"
                    title={`${item.label}  \\${item.name}`}
                    onClick={() => {
                      props.close();
                      insertSnippet(item.insert, { template: true });
                    }}
                  >
                    <Show when={previews()[item.name]} fallback={<code>{item.insert}</code>}>
                      <span innerHTML={previews()[item.name]} aria-hidden="true" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

const SYMBOL_TABS = [
  ...SYMBOLS.map((c) => [c.id, c.title] as const),
  ["constants", "Constants"] as const,
  ["units", "Units"] as const,
];
const [symbolTab, setSymbolTab] = createSignal<string>("greek");

/** The list or grid a symbol tab shows. */
const panel = (id: string) => ({ id: `sympanel-${id}`, role: "tabpanel" as const, "aria-labelledby": `symtab-${id}` });

function SymbolsGallery(props: { close: () => void }) {
  const pick = (sym: Sym) => {
    props.close();
    insertSnippet(sym.insert);
  };
  const pickName = (name: string) => {
    props.close();
    insertSnippet(name);
  };
  return (
    <div class="gallery symbols">
      <div class="gallery-tabs" role="tablist" aria-label="Symbol sets">
        <For each={SYMBOL_TABS}>
          {([id, title]) => (
            <button
              classList={{ on: symbolTab() === id }}
              role="tab"
              id={`symtab-${id}`}
              aria-selected={symbolTab() === id}
              aria-controls={`sympanel-${id}`}
              onClick={() => setSymbolTab(id)}
            >
              {title}
            </button>
          )}
        </For>
      </div>
      <Show when={symbolTab() === "constants"}>
        <div class="gallery-list" {...panel("constants")}>
          <For each={library()?.constants ?? []}>
            {(c) => (
              <button class="gallery-row" onClick={() => pickName(c.name)}>
                <span class="row-name math-font">{c.name.replace(".", "")}</span>
                <span class="row-title">{c.title}</span>
                <span class="row-value">{valueText(c.value)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={symbolTab() === "units"}>
        <div class="gallery-list" {...panel("units")}>
          <For each={library()?.units ?? []}>
            {(u) => (
              <button class="gallery-row" onClick={() => pickName(u.name)}>
                <span class="row-name unit-color">{u.name}</span>
                <span class="row-title">{u.title}</span>
                <span class="row-value">{valueText(u.value)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <For each={SYMBOLS}>
        {(cat) => (
          <Show when={symbolTab() === cat.id}>
            <div class="gallery-grid" {...panel(cat.id)}>
              <For each={cat.items}>
                {(sym) => (
                  <button
                    class="gallery-tile symbol"
                    classList={{ "text-only": !!sym.textOnly }}
                    title={`\\${sym.name}`}
                    onClick={() => pick(sym)}
                  >
                    {sym.insert}
                  </button>
                )}
              </For>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}

function EquationGroup() {
  return (
    <div class="fb-group">
      <Dropdown
        title="Fractions, roots, integrals, matrices"
        popName="Structures"
        class="wide"
        onOpen={loadPreviews}
        label={
          <span class="fb-eq">
            <span class="math-font" aria-hidden="true">
              ∑
            </span>{" "}
            Structures
          </span>
        }
      >
        {(close) => <StructuresGallery close={close} />}
      </Dropdown>
      <Dropdown
        title="Symbols, constants and units (\name)"
        popName="Symbols"
        class="wide"
        onOpen={loadLibrary}
        label={
          <span class="fb-eq">
            <span class="math-font" aria-hidden="true">
              Ω
            </span>{" "}
            Symbols
          </span>
        }
      >
        {(close) => <SymbolsGallery close={close} />}
      </Dropdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------

const ARRANGE: [AlignMode, string, string][] = [
  ["left", "Align left edges", "M2 2v12M4 4h8M4 8h5M4 12h9"],
  ["hcenter", "Align centres", "M8 2v12M4 4h8M5.5 8h5M3.5 12h9"],
  ["right", "Align right edges", "M14 2v12M4 4h8M7 8h5M3 12h9"],
  ["top", "Align tops", "M2 2h12M4 4v8M8 4v5M12 4v9"],
  ["vcenter", "Align middles", "M2 8h12M4 4v8M8 5.5v5M12 3.5v9"],
  ["bottom", "Align bottoms", "M2 14h12M4 4v8M8 7v5M12 3v9"],
];

function ArrangeGroup() {
  const n = () => (state.editing ? 0 : state.selection.length);
  return (
    <div class="fb-group">
      <For each={ARRANGE}>
        {([mode, title, d]) => (
          <Btn title={title} disabled={n() < 2} onClick={() => alignRegions(state.selection, mode)}>
            {icon(d)}
          </Btn>
        )}
      </For>
      <Btn title="Distribute horizontally" disabled={n() < 3} onClick={() => distributeRegions(state.selection, "x")}>
        {icon("M2 3v10M14 3v10M6 5h4v6H6z")}
      </Btn>
      <Btn title="Distribute vertically" disabled={n() < 3} onClick={() => distributeRegions(state.selection, "y")}>
        {icon("M3 2h10M3 14h10M5 6h6v4H5z")}
      </Btn>
    </div>
  );
}

const GROUPS: { id: string; title: string; Group: () => JSX.Element }[] = [
  { id: "text", title: "Text", Group: TextGroup },
  { id: "paragraph", title: "Paragraph", Group: ParagraphGroup },
  { id: "equation", title: "Equation", Group: EquationGroup },
  { id: "arrange", title: "Arrange", Group: ArrangeGroup },
];
/** When the window is too narrow, groups move into the ⋯ menu in this order. */
const OVERFLOW_ORDER = ["arrange", "paragraph", "equation", "text"];
const MORE_WIDTH = 44;

export function FormatBar() {
  // natural widths, measured while each group is in the bar
  const widths: Record<string, number> = {};
  const [hidden, setHidden] = createSignal<string[]>([]);
  let bar!: HTMLDivElement;
  const fit = () => {
    for (const el of bar.querySelectorAll<HTMLElement>(":scope > .fb-slot")) widths[el.dataset.group!] = el.offsetWidth;
    if (GROUPS.some((g) => !widths[g.id])) return;
    const style = getComputedStyle(bar);
    const room = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const shown = new Set(GROUPS.map((g) => g.id));
    const need = () => [...shown].reduce((n, id) => n + widths[id], 0) + (shown.size < GROUPS.length ? MORE_WIDTH : 0);
    for (const id of OVERFLOW_ORDER) {
      if (need() <= room) break;
      shown.delete(id);
    }
    const next = GROUPS.filter((g) => !shown.has(g.id)).map((g) => g.id);
    if (next.join() !== hidden().join()) setHidden(next);
  };
  onMount(() => {
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    // web fonts change the widths once they load
    void document.fonts.ready.then(fit);
    onCleanup(() => ro.disconnect());
  });
  const inBar = (id: string) => !hidden().includes(id);
  return (
    <div class="formatbar" ref={bar} role="toolbar" aria-label="Format" onKeyDown={(e) => toolbarKeys(e, focusCanvas)}>
      <For each={GROUPS}>
        {(g) => (
          <Show when={inBar(g.id)}>
            <div class="fb-slot" data-group={g.id} role="group" aria-label={g.title}>
              <g.Group />
            </div>
          </Show>
        )}
      </For>
      <Show when={hidden().length}>
        <Dropdown
          label={
            <span class="fb-more" aria-hidden="true">
              ⋯
            </span>
          }
          title="More formatting"
          name="More formatting"
          class="wide fb-more-pop"
        >
          {() => (
            <For each={GROUPS.filter((g) => !inBar(g.id))}>
              {(g) => (
                <div class="fb-more-row" role="group" aria-label={g.title}>
                  <span class="fb-more-title">{g.title}</span>
                  <g.Group />
                </div>
              )}
            </For>
          )}
        </Dropdown>
      </Show>
    </div>
  );
}
