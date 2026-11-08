// Headers and footers on the page. Each sheet has a band in its top and bottom margins that
// shows the filled-in fields; a double-click (or Edit Header / Edit Footer) edits the band in
// place: three slots with fields as chips, a small toolbar beside it, one undo step in all.
// Print and PDF draw the same row (text, image and rule) without the editing chrome.
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { announce, focusables, toolbarKeys } from "./a11y";
import { pickAsset } from "./actions";
import { focusCanvas } from "./Canvas";
import { Btn, Dropdown } from "./FormatBar";
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
import {
  type BandContent,
  type BandImage,
  bandLayout,
  contentOn,
  evenPage,
  type FieldContext,
  fillFields,
  HF_DEFAULT_RULE,
  HF_DEFAULT_SIZE,
  HF_RULE_GAP,
  type HeaderFooter,
  mirrored,
  PX_PER_MM,
  scopeLabel as scopeWords,
  toPx,
} from "./pages";
import {
  commitEditing,
  flash,
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

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14];
/** Rule weights offered, in points. */
const RULES: [number, string][] = [
  [0.25, "Hairline"],
  [0.5, "Thin"],
  [1, "Medium"],
  [1.5, "Thick"],
];
/** Image heights offered, in mm; "Automatic" is half the band. */
const IMAGE_HEIGHTS = [6, 9, 12, 15];

const bandOf = (band: Band) => state.doc.page?.[band] as HeaderFooter | undefined;
const startNumber = () => (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
const firstPage = () => (state.doc.page?.firstPage as { header?: boolean; footer?: boolean } | undefined) ?? {};
/** "Different first page": page 1 has its own band, which today's model keeps blank. */
const firstDiffers = (band: Band) => firstPage()[band] === false;
const blankOn = (band: Band, k: number) => k === 0 && firstDiffers(band);
/** "Different odd and even pages": even pages show the band's `even` content. */
const oddEven = (band: Band) => !!bandOf(band)?.even;
const evenOn = (band: Band, k: number) => oddEven(band) && evenPage(k, startNumber());
/** What an edit on page `k` changes: the even pages' own content, or the band's slots. */
const contentOf = (band: Band, k: number): BandContent | undefined =>
  evenOn(band, k) ? bandOf(band)?.even : bandOf(band);
/** What page `k` shows. */
const shownOn = (band: Band, k: number) => contentOn(bandOf(band), k, startNumber(), firstDiffers(band));

function fileLabel(): string {
  return state.path?.replace(/\/+$/, "").split("/").pop() ?? "Untitled.quire";
}

/** The values fields take on page `k` (0-based). */
function fieldContext(k: number, pages: number): FieldContext {
  const meta = state.doc.meta ?? {};
  return {
    page: startNumber() + k,
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

const px = (n: number) => `${n}px`;

/**
 * The row a band's slots sit on, and its rule: where it is in the margin (`room` px high),
 * its type and colour. Shared by the page, the editor and print, so they all agree.
 */
function rowStyle(band: Band, room: number, content: BandContent | undefined): JSX.CSSProperties {
  const hf = bandOf(band);
  const l = bandLayout(hf, content, room);
  return {
    [band === "header" ? "top" : "bottom"]: px(l.offset),
    height: px(l.rowH),
    color: hf?.color ?? DEFAULT_COLOR,
    "font-size": px(l.fontPx),
    "font-weight": hf?.bold ? "bold" : undefined,
  };
}

/** The line under a header or over a footer, just outside its row. */
function Rule(props: { band: Band; room: number; content: BandContent | undefined }) {
  const hf = () => bandOf(props.band);
  const l = () => bandLayout(hf(), props.content, props.room);
  return (
    <Show when={hf()?.rule}>
      <div
        class="hf-rule"
        aria-hidden="true"
        style={{
          [props.band === "header" ? "top" : "bottom"]: px(l().rowH + HF_RULE_GAP),
          height: px(l().ruleW),
          background: hf()?.rule?.color ?? hf()?.color ?? DEFAULT_COLOR,
        }}
      />
    </Show>
  );
}

function BandPicture(props: { image: BandImage; height: number }) {
  return (
    <Show when={state.assets[props.image.src]}>
      <img
        class="hf-image"
        src={state.assets[props.image.src]}
        alt=""
        draggable={false}
        style={{ height: px(props.height) }}
      />
    </Show>
  );
}

/** A slot's image and what goes beside it: the image on the outer side of a right slot. */
function Cell(props: {
  slot: Slot;
  content: BandContent | undefined;
  imageH: number;
  class?: string;
  children: JSX.Element;
}) {
  const image = () => {
    const img = props.content?.image;
    return img && (img.slot ?? "left") === props.slot ? img : undefined;
  };
  const picture = () => (
    <Show when={image()}>
      <BandPicture image={image()!} height={props.imageH} />
    </Show>
  );
  return (
    <span class={`hf-${props.slot} ${props.class ?? ""}`}>
      <Show when={props.slot !== "right"}>{picture()}</Show>
      {props.children}
      <Show when={props.slot === "right"}>{picture()}</Show>
    </span>
  );
}

/** The three slots with their fields filled in: what the page shows, and what prints. */
function Slots(props: { band: Band; content: BandContent; page: number; pages: number; room: number }) {
  const l = () => bandLayout(bandOf(props.band), props.content, props.room);
  return (
    <div class="page-hf" style={rowStyle(props.band, props.room, props.content)}>
      <For each={SLOTS}>
        {(slot) => (
          <Cell slot={slot} content={props.content} imageH={l().imageH}>
            {fill(props.content[slot], props.page, props.pages)}
          </Cell>
        )}
      </For>
      <Rule band={props.band} room={props.room} content={props.content} />
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
  /** The slot the caret is in, or was in last. */
  slot: () => Slot;
  insertField: (key: string) => void;
  restore: (values: HeaderFooter | undefined) => void;
}

let editor: Editor | null = null;
let endUndo: (() => void) | null = null;
let history = new SlotHistory<HeaderFooter | undefined>();
/** Where the caret goes once the band's editor is on the page. */
let pendingFocus: { slot: Slot; at?: [number, number] } | null = null;

const [toolbarAnchor, setToolbarAnchor] = createSignal<HTMLElement | null>(null);

/** The whole band as it is now, for the session's own undo. */
const valuesOf = (band: Band) => bandOf(band);

/** Drop what is empty, so a band set back to its defaults leaves nothing in the file. */
function prune(hf: HeaderFooter) {
  const o = hf as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v === undefined || v === "") delete o[k];
  for (const c of [hf, hf.even]) if (c) for (const s of SLOTS) if (!c[s]) delete c[s];
  if (hf.even && !hf.even.image) delete hf.even.image;
}

/**
 * Change a band in the document. While its session is open, the change joins the session's
 * single undo step; from elsewhere (an image picked after the session ended) it is a step of its own.
 */
function writeHf(band: Band, fn: (hf: HeaderFooter) => void) {
  mutate((d) => {
    const page = (d.page ??= {});
    const hf = JSON.parse(JSON.stringify(page[band] ?? {})) as HeaderFooter;
    fn(hf);
    prune(hf);
    if (Object.keys(hf).length) page[band] = hf;
    else delete page[band];
  }, !state.hfEditing);
}

/** A change from the toolbar: a step of the session's own undo, then the change. */
function change(band: Band, fn: (hf: HeaderFooter) => void) {
  if (state.hfEditing?.band === band) history.before(valuesOf(band), editor?.slot() ?? "left", false);
  writeHf(band, fn);
}

/** Write slots of the content page `k` edits (the even pages' own, or the band's). */
function writeSlots(band: Band, k: number, values: Partial<Record<Slot, string | undefined>>) {
  const even = evenOn(band, k);
  writeHf(band, (hf) => {
    const c = even ? (hf.even ??= {}) : hf;
    for (const [s, v] of Object.entries(values) as [Slot, string | undefined][]) {
      if (v) c[s] = v;
      else delete c[s];
    }
  });
}

function setImage(band: Band, k: number, image: BandImage | undefined) {
  const even = evenOn(band, k);
  change(band, (hf) => {
    const c = even ? (hf.even ??= {}) : hf;
    if (image) c.image = image;
    else delete c.image;
  });
}

function setFirstPageDiffers(band: Band, on: boolean) {
  mutate((d) => {
    const page = (d.page ??= {});
    const first: Record<string, boolean> = { ...((page.firstPage as Record<string, boolean> | undefined) ?? {}) };
    if (on) first[band] = false;
    else delete first[band];
    if (Object.keys(first).length) page.firstPage = first;
    else delete page.firstPage;
  }, !state.hfEditing);
}

/** Different odd and even pages: even pages start as a mirror of the odd ones; off drops them. */
function setOddEven(band: Band, on: boolean) {
  change(band, (hf) => {
    if (on) hf.even = mirrored(hf);
    else delete hf.even;
  });
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
  const now = valuesOf(band);
  const values = redo ? history.redo(now) : history.undo(now);
  if (values !== null) editor.restore(values);
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

/** A header or footer on one sheet; `room` is the height of its margin. */
export function HeaderFooterBand(props: {
  band: Band;
  k: number;
  pages: number;
  room: number;
  style: Record<string, string>;
}) {
  const shown = () => shownOn(props.band, props.k);
  const empty = () => {
    const c = shown();
    return !c?.image && !SLOTS.some((s) => c?.[s]);
  };
  const editing = () => state.hfEditing?.band === props.band && state.hfEditing.page === props.k;
  let el!: HTMLDivElement;
  return (
    <Show
      when={!state.printing}
      fallback={
        <Show when={!empty()}>
          <div class="hf-print" style={props.style}>
            <Slots band={props.band} content={shown()!} page={props.k} pages={props.pages} room={props.room} />
          </div>
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
              <Show when={!empty()}>
                <Slots band={props.band} content={shown()!} page={props.k} pages={props.pages} room={props.room} />
              </Show>
              <Show when={empty()}>
                <span class="hf-hint" aria-hidden="true">
                  Double-click to add a {props.band}
                </span>
              </Show>
            </>
          }
        >
          <BandEditor band={props.band} k={props.k} room={props.room} anchor={el} />
        </Show>
      </div>
    </Show>
  );
}

function BandEditor(props: { band: Band; k: number; room: number; anchor: HTMLElement }) {
  const els: HTMLElement[] = [];
  const blank = () => blankOn(props.band, props.k);
  const content = () => contentOf(props.band, props.k);
  const value = (slot: Slot) => content()?.[slot] ?? "";
  const l = () => bandLayout(bandOf(props.band), content(), props.room);
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
    if (text !== value(slotOf(el))) writeSlots(props.band, props.k, { [slotOf(el)]: text });
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

  function restore(values: HeaderFooter | undefined) {
    // the slot that changes gets the caret, at its end
    const before = content();
    mutate((d) => {
      const page = (d.page ??= {});
      if (values) page[props.band] = JSON.parse(JSON.stringify(values));
      else delete page[props.band];
    }, false);
    const changed = SLOTS.find((s) => (before?.[s] ?? "") !== value(s)) ?? lastSlot;
    focusSlot(changed);
  }

  onMount(() => {
    editor = {
      band: props.band,
      page: props.k,
      slots: () => els.filter((e) => e.isConnected),
      slot: () => lastSlot,
      insertField,
      restore,
    };
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

  // what changes elsewhere (Inspector ▸ Page, undo, odd and even) shows here; what was typed here is left alone
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
      style={rowStyle(props.band, props.room, content())}
    >
      <Show when={!blank()} fallback={<span class="hf-blank">No {props.band} on the first page</span>}>
        <For each={SLOTS}>
          {(slot, i) => (
            <Cell slot={slot} content={content()} imageH={l().imageH} class="hf-cell">
              <div
                ref={(el) => {
                  els[i()] = el;
                  renderSlot(el, value(slot));
                }}
                class="hf-slot"
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
            </Cell>
          )}
        </For>
        <Rule band={props.band} room={props.room} content={content()} />
      </Show>
    </div>
  );
}

/** Which pages an edit reaches, in the toolbar's words. */
function scopeLabel(band: Band, k: number): string {
  return scopeWords(k, { firstBlank: firstDiffers(band), oddEven: oddEven(band), start: startNumber() });
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/** Beside the band being edited: fields, image, type, colour, rule, which pages, Done. */
export function HeaderFooterToolbar() {
  return (
    <Show when={state.hfEditing && toolbarAnchor()}>
      <Toolbar anchor={toolbarAnchor()!} />
    </Show>
  );
}

const ptOf = (w: string | number | undefined) => Math.round((toPx(w ?? HF_DEFAULT_RULE, 0.5) * 72) / 96 / 0.25) * 0.25;

function Toolbar(props: { anchor: HTMLElement }) {
  let bar!: HTMLDivElement;
  const now = () => state.hfEditing!;
  const band = () => now().band;
  const hf = () => bandOf(band());
  const blank = () => blankOn(band(), now().page);
  const color = () => hf()?.color;
  const image = () => contentOf(band(), now().page)?.image;
  const [pos, setPos] = createSignal({ left: 0, top: 0, up: false, max: 0 });

  // Outside the band, so it never covers the content it frames: above a header (over the gap
  // between sheets), below a footer. When it starts, the page pans to make room; when the
  // window's edge later cuts it off, it slides into the band's own margin, and no further.
  let first = true;
  const place = () => {
    if (!bar || !props.anchor.isConnected) return;
    const a = props.anchor.getBoundingClientRect();
    const pane =
      document.querySelector(".viewport")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const gap = 8;
    // a narrow window wraps the toolbar rather than cutting it off
    const max = Math.max(240, pane.width - 2 * gap);
    if (max !== pos().max) setPos({ ...pos(), max });
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
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
    setPos({ left, top, up: !header, max });
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

  async function addImage() {
    const at = now();
    const slot = editor?.slot() ?? "left";
    try {
      const src = await pickAsset();
      if (!src) return;
      setImage(at.band, at.page, { src, slot });
      announce("Image added");
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e));
    }
  }

  const radio = (on: boolean, label: string, run: () => void, close: () => void) => (
    <button
      class="fb-item"
      classList={{ on }}
      role="menuitemradio"
      aria-checked={on}
      onClick={() => {
        close();
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <Portal>
      <div
        ref={bar}
        class="hf-toolbar"
        classList={{ up: pos().up }}
        role="toolbar"
        aria-label={`${NAME[band()]} tools`}
        style={{
          left: `${pos().left}px`,
          top: `${pos().top}px`,
          "max-width": pos().max ? `${pos().max}px` : undefined,
        }}
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
        <Show
          when={image()}
          fallback={
            <button
              class="fb-btn hf-text-btn"
              disabled={blank()}
              title="Add an image, such as a logo"
              onClick={addImage}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <rect
                  x="1.5"
                  y="2"
                  width="10"
                  height="9"
                  rx="1.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                />
                <path d="M2.5 10l3-3.2 2 2 1.4-1.4 2 2.2" fill="none" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span>Image…</span>
            </button>
          }
        >
          <Dropdown
            title="Image"
            name="Image"
            kind="menu"
            label={
              <span class="hf-thumb">
                <Show when={state.assets[image()!.src]}>
                  <img src={state.assets[image()!.src]} alt="" />
                </Show>
              </span>
            }
          >
            {(close) => (
              <>
                <For each={SLOTS}>
                  {(s) =>
                    radio(
                      (image()?.slot ?? "left") === s,
                      `${PLACEHOLDER[s]}`,
                      () => setImage(band(), now().page, { ...image()!, slot: s }),
                      close,
                    )
                  }
                </For>
                <div class="hf-menu-sep" role="separator" />
                {radio(
                  image()?.height === undefined,
                  "Fit the band",
                  () => setImage(band(), now().page, { src: image()!.src, slot: image()!.slot }),
                  close,
                )}
                <For each={IMAGE_HEIGHTS}>
                  {(mm) =>
                    radio(
                      image()?.height !== undefined && Math.round(toPx(image()!.height, 0) / PX_PER_MM) === mm,
                      `${mm} mm high`,
                      () => setImage(band(), now().page, { ...image()!, height: `${mm}mm` }),
                      close,
                    )
                  }
                </For>
                <div class="hf-menu-sep" role="separator" />
                <button
                  class="fb-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void addImage();
                  }}
                >
                  Replace Image…
                </button>
                <button
                  class="fb-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setImage(band(), now().page, undefined);
                    announce("Image removed");
                  }}
                >
                  Remove Image
                </button>
              </>
            )}
          </Dropdown>
        </Show>
        <span class="hf-sep" aria-hidden="true" />
        <Dropdown
          title={`${NAME[band()]} text size`}
          name={`Text size ${hf()?.size ?? HF_DEFAULT_SIZE} pt`}
          kind="menu"
          label={<span class="fb-num">{hf()?.size ?? HF_DEFAULT_SIZE} pt</span>}
        >
          {(close) => (
            <For each={SIZES}>
              {(sz) =>
                radio(
                  (hf()?.size ?? HF_DEFAULT_SIZE) === sz,
                  `${sz} pt`,
                  () => change(band(), (h) => (h.size = sz === HF_DEFAULT_SIZE ? undefined : sz)),
                  close,
                )
              }
            </For>
          )}
        </Dropdown>
        <Btn
          title="Bold"
          active={!!hf()?.bold}
          onClick={() => change(band(), (h) => (h.bold = h.bold ? undefined : true))}
        >
          <b>B</b>
        </Btn>
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
                      change(band(), (h) => (h.color = c));
                    }}
                  />
                )}
              </For>
            </div>
          )}
        </Dropdown>
        <Dropdown
          title={band() === "header" ? "Line under the header" : "Line over the footer"}
          name={band() === "header" ? "Line under the header" : "Line over the footer"}
          kind="menu"
          label={
            <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
              <path d="M2 3.5h12" stroke="currentColor" stroke-width="1" opacity="0.45" />
              <path
                d={band() === "header" ? "M1 9h14" : "M1 1.5h14"}
                stroke="currentColor"
                stroke-width={hf()?.rule ? Math.max(1, ptOf(hf()?.rule?.width) * 1.6) : 1}
                stroke-dasharray={hf()?.rule ? undefined : "1.5 1.5"}
              />
              <path d="M2 6.5h9" stroke="currentColor" stroke-width="1" opacity="0.45" />
            </svg>
          }
        >
          {(close) => (
            <>
              {radio(!hf()?.rule, "No line", () => change(band(), (h) => delete h.rule), close)}
              <For each={RULES}>
                {([pt, name]) =>
                  radio(
                    !!hf()?.rule && ptOf(hf()?.rule?.width) === pt,
                    `${name}, ${pt} pt`,
                    () =>
                      change(band(), (h) => {
                        h.rule = { ...h.rule };
                        if (`${pt}pt` === HF_DEFAULT_RULE) delete h.rule.width;
                        else h.rule.width = `${pt}pt`;
                      }),
                    close,
                  )
                }
              </For>
              <div class="hf-menu-sep" role="separator" />
              <div class="fb-swatches hf-swatches" role="group" aria-label="Line colour">
                <For each={COLORS}>
                  {([c, name]) => (
                    <button
                      class="fb-swatch big"
                      style={{ background: c ?? color() ?? DEFAULT_COLOR }}
                      title={c ? name : "Same as the text"}
                      role="menuitemradio"
                      aria-label={c ? `Line ${name.toLowerCase()}` : "Line the same colour as the text"}
                      aria-checked={!!hf()?.rule && hf()?.rule?.color === c}
                      onClick={() => {
                        close();
                        change(band(), (h) => {
                          h.rule = { ...h.rule };
                          if (c) h.rule.color = c;
                          else delete h.rule.color;
                        });
                      }}
                    />
                  )}
                </For>
              </div>
            </>
          )}
        </Dropdown>
        {/* which pages, and Done: one piece, which moves to a line of its own in a narrow window */}
        <span class="hf-tail">
          <label class="hf-check">
            <input
              type="checkbox"
              checked={firstDiffers(band())}
              onChange={(e) => setFirstPageDiffers(band(), e.currentTarget.checked)}
            />
            Different first page
          </label>
          <label class="hf-check">
            <input
              type="checkbox"
              checked={oddEven(band())}
              onChange={(e) => setOddEven(band(), e.currentTarget.checked)}
            />
            Different odd and even pages
          </label>
          <span class="hf-sep" aria-hidden="true" />
          <button class="hf-done" onClick={() => endHeaderFooter()}>
            Done
          </button>
        </span>
      </div>
    </Portal>
  );
}
