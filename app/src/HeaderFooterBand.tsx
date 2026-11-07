// Headers and footers on the page. Each sheet has a band in its top and bottom margins that
// shows the filled-in fields; a double-click (or Edit Header / Edit Footer) edits the band in
// place: three slots with fields as chips, a small toolbar beside it, one undo step in all.
// Print and PDF draw only the filled-in slots, as before.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { announce, focusables, toolbarKeys } from "./a11y";
import { focusCanvas } from "./Canvas";
import { Dropdown } from "./FormatBar";
import {
  type Band,
  chip,
  chipTypedFields,
  FIELDS,
  readSlot,
  renderSlot,
  type Slot,
  SlotHistory,
  SLOTS,
} from "./headerFooter";
import { type FieldContext, fillFields, type HeaderFooter } from "./pages";
import {
  commitEditing,
  layout,
  localized,
  mutate,
  sectionOn,
  setState,
  snap,
  state,
  togglePageView,
  undo,
  undoSession,
} from "./store";

/** Header and footer text when no colour is set (as on paper). */
const DEFAULT_COLOR = "#8a8f98";

const NAME: Record<Band, string> = { header: "Header", footer: "Footer" };
const SLOT_NAME: Record<Slot, string> = { left: "left", center: "centre", right: "right" };
const PLACEHOLDER: Record<Slot, string> = { left: "Left", center: "Centre", right: "Right" };

const COLORS: [string | undefined, string][] = [
  [undefined, "Automatic"],
  ["#1b1d22", "Black"],
  ["#555b65", "Dark grey"],
  ["#a9a9a9", "Light grey"],
  ["#1d5fa8", "Blue"],
  ["#b42318", "Red"],
  ["#1a7f37", "Green"],
];

const bandOf = (band: Band) => state.doc.page?.[band] as HeaderFooter | undefined;
const firstPage = () => (state.doc.page?.firstPage as { header?: boolean; footer?: boolean } | undefined) ?? {};
/** "Different first page": page 1 has its own band, which today's model keeps blank. */
const firstDiffers = (band: Band) => firstPage()[band] === false;
const blankOn = (band: Band, k: number) => k === 0 && firstDiffers(band);

function fileLabel(): string {
  return state.path?.replace(/\/+$/, "").split("/").pop() ?? "Untitled.quire";
}

/** The values fields take on page `k` (0-based). */
function fieldContext(k: number, pages: number): FieldContext {
  const meta = state.doc.meta ?? {};
  const start = (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
  return {
    page: start + k,
    pages,
    file: fileLabel(),
    title: localized(meta.title, meta.lang),
    author: ((meta.authors as string[] | undefined) ?? []).join(", "),
    company: String(meta.company ?? ""),
    lang: meta.lang,
    now: new Date(),
  };
}

function fill(text: string | undefined, k: number, pages: number): string {
  if (!text) return "";
  const c = fieldContext(k, pages);
  if (text.includes("{section}")) c.section = sectionOn(layout(), k, c.lang);
  return fillFields(text, c);
}

/** The three slots with their fields filled in: what the page shows, and what prints. */
function Slots(props: { hf: HeaderFooter; page: number; pages: number; style: Record<string, string> }) {
  return (
    <div class="page-hf" style={{ ...props.style, color: props.hf.color ?? DEFAULT_COLOR }}>
      <span class="hf-left">{fill(props.hf.left, props.page, props.pages)}</span>
      <span class="hf-center">{fill(props.hf.center, props.page, props.pages)}</span>
      <span class="hf-right">{fill(props.hf.right, props.page, props.pages)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editing session
// ---------------------------------------------------------------------------

/** What the open editor offers the toolbar and the commands. */
interface Editor {
  band: Band;
  page: number;
  slots: () => HTMLElement[];
  insertField: (key: string) => void;
  restore: (values: Record<Slot, string>) => void;
}

let editor: Editor | null = null;
let endUndo: (() => void) | null = null;
let history = new SlotHistory();
/** Where the caret goes once the band's editor is on the page. */
let pendingFocus: { slot: Slot; at?: [number, number] } | null = null;

const [toolbarAnchor, setToolbarAnchor] = createSignal<HTMLElement | null>(null);

function valuesOf(band: Band): Record<Slot, string> {
  const hf = bandOf(band) ?? {};
  return { left: hf.left ?? "", center: hf.center ?? "", right: hf.right ?? "" };
}

/** Write one slot (or the colour) into the document, as part of the session's undo step. */
function writeBand(band: Band, change: Partial<Record<Slot | "color", string | undefined>>) {
  mutate((d) => {
    const page = (d.page ??= {});
    const hf: Record<string, string> = { ...((page[band] as Record<string, string> | undefined) ?? {}) };
    for (const [k, v] of Object.entries(change)) {
      if (v) hf[k] = v;
      else delete hf[k];
    }
    if (Object.keys(hf).length) page[band] = hf;
    else delete page[band];
  }, false);
}

function setFirstPageDiffers(band: Band, on: boolean) {
  mutate((d) => {
    const page = (d.page ??= {});
    const first: Record<string, boolean> = { ...((page.firstPage as Record<string, boolean> | undefined) ?? {}) };
    if (on) first[band] = false;
    else delete first[band];
    if (Object.keys(first).length) page.firstPage = first;
    else delete page.firstPage;
  }, false);
}

/** Start editing a header or footer on page `page` (0-based), with the caret in `slot`. */
export function editHeaderFooter(band: Band, page: number, slot: Slot = "left", at?: [number, number]) {
  if (state.printing) return;
  const now = state.hfEditing;
  if (now?.band === band && now.page === page) {
    focusSlot(slot);
    return;
  }
  if (now) endHeaderFooter(false);
  commitEditing();
  if (!layout().pageView) togglePageView();
  pendingFocus = { slot, at };
  history = new SlotHistory();
  endUndo = undoSession();
  setState({ hfEditing: { band, page: Math.min(page, layout().pages - 1) }, selection: [], caret: null });
}

/** Edit Header / Edit Footer from a menu or ⌘K: on the page in view. */
export function editHeaderFooterInView(band: Band) {
  if (!layout().pageView) togglePageView();
  // after the pages are on screen
  requestAnimationFrame(() => {
    const viewport = document.querySelector(".viewport")?.getBoundingClientRect();
    const sheets = [...document.querySelectorAll<HTMLElement>(".sheet[data-page]")];
    if (!viewport || !sheets.length) return;
    const seen = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, viewport.bottom) - Math.max(r.top, viewport.top));
    };
    // the page the insertion point is on (a right-click puts it there), when it is in view;
    // else the sheet showing the most of itself
    const caretPage = state.caret ? Math.floor(state.caret[1] / layout().geom.contentH) : -1;
    const atCaret = sheets[caretPage];
    const best = atCaret && seen(atCaret) > 0 ? atCaret : sheets.reduce((a, b) => (seen(b) > seen(a) ? b : a));
    const k = Number(best.dataset.page) - 1;
    editHeaderFooter(band, k);
    requestAnimationFrame(() => revealBand(band, k));
  });
}

/** Pan the page so the band being edited, and its toolbar, are in view. */
function revealBand(band: Band, k: number) {
  const el = document.querySelector<HTMLElement>(`.sheet[data-page="${k + 1}"] .hf-band[data-band=${band}]`);
  const viewport = document.querySelector(".viewport")?.getBoundingClientRect();
  if (!el || !viewport) return;
  const r = el.getBoundingClientRect();
  const room = 72;
  let dy = 0;
  if (r.top < viewport.top + room) dy = viewport.top + room - r.top;
  else if (r.bottom > viewport.bottom - room) dy = viewport.bottom - room - r.bottom;
  if (dy) setState("view", "y", state.view.y + dy);
}

/** End the session: what was typed stays, as one undo step. */
export function endHeaderFooter(focusPage = true) {
  const now = state.hfEditing;
  if (!now) return;
  editor = null;
  pendingFocus = null;
  setState({ hfEditing: null });
  endUndo?.();
  endUndo = null;
  if (!focusPage) return;
  // back on the page, at the top of the one whose band was edited
  const l = layout();
  setState({ caret: [0, snap(now.page * l.geom.contentH)] });
  focusCanvas();
}

/** Undo inside the session; with nothing left there, the session ends and undo goes on. */
export function headerFooterUndo(redo = false) {
  if (!state.hfEditing || !editor) return false;
  const band = state.hfEditing.band;
  const values = redo ? history.redo(valuesOf(band)) : history.undo(valuesOf(band));
  if (values) editor.restore(values);
  else if (!redo) {
    endHeaderFooter();
    undo();
  }
  return true;
}

function focusSlot(slot: Slot, at?: [number, number]) {
  const el = editor?.slots()[SLOTS.indexOf(slot)];
  if (!el) return;
  el.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (!sel) return;
  let r: Range | null = null;
  if (at) {
    const hit = document.caretRangeFromPoint?.(at[0], at[1]);
    if (hit && el.contains(hit.startContainer)) r = hit;
  }
  if (!r) {
    r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Tab and ⇧Tab: the three slots, then the toolbar, and round again. */
function ring(from: Element, by: 1 | -1) {
  const bar = document.querySelector<HTMLElement>(".hf-toolbar");
  const stops = [...(editor?.slots() ?? []), ...(bar ? focusables(bar).filter((el) => !el.closest(".fb-pop")) : [])];
  const at = stops.findIndex((el) => el === from || el.contains(from));
  const next = stops[(at + by + stops.length) % stops.length];
  if (!next) return;
  const slot = editor?.slots().indexOf(next) ?? -1;
  if (slot >= 0) focusSlot(SLOTS[slot]);
  else next.focus();
}

/** Inside the session: the band, its toolbar and the menus they open. */
const insideSession = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest(".hf-band.editing, .hf-toolbar, .context-menu");

// a click or focus anywhere else ends the session (what it does there goes ahead)
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (state.hfEditing && !insideSession(e.target)) endHeaderFooter(false);
    },
    true,
  );
  document.addEventListener("focusin", (e) => {
    if (state.hfEditing && !insideSession(e.target)) endHeaderFooter(false);
  });
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

/** Which slot a point on the band is nearest to: the centre slot owns the middle third. */
function slotAt(band: HTMLElement, x: number): Slot {
  const r = band.getBoundingClientRect();
  const center = band.querySelector(".hf-center")?.getBoundingClientRect();
  if (center && center.width && x >= center.left - 6 && x <= center.right + 6) return "center";
  const f = (x - r.left) / r.width;
  return f < 1 / 3 ? "left" : f > 2 / 3 ? "right" : "center";
}

/** A header or footer on one sheet. */
export function HeaderFooterBand(props: { band: Band; k: number; pages: number; style: Record<string, string> }) {
  const shown = () => (blankOn(props.band, props.k) ? undefined : bandOf(props.band));
  const empty = () => !SLOTS.some((s) => shown()?.[s]);
  const editing = () => state.hfEditing?.band === props.band && state.hfEditing.page === props.k;
  let el!: HTMLDivElement;
  return (
    <Show
      when={!state.printing}
      fallback={
        <Show when={shown()}>
          <Slots hf={shown()!} page={props.k} pages={props.pages} style={props.style} />
        </Show>
      }
    >
      <div
        ref={el}
        class={`hf-band ${props.band}`}
        classList={{ editing: editing(), empty: empty() }}
        data-band={props.band}
        style={props.style}
        onPointerDown={(e) => {
          // a click on the band does nothing to the page; a double-click edits it
          if (e.button !== 0) return;
          e.stopPropagation();
          if (editing()) return;
          commitEditing();
          setState({ selection: [], caret: null });
        }}
        onDblClick={(e) => {
          if (editing()) return;
          e.preventDefault();
          editHeaderFooter(props.band, props.k, slotAt(el, e.clientX), [e.clientX, e.clientY]);
        }}
      >
        <Show
          when={editing()}
          fallback={
            <>
              <Show when={shown()}>
                <Slots hf={shown()!} page={props.k} pages={props.pages} style={{ inset: "0" }} />
              </Show>
              <Show when={empty()}>
                <span class="hf-hint" aria-hidden="true">
                  Double-click to add a {props.band}
                </span>
              </Show>
            </>
          }
        >
          <BandEditor band={props.band} k={props.k} anchor={el} />
        </Show>
      </div>
    </Show>
  );
}

function BandEditor(props: { band: Band; k: number; anchor: HTMLElement }) {
  const els: HTMLElement[] = [];
  const blank = () => blankOn(props.band, props.k);
  const value = (slot: Slot) => bandOf(props.band)?.[slot] ?? "";
  /** Where the caret was last in each slot, for the toolbar's Insert field. */
  let lastSlot: Slot = pendingFocus?.slot ?? "left";
  let lastRange: Range | null = null;

  const slotOf = (el: HTMLElement) => SLOTS[els.indexOf(el)];

  /** The slot's DOM is what was typed: write it to the document (Inspector ▸ Page follows). */
  function sync(el: HTMLElement) {
    chipTypedFields(el);
    // an emptied slot keeps nothing (a stray <br>), so its placeholder shows
    const text = readSlot(el);
    if (!text && el.childNodes.length) el.replaceChildren();
    if (text !== value(slotOf(el))) writeBand(props.band, { [slotOf(el)]: text });
  }

  function insertField(key: string) {
    if (blank()) return;
    const slot = lastSlot;
    const el = els[SLOTS.indexOf(slot)];
    el.focus({ preventScroll: true });
    const sel = document.getSelection()!;
    let r = lastRange && el.contains(lastRange.startContainer) ? lastRange : null;
    if (!r) {
      r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
    }
    history.before(valuesOf(props.band), slot, false);
    r.deleteContents();
    const c = chip(document, key);
    r.insertNode(c);
    r.setStartAfter(c);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    sync(el);
    announce(`${FIELDS.find(([k]) => k === key)?.[1] ?? key} field inserted`);
  }

  function restore(values: Record<Slot, string>) {
    // the slot that changes gets the caret, at its end
    const changed = SLOTS.find((s) => values[s] !== value(s)) ?? lastSlot;
    writeBand(props.band, values);
    focusSlot(changed);
  }

  onMount(() => {
    editor = { band: props.band, page: props.k, slots: () => els.filter((e) => e.isConnected), insertField, restore };
    setToolbarAnchor(props.anchor);
    const want = pendingFocus;
    pendingFocus = null;
    // at once, so typing straight after the double-click lands in the slot
    if (!blank() && want) focusSlot(want.slot, want.at);
    // a blank first page has nothing to type in: its toggle, once the toolbar is there
    else requestAnimationFrame(() => document.querySelector<HTMLElement>(".hf-toolbar input[type=checkbox]")?.focus());
  });
  onCleanup(() => {
    if (toolbarAnchor() === props.anchor) setToolbarAnchor(null);
    // the page went (fewer pages, print, another document): the session ends with it
    if (state.hfEditing?.band === props.band && state.hfEditing.page === props.k) endHeaderFooter(false);
  });

  // what changes elsewhere (Inspector ▸ Page, undo) shows here; what was typed here is left alone
  for (const [i, slot] of SLOTS.entries())
    createEffect(() => {
      const v = value(slot);
      const el = els[i];
      if (el?.isConnected && readSlot(el) !== v) renderSlot(el, v);
    });

  const trackCaret = () => {
    const sel = document.getSelection();
    const at = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const el = at && els.find((e) => e.contains(at.startContainer));
    if (el && at) {
      lastSlot = slotOf(el);
      lastRange = at.cloneRange();
    }
  };
  document.addEventListener("selectionchange", trackCaret);
  onCleanup(() => document.removeEventListener("selectionchange", trackCaret));

  function onKeyDown(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLElement;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      ring(el, e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" || (e.key === "Enter" && !e.isComposing)) {
      e.preventDefault();
      e.stopPropagation();
      endHeaderFooter();
    }
  }

  function onBeforeInput(e: InputEvent) {
    const el = e.currentTarget as HTMLElement;
    const t = e.inputType;
    if (t === "historyUndo" || t === "historyRedo") {
      e.preventDefault();
      headerFooterUndo(t === "historyRedo");
      return;
    }
    // one line of plain text: no paragraphs, no bold, nothing dropped in
    if (t.startsWith("format") || t === "insertParagraph" || t === "insertLineBreak" || t === "insertFromDrop") {
      e.preventDefault();
      return;
    }
    const typing = t === "insertText" || t.startsWith("delete") || t.includes("Composition");
    history.before(valuesOf(props.band), slotOf(el), typing);
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*[\r\n]+\s*/g, " ");
    const sel = document.getSelection();
    if (!text || !sel?.rangeCount) return;
    history.before(valuesOf(props.band), slotOf(el), false);
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(text);
    r.insertNode(node);
    r.setStart(node, text.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    el.normalize();
    sync(el);
  }

  // a copied chip pastes back as a chip: the clipboard gets `{page}`, not the word
  function onCopy(e: ClipboardEvent, cut: boolean) {
    const el = e.currentTarget as HTMLElement;
    const sel = document.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    e.stopPropagation();
    const r = sel.getRangeAt(0);
    e.clipboardData?.setData("text/plain", readSlot(r.cloneContents()));
    if (!cut) return;
    history.before(valuesOf(props.band), slotOf(el), false);
    r.deleteContents();
    sync(el);
  }

  return (
    <div
      class="page-hf hf-editor"
      role="group"
      aria-label={`${NAME[props.band]}, ${scopeLabel(props.band, props.k).toLowerCase()}`}
      style={{ inset: "0", color: bandOf(props.band)?.color ?? DEFAULT_COLOR }}
    >
      <Show when={!blank()} fallback={<span class="hf-blank">No {props.band} on the first page</span>}>
        <For each={SLOTS}>
          {(slot, i) => (
            <div
              ref={(el) => {
                els[i()] = el;
                renderSlot(el, value(slot));
              }}
              class={`hf-slot hf-${slot}`}
              contentEditable={true}
              role="textbox"
              aria-label={`${NAME[props.band]} ${SLOT_NAME[slot]}`}
              aria-placeholder={PLACEHOLDER[slot]}
              data-placeholder={PLACEHOLDER[slot]}
              spellcheck={false}
              onKeyDown={onKeyDown}
              onBeforeInput={onBeforeInput}
              onInput={(e) => sync(e.currentTarget)}
              onPaste={onPaste}
              onCopy={(e) => onCopy(e, false)}
              onCut={(e) => onCopy(e, true)}
              onFocus={() => (lastSlot = slot)}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

/** Which pages an edit reaches, in the toolbar's words. */
function scopeLabel(band: Band, k: number): string {
  if (k === 0 && firstDiffers(band)) return "First page";
  return firstDiffers(band) ? "All pages but the first" : "All pages";
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/** Beside the band being edited: fields, colour, Different first page, Done. */
export function HeaderFooterToolbar() {
  return (
    <Show when={state.hfEditing && toolbarAnchor()}>
      <Toolbar anchor={toolbarAnchor()!} />
    </Show>
  );
}

function Toolbar(props: { anchor: HTMLElement }) {
  let bar!: HTMLDivElement;
  const now = () => state.hfEditing!;
  const band = () => now().band;
  const blank = () => blankOn(band(), now().page);
  const color = () => bandOf(band())?.color;
  const [pos, setPos] = createSignal({ left: 0, top: 0, up: false });

  // Outside the band, so it never covers the content it frames: above a header (over the gap
  // between sheets), below a footer. When it starts, the page pans to make room; when the
  // window's edge later cuts it off, it slides into the band's own margin, and no further.
  let first = true;
  const place = () => {
    if (!bar || !props.anchor.isConnected) return;
    const a = props.anchor.getBoundingClientRect();
    const pane =
      document.querySelector(".viewport")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const gap = 8;
    const header = band() === "header";
    const ideal = header ? a.top - h - gap : a.bottom + gap;
    if (first) {
      first = false;
      const short = header ? pane.top + gap - ideal : ideal + h + gap - pane.bottom;
      if (short > 0) {
        setState("view", "y", state.view.y + (header ? short : -short));
        return; // the effect below places it again once the page has moved
      }
    }
    const top = header
      ? Math.min(Math.max(ideal, pane.top + gap), a.bottom - h - 2)
      : Math.max(Math.min(ideal, pane.bottom - h - gap), a.top + 2);
    const left = Math.max(pane.left + gap, Math.min(a.left, pane.right - w - gap));
    setPos({ left, top, up: !header });
  };
  createEffect(() => {
    // what moves the band on screen
    void [state.view.x, state.view.y, state.view.zoom, layout(), state.hfEditing, state.inspector];
    requestAnimationFrame(place);
  });
  onMount(() => {
    const ro = new ResizeObserver(place);
    ro.observe(bar);
    window.addEventListener("resize", place);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    });
  });

  // as the page shows it (a blank page added at the end counts until it prints)
  const preview = (key: string) => fill(`{${key}}`, now().page, layout().pages);

  return (
    <Portal>
      <div
        ref={bar}
        class="hf-toolbar"
        classList={{ up: pos().up }}
        role="toolbar"
        aria-label={`${NAME[band()]} tools`}
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as Element).closest(".fb-pop")) {
            e.preventDefault();
            ring(e.target as Element, e.shiftKey ? -1 : 1);
            return;
          }
          toolbarKeys(e, () => endHeaderFooter());
        }}
      >
        <span class="hf-scope">
          <span class="hf-scope-band">{NAME[band()]}</span>
          <span class="hf-scope-pages">{scopeLabel(band(), now().page)}</span>
        </span>
        <span class="hf-sep" aria-hidden="true" />
        <Dropdown
          title="Insert a field"
          name="Insert field"
          kind="menu"
          class="hf-fields"
          disabled={blank()}
          label={
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
              <span>Field</span>
            </>
          }
        >
          {(close) => (
            <For each={FIELDS}>
              {([key, name]) => (
                <button
                  class="fb-item hf-field-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    editor?.insertField(key);
                  }}
                >
                  <span>{name}</span>
                  <span class="hf-field-value">{preview(key) || "—"}</span>
                </button>
              )}
            </For>
          )}
        </Dropdown>
        <Dropdown
          title={`${NAME[band()]} colour`}
          name={`${NAME[band()]} colour`}
          kind="menu"
          label={<span class="fb-swatch" style={{ background: color() ?? DEFAULT_COLOR }} />}
        >
          {(close) => (
            <div class="fb-swatches hf-swatches">
              <For each={COLORS}>
                {([c, name]) => (
                  <button
                    class="fb-swatch big"
                    style={{ background: c ?? DEFAULT_COLOR }}
                    title={name}
                    role="menuitemradio"
                    aria-label={name}
                    aria-checked={color() === c}
                    onClick={() => {
                      close();
                      writeBand(band(), { color: c });
                    }}
                  />
                )}
              </For>
            </div>
          )}
        </Dropdown>
        <span class="hf-sep" aria-hidden="true" />
        <label class="hf-check">
          <input
            type="checkbox"
            checked={firstDiffers(band())}
            onChange={(e) => setFirstPageDiffers(band(), e.currentTarget.checked)}
          />
          Different first page
        </label>
        <span class="hf-sep" aria-hidden="true" />
        <button class="hf-done" onClick={() => endHeaderFooter()}>
          Done
        </button>
      </div>
    </Portal>
  );
}
