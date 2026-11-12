// Math regions while you type: the linear editor, Greek and LaTeX shortcuts, prose detection
// (a sentence becomes text), and the meanings of a name: Ctrl+Space lists them, a list opens by
// itself after two letters, and ⌥Enter cycles the name at the caret through them.
import { nameAt, setCaretName } from "./trace";
import { paletteOpen } from "./Palette";
import { stepRegion } from "./nav";
import { selectInView } from "./Canvas";
import { editTableAt } from "./TableEditor";
import { prefs } from "./settings";
import { isMac } from "./api";
import { createEffect, on, onCleanup, untrack } from "solid-js";
import { announceFirst, completionKey, hideCompletions, type Item, openList, showCompletions } from "./Completion";
import { nameHtml, prettyValue } from "./math";
import { announce } from "./a11y";
import {
  cycleOrder,
  currentMeaning,
  forgetMeanings,
  KIND_WORD,
  knownMeanings,
  meanings,
  type NameSpan,
  nameSpan,
} from "./names";
import type { Completion } from "./types";
import { latexToLinear } from "./clipboard";
import { commandsFor, completions, exact, isTemplate, type Sym } from "./symbols";
import {
  commitBelow,
  commitEditing,
  convertEditing,
  definedNames,
  editClickPoint,
  editText,
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
/** Undo and redo for the math being edited, set while its editor is on the page. */
let activeMathHistory: ((redo: boolean) => void) | null = null;

/**
 * Undo (or redo) one step of typing in the math being edited; false when no math is being
 * edited. The browser's own undo is not used: it keeps one history for the whole page, so
 * a step typed into the hidden page field or the input before it can take the focus away,
 * or do nothing. Undoing past the start of the edit does nothing.
 */
export function undoInMath(redo = false): boolean {
  if (!activeMathHistory) return false;
  activeMathHistory(redo);
  return true;
}
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
const POPULAR = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "Delta",
  "theta",
  "lambda",
  "mu",
  "sigma",
  "omega",
  "phi",
  "sqrt",
  "frac",
  "sum",
  "int",
]
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

/**
 * A line of math inside another region (a solve block's), edited like a math region: its text
 * and results are its own, the region being edited (`state.editing`) is its owner.
 */
export interface MathLine {
  /** The id of its results in the report (`<region>:c0`). */
  view: string;
  /** The region being edited. */
  owner: string;
  text: string;
  /** A constraint: `=` types the equation sign, `==`. */
  equation?: boolean;
  /** Whether this line is still the one being edited (a blur from leaving it ends nothing). */
  active: () => boolean;
  onInput: (text: string) => void;
  onEnter: () => void;
  /** Tab or ⇧Tab: false when there is no line that way (on to the next region). */
  onTab: (by: 1 | -1) => boolean;
}

export function MathEditor(props: { r: Region; line?: MathLine }) {
  let input!: HTMLInputElement;
  // the id of its results and meanings, and the region being edited
  const viewId = untrack(() => props.line?.view ?? props.r.id);
  const owner = untrack(() => props.line?.owner ?? props.r.id);
  const live = (text: string) => (props.line ? props.line.onInput(text) : setLive(props.r.id, text));
  const initial = untrack(() => props.line?.text ?? editText(props.r));
  assignJustTyped = initial.endsWith(":=");
  createEffect(() => {
    input.focus();
    const hole = initial.indexOf("?");
    const at = editClickPoint ? offsetAt(input, editClickPoint[0]) : initial.length;
    if (hole >= 0) input.setSelectionRange(hole, hole + 1);
    else input.setSelectionRange(at, at);
    activeMathInput = input;
    activeMathHistory = travel;
    // the regions above may have changed since the last edit
    forgetMeanings(viewId);
    traceCaret();
  });
  onCleanup(() => {
    clearTimeout(nameTimer);
    if (activeMathInput === input) {
      activeMathInput = null;
      activeMathHistory = null;
    }
    setCaretName(null);
    hideCompletions();
  });
  const fit = () => {
    input.style.width = `${Math.max(6, input.value.length + 2)}ch`;
  };

  // every change to the text is a step; `at` is the step shown now
  type Step = { value: string; from: number; to: number };
  const steps: Step[] = [{ value: initial, from: initial.length, to: initial.length }];
  let at = 0;
  const record = () => {
    const now = { value: input.value, from: input.selectionStart ?? 0, to: input.selectionEnd ?? 0 };
    if (now.value === steps[at].value) return;
    steps.length = at + 1;
    steps.push(now);
    if (steps.length > 500) steps.shift();
    at = steps.length - 1;
  };
  const travel = (redo: boolean) => {
    const to = at + (redo ? 1 : -1);
    if (to < 0 || to >= steps.length) return;
    at = to;
    const step = steps[at];
    input.value = step.value;
    input.setSelectionRange(step.from, step.to);
    fit();
    live(step.value);
    updateCompletion();
    traceCaret();
  };
  const atEnd = () => input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  const latexBefore = () => (prefs.latex ? LATEX_BEFORE.exec(input.value.slice(0, input.selectionStart ?? 0)) : null);

  const traceCaret = () =>
    setCaretName(input.selectionStart === input.selectionEnd ? nameAt(input.value, input.selectionStart ?? 0) : null);
  /** The list for where the caret is: `\name` first, then the units after `=`, then names. */
  const updateCompletion = (typing = false) => {
    const m = latexBefore();
    if (!m) return inShownUnit() ? unitSuggestions() : nameSuggestions(typing);
    const caret = input.selectionStart ?? 0;
    const items = m[1] ? completions(m[1], 8, "math") : [...commandsFor("math"), ...POPULAR];
    const [x, y] = caretPoint(input);
    showCompletions(x, y, items, (sym) => applySymbol(input, sym, caret - m[0].length, caret));
  };
  /** The caret is after the `=` that shows the result, where the unit to show it in goes. */
  const inShownUnit = () =>
    splitShow(input.value).show === "value" && (input.selectionStart ?? 0) > input.value.lastIndexOf("=");

  // ---- names: what the name at the caret can mean here ----

  /** Set while this editor rewrites a name itself, so the change opens no list. */
  let rewriting = false;
  /** Replace `[from, to)` with `text` as one edit (one undo step). */
  const rewrite = (from: number, to: number, text: string) => {
    rewriting = true;
    input.focus();
    input.setSelectionRange(from, to);
    document.execCommand("insertText", false, text);
    rewriting = false;
  };
  const replaceName = (insert: string) => {
    const caret = input.selectionStart ?? 0;
    const span = nameSpan(input.value, caret);
    rewrite(span?.from ?? caret, span?.to ?? caret, insert);
  };
  const toItem = (c: Completion): Item => {
    const preview = prettyValue(c.preview);
    return {
      name: c.name,
      insert: c.insert,
      note: preview,
      kind: c.kind,
      html: nameHtml(c.name, c.kind),
      speak: `${c.name}, ${KIND_WORD[c.kind]}, ${preview}`,
    };
  };

  let nameTimer: ReturnType<typeof setTimeout> | undefined;
  let nameGen = 0;
  /**
   * The meanings of the name at the caret. Asked for (Ctrl+Space), the list lists them all and
   * Enter takes one; by itself it opens only after two letters that start a name, quietly:
   * Enter still finishes the line until the arrows move into it. Typing narrows either.
   */
  const nameSuggestions = (typing: boolean, ask = false) => {
    const gen = ++nameGen;
    clearTimeout(nameTimer);
    const open = openList();
    const namesOpen = open?.list === "names";
    const asked = ask || (namesOpen && !open.soft);
    const caret = input.selectionStart ?? 0;
    const span = input.selectionStart === input.selectionEnd ? nameSpan(input.value, caret) : null;
    // asked for between names: everything there is
    const here: NameSpan | null = span ?? (ask ? { from: caret, to: caret, name: "", marker: "", typed: "" } : null);
    const prefix = here ? (asked ? here.typed || here.name : here.typed) : "";
    const starts = typing && here?.to === caret && /^\p{L}{2}/u.test(prefix) && !KEYWORDS.has(prefix.toLowerCase());
    if (!here || !(asked || (prefix && (namesOpen || starts)))) {
      if (open) hideCompletions();
      return;
    }
    if (open && !namesOpen) hideCompletions();
    const id = viewId;
    const value = input.value;
    let toSay = ask;
    const show = (all: Completion[]) => {
      if (gen !== nameGen || input.value !== value || document.activeElement !== input) return;
      const fits = (c: Completion) =>
        c.name.startsWith(prefix) &&
        (here.marker === "'" ? c.kind === "unit" : here.marker === "#" ? c.kind === "constant" : true);
      const items = all.filter(fits).slice(0, 100).map(toItem);
      // a list that would only repeat what is typed stays closed
      const same = items.length === 1 && items[0].insert === value.slice(here.from, here.to);
      if (!items.length || (!asked && same)) {
        if (openList()?.list === "names") hideCompletions();
        if (toSay) announce(`Nothing named ${prefix || "here"}`);
        toSay = false;
        return;
      }
      const [x, y] = caretPoint(input);
      showCompletions(x, y, items, (item) => replaceName(item.insert), !asked, "names");
      if (toSay) announceFirst();
      toSay = false;
    };
    // what is known answers now; the engine is asked once typing pauses
    const known = knownMeanings(id, prefix);
    if (known) show(known.list);
    if (known?.exact) return;
    nameTimer = setTimeout(() => void meanings(id, prefix).then(show), asked ? 0 : 150);
  };

  /** ⌥Enter: the name at the caret takes its next meaning here (yours → unit → constant). */
  const cycleName = async () => {
    const value = input.value;
    const caret = input.selectionStart ?? 0;
    const span = input.selectionStart === input.selectionEnd ? nameSpan(value, caret) : null;
    if (!span) return announce("No name at the caret");
    const order = cycleOrder(await meanings(viewId, span.name), span.name);
    if (input.value !== value || state.editing !== owner) return;
    if (order.length < 2) {
      const only = order[0];
      return announce(
        only ? `${span.name} is only a ${KIND_WORD[only.kind]} here` : `${span.name} has no other meaning here`,
      );
    }
    const next = order[(currentMeaning(order, span, value) + 1) % order.length];
    rewrite(span.from, span.to, next.insert);
    announce(`${next.name}, ${KIND_WORD[next.kind]}, ${prettyValue(next.preview)}`);
  };

  // after `=`, the units the result can be shown in, each with the result in it (SMath's
  // unit placeholder); typing narrows the list, ↑↓ and Tab pick, Enter still finishes
  const unitSuggestions = () => {
    const { show, unit } = splitShow(input.value);
    const choices = state.views[viewId]?.unitChoices ?? [];
    if (show !== "value" || !atEnd() || !choices.length) return hideCompletions();
    const typed = (unit ?? "").toLowerCase();
    const items: Sym[] = choices
      .filter((c) => c.unit.toLowerCase().startsWith(typed))
      .map((c) => ({
        name: c.unit,
        insert: c.unit,
        label: prettyValue(`'${c.unit.replace(/\*/g, "*'").replace(/\//g, "/'")}`),
        note: prettyValue(c.text),
      }));
    if (!items.length || (items.length === 1 && items[0].name === unit)) return hideCompletions();
    // below the whole box, so the live result stays in view
    const [x] = caretPoint(input);
    const y = (input.closest(".region")?.getBoundingClientRect().bottom ?? caretPoint(input)[1]) + 6;
    showCompletions(
      x,
      y,
      items,
      (sym) => {
        const v = input.value;
        const start = unit ? v.length - unit.length : v.length;
        input.focus();
        input.setSelectionRange(start, v.length);
        document.execCommand("insertText", false, `${unit || v.endsWith(" ") ? "" : " "}${sym.insert}`);
      },
      true,
    );
  };
  // the choices arrive with the next evaluation after `=` is typed
  createEffect(
    on(
      () => state.views[viewId]?.unitChoices,
      () => document.activeElement === input && inShownUnit() && unitSuggestions(),
      { defer: true },
    ),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    // only the key right after `:` may be the `=` of `:=`; any other key ends that
    const typedAssign = assignJustTyped;
    assignJustTyped = false;
    // Ctrl+Space: what the name at the caret can be (after `=`, the units; in `\name`, symbols).
    // On a Mac also ⌥Space, as macOS keeps Ctrl+Space for input sources (and ⌥Space would only
    // type a non-breaking space); not on Windows, where Alt+Space opens the window menu
    const space = e.code === "Space" || e.key === " ";
    const listKey = e.ctrlKey ? !e.metaKey && !e.altKey : isMac && e.altKey && !e.metaKey;
    if (space && listKey) {
      e.preventDefault();
      if (latexBefore()) updateCompletion();
      else if (inShownUnit()) unitSuggestions();
      else nameSuggestions(false, true);
      return;
    }
    // ⌥Enter: the name at the caret takes its next meaning
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      hideCompletions();
      void cycleName();
      return;
    }
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
      // no slots to fill: on to the next line of the block, or the next region
      else if (!props.line?.onTab(e.shiftKey ? -1 : 1)) editNext(owner, e.shiftKey ? -1 : 1);
      return;
    }
    // ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+⇧Z / Ctrl+Y redo
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === "z" || (k === "y" && !e.metaKey))) {
      e.preventDefault();
      travel(k === "y" || e.shiftKey);
      return;
    }
    if (e.metaKey || e.altKey) return;
    if (e.key === "=" && props.line?.equation && !e.ctrlKey && !typedAssign) {
      // in a constraint `=` is the equation sign (a bold =, stored as `==`); `<=`, `>=`, `!=` as typed
      const before = input.value.slice(0, input.selectionStart ?? 0);
      if (/[<>!:≤≥≠]$/.test(before)) return;
      e.preventDefault();
      // `==` typed out in full: its second `=` is already there
      if (!before.endsWith("==")) document.execCommand("insertText", false, "==");
      return;
    }
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
      !props.line &&
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
      if (props.line) props.line.onEnter();
      else commitBelow(props.r.id);
    } else if (e.key === "Escape") {
      // done editing; the region stays selected for the keyboard
      e.preventDefault();
      const id = owner;
      const at = layout().byId.get(id)?.region.at;
      commitEditing();
      if (layout().byId.has(id)) setState({ selection: [id], caret: null });
      // an empty line goes away: the insertion point returns to where it was, so typing still works
      else if (at) setState({ caret: [at[0], at[1]] });
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
        record();
        live(e.currentTarget.value);
        if (rewriting) {
          // a name this editor put in: no list reopens over it
          nameGen++;
          clearTimeout(nameTimer);
        } else updateCompletion(e.inputType === "insertText" && /\p{L}$/u.test(e.data ?? ""));
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
      onBeforeInput={(e) => {
        // the edit menu and the context menu undo through here
        if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
        e.preventDefault();
        travel(e.inputType === "historyRedo");
      }}
      onKeyDown={(e) => {
        onKeyDown(e);
        e.stopPropagation();
      }}
      onKeyUp={(e) => {
        traceCaret();
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") updateCompletion();
      }}
      onClick={() => {
        traceCaret();
        if (openList()) updateCompletion();
      }}
      onBlur={(e) => {
        hideCompletions();
        setCaretName(null);
        // switching to text unmounts this input: that blur must not end the edit; nor does
        // moving to another line of the same block
        const stillMath = props.line ? props.line.active() : layout().byId.get(props.r.id)?.region.kind === "math";
        // nor does the command palette, which puts what it inserts at this caret, nor the
        // format bar reached from the keyboard (F6), whose galleries insert here too
        const toBar = (e.relatedTarget as Element | null)?.closest?.(".formatbar");
        if (state.editing === owner && stillMath && !paletteOpen() && !toBar) commitEditing();
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
