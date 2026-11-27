// Inline math in text edited in place (#165, phase 3b): where the text ends and a formula begins.
// A formula in a paragraph is ProseMirror's `math` node; while it is typed into, the text's
// selection is that node (a NodeSelection), and its node view (MathInText.tsx) holds the
// structural editor (MathInPlace.tsx). Every change to the formula is a step of the text's own
// undo history, so one ⌘Z always undoes the latest edit, in the text or in a formula.
//
// The boundary is pure: ProseMirror states and edit trees, no DOM. The node view and the editor act
// on what these functions say, and the tests run the same functions key by key (inlineSim.ts).
// Below them, the little state the text editor and the node views share (which formula is open,
// and where the next one opens). The keys: docs/07-math-editing.md § Inline math in text.
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { type EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { type EditState, positions } from "./mathTree";

/** Where the caret goes in a formula opened: its start, its end, its first □, or where a click landed. */
export type Start = "start" | "end" | "hole" | [number, number];

/** A formula to open, and the key to give it once open (Backspace into it deletes its last character). */
export interface Open {
  pos: number;
  start: Start;
  then?: "Backspace" | "Delete";
}

/** Which side of the formula the text caret goes to when it is left. */
export type Side = "before" | "after";

/** A transaction made by the formula's editor: the text editor's own reactions (its `\` list) skip it. */
export const FROM_FORMULA = "quire.fromFormula";

export const isMath = (n: PMNode | null | undefined): n is PMNode => !!n && n.type.name === "math";

/** The formula open now: the math node the text's selection is on. */
export function openAt(state: EditorState): number | null {
  const sel = state.selection;
  return sel instanceof NodeSelection && isMath(sel.node) ? sel.from : null;
}

/**
 * A key typed in the text, next to a formula: does it go into the formula? → before a formula
 * enters it at its start, ← after one at its end, as a caret walks into a word; there is no stop
 * on the formula as a whole between the two (one press, one visible step, as everywhere in
 * docs/07). Backspace after a formula goes in and deletes its last character, Delete before one
 * its first: what a structure does in a formula (docs/07 § Backspace and Delete).
 */
export function enterFromText(state: EditorState, key: string): Open | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $p = sel.$from;
  const before = $p.nodeBefore;
  const after = $p.nodeAfter;
  switch (key) {
    case "ArrowRight":
      return isMath(after) ? { pos: $p.pos, start: "start" } : null;
    case "ArrowLeft":
      return isMath(before) ? { pos: $p.pos - before.nodeSize, start: "end" } : null;
    case "Backspace":
      return isMath(before) ? { pos: $p.pos - before.nodeSize, start: "end", then: "Backspace" } : null;
    case "Delete":
      return isMath(after) ? { pos: $p.pos, start: "start", then: "Delete" } : null;
  }
  return null;
}

/** Open the formula at `pos`: the text's selection on it, a new undo step after. */
export function openFormula(state: EditorState, pos: number): Transaction {
  return closeHistory(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
}

/** A new empty formula in place of the selection (`$$`, the Inline Math button), open. */
export function insertFormula(state: EditorState, expr = "", from?: number, to?: number): Transaction {
  const tr = state.tr;
  const node = state.schema.nodes.math.create({ expr });
  let at = from ?? state.selection.from;
  if (from === undefined) {
    tr.replaceSelectionWith(node, false);
    at = tr.mapping.map(at, -1);
  } else tr.replaceWith(from, to ?? from, node);
  if (!isMath(tr.doc.nodeAt(at))) return closeHistory(tr);
  return closeHistory(tr.setSelection(NodeSelection.create(tr.doc, at)));
}

/**
 * The formula's text, changed: one undo step of the text's history, of its own, so that ⌘Z in
 * the formula and in the text go back through the same steps in the order they were made.
 */
export function formulaChange(state: EditorState, pos: number, expr: string): Transaction {
  return closeHistory(state.tr.setNodeAttribute(pos, "expr", expr)).setMeta(FROM_FORMULA, true);
}

/**
 * Leave the formula at `pos` for the text: before it or after it, or at `at` (↑ ↓ to the line
 * above or below). A formula left empty goes, as an empty math region does.
 */
export function leaveFormula(state: EditorState, pos: number, side: Side, at?: number | null): Transaction {
  const tr = state.tr;
  const node = state.doc.nodeAt(pos);
  let to = at ?? (side === "before" ? pos : pos + (node?.nodeSize ?? 0));
  if (isMath(node) && !String(node.attrs.expr).trim()) {
    tr.delete(pos, pos + node.nodeSize);
    to = at != null ? tr.mapping.map(at) : pos;
  }
  const $to = tr.doc.resolve(Math.max(0, Math.min(to, tr.doc.content.size)));
  tr.setSelection($to.parent.inlineContent ? TextSelection.create(tr.doc, $to.pos) : TextSelection.near($to));
  return closeHistory(tr);
}

/**
 * ↑ or ↓ out of a formula on its paragraph's first or last line (no line of text that way): the
 * start or the end of the paragraph, as macOS moves a caret off a text's first or last line.
 */
export function lineEnd(state: EditorState, pos: number, dir: "up" | "down"): number {
  const $p = state.doc.resolve(pos);
  return dir === "up" ? $p.start() : $p.end();
}

/**
 * A key in the open formula that belongs to the text around it: Backspace at its very start,
 * Delete at its very end (the formula's first and last caret positions), with nothing selected.
 * There, the text's character on that side goes, as the formula's own characters would; an
 * empty formula goes itself.
 */
export function edgeKey(s: EditState, key: string): "back" | "forward" | null {
  if (s.anchor || (key !== "Backspace" && key !== "Delete")) return null;
  const all = positions(s);
  const at = (p: { row: string; i: number } | undefined) => !!p && p.row === s.caret.row && p.i === s.caret.i;
  if (key === "Backspace" && at(all[0])) return "back";
  if (key === "Delete" && at(all.at(-1))) return "forward";
  return null;
}

/** What the formula's editor asks of the text around it: to leave it one way, or to end the text's edit. */
export type Exit =
  | { leave: Side; at?: "up" | "down" }
  | { edge: "back" | "forward" }
  /** ⌘Enter: the text's edit ends, the insertion point under it (as ⌘Enter in text). */
  | { finish: true };

/** The tree's `effect`, said as what happens to the text: off an edge, out of the formula. */
export function exitOf(effect: EditState["effect"]): Exit | null {
  if (!effect) return null;
  if (effect.finish) return { leave: "after" };
  if (effect.command === "to_text") return { leave: "after" };
  switch (effect.leave) {
    case "left":
      return { leave: "before" };
    case "right":
      return { leave: "after" };
    case "up":
      return { leave: "before", at: "up" };
    case "down":
      return { leave: "after", at: "down" };
  }
  return null;
}

/**
 * Backspace (`by` −1) or Delete (+1) in the text: a character next to the caret, or into the
 * formula on that side. `null` for what the text editor does itself (joining paragraphs, a
 * selection).
 */
export function deleteInText(state: EditorState, by: -1 | 1): Transaction | Open | null {
  const into = enterFromText(state, by < 0 ? "Backspace" : "Delete");
  if (into) return into;
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $p = sel.$from;
  const node = by < 0 ? $p.nodeBefore : $p.nodeAfter;
  if (!node?.isText) return null;
  const text = node.text ?? "";
  // one character as the text is drawn: a surrogate pair at once
  const ch = by < 0 ? [...text].at(-1) : [...text][0];
  const n = ch?.length ?? 1;
  return by < 0 ? state.tr.delete($p.pos - n, $p.pos) : state.tr.delete($p.pos, $p.pos + n);
}

/**
 * `$$` typed in text: an empty formula, open (as in Notion). `$` alone stays a dollar sign, so
 * prices stay text; `$x$` becomes the formula `x` as it did before (`DOLLAR_MATH` in richtext.ts).
 * The position of the first `$`, or null.
 */
export function doubleDollar(state: EditorState, from: number, to: number, text: string): number | null {
  if (text !== "$" || from !== to) return null;
  const $from = state.doc.resolve(from);
  if (!$from.parent.inlineContent) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  return /(^|[\s([{"'“‘])\$$/u.test(before) ? from - 1 : null;
}

/**
 * The index of the formula at `pos` among the text's inline math, as the engine numbers it
 * (`<text region id>:m<n>`, in the order of the Djot): the formulas before it, and those in the
 * blocks kept as written. An empty formula isn't written, so has none.
 */
export function mathIndex(doc: PMNode, pos: number): number | null {
  let n = 0;
  let found: number | null = null;
  doc.descendants((node, at) => {
    if (found !== null) return false;
    if (node.type.name === "math") {
      const empty = !String(node.attrs.expr).trim();
      if (at === pos) {
        found = empty ? -1 : n;
        return false;
      }
      if (!empty) n++;
    } else if (node.type.name === "djot_block") {
      n += (String(node.attrs.html).match(/class="qmath"/g) ?? []).length;
      return false;
    }
    return true;
  });
  return found === null || found === -1 ? null : found;
}

// ---------------------------------------------------------------------------
// Which formula is open, and how the next one opens: shared by the text editor (richtext.ts) and
// the formulas' node views (MathInText.tsx), which the text region makes (Region.tsx)
// ---------------------------------------------------------------------------

/** A formula's node view, as the text editor around it knows it. */
export interface FormulaView {
  dom: HTMLElement;
  view: EditorView;
  /** Its place in the text. */
  pos(): number | undefined;
  /** The text changed: its number among the text's inline math may have too. */
  reindex(): void;
  isOpen(): boolean;
  /** The keyboard back to its editor. */
  focus(): void;
}

/** What the text editor around the formulas does for them. */
export interface TextHost {
  /** The text region, whose inline math is evaluated as `<id>:m<n>`. */
  region: string;
  /** ⌘Enter: the text's edit ends, the insertion point under it. */
  finish(): void;
  /** A key the text editor does itself (Backspace joining paragraphs). */
  textKey(view: EditorView, key: "Backspace" | "Delete"): void;
  /** A formula's node view is gone. */
  forget(f: FormulaView): void;
}

/** How the next formula opened starts: set right before the selection goes onto it. */
let next: { start: Start; then?: "Backspace" | "Delete" } | null = null;

/** How the formula the selection just came onto starts (MathInText `selectNode`): at its end unless told. */
export function takeStart(): { start: Start; then?: "Backspace" | "Delete" } {
  const how = next ?? { start: "end" as Start };
  next = null;
  return how;
}

/** `run` puts the selection on a formula (a new one): it opens with the caret at `start`. */
export function opening(start: Start, run: () => void) {
  next = { start };
  try {
    run();
  } finally {
    next = null;
  }
}

/** Open the formula at `o.pos` with the caret at `o.start` (a key, a click). */
export function openMath(view: EditorView, o: Open) {
  const node = view.state.doc.nodeAt(o.pos);
  // Backspace or Delete into an empty formula: it goes, as one does from inside
  if (o.then && node && !String(node.attrs.expr).trim()) {
    view.dispatch(leaveFormula(view.state, o.pos, "before"));
    return;
  }
  next = { start: o.start, then: o.then };
  try {
    view.dispatch(openFormula(view.state, o.pos));
  } finally {
    next = null;
  }
}

/** The formula open now, in whichever text editor. */
let current: FormulaView | null = null;

/** The formula opened (or closed, with null when `f` is the one open). */
export function setOpenFormula(f: FormulaView, open: boolean) {
  if (open) current = f;
  else if (current === f) current = null;
}

/** Put the keyboard back in the open formula, if a command run on the text took it (true if there is one). */
export function refocusFormula(view: EditorView): boolean {
  if (!current || current.view !== view || !current.isOpen()) return false;
  current.focus();
  return true;
}
