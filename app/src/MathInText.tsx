// Inline math in a paragraph, with Settings ▸ Editing ▸ Edit math in place on (#165, phase 3b): the
// ProseMirror node view of a `math` node. It is drawn typeset, exactly as the text draws it when
// it isn't edited, and while the text's selection is on it (inlineMath.ts) it holds the formula's
// editor (MathInPlace.tsx), drawn the same way: the paragraph never moves as the caret goes in and
// out. The keys at its edges: docs/07-math-editing.md § Inline math in text.
import type { Node as PMNode } from "prosemirror-model";
import { redo as redoCmd, undo as undoCmd } from "prosemirror-history";
import type { NodeView, EditorView } from "prosemirror-view";
import { createEffect, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { mathml } from "./math";
import { drawLine, type Said } from "./mathDraw";
import { fromExpr, fromLinear, key, settleSlots, toLinear } from "./mathTree";
import { MathInPlace, type Spot } from "./MathInPlace";
import type { MathLine } from "./MathEditor";
import { spokenMath } from "./speech";
import { splitShow, state } from "./store";
import type { RegionView } from "./types";
import {
  deleteInText,
  type Exit,
  formulaChange,
  type FormulaView,
  leaveFormula,
  mathIndex,
  openMath,
  setOpenFormula,
  type Start,
  takeStart,
  type TextHost,
} from "./inlineMath";

const sameSaid = (a: Said, b: Said) =>
  a.result === b.result && a.units.join() === b.units.join() && a.constants.join() === b.constants.join();

/**
 * Whether the engine's view of a number is this formula as it reads now: inline math is numbered
 * by its place in the text, so for a moment after a formula is added, the view at a number can
 * still be another's.
 */
function readsAs(
  v: RegionView | undefined,
  expr: string,
): v is RegionView & { input: NonNullable<RegionView["input"]> } {
  if (!v?.input) return false;
  const { show, unit } = splitShow(expr);
  try {
    return toLinear(fromExpr(v.input, show || null, unit ?? "")) === toLinear(fromLinear(expr));
  } catch {
    return false;
  }
}

/**
 * The formula as the text draws it when it isn't edited (Region.tsx `fillInlineMath`); before the
 * engine has read it, as the editor would draw it. A line that asks for a result it has none for
 * keeps its `= □`, as the editor draws it, so opening it moves nothing.
 */
export function inlineHtml(expr: string, v: RegionView | undefined): string {
  if (readsAs(v, expr)) {
    const { show } = splitShow(expr);
    const pending = show && !v.result ? { unit: null } : undefined;
    return mathml(v.input, v.result, v.units, v.constants, v.symbolic, {}, undefined, pending);
  }
  const s = settleSlots(key(fromLinear(expr), "End"));
  return drawLine(s, { result: null, units: v?.units ?? [], constants: v?.constants ?? [] }).replace(
    / data-(?:r|a|n|node|hole|script|open|close|unitrow)="[^"]*"/g,
    "",
  );
}

export class MathInText implements NodeView, FormulaView {
  dom: HTMLSpanElement;
  private shown: HTMLSpanElement;
  private node: PMNode;
  private index: () => number | null;
  private setIndex: (n: number | null) => void;
  private setExpr: (e: string) => void;
  private opened: () => boolean;
  private setOpened: (o: boolean) => void;
  private disposeDrawing: () => void;
  private disposeEditor: (() => void) | null = null;
  private api: { reload(text: string): void; focus(): void } | null = null;
  private closing = false;

  constructor(
    node: PMNode,
    readonly view: EditorView,
    private getPos: () => number | undefined,
    private host: TextHost,
  ) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "qmath qmath-ip";
    this.dom.contentEditable = "false";
    this.shown = document.createElement("span");
    this.shown.className = "m";
    this.dom.appendChild(this.shown);
    const [index, setIndex] = createSignal<number | null>(null);
    this.index = index;
    this.setIndex = setIndex;
    const [expr, setExpr] = createSignal(String(node.attrs.expr));
    this.setExpr = setExpr;
    const [opened, setOpened] = createSignal(false);
    this.opened = opened;
    this.setOpened = setOpened;
    this.disposeDrawing = createRoot((dispose) => {
      createEffect(() => {
        const e = expr();
        const v = this.viewOf();
        // while open, its editor draws it
        if (this.opened()) return;
        this.shown.innerHTML = inlineHtml(e, v);
        const reads = readsAs(v, e);
        this.dom.classList.toggle("inline-error", !!v?.error && reads);
        this.dom.title = reads ? (v?.error ?? "") : "";
        this.dom.setAttribute("role", "img");
        this.dom.setAttribute(
          "aria-label",
          reads ? spokenMath(v.input, v.result, v.units, v.constants, v.symbolic) : e || "empty formula",
        );
      });
      return dispose;
    });
    this.reindex();
    // a click on the formula opens it where it lands; on the text, the text editor has it
    this.dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || this.isOpen()) return;
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) openMath(this.view, { pos, start: [e.clientX, e.clientY] });
    });
  }

  /** The engine's view of this formula: `<region>:m<n>`. */
  private viewOf(): RegionView | undefined {
    const n = this.index();
    return n === null ? undefined : state.views[`${this.host.region}:m${n}`];
  }

  /** Where it is in the text. */
  pos(): number | undefined {
    return this.getPos();
  }

  /** Its number among the text's inline math, after the text changed. */
  reindex() {
    const pos = this.getPos();
    this.setIndex(pos === undefined ? null : mathIndex(this.view.state.doc, pos));
  }

  isOpen() {
    return this.opened();
  }

  focus() {
    this.api?.focus();
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const expr = String(node.attrs.expr);
    if (this.isOpen()) this.api?.reload(expr);
    this.setExpr(expr);
    return true;
  }

  /** The text's selection came onto it: the formula is typed into. */
  selectNode() {
    const how = takeStart();
    this.open(how.start, how.then);
  }

  /** The text's selection left it. */
  deselectNode() {
    this.close();
  }

  private open(start: Start, then?: string) {
    if (this.isOpen()) return;
    const n = this.index();
    const id = `${this.host.region}:m${n ?? "new"}`;
    const said = (): Said => {
      const v = this.viewOf();
      return { result: v?.result ?? null, units: v?.units ?? [], constants: v?.constants ?? [] };
    };
    let last: Said | null = null;
    // a new object only when what it says changed, so the formula isn't drawn again for nothing
    const steady = () => {
      const now = said();
      if (!last || !sameSaid(last, now)) last = now;
      return last;
    };
    const line: MathLine = {
      view: id,
      owner: this.host.region,
      text: String(this.node.attrs.expr),
      active: () => this.isOpen(),
      onInput: (text) => {
        const pos = this.getPos();
        if (pos !== undefined) this.view.dispatch(formulaChange(this.view.state, pos, text));
      },
      onEnter: () => this.exit({ leave: "after" }, null),
      onTab: (by) => {
        this.exit({ leave: by > 0 ? "after" : "before" }, null);
        return true;
      },
    };
    this.dom.removeAttribute("role");
    this.dom.removeAttribute("aria-label");
    this.dom.removeAttribute("title");
    this.shown.remove();
    this.setOpened(true);
    this.dom.classList.add("open");
    setOpenFormula(this, true);
    this.closing = false;
    const dispose = render(
      () => (
        <MathInPlace
          r={{ id, kind: "math", at: [0, 0], expr: line.text }}
          line={line}
          said={steady}
          inline={{
            start,
            then,
            exit: (how, at) => this.exit(how, at),
            undo: (redo) => (redo ? redoCmd : undoCmd)(this.view.state, this.view.dispatch),
            bind: (api) => (this.api = api),
          }}
        />
      ),
      this.dom,
    );
    this.disposeEditor = dispose;
    // left already, by the key it was opened with
    if (this.closing) this.close();
  }

  private close() {
    if (!this.disposeEditor) {
      this.closing = true;
      return;
    }
    const dispose = this.disposeEditor;
    this.disposeEditor = null;
    this.api = null;
    setOpenFormula(this, false);
    const typing = this.dom.contains(document.activeElement);
    dispose();
    this.dom.textContent = "";
    this.dom.appendChild(this.shown);
    // drawn again as the text draws it
    this.setOpened(false);
    this.dom.classList.remove("open");
    // the text's selection moved off it (an undo or redo): the keys go to the text
    if (typing) this.view.focus();
  }

  /** Out of the formula, into the text: to one side, to the line above or below, or out of the text's edit. */
  private exit(how: Exit, at: Spot | null) {
    const pos = this.getPos();
    if (pos === undefined) return;
    const view = this.view;
    if ("finish" in how) return this.host.finish();
    if ("edge" in how) {
      const side = how.edge === "back" ? "before" : "after";
      const empty = !String(this.node.attrs.expr).trim();
      view.dispatch(leaveFormula(view.state, pos, side));
      view.focus();
      // the character on that side goes, as the formula's own would (an empty formula went itself)
      if (!empty) {
        const by = how.edge === "back" ? -1 : 1;
        const out = deleteInText(view.state, by);
        if (out && "pos" in out) openMath(view, out);
        else if (out) view.dispatch(out);
        else this.host.textKey(view, how.edge === "back" ? "Backspace" : "Delete");
      }
      return;
    }
    let to: number | null = null;
    if (how.at && at) {
      // ↑ ↓: the line above or below, at the caret's x, as in the text
      const r = this.dom.getBoundingClientRect();
      const y = how.at === "up" ? r.top - 2 : r.bottom + 2;
      const found = view.posAtCoords({ left: at.x, top: y });
      if (found && (found.pos < pos || found.pos > pos + this.node.nodeSize)) to = found.pos;
    }
    view.dispatch(leaveFormula(view.state, pos, how.leave, to));
    view.focus();
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.host.forget(this);
    if (this.disposeEditor) {
      const dispose = this.disposeEditor;
      this.disposeEditor = null;
      setOpenFormula(this, false);
      dispose();
    }
    this.disposeDrawing();
  }
}
