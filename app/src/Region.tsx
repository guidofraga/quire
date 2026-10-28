import type { EditorView } from "prosemirror-view";
import { hitIds } from "./find";
import { nameAt, setCaretName, trace } from "./trace";
import { paletteOpen } from "./Palette";
import { fillRefs } from "./xref";
import { captionLabel, defaultLabel, labelKey, labelPattern } from "./labels";
import { openPopover } from "./Popover";
import { Field, Text as InspText } from "./Inspector";
import { DEFAULT_SIZE, editPlot, insertPlot, PlotBody } from "./Plot";
import { stepRegion } from "./nav";
import { selectInView } from "./Canvas";
import { editTableAt, isSheet, SheetGrid } from "./TableEditor";
import { prefs } from "./settings";
import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { produce } from "solid-js/store";
import { api } from "./api";
import { completionKey, hideCompletions, showCompletions } from "./Completion";
import { cellHtml, mathml, prettyValue } from "./math";
import { commandsFor, completions, exact, isTemplate, type Sym } from "./symbols";
import { closeMenu, type MenuItems, openRegionMenu, setMenu } from "./menu";
import { createEditor, placeCaret, plainText, releaseEditor } from "./richtext";
import {
  AREA_COLLAPSED_HEIGHT,
  availableWidth,
  checkpoint,
  commitBelow,
  commitEditing,
  convertEditing,
  definedNames,
  editClickPoint,
  editText,
  findDraft,
  GRID,
  heights,
  layout,
  localized,
  PAGE_WIDTH,
  type Placed,
  regionGrew,
  renameIn,
  runAppCommand,
  revealRegion,
  setHeights,
  setLive,
  setState,
  setWidths,
  splitShow,
  startEditing,
  state,
  toggleArea,
  updateDoc,
  updateRegion,
  widths,
} from "./store";
import type { Expr, Fix, Region } from "./types";

export interface RegionProps {
  region: Region;
  onDragStart: (id: string, e: PointerEvent) => void;
}

const pt = (n: number | undefined, fallback: number) => `${n ?? fallback}pt`;

/** Apply Djot attributes the HTML renderer leaves as plain attributes ({size=12 font="Arial"}). */
function applyDjotAttributes(el: HTMLElement) {
  for (const node of el.querySelectorAll<HTMLElement>("[size],[font],[color]")) {
    const size = node.getAttribute("size");
    if (size && /^[\d.]+$/.test(size)) node.style.fontSize = `${size}pt`;
    const font = node.getAttribute("font");
    if (font) node.style.fontFamily = `"${font.replace(/"/g, "")}"`;
    const color = node.getAttribute("color");
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) node.style.color = color;
  }
}

/** Typeset the live inline math placeholders (`$`expr``) inside rendered text. */
function fillInlineMath(el: HTMLElement) {
  for (const span of el.querySelectorAll<HTMLElement>("[data-math]")) {
    const v = state.views[span.dataset.math!];
    span.classList.toggle("inline-error", !!v?.error);
    span.title = v?.error ?? "";
    span.innerHTML = v?.input ? mathml(v.input, v.result, v.units, v.constants, v.symbolic) : `<code class="raw">?</code>`;
  }
}

function Html(props: { html: string | undefined; class?: string }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    el.innerHTML = props.html ?? "";
    applyDjotAttributes(el);
    fillInlineMath(el);
  });
  // references follow the numbering without re-rendering the text
  createEffect(() => {
    void props.html;
    fillRefs(el);
  });
  return <div ref={el} class={props.class} />;
}

function captionPrefix(r: Region, number: string | undefined): string {
  return number ? `${captionLabel(r.kind === "table" ? "table" : "figure", number)} ` : "";
}

/** Double-click a caption's "Figure 3 –": what every figure (or table) caption says. */
function editCaptionLabel(e: MouseEvent, kind: "figure" | "table") {
  const key = labelKey(kind);
  const set = (v: string) =>
    updateDoc((d) => {
      d.styles = { ...d.styles, numbering: { ...d.styles?.numbering, [key]: v || undefined } };
    });
  openPopover(e, kind === "table" ? "Table captions" : "Figure captions", () => (
    <>
      <Field label="Every caption reads" hint="{n} is the number, e.g. Figura {n} –">
        <InspText value={labelPattern(kind)} placeholder={defaultLabel(kind)} onCommit={set} />
      </Field>
      <div class="insp-hint">Empty follows the document's language. Also in Document ▸ Numbering.</div>
    </>
  ));
}

/** A caption to start editing as soon as it appears (right after Add Caption). */
export const [captionToEdit, setCaptionToEdit] = createSignal<string | null>(null);

function Caption(props: { p: Placed }) {
  const r = () => props.p.region;
  const [editing, setEditing] = createSignal(false);
  createEffect(() => {
    if (captionToEdit() === r().id && r().caption) {
      setCaptionToEdit(null);
      setEditing(true);
    }
  });
  const lang = () => state.doc.meta?.lang;
  const commit = (text: string) => {
    setEditing(false);
    const caption = r().caption;
    if (!caption || text === localized(caption.text, lang())) return;
    // a caption in several languages keeps the others
    const next =
      typeof caption.text === "object" && caption.text !== null
        ? { ...caption.text, [Object.keys(caption.text).find((k) => lang()?.startsWith(k)) ?? Object.keys(caption.text)[0]]: text }
        : text;
    updateRegion(r().id, { caption: { ...caption, text: next } });
  };
  return (
    <Show when={r().caption}>
      <div class="caption">
        <span
          class="caption-num"
          title="Double-click to change what every caption of this kind says"
          onDblClick={(e) => editCaptionLabel(e, r().kind === "table" ? "table" : "figure")}
        >
          {captionPrefix(r(), props.p.number)}
        </span>
        <Show
          when={editing()}
          fallback={
            <span
              class="caption-edit-target"
              title="Double-click to edit the caption"
              onDblClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              <Html html={state.report?.html[`${r().id}:caption`]} class="caption-text" />
            </span>
          }
        >
          <input
            class="caption-input"
            value={localized(r().caption!.text, lang())}
            size={Math.max(12, localized(r().caption!.text, lang()).length + 2)}
            spellcheck={true}
            // after the menu that opened it has closed and handed focus back to the page
            ref={(el) => setTimeout(() => (el.focus(), el.select()), 60)}
            onPointerDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onInput={(e) => (e.currentTarget.size = Math.max(12, e.currentTarget.value.length + 2))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit(e.currentTarget.value.trim());
              else if (e.key === "Escape") setEditing(false);
            }}
            onBlur={(e) => editing() && commit(e.currentTarget.value.trim())}
          />
        </Show>
      </div>
    </Show>
  );
}

const GREEK: Record<string, string> = Object.fromEntries(
  [..."abgdezhqiklmnxoprstufcyw"]
    .map((c, i) => [c, "αβγδεζηθικλμνξοπρστυφχψω"[i]])
    .concat([..."ABGDEZHQIKLMNXOPRSTUFCYW"].map((c, i) => [c, "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"[i]])),
);
const LATIN = Object.fromEntries(Object.entries(GREEK).map(([l, g]) => [g, l]));

let activeMathInput: HTMLInputElement | null = null;
/** After ":" became ":=", an "=" typed out of habit is swallowed. */
let assignJustTyped = false;

/** Text typed so fast it reached the canvas before the new editor took focus. */
export function forwardTyping(text: string): boolean {
  const input = activeMathInput;
  if (!input) return false;
  input.focus();
  for (const ch of text) {
    if (ch === ":") {
      document.execCommand("insertText", false, ":=");
      assignJustTyped = true;
    } else if (ch === "=" && assignJustTyped) {
      assignJustTyped = false;
    } else {
      assignJustTyped = false;
      document.execCommand("insertText", false, ch);
    }
  }
  return true;
}

/** Insert a template (e.g. `sqrt(?)`) into the math being edited; selects the first `?`. */
export function insertIntoMath(template: string): boolean {
  const input = activeMathInput;
  if (!input) return false;
  input.focus();
  const start = input.selectionStart ?? input.value.length;
  document.execCommand("insertText", false, template);
  const hole = input.value.indexOf("?", start);
  if (hole >= 0) input.setSelectionRange(hole, hole + 1);
  return true;
}

const WORD = /^[\p{L}][\p{L}]+$/u;
const WORDS = /^[\p{L}][\p{L}\p{N}_.]*(?:\s+[\p{L}][\p{L}\p{N}_.]*)*\s+(\p{L}{3,})$/u;
const KEYWORDS = new Set(["and", "or", "not", "mod"]);

/**
 * Is what was typed at the start of a new region prose? A single word that is not a
 * variable (`Area`), or words ending in a real word that is not a variable, unit or
 * keyword (`A medida`); `x y` and `F kN` stay math.
 */
function looksLikeProse(value: string, id: string): boolean {
  const names = definedNames();
  if (WORD.test(value)) return !names.has(value);
  const m = WORDS.exec(value);
  if (!m) return false;
  const last = m[1];
  const units = state.views[id]?.units ?? [];
  return !names.has(last) && !units.includes(last) && !KEYWORDS.has(last.toLowerCase());
}

const LATEX_BEFORE = /\\([A-Za-z]*)$/;
const POPULAR = ["alpha", "beta", "gamma", "delta", "Delta", "theta", "lambda", "mu", "sigma", "omega", "phi", "sqrt", "frac", "sum", "int"]
  .map((n) => exact(n))
  .filter((x): x is Sym => !!x);

const measure = document.createElement("canvas").getContext("2d")!;

/** Screen position just below the caret of a single-line input. */
function caretPoint(input: HTMLInputElement): [number, number] {
  const style = getComputedStyle(input);
  measure.font = style.font;
  const width = measure.measureText(input.value.slice(0, input.selectionStart ?? 0)).width;
  const rect = input.getBoundingClientRect();
  const scale = rect.width / input.offsetWidth || 1;
  return [rect.left + (parseFloat(style.paddingLeft) + width - input.scrollLeft) * scale, rect.bottom + 4];
}

/** The character offset in a single-line input nearest to screen x. */
function offsetAt(input: HTMLInputElement, x: number): number {
  const style = getComputedStyle(input);
  measure.font = style.font;
  const rect = input.getBoundingClientRect();
  const scale = rect.width / input.offsetWidth || 1;
  const target = (x - rect.left) / scale - parseFloat(style.paddingLeft);
  let best = 0;
  for (let i = 0, prev = 0; i <= input.value.length; i++) {
    const w = measure.measureText(input.value.slice(0, i)).width;
    if (w >= target) return w - target < target - prev ? i : best;
    best = i;
    prev = w;
  }
  return input.value.length;
}

/** Replace `input.value[start..end]` with a symbol or template (selecting its first slot). */
function applySymbol(input: HTMLInputElement, sym: Sym, start: number, end: number) {
  input.focus();
  input.setSelectionRange(start, end);
  if (sym.command) {
    // a `\` command: the typed `\text` goes, then the command runs
    if (start !== end) document.execCommand("delete");
    if (sym.command === "to_text") convertEditing("text", input.value.trimEnd() ? `${input.value.trimEnd()} ` : "");
    else runAppCommand(sym.command);
    return;
  }
  document.execCommand("insertText", false, sym.insert);
  const hole = input.value.indexOf("?", start);
  if (isTemplate(sym) && hole >= 0 && hole < start + sym.insert.length) input.setSelectionRange(hole, hole + 1);
}

function MathEditor(props: { r: Region }) {
  let input!: HTMLInputElement;
  const initial = untrack(() => editText(props.r));
  assignJustTyped = initial.endsWith(":=");
  createEffect(() => {
    input.focus();
    const hole = initial.indexOf("?");
    const at = editClickPoint ? offsetAt(input, editClickPoint[0]) : initial.length;
    if (hole >= 0) input.setSelectionRange(hole, hole + 1);
    else input.setSelectionRange(at, at);
    activeMathInput = input;
    traceCaret();
  });
  onCleanup(() => {
    if (activeMathInput === input) activeMathInput = null;
    setCaretName(null);
    hideCompletions();
  });
  const fit = () => {
    input.style.width = `${Math.max(6, input.value.length + 2)}ch`;
  };
  const atEnd = () => input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  const latexBefore = () => (prefs.latex ? LATEX_BEFORE.exec(input.value.slice(0, input.selectionStart ?? 0)) : null);

  const traceCaret = () => setCaretName(input.selectionStart === input.selectionEnd ? nameAt(input.value, input.selectionStart ?? 0) : null);
  const updateCompletion = () => {
    const m = latexBefore();
    if (!m) return unitSuggestions();
    const caret = input.selectionStart ?? 0;
    const items = m[1] ? completions(m[1], 8, "math") : [...commandsFor("math"), ...POPULAR];
    const [x, y] = caretPoint(input);
    showCompletions(x, y, items, (sym) => applySymbol(input, sym, caret - m[0].length, caret));
  };

  // after `=`, the units the result can be shown in, each with the result in it (SMath's
  // unit placeholder); typing narrows the list, ↑↓ and Tab pick, Enter still finishes
  const unitSuggestions = () => {
    const { show, unit } = splitShow(input.value);
    const choices = state.views[props.r.id]?.unitChoices ?? [];
    if (show !== "value" || !atEnd() || !choices.length) return hideCompletions();
    const typed = (unit ?? "").toLowerCase();
    const items: Sym[] = choices
      .filter((c) => c.unit.toLowerCase().startsWith(typed))
      .map((c) => ({ name: c.unit, insert: c.unit, label: prettyValue(`'${c.unit.replace(/\*/g, "*'").replace(/\//g, "/'")}`), note: prettyValue(c.text) }));
    if (!items.length || (items.length === 1 && items[0].name === unit)) return hideCompletions();
    // below the whole box, so the live result stays in view
    const [x] = caretPoint(input);
    const y = (input.closest(".region")?.getBoundingClientRect().bottom ?? caretPoint(input)[1]) + 6;
    showCompletions(x, y, items, (sym) => {
      const v = input.value;
      const start = unit ? v.length - unit.length : v.length;
      input.focus();
      input.setSelectionRange(start, v.length);
      document.execCommand("insertText", false, `${unit || v.endsWith(" ") ? "" : " "}${sym.insert}`);
    }, true);
  };
  // the choices arrive with the next evaluation after `=` is typed
  createEffect(on(() => state.views[props.r.id]?.unitChoices, () => document.activeElement === input && updateCompletion(), { defer: true }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (completionKey(e)) {
      e.preventDefault();
      return;
    }
    // `\Delta` followed by a space or an operator becomes Δ (Word's equation autocorrect)
    if (e.key.length === 1 && !/[A-Za-z\\]/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const m = latexBefore();
      const sym = m?.[1] ? exact(m[1], "math") : undefined;
      if (m && sym) {
        const caret = input.selectionStart ?? 0;
        applySymbol(input, sym, caret - m[0].length, caret);
        hideCompletions();
        if (e.key === " ") {
          e.preventDefault();
          return;
        }
      }
    }
    // Tab / Shift-Tab jump between the empty slots (?) of a structure
    if (e.key === "Tab") {
      const v = input.value;
      const from = e.shiftKey ? (input.selectionStart ?? 0) - 1 : (input.selectionEnd ?? 0);
      let hole = e.shiftKey ? v.lastIndexOf("?", Math.max(0, from - 1)) : v.indexOf("?", from);
      if (hole < 0) hole = e.shiftKey ? v.lastIndexOf("?") : v.indexOf("?");
      e.preventDefault();
      if (hole >= 0) input.setSelectionRange(hole, hole + 1);
      // no slots to fill: on to the next region
      else editNext(props.r.id, e.shiftKey ? -1 : 1);
      return;
    }
    const typedAssign = assignJustTyped;
    assignJustTyped = false;
    if (e.metaKey || e.altKey) return;
    if (e.key === ":" && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand("insertText", false, ":=");
      assignJustTyped = true;
    } else if (e.key === "=" && typedAssign) {
      e.preventDefault();
    } else if (e.key === "~") {
      // SMath's key for a global definition
      e.preventDefault();
      document.execCommand("insertText", false, " ≡ ");
    } else if (
      e.key === " " &&
      state.editingFresh &&
      atEnd() &&
      looksLikeProse(input.value, props.r.id)
    ) {
      // a word and a space, or words ending in a real word: this is prose, not math
      e.preventDefault();
      convertEditing("text", `${input.value} `);
    } else if (e.ctrlKey && e.key === ".") {
      // SMath's key for symbolic evaluation
      e.preventDefault();
      document.execCommand("insertText", false, " →");
    } else if (e.ctrlKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      const i = input.selectionStart ?? 0;
      const ch = input.value[i - 1];
      const swap = ch && (GREEK[ch] ?? LATIN[ch]);
      if (swap) {
        input.setSelectionRange(i - 1, i);
        document.execCommand("insertText", false, swap);
      }
    } else if (e.key === "Enter") {
      // like SMath: Enter moves the insertion point below the region
      e.preventDefault();
      commitBelow(props.r.id);
    } else if (e.key === "Escape") {
      // done editing; the region stays selected for the keyboard
      e.preventDefault();
      const id = props.r.id;
      commitEditing();
      if (layout().byId.has(id)) setState({ selection: [id], caret: null });
    }
  };
  return (
    <input
      ref={input}
      class="math-input"
      value={initial}
      spellcheck={false}
      autocomplete="off"
      autocapitalize="off"
      onInput={(e) => {
        fit();
        setLive(props.r.id, e.currentTarget.value);
        updateCompletion();
        traceCaret();
      }}
      onSelect={traceCaret}
      onKeyDown={(e) => {
        onKeyDown(e);
        e.stopPropagation();
      }}
      onKeyUp={(e) => {
        traceCaret();
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") updateCompletion();
      }}
      onClick={traceCaret}
      onBlur={() => {
        hideCompletions();
        setCaretName(null);
        // switching to text unmounts this input: that blur must not end the edit
        const stillMath = layout().byId.get(props.r.id)?.region.kind === "math";
        // nor does the command palette, which puts what it inserts at this caret
        if (state.editing === props.r.id && stillMath && !paletteOpen()) commitEditing();
      }}
      style={{ width: `${Math.max(6, initial.length + 2)}ch` }}
    />
  );
}

/** Tab out of a region: edit the next one in reading order (⇧Tab: the one before). */
function editNext(id: string, by: 1 | -1) {
  const next = stepRegion(id, by);
  commitEditing();
  if (!next || !layout().byId.has(next)) return;
  selectInView(next);
  const kind = layout().byId.get(next)!.region.kind;
  if (kind === "table") editTableAt(next);
  else startEditing(next);
}

/** Rewrite a plain name as the explicit unit `'name` everywhere in the math being edited. */
export function forceUnit(name: string) {
  const input = activeMathInput;
  if (!input) return;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_.'])${escaped}(?![\\p{L}\\p{N}_])`, "gu");
  const next = input.value.replace(re, `'${name}`);
  if (next === input.value) return;
  input.focus();
  input.select();
  document.execCommand("insertText", false, next);
}


/** `10 m` → `10*m`: the variable m, not the unit, in the math being edited. */
function useVariable(name: string) {
  const input = activeMathInput;
  if (!input) return;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // a number (or a vector's closing bracket) followed by spaces and the name, as a whole word
  const re = new RegExp(`([\\p{N}\\]])\\s+${escaped}(?![\\p{L}\\p{N}_.])`, "gu");
  const next = input.value.replace(re, `$1*${name}`);
  if (next === input.value) return;
  input.focus();
  input.select();
  document.execCommand("insertText", false, next);
}

/** What the ambiguous names in this math mean, with a one-click switch where useful. */
function NameNotes(props: { id: string }) {
  const notes = () => {
    const v = state.views[props.id];
    const g = state.report?.glossary ?? {};
    const out: { name: string; text: string; action?: [string, () => void] }[] = [];
    for (const name of v?.constants ?? []) {
      const c = g[`constant:${name}`];
      if (c?.meanings.includes("unit"))
        out.push({ name, text: `${c.title} = ${prettyValue(c.value)}`, action: [`Use the unit ${name}`, () => forceUnit(name)] });
    }
    for (const name of v?.units ?? []) {
      const u = g[`unit:${name}`];
      if (u?.meanings.includes("constant")) out.push({ name, text: `unit, ${prettyValue(u.value)} (after a number). Write *${name} for the constant` });
    }
    for (const name of v?.unitsOverVariables ?? []) {
      out.push({
        name,
        text: `the unit here (after a number), not your variable ${name}`,
        action: [`Use the variable ${name}`, () => useVariable(name)],
      });
    }
    for (const name of v?.shadowing ?? []) {
      const c = g[`constant:${name}`];
      if (c) out.push({ name, text: `your variable here, not the constant ${c.title}` });
    }
    return out;
  };
  return (
    <Show when={notes().length}>
      <div class="name-notes" onMouseDown={(e) => e.preventDefault()}>
        <For each={notes()}>
          {(n) => (
            <div class="name-note">
              <b>{n.name}</b>
              <span>{n.text}</span>
              <Show when={n.action}>
                <button onClick={() => n.action![1]()}>{n.action![0]}</button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function RichTextEditor(props: { p: Placed; style: Record<string, string | undefined> }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const id = untrack(() => props.p.region.id);
  onCleanup(() => view && releaseEditor(view));
  onMount(async () => {
    const src = untrack(() => editText(props.p.region));
    // plain text (e.g. just switched from math) opens instantly; markup goes through the parser
    const plain = !/[\\*_[\]{}`~^$<>#|-]|^\s*\d+\./.test(src);
    const html = plain ? null : await api.djotHtml(src).catch(() => "");
    if (state.editing !== id) return;
    view = createEditor(host, html ?? { text: src }, {
      onChange: (djot) => setLive(id, djot),
      onExit: (below) => (below ? commitBelow(id) : commitEditing()),
      onKey: (v, e) => {
        // "Area" + space became text, then ":" — it was a definition after all
        if (state.editingFresh && (e.key === ":" || e.key === "=") && !e.metaKey) {
          const word = plainText(v).trim();
          if (/^[\p{L}][\p{L}\p{N}_.]*$/u.test(word)) {
            e.preventDefault();
            convertEditing("math", `${word} ${e.key === ":" ? ":=" : "="}`);
            return true;
          }
        }
        return false;
      },
    });
    if (editClickPoint) placeCaret(view, ...editClickPoint);
  });
  return <div ref={host} class="text-body rich-host" style={props.style} />;
}

/** The engine's repair for an error, one click away. */
function FixButton(props: { id: string; fix: Fix }) {
  const label = () => (props.fix.kind === "rename" ? `Use ${props.fix.to}` : "Show definition");
  return (
    <button
      class="err-fix"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const f = props.fix;
        if (f.kind === "rename") renameIn(props.id, f.from, f.to);
        else revealRegion(f.id);
      }}
    >
      {label()}
    </button>
  );
}

function MathBody(props: { r: Region }) {
  const view = () => state.views[props.r.id];
  const editing = () => state.editing === props.r.id;
  const rendered = () => {
    const v = view();
    return v?.input ? mathml(v.input, props.r.show ? v.result : null, v.units, v.constants, props.r.show === "symbolic") : null;
  };
  return (
    <>
      <Show when={editing()}>
        <MathEditor r={props.r} />
      </Show>
      <div class="math-line" classList={{ preview: editing() }}>
        <Show when={rendered()} fallback={<code class="raw">{props.r.expr || " "}</code>}>
          <span class="m" innerHTML={rendered()!} />
        </Show>
        <Show when={props.r.note && !editing()}>
          <Html html={state.report?.html[`${props.r.id}:note`]} class="note" />
        </Show>
      </div>
      <Show when={editing() && prefs.nameNotes}>
        <NameNotes id={props.r.id} />
      </Show>
      <Show when={view()?.error}>
        <div class="err" title={view()!.error!}>
          <span class="err-text">{view()!.error}</span>
          <Show when={!editing() && view()?.fix}>{(fix) => <FixButton id={props.r.id} fix={fix()} />}</Show>
        </div>
      </Show>
    </>
  );
}

function TextBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const style = () => ({
    "font-family": r().style?.font ?? state.doc.styles?.body?.font,
    "font-size": pt(r().style?.size, state.doc.styles?.body?.size ?? 10),
    // aligned text needs the full width to align within; plain text hugs its content
    width: r().width
      ? `${r().width}px`
      : /\{[^}\n]*\.(center|right|justify)\b/.test(localized(r().text, state.doc.meta?.lang))
        ? `${availableWidth(props.p.x)}px`
        : undefined,
    // unsized text wraps at the page edge
    "max-width": r().width ? undefined : `${availableWidth(props.p.x)}px`,
    "--num": props.p.number && state.doc.styles?.numbering?.headings !== "" ? `"${props.p.number}. "` : undefined,
  });
  return (
    <Show
      when={state.editing !== r().id}
      fallback={<RichTextEditor p={props.p} style={{ ...style(), "min-width": "160px", "white-space": "normal" }} />}
    >
      <div style={style()} class="text-wrap" classList={{ fixed: !!r().width }}>
        <Show
          when={state.report?.html[r().id] !== undefined}
          fallback={<div class="text-body">{localized(r().text, state.doc.meta?.lang)}</div>}
        >
          <Html html={state.report?.html[r().id]} class="text-body" />
        </Show>
      </div>
    </Show>
  );
}

function ImageBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const size = () => r().size ?? [200, 150];
  const url = () => (r().src ? state.assets[r().src!] : undefined);
  return (
    <figure class="figure" style={{ width: `${size()[0]}px` }}>
      <Show when={r().caption?.position === "above"}>
        <Caption p={props.p} />
      </Show>
      <Show when={url()} fallback={<div class="img-missing" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }} />}>
        <img src={url()} width={size()[0]} height={size()[1]} draggable={false} alt="" />
      </Show>
      <Show when={r().caption?.position !== "above"}>
        <Caption p={props.p} />
      </Show>
    </figure>
  );
}

/** A plot as a figure: captioned like an image, with its error below. */
function PlotFigure(props: { p: Placed }) {
  const r = () => props.p.region;
  const error = () => state.views[r().id]?.error;
  return (
    <figure class="figure plot-figure" style={{ width: `${(r().size ?? DEFAULT_SIZE)[0]}px` }}>
      <Show when={r().caption?.position === "above"}>
        <Caption p={props.p} />
      </Show>
      <PlotBody r={r()} />
      <Show when={error()}>
        <div class="err" title={error()!}>
          <span class="err-text">{error()}</span>
        </div>
      </Show>
      <Show when={r().caption?.position !== "above"}>
        <Caption p={props.p} />
      </Show>
    </figure>
  );
}

function AreaBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const height = () => (r().collapsed ? AREA_COLLAPSED_HEIGHT : (r().height ?? 90));
  return (
    <div
      class="area"
      classList={{ collapsed: !!r().collapsed }}
      style={{ width: `${layout().pageView ? layout().geom.contentW : PAGE_WIDTH}px`, height: `${height()}px` }}
    >
      <div class="area-header">
        <button
          class="disclosure"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleArea(r().id)}
          title={r().collapsed ? "Expand" : "Collapse"}
        >
          {r().collapsed ? "▸" : "▾"}
        </button>
        <Html html={state.report?.html[`${r().id}:title`]} class="area-title" />
      </div>
    </div>
  );
}

function TableBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const view = () => state.views[r().id];
  const rows = (): Expr[][] | null => {
    const res = view()?.result;
    return res?.t === "Matrix" ? res.c : null;
  };
  const BoundTable = () => (
        <Show
          when={rows()}
          fallback={
            <div class="placeholder-box" style={{ width: `${r().size?.[0] ?? 300}px` }}>
              Table of <code>{r().source ?? "—"}</code>
              <Show when={view()?.error}>
                <div class="err">{view()!.error}</div>
              </Show>
            </div>
          }
        >
          <table class="table" classList={{ "head-row": !!r().header?.row, "head-col": !!r().header?.column }}>
            <tbody>
              <For each={rows()!}>
                {(row) => (
                  <tr>
                    <For each={row}>{(cell) => <td innerHTML={cellHtml(cell)} />}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
  );
  return (
    <figure class="figure">
      <Show when={r().caption?.position === "above"}>
        <Caption p={props.p} />
      </Show>
      <Show when={isSheet(r())} fallback={BoundTable()}>
        <SheetGrid p={props.p} />
      </Show>
      <Show when={r().caption?.position !== "above"}>
        <Caption p={props.p} />
      </Show>
    </figure>
  );
}

const textOf = (html: string | undefined) =>
  new DOMParser().parseFromString(html ?? "", "text/html").body.textContent?.trim() ?? "";

/** The text of the first heading in rendered text (a region may hold more after it). */
const headingOf = (html: string | undefined) => {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html");
  return (doc.querySelector("h1, h2, h3, h4, h5, h6") ?? doc.body).textContent?.trim() ?? "";
};

/** Table of contents / list of figures / list of tables — always current. */
function ContentsBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const of = () => (r().of as string | undefined) ?? "headings";
  const start = () => (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
  const entries = () =>
    layout()
      .list.filter((q) => !q.hidden && q.number)
      .filter((q) =>
        of() === "headings"
          ? q.region.kind === "text"
          : of() === "tables"
            ? q.region.kind === "table" && !!q.region.caption
            : q.region.kind !== "table" && q.region.kind !== "text" && !!q.region.caption,
      )
      .map((q) => {
        const headings = of() === "headings";
        const html = state.report?.html[headings ? q.region.id : `${q.region.id}:caption`];
        return {
          id: q.region.id,
          number: headings ? q.number! : "",
          label: headings ? headingOf(html) : `${captionPrefix(q.region, q.number)}${textOf(html)}`,
          level: headings ? q.number!.split(".").length : 1,
          page: q.page,
        };
      });
  return (
    <div class="contents" style={{ width: `${Math.min(availableWidth(props.p.x), 640)}px` }}>
      <div class="contents-title">{String(r().title ?? "Contents")}</div>
      <Show when={entries().length} fallback={<div class="contents-empty">Nothing to list yet.</div>}>
        <For each={entries()}>
          {(e) => (
            <div
              class={`contents-row lvl-${e.level}`}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => revealRegion(e.id)}
              title="Go to"
            >
              <Show when={e.number}>
                <span class="contents-num">{e.number}</span>
              </Show>
              <span class="contents-label">{e.label}</span>
              <span class="contents-dots" />
              <Show when={layout().pageView}>
                <span class="contents-page">{e.page + start()}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/** Drag handle that sets a text region's width or an image's size (Shift: free aspect). */
function ResizeHandle(props: { p: Placed }) {
  const r = () => props.p.region;
  const onDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const id = r().id;
    const startX = e.clientX;
    const startY = e.clientY;
    const sized = r().kind === "image" || r().kind === "plot2d";
    const w0 = sized ? (r().size?.[0] ?? 200) : (r().width ?? widths[id] ?? 200);
    const h0 = r().size?.[1] ?? 150;
    const ratio = h0 / w0;
    checkpoint();
    const move = (ev: PointerEvent) => {
      const w = Math.max(24, Math.round((w0 + (ev.clientX - startX) / state.view.zoom) / GRID) * GRID);
      const free = Math.max(16, Math.round(h0 + (ev.clientY - startY) / state.view.zoom));
      setState(
        "doc",
        produce((d) => {
          const reg = findDraft(d, id);
          if (!reg) return;
          if (reg.kind === "image") reg.size = [w, ev.shiftKey ? free : Math.round(w * ratio)];
          else if (reg.kind === "plot2d") reg.size = [Math.max(160, w), Math.max(120, free)];
          else reg.width = w;
        }),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setState({ dirty: true, rev: state.rev + 1 });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div class="resize-handle" classList={{ corner: r().kind === "image" || r().kind === "plot2d" }} onPointerDown={onDown} title="Drag to resize" />
  );
}

/** The units a result can be shown in, as a menu at the clicked unit. */
function openUnitMenu(e: MouseEvent, r: Region) {
  const choices = state.views[r.id]?.unitChoices ?? [];
  const current = r.display?.unit;
  const setUnit = (unit: string | undefined) => {
    closeMenu();
    updateRegion(r.id, (d) => {
      d.display = { ...d.display, unit };
      if (!unit) delete d.display.unit;
      if (!Object.keys(d.display).length) delete d.display;
    });
  };
  const items: MenuItems = choices.map((c) => ({ label: prettyValue(c.text), checked: c.unit === current, run: () => setUnit(c.unit) }));
  items.push(null, { label: "Automatic", checked: !current, run: () => setUnit(undefined) });
  items.push({
    label: "Other Unit…",
    run: () => {
      closeMenu();
      startEditing(r.id);
    },
  });
  const box = (e.target as Element).closest(".res")!.getBoundingClientRect();
  setMenu({ x: box.left, y: box.bottom + 4, items });
}

const KIND_LABEL: Record<string, string> = {
  plot3d: "3D plot (not supported in this version yet)",
  data: "Data import (not supported in this version yet)",
  legacy: "Unconverted SMath region",
  pagebreak: "Page break",
};

export function RegionBox(props: RegionProps) {
  // keyed by the region (a stable store object); its placement is looked up reactively,
  // so layout changes move the element instead of rebuilding it (and losing focus)
  const placed = (): Placed =>
    layout().byId.get(props.region.id) ?? {
      region: props.region,
      x: 0,
      y: 0,
      shift: 0,
      hidden: true,
      parent: null,
      page: 0,
      left: 0,
      top: 0,
    };
  const r = () => props.region;
  const selected = () => state.selection.includes(r().id);
  const editing = () => state.editing === r().id;
  let el!: HTMLDivElement;
  // pagination needs real heights; report them whenever the rendering changes size
  onMount(() => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const before = untrack(() => heights[r().id]) ?? 0;
      if (h && Math.abs(before - h) > 0.5) {
        setHeights(r().id, h);
        regionGrew(r().id, before, h);
      }
      const w = el.offsetWidth;
      if (w && Math.abs((untrack(() => widths[r().id]) ?? 0) - w) > 0.5) setWidths(r().id, w);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div
      ref={el}
      class={`region ${r().kind}`}
      classList={{
        selected: selected(),
        editing: editing(),
        error: !!state.views[r().id]?.error,
        found: hitIds().has(r().id),
        "trace-def": !!trace()?.defs.has(r().id),
        "trace-use": !!trace()?.uses.has(r().id) && !trace()?.defs.has(r().id),
      }}
      data-region={r().id}
      style={{
        left: `${placed().left}px`,
        top: `${placed().top}px`,
        display: placed().hidden ? "none" : undefined,
        "font-size": r().kind === "math" ? pt(r().style?.size, state.doc.styles?.math?.size ?? 10) : undefined,
      }}
      onPointerDown={(e) => {
        // inside the region being edited, clicks belong to the editor, not the canvas
        if (editing()) return e.stopPropagation();
        // a result's unit: pick another one
        if (e.button === 0 && !e.shiftKey && (e.target as Element).closest?.(".res .u") && state.views[r().id]?.unitChoices?.length) {
          e.stopPropagation();
          e.preventDefault();
          setState({ selection: [r().id], caret: null });
          return openUnitMenu(e, r());
        }
        props.onDragStart(r().id, e);
      }}
      onDblClick={(e) =>
        r().kind === "table"
          ? editTableAt(r().id, [e.clientX, e.clientY])
          : r().kind === "plot2d"
            ? editPlot(r().id)
            : startEditing(r().id, [e.clientX, e.clientY])
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // the canvas has its own menu
        if (!selected()) setState({ selection: [r().id], caret: null });
        openRegionMenu(e, r().id);
      }}
    >
      <Switch
        fallback={
          <div class="placeholder-box" style={{ width: `${r().size?.[0] ?? 240}px`, height: `${r().size?.[1] ?? 60}px` }}>
            {KIND_LABEL[r().kind] ?? r().kind}
          </div>
        }
      >
        <Match when={r().kind === "math"}>
          <MathBody r={r()} />
        </Match>
        <Match when={r().kind === "text"}>
          <TextBody p={placed()} />
        </Match>
        <Match when={r().kind === "image"}>
          <ImageBody p={placed()} />
        </Match>
        <Match when={r().kind === "area"}>
          <AreaBody p={placed()} />
        </Match>
        <Match when={r().kind === "table"}>
          <TableBody p={placed()} />
        </Match>
        <Match when={r().kind === "toc"}>
          <ContentsBody p={placed()} />
        </Match>
        <Match when={r().kind === "plot2d"}>
          <PlotFigure p={placed()} />
        </Match>
      </Switch>
      <Show
        when={
          selected() && state.selection.length === 1 && !editing() && !state.printing && ["text", "image", "plot2d"].includes(r().kind)
        }
      >
        <ResizeHandle p={placed()} />
      </Show>
      {/* a function definition can be plotted in one click (shown on hover or when selected) */}
      <Show when={r().kind === "math" && !editing() && !state.printing && /\(/.test(state.views[r().id]?.defines ?? "")}>
        <button
          class="plot-this"
          title="Plot this function below it"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setState({ selection: [r().id], caret: null });
            insertPlot();
          }}
        >
          <span>∿ Plot</span>
        </button>
      </Show>
    </div>
  );
}
