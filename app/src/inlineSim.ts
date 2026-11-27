// A paragraph of text with inline formulas, typed key by key as the editor on the page does it
// (#165, phase 3b), without a screen: for the tests of docs/07-math-editing.md § Inline math in
// text. The text's side is ProseMirror's own state and commands, as the browser would move a caret
// through text; at the boundary, and in a formula, it runs exactly what the editor runs:
// inlineMath.ts for the edges, mathTree.ts for the formula, and its text written into the
// paragraph as MathInPlace.tsx writes it. What needs a screen (a click, ↑ ↓ to another line) is
// left to the end-to-end tests.
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import {
  deleteInText,
  doubleDollar,
  edgeKey,
  enterFromText,
  type Exit,
  exitOf,
  formulaChange,
  insertFormula,
  leaveFormula,
  lineEnd,
  type Open,
  openAt,
  openFormula,
  type Start,
} from "./inlineMath";
import { type EditState, fromLinear, key as treeKey, settleSlots, sketch, toFirstHole, toLinear } from "./mathTree";
import { schema, toDjot } from "./richtext";

/** The formula open, as MathInPlace.tsx holds it. */
interface Formula {
  pos: number;
  s: EditState;
  initialText: string;
  initialTree: string;
  sent: string;
  byText: Map<string, EditState>;
}

const NAMED: Record<string, string> = {
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "⌫": "Backspace",
  "⌦": "Delete",
  Esc: "Escape",
};

/**
 * Paragraphs as the spec writes them: text, closed formulas as `$text$`, the text caret `‸`,
 * paragraphs apart by ` ¶ `.
 */
export function paragraphs(spec: string): { state: EditorState } {
  const blocks: PMNode[] = [];
  let caret = -1;
  let at = 0;
  for (const para of spec.split(" ¶ ")) {
    at += 1;
    const inline: PMNode[] = [];
    for (const m of para.matchAll(/\$([^$]*)\$|‸|[^$‸]+/gu)) {
      if (m[0] === "‸") caret = at;
      else if (m[1] !== undefined) {
        inline.push(schema.nodes.math.create({ expr: m[1] }));
        at += 1;
      } else {
        inline.push(schema.text(m[0]));
        at += m[0].length;
      }
    }
    blocks.push(schema.nodes.paragraph.create(null, inline));
    at += 1;
  }
  const doc = schema.node("doc", null, blocks);
  const sel = caret >= 0 ? TextSelection.create(doc, caret) : Selection.atEnd(doc);
  return { state: EditorState.create({ doc, selection: sel, plugins: [history()] }) };
}

export class InlineSim {
  state: EditorState;
  formula: Formula | null = null;
  /** The text's edit ended (Esc in the text, ⌘Enter). */
  ended = false;
  /** Every step taken, for a failure's message. */
  readonly log: string[] = [];

  constructor(spec: string) {
    this.state = paragraphs(spec).state;
  }

  private apply(tr: Transaction) {
    this.state = this.state.apply(tr);
  }

  /** Keys as the spec writes them: characters, `{→}`, `{⌫}`, `{Esc}`, `{Enter}`, `{⌘Enter}`, `{⌘Z}`, `{⌘⇧Z}`, `{Inline math}`. */
  keys(keys: string): this {
    for (const m of keys.matchAll(/\{([^}]+)\}|([\s\S])/gu))
      this.key(m[1] ? (NAMED[m[1]] ?? m[1]) : m[2] === "␣" ? " " : m[2]);
    return this;
  }

  key(k: string) {
    this.log.push(k);
    if (k === "⌘Z" || k === "⌘⇧Z") {
      (k === "⌘Z" ? undo : redo)(this.state, (tr) => this.apply(tr));
      return this.sync();
    }
    if (this.formula) return this.formulaKey(k);
    this.textKey(k);
    this.sync();
  }

  // ---- in the text: what the browser and ProseMirror do, and the boundary (inlineMath.ts) ----

  private textKey(k: string) {
    const run = (cmd: (s: EditorState, d: (tr: Transaction) => void) => boolean) =>
      cmd(this.state, (tr) => this.apply(tr));
    switch (k) {
      case "ArrowLeft":
      case "ArrowRight": {
        const into = enterFromText(this.state, k);
        if (into) return this.open(into);
        const by = k === "ArrowRight" ? 1 : -1;
        const sel = this.state.selection;
        const from = by > 0 ? sel.to : sel.from;
        if (!sel.empty) return this.apply(this.state.tr.setSelection(TextSelection.create(this.state.doc, from)));
        const $next = this.state.doc.resolve(Math.max(0, Math.min(this.state.doc.content.size, from + by)));
        const to = Selection.findFrom($next, by, true);
        if (to) this.apply(this.state.tr.setSelection(to));
        return;
      }
      case "Backspace":
      case "Delete": {
        const out = deleteInText(this.state, k === "Backspace" ? -1 : 1);
        if (out && "pos" in out) return this.open(out);
        if (out) return this.apply(out);
        run(baseKeymap[k]);
        return;
      }
      case "Escape":
      case "⌘Enter":
        this.ended = true;
        return;
      case "Enter":
        run(baseKeymap.Enter);
        return;
      case "Inline math":
        if (openAt(this.state) === null) this.open({ pos: -1, start: "hole" }, insertFormula(this.state));
        return;
    }
    if ([...k].length !== 1) return;
    const { from, to } = this.state.selection;
    const at = doubleDollar(this.state, from, to, k);
    if (at !== null) return this.open({ pos: -1, start: "hole" }, insertFormula(this.state, "", at, to));
    this.apply(this.state.tr.insertText(k));
  }

  // ---- in a formula: what MathInPlace.tsx does, and MathInText.tsx at its edges ----

  /** Open the formula at `o.pos` (or the one `tr` puts the selection on), as MathInText `openMath` and `open`. */
  private open(o: Open, tr?: Transaction) {
    if (!tr) {
      const node = this.state.doc.nodeAt(o.pos);
      if (o.then && node && !String(node.attrs.expr).trim())
        return this.apply(leaveFormula(this.state, o.pos, "before"));
      tr = openFormula(this.state, o.pos);
    }
    this.apply(tr);
    const pos = openAt(this.state);
    if (pos === null) return;
    this.formula = this.begin(pos, o.start);
    if (o.then) this.formulaKey(o.then);
  }

  private begin(pos: number, start: Start): Formula {
    const text = String(this.state.doc.nodeAt(pos)!.attrs.expr);
    let s = settleSlots(treeKey(fromLinear(text), "End"));
    const initialTree = toLinear(s);
    if (start === "start") s = treeKey(s, "Home");
    else if (start === "hole") s = toFirstHole(s) ?? s;
    s = settleSlots(s);
    return { pos, s, initialText: text, initialTree, sent: text, byText: new Map([[text, s]]) };
  }

  private formulaKey(k: string) {
    const f = this.formula!;
    if (k === "Escape") return this.exit({ leave: "after" });
    if (k === "⌘Enter") return this.exit({ finish: true });
    const edge = edgeKey(f.s, k);
    if (edge) return this.exit({ edge });
    f.s = settleSlots(treeKey(f.s, k));
    const text = toLinear(f.s);
    const out = text === f.initialTree ? f.initialText : text;
    f.byText.set(out, f.s);
    if (out !== f.sent) {
      f.sent = out;
      this.apply(formulaChange(this.state, f.pos, out));
    }
    const exit = exitOf(f.s.effect);
    f.s = { ...f.s, effect: undefined };
    if (exit) this.exit(exit);
  }

  private exit(how: Exit) {
    const f = this.formula!;
    if ("finish" in how) {
      this.ended = true;
      return;
    }
    const node = this.state.doc.nodeAt(f.pos);
    const empty = !String(node?.attrs.expr ?? "").trim();
    if ("edge" in how) {
      this.apply(leaveFormula(this.state, f.pos, how.edge === "back" ? "before" : "after"));
      this.formula = null;
      if (empty) return;
      const out = deleteInText(this.state, how.edge === "back" ? -1 : 1);
      if (out && "pos" in out) return this.open(out);
      if (out) return this.apply(out);
      baseKeymap[how.edge === "back" ? "Backspace" : "Delete"](this.state, (tr) => this.apply(tr));
      return;
    }
    // ↑ ↓ to another line need the page; here every paragraph is one line, so as on its first
    // or last: to the paragraph's start or end, as macOS does
    const to = "at" in how && how.at ? lineEnd(this.state, f.pos, how.at) : null;
    this.apply(leaveFormula(this.state, f.pos, how.leave, to));
    this.formula = null;
  }

  /** After an undo or redo: the formula the selection is on is the one open (MathInText `selectNode` / `update`). */
  private sync() {
    const pos = openAt(this.state);
    if (pos === null) {
      this.formula = null;
      return;
    }
    const text = String(this.state.doc.nodeAt(pos)!.attrs.expr);
    if (this.formula?.pos === pos) {
      const f = this.formula;
      if (text !== f.sent) {
        f.sent = text;
        f.s = f.byText.get(text) ?? settleSlots(treeKey(fromLinear(text), "End"));
      }
    } else this.formula = this.begin(pos, "end");
  }

  // ---- what the spec shows ----

  /** The paragraphs, closed formulas as `$text$`, the open one as its tree, the caret `‸`. */
  shown(): string {
    const sel = this.state.selection;
    const out: string[] = [];
    this.state.doc.forEach((block, offset) => {
      let line = "";
      const caret = (pos: number) => (sel instanceof TextSelection && sel.empty && sel.from === pos ? "‸" : "");
      block.forEach((n, o) => {
        const pos = offset + 1 + o;
        if (n.type.name === "math") {
          line += caret(pos) + (this.formula?.pos === pos ? `⟨${sketch(this.formula.s)}⟩` : `$${n.attrs.expr}$`);
        } else for (let k = 0; k < (n.text ?? "").length; k++) line += caret(pos + k) + n.text![k];
      });
      line += caret(offset + 1 + block.content.size);
      out.push(line);
    });
    return out.join(" ¶ ") + (this.ended ? " ⟶ end" : "");
  }

  /** What the document stores: the Djot written as the edit is typed. */
  djot(): string {
    return toDjot(this.state.doc, [], { dropEmptyMath: true });
  }
}
