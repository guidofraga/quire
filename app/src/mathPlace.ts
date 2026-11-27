// Where the caret is in a formula edited in place, in words, for a screen reader (#165): "in the
// denominator of q times L squared over 8", "in the else branch", "on line 2 of 3 of the
// block". MathInPlace.tsx says it in a polite live region when the caret moves to another slot,
// never for each character typed, and says what a key deleted. Pure: no DOM.
import { type Deleted, type EditState, fromLinear, type Kind, type Node, nodeExpr, toExpr, whereIs } from "./mathTree";
import { spokenExpr } from "./speech";

/** Names the formula reads as units and constants, for reading it as the view does. */
export interface Names {
  units: readonly string[];
  constants: readonly string[];
}

/** Longer than this, the structure's own words are left out: where the caret is comes first. */
const MAX_WORDS = 10;

const NODE_WORD: Record<Kind, string> = {
  frac: "fraction",
  sup: "exponent",
  sub: "subscript",
  paren: "brackets",
  index: "index",
  matrix: "matrix",
  sqrt: "square root",
  root: "root",
  abs: "absolute value",
  big: "operator",
  str: "text",
  unit: "unit",
  const: "constant",
  cmd: "shortcut",
  if: "condition",
  block: "block",
  for: "loop",
  while: "loop",
};

const BIG_SLOTS: Record<string, string[]> = {
  sum: ["the body of the sum", "the index", "the lower limit", "the upper limit"],
  prod: ["the body of the product", "the index", "the lower limit", "the upper limit"],
  product: ["the body of the product", "the index", "the lower limit", "the upper limit"],
  int: ["the integrand", "the variable of integration", "the lower limit", "the upper limit"],
  diff: ["the expression differentiated", "the variable", "the order"],
  lim: ["the expression", "the variable", "the value approached"],
  limit: ["the expression", "the variable", "the value approached"],
};

/** "of a over b", or nothing when that would be long. */
function of(n: Node, names: Names): string {
  const e = nodeExpr(n);
  if (!e) return "";
  const words = spokenExpr(e, names.units, names.constants);
  return words.split(/\s+/).length <= MAX_WORDS ? ` of ${words}` : "";
}

/** One slot of a structure in words: "in the exponent", "in the else branch". */
function slotWords(n: Node, slot: number, names: Names): string | null {
  switch (n.k) {
    case "frac":
      return `in the ${slot ? "denominator" : "numerator"}${of(n, names)}`;
    case "sup":
      return "in the exponent";
    case "sub":
      return "in the subscript";
    case "index":
      return "in the index";
    case "paren":
      return "in brackets";
    case "sqrt":
      return "under the square root";
    case "root":
      return slot ? "in the index of the root" : "under the root";
    case "abs":
      return "in the absolute value";
    case "matrix": {
      const cols = n.cols ?? 1;
      return `in row ${Math.floor(slot / cols) + 1}, column ${(slot % cols) + 1} of the matrix`;
    }
    case "big": {
      const named = BIG_SLOTS[n.name ?? ""]?.[slot];
      return named ? `in ${named}` : `in argument ${slot + 1} of ${n.name}`;
    }
    case "str":
      return "in the text";
    case "unit":
      return "in the unit";
    case "const":
      return "in the constant";
    case "cmd":
      return null;
    case "if": {
      const last = n.slots.length - 1;
      if (n.slots.length % 2 === 1 && slot === last) return "in the else branch";
      if (slot % 2 === 0) return slot ? "in the else if condition" : "in the if condition";
      return slot === 1 ? "in the if branch" : "in the else if branch";
    }
    case "block":
      return `on line ${slot + 1} of ${n.slots.length} of the block`;
    case "for":
      return n.slots.length === 4
        ? ["in the start", "in the condition", "in the step", "in the loop body"][slot]
        : ["in the loop variable", "in the range", "in the loop body"][slot];
    case "while":
      return slot ? "in the loop body" : "in the condition";
  }
}

/**
 * Where the caret is: `key` changes when it moves to another slot (or a block's line), and only
 * then is `words` said. Null inside a `\name` being typed (its list speaks for itself).
 */
export function placeWords(s: EditState, names: Names): { key: string; words: string } | null {
  const w = whereIs(s, s.caret.row);
  if (!w) return null;
  if (!w.owner) {
    const unit = s.caret.row === s.line.unit.id;
    return { key: unit ? "unit" : "line", words: unit ? "in the unit of the result" : "on the main line" };
  }
  const words = slotWords(w.owner, w.slot, names);
  if (words === null) return null;
  const size = w.owner.k === "block" || w.owner.k === "if" || w.owner.k === "matrix" ? `:${w.owner.slots.length}` : "";
  return { key: `${w.owner.id}:${w.slot}${size}`, words };
}

const OP_WORD: Record<string, string> = {
  "+": "plus",
  "-": "minus",
  "*": "times",
  "/": "over",
  "^": "power",
  ",": "comma",
  ";": "semicolon",
  ":=": "is defined as",
  "≡": "is defined everywhere as",
  "==": "equals",
  "<": "less than",
  ">": "greater than",
  "≤": "less than or equal to",
  "≥": "greater than or equal to",
  "≠": "not equal to",
  "!": "factorial",
  ".": "point",
  "..": "range",
  " ": "space",
  "?": "blank",
  "(": "open bracket",
  ")": "close bracket",
};

/** What a key deleted, in words: "deleted 8", "removed the fraction", "removed line 2". */
export function deletedWords(d: Deleted, names: Names): string {
  if ("line" in d) return `removed line ${d.line}`;
  if ("branch" in d) return `removed the ${d.branch} branch`;
  if ("node" in d) return `removed the ${NODE_WORD[d.node]}`;
  const text = d.text;
  if (OP_WORD[text]) return `deleted ${OP_WORD[text]}`;
  const e = [...text].length > 1 ? toExpr(fromLinear(text)) : null;
  return `deleted ${e ? spokenExpr(e, names.units, names.constants) : text}`;
}
