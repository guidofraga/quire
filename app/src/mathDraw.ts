// The formula being edited in place (#165), as MathML: the edit tree (mathTree.ts) read row by
// row as the engine reads text (mathLinear `traceRow`), with the brackets the stored text will
// have (`withPrintedBrackets`), drawn by math.ts exactly as the stored formula is drawn. Each
// part carries where it is in the tree, for the caret (MathInPlace.tsx). Pure: no DOM.
import { editingMathml, esc, type NameMarks, type Piece } from "./math";
import { isDigit, isNameStart, OPS, traceRow, traceSlice, withPrintedBrackets } from "./mathLinear";
import type { EditState, Row } from "./mathTree";
import type { Expr } from "./types";

/** What the engine said about the line last: the result, and which names are units or constants. */
export interface Said {
  result: Expr | null;
  units: readonly string[];
  constants: readonly string[];
  marks?: NameMarks;
}

/** The line's MathML, tagged for the caret. */
export function drawLine(s: EditState, said: Said): string {
  const line = s.line;
  const unit = line.show === "value" && line.unit.atoms.length ? rowPieces(line.unit) : null;
  return editingMathml({
    main: rowPieces(line.main),
    show: line.show,
    result: said.result,
    unit: unit?.length === 1 ? unit[0] : null,
    unitRow: line.unit.id,
    units: said.units,
    constants: said.constants,
    nameMarks: said.marks ?? {},
  });
}

/**
 * A row as pieces to draw: one expression, as nearly always; for a row that doesn't read as one
 * (`a, b`, `x := 1, 2`), its parts between the separators, and each atom of a part that doesn't
 * read either, so that whatever is typed is drawn where it is typed.
 */
function rowPieces(r: Row): Piece[] {
  const whole = traceRow(r);
  if (whole.expr) return [{ expr: withPrintedBrackets(whole.expr), spans: whole.spans }];
  const out: Piece[] = [];
  let start = 0;
  const part = (from: number, to: number) => {
    if (from >= to) return;
    const p = traceSlice(r, from, to);
    if (p.expr) out.push({ expr: withPrintedBrackets(p.expr), spans: p.spans });
    else for (let k = from; k < to; k++) out.push(atomPiece(r, k));
  };
  r.atoms.forEach((a, k) => {
    if (a.k === "g" && (a.s === "," || a.s === ";")) {
      part(start, k);
      out.push(glyphHtml(r, k));
      start = k + 1;
    }
  });
  part(start, r.atoms.length);
  return out.length ? out : [glyphHtml(r, 0)];
}

function atomPiece(r: Row, k: number): Piece {
  const a = r.atoms[k];
  if (a.k === "g") return glyphHtml(r, k);
  const p = traceSlice(r, k, k + 1);
  return p.expr ? { expr: withPrintedBrackets(p.expr), spans: p.spans } : "";
}

const SHOWN: Record<string, string> = { "*": "·", "-": "−", ":=": "≔", "==": "=", and: "∧", or: "∨", not: "¬" };

/** A single character as typed, where the row doesn't read: an operator, a letter, a digit. */
function glyphHtml(r: Row, k: number): string {
  const a = r.atoms[k];
  if (!a || a.k !== "g") return "";
  const tags = ` data-r="${esc(r.id)}" data-a="${k}" data-n="1"`;
  if (a.s === " ") return `<mspace width="0.2em"${tags}></mspace>`;
  if (OPS.has(a.s) || a.s === "?") return `<mo${tags}>${esc(SHOWN[a.s] ?? a.s)}</mo>`;
  if (isDigit(a.s) || a.s === ".") return `<mn${tags}>${esc(a.s)}</mn>`;
  return isNameStart(a.s) ? `<mi${tags}>${esc(a.s)}</mi>` : `<mo${tags}>${esc(a.s)}</mo>`;
}
