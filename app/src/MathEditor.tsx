// Math regions while you type: the linear editor, Greek and LaTeX shortcuts, prose detection
// (a sentence becomes text) and the notes under a line about names that mean two things.
import { nameAt, setCaretName } from "./trace";
import { paletteOpen } from "./Palette";
import { stepRegion } from "./nav";
import { selectInView } from "./Canvas";
import { editTableAt } from "./TableEditor";
import { prefs } from "./settings";
import { createEffect, For, on, onCleanup, Show, untrack } from "solid-js";
import { completionKey, hideCompletions, showCompletions } from "./Completion";
import { prettyValue } from "./math";
import { latexToLinear } from "./clipboard";
import { commandsFor, completions, exact, isTemplate, type Sym } from "./symbols";
import {
  commitBelow,
  commitEditing,
  convertEditing,
  definedNames,
  editClickPoint,
  editText,
  flash,
  layout,
  runAppCommand,
  setLive,
  setState,
  splitShow,
  startEditing,
  state,
} from "./store";
import type { Region } from "./types";

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
export function looksLikeProse(value: string, id: string): boolean {
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

export function MathEditor(props: { r: Region }) {
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
      aria-label="Math"
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
      onPaste={(e) => {
        // LaTeX from a paper or Overleaf goes in as linear math (`\frac{a}{b}` → `a/b`)
        const linear = latexToLinear(e.clipboardData?.getData("text/plain").trim() ?? "");
        if (linear === null) return;
        e.preventDefault();
        document.execCommand("insertText", false, linear.split("\n")[0]);
      }}
      onKeyDown={(e) => {
        onKeyDown(e);
        e.stopPropagation();
      }}
      onKeyUp={(e) => {
        traceCaret();
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") updateCompletion();
      }}
      onClick={traceCaret}
      onBlur={(e) => {
        hideCompletions();
        setCaretName(null);
        // switching to text unmounts this input: that blur must not end the edit
        const stillMath = layout().byId.get(props.r.id)?.region.kind === "math";
        // nor does the command palette, which puts what it inserts at this caret, nor the
        // format bar reached from the keyboard (F6), whose galleries insert here too
        const toBar = (e.relatedTarget as Element | null)?.closest?.(".formatbar");
        if (state.editing === props.r.id && stillMath && !paletteOpen() && !toBar) commitEditing();
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
  // a whole name, also straight after a number (`2g`)
  const re = new RegExp(`(?<![\\p{L}_.'])${escaped}(?![\\p{L}\\p{N}_])`, "gu");
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
  // a number (or a vector's closing bracket), then the name as a whole word: `10 m`, `10m`
  const re = new RegExp(`([\\p{N}\\]])\\s*${escaped}(?![\\p{L}\\p{N}_.])`, "gu");
  const next = input.value.replace(re, `$1*${name}`);
  // inside a unit (`100 km/h` with a variable h) there is no number to split from
  if (next === input.value) return flash(`Write *${name} for your variable`);
  input.focus();
  input.select();
  document.execCommand("insertText", false, next);
}

/** What the ambiguous names in this math mean, with a one-click switch where useful. */
export function NameNotes(props: { id: string }) {
  const notes = () => {
    const v = state.views[props.id];
    const g = state.report?.glossary ?? {};
    const out: { name: string; text: string; action?: [string, () => void] }[] = [];
    for (const name of v?.constants ?? []) {
      const c = g[`constant:${name}`];
      if (c?.meanings.includes("unit"))
        out.push({ name, text: `${c.title} = ${prettyValue(c.value)}`, action: [`Use unit ${name}`, () => forceUnit(name)] });
    }
    for (const name of v?.units ?? []) {
      const u = g[`unit:${name}`];
      if (u?.meanings.includes("constant")) out.push({ name, text: `unit, ${prettyValue(u.value)} · *${name} for the constant` });
    }
    for (const name of v?.unitsOverVariables ?? []) {
      out.push({
        name,
        text: `unit here, not your variable`,
        action: [`Use variable ${name}`, () => useVariable(name)],
      });
    }
    for (const name of v?.shadowing ?? []) {
      const c = g[`constant:${name}`];
      if (c) out.push({ name, text: `your variable, not ${c.title}` });
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
