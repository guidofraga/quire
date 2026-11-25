// The structural math editor's model (#165): a formula as a tree of rows and structures, a caret
// in it, and what every key does to both. Pure data and functions, no DOM: the editor on the page
// (phase 2) draws `hints()` and sends keys to `key()`. The rules are specified, with the reasons,
// in docs/07-math-editing.md; mathTree.test.ts runs that page's tables.
//
// The one idea behind the rules: typing the linear text of a formula, character by character,
// builds the tree that the engine's parser reads from that text. `q*L^2/8` typed here is the
// fraction (q·L²)/8, exactly as when it is typed in the linear box, so nothing typed fast and
// from habit means something else. Where the caret was put by hand (arrows, a click), what is
// typed goes where the caret is.
import type { Expr } from "./types";
import {
  constName,
  isDigit,
  isNameCont,
  isNameStart,
  isUnitChar,
  NEEDS_BRACKETS,
  OPS,
  prec,
  print,
  rawText,
  rowExpr,
  rowLinear,
  rowText,
} from "./mathLinear";
import { exact } from "./symbols";

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * One visible thing on a row: a letter or digit of a name or number, a decimal point, an
 * operator (`+`, `*` drawn ·, `:=` drawn ≔, `and` drawn ∧), `?` (an empty slot typed as such),
 * or `" "`, which only keeps two names apart (`a and b` while `and` is being typed).
 */
export interface Glyph {
  k: "g";
  id: string;
  s: string;
  /** Put in by the editor, not typed: the `·` between two values (`2·(`). */
  auto?: boolean;
}

export type Kind =
  /** slots: numerator, denominator */
  | "frac"
  /** a superscript; its base is what comes before it on the row */
  | "sup"
  /** a name's literal subscript, `A.net`; it follows the name's letters */
  | "sub"
  /** brackets typed; `ghost` while the `)` hasn't been typed */
  | "paren"
  /** `M[i, j]`, drawn as a subscript */
  | "index"
  /** cells row by row, `cols` wide */
  | "matrix"
  | "sqrt"
  /** slots: radicand, index (as `root(x, n)`); drawn and walked index first */
  | "root"
  | "abs"
  /** sums, products, integrals, derivatives and limits: `name` and its arguments */
  | "big"
  | "str"
  /** a quoted unit, `'kN` */
  | "unit"
  /** a built-in constant, `#G` */
  | "const"
  /** a `\name` shortcut being typed */
  | "cmd";

export interface Node {
  k: Kind;
  id: string;
  slots: Row[];
  ghost?: boolean;
  cols?: number;
  name?: string;
}

export type Atom = Glyph | Node;

export interface Row {
  id: string;
  atoms: Atom[];
  /**
   * Opened by typing (`/`, `^`, `.`, `'`, `#`) or entered by Backspace or Delete: an operator
   * this slot can't hold, typed at its end, leaves it, as it would end it in the linear text.
   */
  born?: boolean;
  /** Brackets typed around the whole slot that it doesn't draw and doesn't need: `x^(2)`. */
  kept?: boolean;
}

export type Show = null | "value" | "symbolic";

export interface Line {
  main: Row;
  /** After `=`: the unit to show the result in (`= kN*m`). */
  unit: Row;
  show: Show;
}

export interface Pos {
  row: string;
  i: number;
}

export type Dir = "left" | "right" | "up" | "down";

export interface EditState {
  line: Line;
  caret: Pos;
  /** The other end of the selection, if any. The selection is always a slice of one row. */
  anchor: Pos | null;
  /** A space was typed: a name typed next is a new word (`a and b`). */
  space?: boolean;
  /** `:` just typed `:=`: an `=` right after it is swallowed, a `:` makes `≡`. */
  assign?: boolean;
  /** The line before an `=` showed the result: a second `=` makes `==` there instead. */
  beforeShow?: { line: Line; caret: Pos };
  /** A solve block's constraint: `=` types the equation sign `==`. */
  equation?: boolean;
  /** Counts changes to the line; undo steps are taken where it changes. */
  version: number;
  /** What the last key asks of the editor around the model. */
  effect?: { leave?: Dir; command?: string };
}

let seq = 0;
const nid = () => `m${(++seq).toString(36)}`;
const gl = (s: string): Glyph => ({ k: "g", id: nid(), s });
/** The `·` the editor puts between two values the text can't write side by side. */
const times = (): Glyph => ({ k: "g", id: nid(), s: "*", auto: true });
const mkRow = (atoms: Atom[] = [], extra: Partial<Row> = {}): Row => ({ id: nid(), atoms, ...extra });
const mkNode = (k: Kind, slots: Row[], extra: Partial<Node> = {}): Node => ({ k, id: nid(), slots, ...extra });

const glyph = (a: Atom | undefined): string | null => (a && a.k === "g" ? a.s : null);
const isOp = (a: Atom | undefined) => !!a && a.k === "g" && OPS.has(a.s) && a.s !== "!";
const isWordChar = (a: Atom | undefined) => !!a && a.k === "g" && isNameCont(a.s);

/** Operators looser than `*` and `/`: where a fraction's numerator starts. */
const LOOSE = new Set(["+", "-", "±", ",", ";", ":=", "≡", "==", "<", ">", "≤", "≥", "≠", "..", "and", "or", "not"]);
const SIGNS = new Set(["+", "-", "±"]);

/**
 * Functions drawn as a shape, with the order their slots are walked in (`order`, indices into
 * the arguments) and where ↑ and ↓ go between them. `sqrt`, `abs` and `root` take their shape as
 * soon as `(` is typed after the name; the others when their `)` is typed, with this many arguments.
 */
const BIG: Record<string, { order: number[]; up?: Record<number, number>; down?: Record<number, number> }> = {
  "sum/4": { order: [1, 2, 3, 0], up: { 1: 3, 2: 3 }, down: { 3: 2 } },
  "prod/4": { order: [1, 2, 3, 0], up: { 1: 3, 2: 3 }, down: { 3: 2 } },
  "product/4": { order: [1, 2, 3, 0], up: { 1: 3, 2: 3 }, down: { 3: 2 } },
  "int/4": { order: [2, 3, 0, 1], up: { 2: 3 }, down: { 3: 2 } },
  "int/2": { order: [0, 1] },
  "diff/2": { order: [1, 0] },
  "diff/3": { order: [2, 1, 0], up: { 1: 2 }, down: { 2: 1 } },
  "lim/3": { order: [1, 2, 0] },
  "limit/3": { order: [1, 2, 0] },
};
const SHAPED_NOW: Record<string, Kind> = { sqrt: "sqrt", abs: "abs", root: "root" };

/** The order a structure's slots are walked in by ← and →. */
function order(n: Node): number[] {
  if (n.k === "root") return [1, 0];
  if (n.k === "big") return BIG[`${n.name}/${n.slots.length}`]?.order ?? n.slots.map((_, i) => i);
  return n.slots.map((_, i) => i);
}

// ---------------------------------------------------------------------------
// Where everything is
// ---------------------------------------------------------------------------

interface Where {
  row: Row;
  /** The structure this row is a slot of; null for the line's main and unit rows. */
  owner: Node | null;
  slot: number;
  /** The row the owner sits on, and its index there. */
  parent: Row | null;
  at: number;
}

function locate(line: Line): Map<string, Where> {
  const map = new Map<string, Where>();
  const walk = (r: Row, owner: Node | null, slot: number, parent: Row | null, at: number) => {
    map.set(r.id, { row: r, owner, slot, parent, at });
    r.atoms.forEach((a, k) => {
      if (a.k !== "g") a.slots.forEach((s, j) => walk(s, a, j, r, k));
    });
  };
  walk(line.main, null, 0, null, 0);
  walk(line.unit, null, 1, null, 0);
  return map;
}

/** Every caret position in reading order; `skip` marks one ← → pass over (between `A.b` and its `²`). */
function stops(line: Line): (Pos & { skip?: boolean })[] {
  const out: (Pos & { skip?: boolean })[] = [];
  const walk = (r: Row) => {
    out.push({ row: r.id, i: 0 });
    r.atoms.forEach((a, k) => {
      if (a.k !== "g") for (const s of order(a)) walk(a.slots[s]);
      out.push({ row: r.id, i: k + 1, skip: a.k === "sub" && r.atoms[k + 1]?.k === "sup" });
    });
  };
  walk(line.main);
  if (line.show) walk(line.unit);
  return out;
}

/** The line as the formula it is, without which slots are open for typing: a change is a change of this. */
const content = (line: Line) => JSON.stringify(line, (k, v) => (k === "born" ? undefined : v));

const forEachRow = (line: Line, f: (r: Row) => void) => {
  const walk = (r: Row) => {
    f(r);
    for (const a of r.atoms) if (a.k !== "g") a.slots.forEach(walk);
  };
  walk(line.main);
  walk(line.unit);
};

// ---------------------------------------------------------------------------
// Building a tree from what the engine parsed
// ---------------------------------------------------------------------------

const P_POSTFIX = 11;

/** `e`'s atoms on a row, with brackets wherever printing it would need them. */
function atomsOf(e: Expr): Atom[] {
  const child = (x: Expr, min: number): Atom[] => (prec(x) < min ? [mkNode("paren", [mkRow(atomsOf(x))])] : atomsOf(x));
  const chars = (s: string) => [...s].map(gl);
  switch (e.t) {
    case "Num":
      return chars(e.c);
    case "Ident":
      return nameAtoms(e.c);
    case "Unit":
      return [mkNode("unit", [mkRow(chars(e.c))])];
    case "Const":
      return [mkNode("const", [mkRow(nameAtoms(e.c))])];
    case "Str":
      return [mkNode("str", [mkRow(chars(e.c))])];
    case "Placeholder":
      return [gl("?")];
    case "Paren":
      return [mkNode("paren", [mkRow(atomsOf(e.c))])];
    case "Unary": {
      const [op, x] = e.c;
      return [gl({ Neg: "-", Pos: "+", PlusMinus: "±", Not: "not" }[op]), ...child(x, op === "Not" ? 3 : 8)];
    }
    case "Factorial":
      return [...child(e.c, P_POSTFIX), gl("!")];
    case "Binary": {
      const [op, a, b] = e.c;
      switch (op) {
        case "Div":
          return [mkNode("frac", [slotOf(a, NEEDS_BRACKETS.numerator), slotOf(b, NEEDS_BRACKETS.denominator)])];
        case "Pow":
          return [...child(a, P_POSTFIX), mkNode("sup", [slotOf(b, NEEDS_BRACKETS.exponent)])];
        case "Juxt":
          return joinApart(atomsOf(a), atomsOf(b));
      }
      const p = { Or: 1, And: 2, Add: 6, Sub: 6, PlusMinus: 6, Mul: 7, Mod: 7 }[op];
      const sym = { Or: "or", And: "and", Add: "+", Sub: "-", PlusMinus: "±", Mul: "*", Mod: "%" }[op];
      return [...child(a, p), gl(sym), ...child(b, p + 1)];
    }
    case "Compare": {
      const sym = { Eq: "==", Ne: "≠", Lt: "<", Le: "≤", Gt: ">", Ge: "≥" };
      return [...child(e.c[0], 5), ...e.c[1].flatMap(([op, x]) => [gl(sym[op]), ...child(x, 5)])];
    }
    case "Call": {
      const [name, args] = e.c;
      const shape = shapeOf(name, args.length);
      if (shape === "sqrt" || shape === "abs") return [mkNode(shape, [slotOf(args[0], () => false)])];
      if (shape === "root") return [mkNode("root", [slotOf(args[0], () => false), mkRow(atomsOf(args[1]))])];
      if (shape === "big") return [mkNode("big", args.map(wholeSlot), { name })];
      return [...nameAtoms(name), mkNode("paren", [mkRow(listAtoms(args))])];
    }
    case "Index":
      return [...child(e.c[0], P_POSTFIX), mkNode("index", [mkRow(listAtoms(e.c[1]))])];
    case "Matrix":
      return [mkNode("matrix", e.c.flat().map(wholeSlot), { cols: e.c[0]?.length ?? 1 })];
    case "Range":
      return [...child(e.c[0], 6), gl(".."), ...child(e.c[1], 6)];
    case "Define":
      return [...child(e.c.lhs, 1), gl(e.c.global ? "≡" : ":="), ...atomsOf(e.c.rhs)];
  }
}

/** `A.net`: the name's letters, and its literal subscript. */
function nameAtoms(name: string): Atom[] {
  const dot = name.indexOf(".");
  if (dot <= 0) return [...name].map(gl);
  return [...[...name.slice(0, dot)].map(gl), mkNode("sub", [mkRow([...name.slice(dot + 1)].map(gl))])];
}

/** Two operands side by side (`2 m`): a space between them where the letters would run together. */
function joinApart(a: Atom[], b: Atom[]): Atom[] {
  const last = a[a.length - 1];
  const first = glyph(b[0]);
  const merge =
    (isWordChar(last) || last?.k === "sub" || last?.k === "const") && isNameCont(first)
      ? true
      : isDigit(glyph(last)) && (first === "e" || first === "E");
  return merge ? [...a, gl(" "), ...b] : [...a, ...b];
}

function listAtoms(args: Expr[]): Atom[] {
  return args.flatMap((x, i) => (i ? [gl(","), ...atomsOf(x)] : atomsOf(x)));
}

/** A slot holding `e`: empty for an empty slot. */
function wholeSlot(e: Expr): Row {
  return mkRow(e.t === "Placeholder" ? [] : atomsOf(e));
}

/**
 * A slot that draws no brackets of its own (a numerator, an exponent, a radicand): brackets
 * around the whole of it are the slot's, remembered (`kept`) only when the text needs them
 * nowhere else.
 */
function slotOf(e: Expr, needs: (x: Expr) => boolean): Row {
  if (e.t === "Paren") return mkRow(e.c.t === "Placeholder" ? [] : atomsOf(e.c), needs(e.c) ? {} : { kept: true });
  return wholeSlot(e);
}

function shapeOf(name: string, arity: number): "sqrt" | "abs" | "root" | "big" | null {
  if ((name === "sqrt" || name === "abs") && arity === 1) return name;
  if (name === "root" && arity === 2) return "root";
  return BIG[`${name}/${arity}`] ? "big" : null;
}

const emptyLine = (): Line => ({ main: mkRow(), unit: mkRow(), show: null });

function fresh(line: Line, caret?: Pos): EditState {
  return { line, caret: caret ?? { row: line.main.id, i: line.main.atoms.length }, anchor: null, version: 0 };
}

/**
 * The tree of a parsed expression (`RegionView.input`), with the caret at its end. `show` and
 * `unit` are the region's `= unit` (`r.show`, `r.display.unit`).
 */
export function fromExpr(e: Expr | null, show: Show = null, unit = "", opts: { equation?: boolean } = {}): EditState {
  const line = emptyLine();
  if (e) line.main.atoms = e.t === "Placeholder" ? [] : atomsOf(e);
  line.show = show;
  let s = fresh(line);
  s.equation = opts.equation;
  if (show === "value" && unit) s = typeText({ ...s, caret: { row: line.unit.id, i: 0 } }, unit);
  return settle({ ...s, caret: { row: line.main.id, i: line.main.atoms.length }, version: 0 });
}

/**
 * The tree of a line of text, finished or not, as typing it would build it: `q*(L - x` is
 * `q·(L − x)` with its `)` still to come. What `MathEditor` holds today (`editText`), with the
 * `=` and unit after it, goes in as it is.
 */
export function fromLinear(text: string, opts: { equation?: boolean } = {}): EditState {
  const { expr, show, unit } = splitShow(text);
  const base = { ...fresh(emptyLine()), equation: opts.equation };
  let s = typeText(base, expr, true);
  s = absorbed(s, !!show);
  if (show) {
    s = clean(s);
    s.line.show = show;
    if (show === "value" && unit) s = typeText({ ...s, caret: { row: s.line.unit.id, i: 0 } }, unit, true);
  }
  return settle({ ...s, caret: show ? endOf(s.line) : s.caret, anchor: null, version: 0 });
}

/** Brackets that fill a slot become the slot's, except where the caret still is (`everywhere`: there too). */
function absorbed(s: EditState, everywhere: boolean): EditState {
  const e = new Ed(s);
  if (everywhere) e.caret = { row: e.line.main.id, i: 0 };
  e.absorbAll();
  if (everywhere) e.caret = s.caret;
  e.re();
  return e.done(s);
}

/** `store.ts` `splitShow`: the expression, and the `=` or `→` with the unit typed after it. */
function splitShow(text: string): { expr: string; show: Show; unit?: string } {
  const t = text.trimEnd();
  const arrow = /\s*(→|->)$/.exec(t);
  if (arrow) return { expr: t.slice(0, arrow.index).trimEnd(), show: "symbolic" };
  if (t.endsWith("=") && !/(==|:=|<=|>=|!=|≠=)$/.test(t)) return { expr: t.slice(0, -1).trimEnd(), show: "value" };
  const m = /^(.*[^=<>!:≠\s])\s*=\s*([\p{L}\p{N}_*/^()·.'°%\s-]*\p{L}[\p{L}\p{N}_*/^()·.'°%\s-]*)$/u.exec(t);
  if (m && !/=/.test(m[2])) return { expr: m[1].trimEnd(), show: "value", unit: m[2].trim() };
  return { expr: text, show: null };
}

const endOf = (line: Line): Pos =>
  line.show ? { row: line.unit.id, i: line.unit.atoms.length } : { row: line.main.id, i: line.main.atoms.length };

/** No slot left open for typing: what is typed next goes where the caret is. */
function settle(s: EditState): EditState {
  const line = structuredClone(s.line);
  forEachRow(line, (r) => delete r.born);
  return { ...s, line, space: false, assign: false, beforeShow: undefined };
}
const clean = (s: EditState): EditState => ({ ...s, line: structuredClone(s.line) });

// ---------------------------------------------------------------------------
// Back to text
// ---------------------------------------------------------------------------

/**
 * The line in Quire's linear syntax, as `MathEditor` sends it on (`setLive`): the expression,
 * then ` =` and the unit, or ` →`. Empty slots are `?`. Canonical where the tree reads as an
 * expression, so a formula opened and closed unchanged keeps its text.
 */
export function toLinear(s: EditState | Line): string {
  const line = "line" in s ? s.line : s;
  const expr = line.main.atoms.length ? rowLinear(line.main) : "";
  if (line.show === "symbolic") return `${expr} →`;
  if (line.show === "value") {
    const unit = line.unit.atoms.length ? rowLinear(line.unit) : "";
    return `${expr} =${unit ? ` ${unit}` : ""}`;
  }
  return expr;
}

/** The line's expression as the engine would parse its text; null when it isn't one yet. */
export function toExpr(s: EditState | Line): Expr | null {
  const line = "line" in s ? s.line : s;
  return rowExpr(line.main);
}

/** The selection as linear text, for the clipboard. */
export function selectedText(s: EditState): string {
  const sel = selection(s);
  if (!sel) return "";
  const r = locate(s.line).get(sel.row)?.row;
  return r ? rowLinear(mkRow(r.atoms.slice(sel.from, sel.to))) : "";
}

/**
 * A line typed as words only (`Area`, `A medida`), as prose detection reads it: the words with
 * the spaces typed between them; null when it holds anything but names.
 */
export function plainWords(s: EditState): string | null {
  const atoms = s.line.main.atoms;
  if (s.line.show || !atoms.length) return null;
  let out = "";
  for (const a of atoms) {
    if (a.k === "g" && (isNameCont(a.s) || isNameStart(a.s) || a.s === " " || KW.has(a.s)))
      out += KW.has(a.s) ? ` ${a.s} ` : a.s;
    else if (a.k === "sub") out += `.${rowText(a.slots[0])}`;
    else return null;
  }
  return out.replace(/ {2,}/g, " ").trim() + (s.space ? " " : "");
}
const KW = new Set(["and", "or", "not"]);

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

/** The rows from `id` up to the line: each with the index, in the row above, of its structure. */
function ancestry(w: Map<string, Where>, id: string): { row: string; at: number }[] {
  const out: { row: string; at: number }[] = [];
  let cur = w.get(id);
  let at = -1;
  while (cur) {
    out.push({ row: cur.row.id, at });
    at = cur.at;
    cur = cur.parent ? w.get(cur.parent.id) : undefined;
  }
  return out;
}

/** The selection as a slice of one row: anchor and caret lifted to the row holding both. */
export function selection(s: EditState): { row: string; from: number; to: number } | null {
  if (!s.anchor) return null;
  const w = locate(s.line);
  const a = ancestry(w, s.anchor.row);
  const c = ancestry(w, s.caret.row);
  const common = a.find((x) => c.some((y) => y.row === x.row));
  if (!common) return null;
  const span = (chain: { row: string; at: number }[], p: Pos): [number, number] => {
    const k = chain.findIndex((x) => x.row === common.row);
    return k === 0 ? [p.i, p.i] : [chain[k].at, chain[k].at + 1];
  };
  const [a0, a1] = span(a, s.anchor);
  const [c0, c1] = span(c, s.caret);
  const from = Math.min(a0, c0);
  const to = Math.max(a1, c1);
  return from === to ? null : { row: common.row, from, to };
}

// ---------------------------------------------------------------------------
// The editor: one key at a time, on a copy of the state
// ---------------------------------------------------------------------------

class Ed {
  line: Line;
  caret: Pos;
  anchor: Pos | null;
  space: boolean;
  assign: boolean;
  beforeShow?: { line: Line; caret: Pos };
  equation: boolean;
  effect?: { leave?: Dir; command?: string };
  w!: Map<string, Where>;
  private before: string;

  constructor(s: EditState) {
    this.line = structuredClone(s.line);
    this.caret = { ...s.caret };
    this.anchor = s.anchor ? { ...s.anchor } : null;
    this.space = !!s.space;
    this.assign = !!s.assign;
    this.beforeShow = s.beforeShow;
    this.equation = !!s.equation;
    this.before = content(s.line);
    this.re();
  }

  re() {
    this.w = locate(this.line);
    // a caret left in a row that has gone is put back at the end of the line
    const at = this.w.get(this.caret.row);
    if (!at) this.caret = endOf(this.line);
    else this.caret.i = Math.max(0, Math.min(this.caret.i, at.row.atoms.length));
    if (this.anchor && !this.w.has(this.anchor.row)) this.anchor = null;
  }

  done(s: EditState): EditState {
    const changed = content(this.line) !== this.before;
    return {
      line: this.line,
      caret: this.caret,
      anchor:
        this.anchor && (this.anchor.row !== this.caret.row || this.anchor.i !== this.caret.i) ? this.anchor : null,
      space: this.space || undefined,
      assign: this.assign || undefined,
      beforeShow: this.beforeShow,
      equation: s.equation,
      version: s.version + (changed ? 1 : 0),
      effect: this.effect,
    };
  }

  get here(): Where {
    return this.w.get(this.caret.row)!;
  }
  get row(): Row {
    return this.here.row;
  }
  get i(): number {
    return this.caret.i;
  }
  set(row: Row | string, i: number) {
    this.caret = { row: typeof row === "string" ? row : row.id, i };
  }
  prev(): Atom | undefined {
    return this.row.atoms[this.i - 1];
  }
  next(): Atom | undefined {
    return this.row.atoms[this.i];
  }

  /** Puts `atoms` at the caret, which ends up after them. */
  put(...atoms: Atom[]) {
    const r = this.row;
    r.atoms.splice(this.i, 0, ...atoms);
    this.caret.i += atoms.length;
    this.re();
  }

  /** The caret goes just after structure `n`, on the row it sits on. */
  after(n: Node) {
    for (const [, w] of this.w) {
      const k = w.row.atoms.indexOf(n);
      if (k >= 0) return this.set(w.row, k + 1);
    }
  }
  /** The row a structure sits on, and its index there. */
  placeOf(n: Node): { row: Row; at: number } | null {
    for (const [, w] of this.w) {
      const k = w.row.atoms.indexOf(n);
      if (k >= 0) return { row: w.row, at: k };
    }
    return null;
  }

  clearBorn() {
    forEachRow(this.line, (r) => delete r.born);
  }

  // -------------------------------------------------------------------------
  // Typing
  // -------------------------------------------------------------------------

  type(raw: string, literal = false) {
    let ch = raw;
    if (ch === "\n" || ch === "\t" || ch === " ") ch = " ";
    ch = ({ "·": "*", "⋅": "*", "×": "*", "−": "-", "÷": "/", "≔": ":" } as Record<string, string>)[ch] ?? ch;
    const assign = this.assign;
    this.assign = false;
    this.effect = undefined;

    const sel = selection(this.state());
    if (sel) {
      if (ch === "/" || ch === "^" || ch === "(" || ch === "[") return this.wrap(sel, ch);
      this.cut(sel);
    }
    this.anchor = null;

    const owner = this.here.owner;
    // a string takes everything as text, up to its closing quote
    if (owner?.k === "str") {
      if (ch === '"') {
        owner.ghost = false;
        return this.after(owner);
      }
      return this.put(gl(ch));
    }
    // a `\name` ends at anything but a letter
    if (owner?.k === "cmd") {
      if (/^[A-Za-z]$/.test(ch)) return this.put(gl(ch));
      this.resolve(owner);
      if (ch === " ") return;
    }
    if (ch === "." && this.dotEndsName()) return;
    this.leaveFor(ch);
    const space = this.space;
    this.space = false;

    if (ch === " ") {
      this.keyword();
      this.space = true;
      return;
    }
    if (!isNameCont(ch) && !isNameStart(ch)) this.keyword();
    if (isDigit(ch) || isNameStart(ch) || isNameCont(ch)) return this.operand(ch, space);
    switch (ch) {
      case ".":
        return this.dot();
      case "/":
        return this.slash();
      case "^":
        return this.power();
      case "(":
        return this.open();
      case ")":
      case "]":
        return this.close(ch);
      case "[":
        return this.bracket();
      case ",":
      case ";":
        return this.separator(ch);
      case '"':
        return this.quote("str");
      case "'":
        return this.quote("unit");
      case "#":
        return this.quote("const");
      case "\\":
        return this.quote("cmd");
      case "?":
        return this.put(gl("?"));
      case ":":
        // `::=` is `≡`
        if (assign && glyph(this.prev()) === ":=") this.row.atoms.splice(this.i - 1, 1, gl("≡"));
        else this.put(gl(":="));
        this.assign = true;
        return;
      case "~":
        return this.put(gl("≡"));
      case "=":
        return this.equals(assign, literal);
      case "<":
      case ">":
        if (
          ch === ">" &&
          glyph(this.prev()) === "-" &&
          this.row === this.line.main &&
          this.i === this.row.atoms.length
        ) {
          this.row.atoms.splice(this.i - 1, 1);
          this.re();
          return this.symbolic();
        }
        return this.put(gl(ch));
      case "→":
        return this.symbolic();
      case "+":
      case "-":
      case "*":
      case "%":
      case "±":
      case "!":
      case "≤":
      case "≥":
      case "≠":
      case "≡":
        return this.put(gl(ch));
      default:
      // anything else has no meaning in math: nothing happens
    }
  }

  state(): EditState {
    return {
      line: this.line,
      caret: this.caret,
      anchor: this.anchor,
      version: 0,
    };
  }

  /**
   * Leaves the slots that `ch` can't continue, as the linear text would end them: a name's
   * subscript, a quoted unit or a constant at anything not part of a name; an exponent or a
   * denominator opened by typing, when `ch` typed at its end is an operator it doesn't bind.
   */
  leaveFor(ch: string) {
    for (;;) {
      const { row, owner } = this.here;
      if (!owner) return;
      const i = this.i;
      if (owner.k === "sub" || owner.k === "unit" || owner.k === "const") {
        if (this.holds(owner.k, ch)) return;
        const tail = row.atoms.splice(i);
        const place = this.placeOf(owner)!;
        place.row.atoms.splice(place.at + 1, 0, ...tail);
        if (!row.atoms.length) {
          place.row.atoms.splice(place.at, 1);
          this.re();
          this.set(place.row, place.at);
        } else {
          this.re();
          this.set(place.row, place.at + 1);
        }
        continue;
      }
      if (!row.born || i !== row.atoms.length || !row.atoms.length || !endsValue(row)) return;
      if (owner.k === "sup" && this.continuesExponent(row, ch)) return;
      if (owner.k === "frac" && (this.here.slot === 0 || this.continuesDenominator(row, ch))) return;
      if (owner.k !== "sup" && owner.k !== "frac") return;
      this.absorb(row);
      this.after(owner);
    }
  }

  /** What a name-only slot holds: name characters, and a dot (a subscript's `1.2`, a unit's `g.e`). */
  holds(k: Kind, ch: string): boolean {
    if (ch === ".") return true;
    return k === "unit" ? isUnitChar(ch) : isNameCont(ch);
  }

  /** `x^2` then `ch`: still the exponent? (`e^-x`, `x^2^3`, `x^0.5`; not `+`, ` `, nor a unit) */
  continuesExponent(row: Row, ch: string): boolean {
    if (isDigit(ch) || ".^!([?".includes(ch)) return true;
    if (isNameStart(ch) || isNameCont(ch)) return !holdsUnitNow(row);
    if (ch === "-" || ch === "+") return numberExponentOpen(row);
    return false;
  }

  /** `a/b` then `ch`: still the denominator? It takes a power, a unit, a call; not `*` or `+`. */
  continuesDenominator(row: Row, ch: string): boolean {
    if (isDigit(ch) || isNameStart(ch) || isNameCont(ch) || ".^!([?'# ".includes(ch)) return true;
    if (ch === "-" || ch === "+") return numberExponentOpen(row);
    return false;
  }

  /** A letter or digit. */
  operand(ch: string, space: boolean) {
    // typed over an empty slot `?`
    if (glyph(this.prev()) === "?") {
      this.row.atoms.splice(this.i - 1, 1);
      this.caret.i--;
    } else if (glyph(this.next()) === "?") this.row.atoms.splice(this.i, 1);
    const prev = this.prev();
    if (space && endsName(this.row, this.i) && isNameCont(ch)) {
      this.put(gl(" "));
    } else if (space && isDigit(glyph(prev)) && (ch === "e" || ch === "E")) this.put(gl(" "));
    else if (this.timesBefore(prev, ch)) this.put(times());
    this.put(gl(ch));
  }

  /**
   * A value typed right after another that the text can't write side by side gets its `·`
   * (`2(`, `(a + b)x`, `√2 x`), as Mathcad does. Not after a number (`2 m` is a quantity) nor
   * after an exponent that takes a unit (`10^-4 m`), nor a matrix (`[1; 2] s`).
   */
  timesBefore(prev: Atom | undefined, ch: string): boolean {
    if (!prev) return false;
    if (prev.k === "g") return prev.s === "!";
    switch (prev.k) {
      case "sup":
        return isDigit(ch) || ch === "(" || !holdsUnitNow(prev.slots[0]);
      case "matrix":
        return isDigit(ch) || ch === "(";
      case "cmd":
        return false;
      default:
        return true;
    }
  }

  /** `.`: a subscript after a name, a decimal point after a digit, `..` after a value. */
  dot() {
    const prev = this.prev();
    const owner = this.here.owner;
    if (owner?.k === "sub" || owner?.k === "unit") return this.put(gl("."));
    const p = glyph(prev);
    if (p === ".") {
      this.row.atoms.splice(this.i - 1, 1, gl(".."));
      return this.re();
    }
    if (p === "..") return;
    if (prev && (prev.k === "sub" || (prev.k === "g" && isNameCont(prev.s) && this.inName()))) {
      // `A.` then the subscript; the name's letters after the caret go into it (`A|net` → `A.net`)
      const next = this.next();
      if (next?.k === "sub") return this.set(next.slots[0], 0);
      if (prev.k === "sub") {
        this.set(prev.slots[0], prev.slots[0].atoms.length);
        return this.put(gl("."));
      }
      const r = this.row;
      let end = this.i;
      while (isWordChar(r.atoms[end])) end++;
      const sub = mkNode("sub", [mkRow(r.atoms.splice(this.i, end - this.i), { born: true })]);
      r.atoms.splice(this.i, 0, sub);
      this.re();
      return this.set(sub.slots[0], 0);
    }
    if (p !== null && isDigit(p)) return this.put(gl("."));
    if (!prev || isOp(prev) || p === " ") return this.put(gl("."));
    return this.put(gl(".."));
  }

  /** Whether the glyph before the caret is part of a name (not of a number: `x2` against `12`). */
  inName(): boolean {
    let k = this.i - 1;
    while (k > 0 && isWordChar(this.row.atoms[k - 1])) k--;
    return isNameStart(glyph(this.row.atoms[k]));
  }

  /** `.` right after a subscript's dot: the range `..` (`a..b`). */
  dotEndsName(): boolean {
    const { owner, row } = this.here;
    if (owner?.k !== "sub") return false;
    if (row.atoms.length && glyph(this.prev()) !== ".") return false;
    if (row.atoms.length) {
      row.atoms.splice(this.i - 1, 1);
      this.re();
      this.set(row, this.i - 1);
    }
    this.leaveFor(" ");
    this.put(gl(".."));
    return true;
  }

  /**
   * `/`: a fraction whose numerator is what the linear `/` would divide, the whole product before
   * it (`q*L^2/` is (q·L²)/□, `-a/` is (−a)/□); its denominator is the value after the caret, if
   * any (`a|b` → `a/b`). With nothing before it, an empty fraction □/□ with the caret on top.
   */
  slash() {
    const r = this.row;
    const i = this.i;
    const end = operandEnd(r, i);
    const den = mkRow(r.atoms.slice(i, end));
    let start = i;
    if (endsValueAt(r, i)) {
      while (start > 0) {
        const a = r.atoms[start - 1];
        if (a.k === "g" && LOOSE.has(a.s) && !(SIGNS.has(a.s) && isUnaryAt(r, start - 1))) break;
        start--;
      }
    }
    const num = this.slotFrom(r.atoms.slice(start, i), "numerator");
    const frac = mkNode("frac", [num, den]);
    r.atoms.splice(start, end - start, frac);
    this.re();
    if (start === i) return this.set(num, 0);
    den.born = true;
    this.set(den, 0);
  }

  /** Atoms going into a slot that draws no brackets: brackets around all of them become the slot's. */
  slotFrom(atoms: Atom[], what: keyof typeof NEEDS_BRACKETS | "radicand"): Row {
    const only = atoms.length === 1 ? atoms[0] : null;
    if (only?.k === "paren" && !only.ghost) {
      const inner = only.slots[0];
      const e = rowExpr(inner);
      const needed = what !== "radicand" && (!e || NEEDS_BRACKETS[what](e));
      return mkRow(inner.atoms, needed ? {} : { kept: true });
    }
    return mkRow(atoms);
  }

  /** `^`: a superscript on what comes before (`x^`, `(a + b)^`, `L.s^`), the caret in it. */
  power(): void {
    const { owner, row } = this.here;
    // `x^^`: nothing to raise
    if (owner?.k === "sup" && !row.atoms.length) return;
    const prev = this.prev();
    // `x^2^`: the power of the exponent (`^` groups to the right)
    if (prev?.k === "sup") {
      const exp = prev.slots[0];
      exp.born = true;
      this.set(exp, exp.atoms.length);
      return this.power();
    }
    const r = this.row;
    // a fraction as a base keeps the brackets the text needs: (a/b)²
    if (prev?.k === "frac") r.atoms.splice(this.i - 1, 1, mkNode("paren", [mkRow([prev])]));
    const end = operandEnd(r, this.i);
    const exp = mkRow(r.atoms.splice(this.i, end - this.i), { born: true });
    r.atoms.splice(this.i, 0, mkNode("sup", [exp]));
    this.re();
    this.set(exp, 0);
  }

  /**
   * `(`: brackets, the `)` faint until typed. Before a value they take in the rest of the row
   * (its `)` closes at the end, as the preview closes it). After a name, the call's brackets;
   * after `sqrt`, `abs` or `root`, the shape.
   */
  open() {
    const r = this.row;
    let start = this.i;
    while (start > 0 && isWordChar(r.atoms[start - 1])) start--;
    const word = r.atoms
      .slice(start, this.i)
      .map((a) => glyph(a))
      .join("");
    const shape = SHAPED_NOW[word];
    if (shape && start < this.i && isNameStart(glyph(r.atoms[start])) && !isWordChar(r.atoms[start - 1])) {
      const slots = shape === "root" ? [mkRow(), mkRow()] : [mkRow()];
      const n = mkNode(shape, slots);
      r.atoms.splice(start, this.i - start, n);
      this.re();
      return this.set(slots[0], 0);
    }
    const prev = this.prev();
    const call = (isWordChar(prev) && this.inName()) || prev?.k === "sub";
    if (!call && endsValueBefore(prev)) this.put(times());
    const next = this.next();
    const inner = mkRow(next && !isOp(next) ? r.atoms.splice(this.i) : []);
    const paren = mkNode("paren", [inner], { ghost: true });
    this.put(paren);
    this.set(inner, 0);
  }

  /**
   * `)` and `]`: the bracket around the caret closes there, and the caret steps past it. A `)` in
   * a slot it can't close (in the middle of a denominator, or in no bracket) does nothing.
   */
  close(ch: ")" | "]") {
    const start = { ...this.caret };
    for (;;) {
      const { row, owner } = this.here;
      if (!owner) break;
      if (ch === ")" && owner.k === "paren") {
        const tail = row.atoms.splice(this.i);
        const place = this.placeOf(owner)!;
        // what was left after the `)` is a value of its own: `(a)·b`
        if (tail.length && !isOp(tail[0]) && glyph(tail[0]) !== " ") tail.unshift(times());
        place.row.atoms.splice(place.at + 1, 0, ...tail);
        owner.ghost = false;
        this.re();
        this.set(place.row, place.at + 1);
        this.shape(owner);
        return;
      }
      const fn = owner.k === "sqrt" || owner.k === "abs" || owner.k === "root" || owner.k === "big";
      const bracket = owner.k === "index" || owner.k === "matrix";
      if ((ch === ")" && fn) || (ch === "]" && bracket)) {
        owner.ghost = false;
        this.absorb(row);
        return this.after(owner);
      }
      if (fn || bracket || owner.k === "paren" || this.i !== row.atoms.length) break;
      this.absorb(row);
      this.after(owner);
    }
    this.caret = start;
  }

  /**
   * A slot being left whose content is one pair of closed brackets, in a slot that draws none
   * (`e^(x + 1)`, `sqrt((a + b))`): the brackets become the slot's, drawn as the formula will be
   * once the edit ends. Only when the slot is left, since what follows the `)` may still apply
   * to the brackets (`sqrt((1 - a)/2)`, `/(2 n)!`, `/(m)^3`).
   */
  absorb(on: Row) {
    const w = this.w.get(on.id);
    const owner = w?.owner;
    const paren = on.atoms[0];
    // one pair per slot: `((x))/2` keeps its inner pair
    if (!w || !owner || on.kept || on.atoms.length !== 1 || paren.k !== "paren" || paren.ghost) return;
    const what =
      owner.k === "frac"
        ? w.slot === 0
          ? "numerator"
          : "denominator"
        : owner.k === "sup"
          ? "exponent"
          : (owner.k === "sqrt" || owner.k === "abs" || owner.k === "root") && w.slot === 0
            ? "radicand"
            : null;
    if (!what) return;
    const inner = paren.slots[0];
    const e = rowExpr(inner);
    on.atoms = inner.atoms;
    if (what === "radicand" || (!!e && !NEEDS_BRACKETS[what](e))) on.kept = true;
    else delete on.kept;
    if (this.caret.row === inner.id) this.caret.row = on.id;
    this.re();
  }

  /** `absorb` in every slot but the one the caret is in, where more may still be typed. */
  absorbAll() {
    const rows: Row[] = [];
    forEachRow(this.line, (r) => rows.push(r));
    for (const r of rows.reverse()) if (r.id !== this.caret.row) this.absorb(r);
  }

  /** `int(f, x, a, b)` with its `)` typed: the integral's shape, when it has that many arguments. */
  shape(paren: Node) {
    const place = this.placeOf(paren);
    if (!place) return;
    const r = place.row;
    let start = place.at;
    while (start > 0 && isWordChar(r.atoms[start - 1])) start--;
    if (start === place.at || isWordChar(r.atoms[start - 1]) || !isNameStart(glyph(r.atoms[start]))) return;
    const name = r.atoms
      .slice(start, place.at)
      .map((a) => glyph(a))
      .join("");
    const parts: Atom[][] = [[]];
    for (const a of paren.slots[0].atoms) {
      if (glyph(a) === ",") parts.push([]);
      else parts[parts.length - 1].push(a);
    }
    if (shapeOf(name, parts.length) !== "big") return;
    const big = mkNode(
      "big",
      parts.map((p) => mkRow(p.length === 1 && glyph(p[0]) === "?" ? [] : p)),
      { name },
    );
    r.atoms.splice(start, place.at - start + 1, big);
    this.re();
    this.set(r, start + 1);
  }

  /** `[`: an index after a name or a bracket (`M[2]`), a matrix anywhere else. */
  bracket() {
    const prev = this.prev();
    const indexable =
      (isWordChar(prev) && this.inName()) ||
      (prev && prev.k !== "g" && ["sub", "paren", "index", "matrix", "const"].includes(prev.k));
    if (indexable) {
      const n = mkNode("index", [mkRow()]);
      this.put(n);
      return this.set(n.slots[0], 0);
    }
    if (endsValueBefore(prev)) this.put(times());
    const m = mkNode("matrix", [mkRow()], { cols: 1 });
    this.put(m);
    this.set(m.slots[0], 0);
  }

  /**
   * `,` and `;`: in a matrix, the next column or row (added when there is none, or when the next
   * cell is taken); in a shape (`root`, `int`), the next argument; elsewhere the character.
   */
  separator(ch: "," | ";") {
    const { owner, slot, row } = this.here;
    if (owner?.k === "matrix") {
      const cols = owner.cols ?? 1;
      const rows = owner.slots.length / cols;
      const r = Math.floor(slot / cols);
      const c = slot % cols;
      const atEnd = this.i === row.atoms.length;
      if (ch === ",") {
        const nextCell = owner.slots[slot + 1];
        if (atEnd && c + 1 < cols && !nextCell.atoms.length) return this.set(nextCell, 0);
        const tail = row.atoms.splice(this.i);
        for (let k = rows - 1; k >= 0; k--) owner.slots.splice(k * cols + c + 1, 0, mkRow());
        owner.cols = cols + 1;
        const cell = owner.slots[r * (cols + 1) + c + 1];
        cell.atoms = tail;
        this.re();
        return this.set(cell, 0);
      }
      const below = owner.slots[(r + 1) * cols];
      if (atEnd && below && !below.atoms.length) return this.set(below, 0);
      const tail = row.atoms.splice(this.i);
      const fresh = Array.from({ length: cols }, () => mkRow());
      fresh[0].atoms = tail;
      owner.slots.splice((r + 1) * cols, 0, ...fresh);
      this.re();
      return this.set(fresh[0], 0);
    }
    if (ch === "," && owner && (owner.k === "root" || owner.k === "big")) {
      const next = owner.slots[slot + 1];
      if (next) {
        this.absorb(row);
        this.set(next, 0);
      }
      return;
    }
    this.put(gl(ch));
  }

  /** `"`, `'`, `#`, `\`: a string, a quoted unit, a constant or a shortcut, the caret in it. */
  quote(k: "str" | "unit" | "const" | "cmd") {
    const r = this.row;
    let end = this.i;
    // `'|kN` → `'kN`: the name after the caret is the unit's
    if (k === "unit") while (isUnitChar(glyph(r.atoms[end]))) end++;
    if (k === "const") while (isWordChar(r.atoms[end])) end++;
    const inside = mkRow(r.atoms.splice(this.i, end - this.i), k === "str" ? {} : { born: true });
    const n = mkNode(k, [inside], k === "str" ? { ghost: true } : {});
    this.put(n);
    this.set(inside, 0);
  }

  /** A `\name` shortcut ends: its symbol or template goes in its place, or its letters stay. */
  resolve(cmd: Node) {
    const place = this.placeOf(cmd)!;
    const name = rowText(cmd.slots[0]);
    place.row.atoms.splice(place.at, 1);
    this.re();
    this.set(place.row, place.at);
    const sym = name ? exact(name, "math") : undefined;
    if (!sym) {
      for (const ch of name) this.type(ch);
      return;
    }
    if (sym.command) {
      this.effect = { command: sym.command };
      return;
    }
    this.insertTemplate(sym.insert);
  }

  /**
   * A template (`sqrt(?)`, `(?)/(?)`) built on its own, as if typed into an empty line, then put
   * at the caret, which goes to its first empty slot. Built apart so that what is before the
   * caret stays out of it (`2*` then a fraction is 2·□/□, not (2·□)/□).
   */
  insertTemplate(text: string) {
    const t = new Ed(empty());
    for (const ch of text) t.type(ch, true);
    t.caret = { row: t.line.main.id, i: 0 };
    t.absorbAll();
    // a slot holding only `?` is an empty slot
    forEachRow(t.line, (r) => {
      const at = t.w.get(r.id);
      if (at?.owner && r.atoms.length === 1 && glyph(r.atoms[0]) === "?" && !isCallParen(t.line, at)) r.atoms = [];
    });
    t.re();
    const atoms = t.line.main.atoms;
    const startRow = this.caret.row;
    const startAt = this.i;
    this.put(...atoms);
    const inserted = new Set<string>();
    const mark = (a: Atom) => {
      if (a.k !== "g")
        a.slots.forEach((r) => {
          inserted.add(r.id);
          r.atoms.forEach(mark);
        });
    };
    atoms.forEach(mark);
    const hole = holes(this.line).find(
      (h) => inserted.has(h.row) || (h.row === startRow && h.i >= startAt && h.i < startAt + atoms.length),
    );
    if (hole) this.set(hole.row, hole.i);
    this.space = false;
    this.clearBorn();
  }

  /**
   * `=`: the result is shown, the caret goes to the unit after it. `<=` `>=` `!=` are `≤ ≥ ≠`;
   * an `=` right after `:` (typed as `:=`) is swallowed; a second `=` makes the comparison `==`
   * where the first was typed; in a constraint, `=` is the equation sign.
   */
  equals(assign: boolean, literal: boolean) {
    const p = glyph(this.prev());
    const swap = { "<": "≤", ">": "≥", "!": "≠" }[p ?? ""];
    if (swap) {
      this.row.atoms.splice(this.i - 1, 1, gl(swap));
      return this.re();
    }
    if (assign) return;
    if (p === "==") return;
    if (this.beforeShow) {
      this.line = this.beforeShow.line;
      this.caret = { ...this.beforeShow.caret };
      this.beforeShow = undefined;
      this.re();
      return this.put(gl("=="));
    }
    if (this.equation || literal) return this.put(gl("=="));
    const here = this.here;
    if (here.row === this.line.unit && this.line.show) return;
    this.beforeShow = { line: structuredClone(this.line), caret: { ...this.caret } };
    this.line.show = "value";
    this.re();
    this.set(this.line.unit, this.line.unit.atoms.length);
  }

  /** `->` or Ctrl+.: the result symbolically. */
  symbolic() {
    this.line.show = "symbolic";
    this.line.unit.atoms = [];
    this.re();
    this.set(this.line.unit, 0);
  }

  /**
   * `and`, `or`, `not` typed as a word of their own become the operator, wherever the text would
   * read them so: after a space, an operator, a number (`2 and b`), brackets (`(a) and b`). A gap
   * or an automatic `·` before the word goes. Another word typed after a space is a second
   * name: the gap becomes `·`.
   */
  keyword() {
    const r = this.row;
    let start = this.i;
    while (start > 0 && isWordChar(r.atoms[start - 1])) start--;
    // digits before letters are a number of their own (`2and`): the word starts at the letters
    if (!isNameStart(glyph(r.atoms[start]))) while (start < this.i && !isNameStart(glyph(r.atoms[start]))) start++;
    const word = r.atoms
      .slice(start, this.i)
      .map((a) => glyph(a))
      .join("");
    if (!word || isWordChar(this.next())) return;
    const before = r.atoms[start - 1];
    if (!KW.has(word)) {
      if (glyph(before) === " " && endsName(r, start - 1)) {
        r.atoms.splice(start - 1, 1, times());
        this.re();
      }
      return;
    }
    const from = before?.k === "g" && (before.s === " " || before.auto) ? start - 1 : start;
    r.atoms.splice(from, this.i - from, gl(word));
    this.re();
    this.set(r, from + 1);
  }

  // -------------------------------------------------------------------------
  // Wrapping a selection, deleting
  // -------------------------------------------------------------------------

  cut(sel: { row: string; from: number; to: number }): Atom[] {
    const r = this.w.get(sel.row)!.row;
    const out = r.atoms.splice(sel.from, sel.to - sel.from);
    this.anchor = null;
    this.re();
    this.set(r, sel.from);
    return out;
  }

  /** A selection typed over with `/`, `^`, `(` or `[`, or given a shape: it goes inside. */
  wrap(sel: { row: string; from: number; to: number }, how: string) {
    const atoms = this.cut(sel);
    if (how === "/") {
      const frac = mkNode("frac", [this.slotFrom(atoms, "numerator"), mkRow([], { born: true })]);
      this.put(frac);
      return this.set(frac.slots[1], 0);
    }
    if (how === "^") {
      const e = rowExpr(mkRow(atoms));
      const single = atoms[0]?.k !== "frac" && (atoms.length === 1 || (!!e && prec(e) >= P_POSTFIX));
      const exp = mkRow([], { born: true });
      this.put(...(single ? atoms : [mkNode("paren", [mkRow(atoms)])]), mkNode("sup", [exp]));
      return this.set(exp, 0);
    }
    const n =
      how === "(" || how === "["
        ? mkNode(how === "(" ? "paren" : "matrix", [mkRow(atoms)], how === "[" ? { cols: 1 } : {})
        : mkNode(
            how as Kind,
            how === "root" ? [this.slotFrom(atoms, "radicand"), mkRow()] : [this.slotFrom(atoms, "radicand")],
          );
    this.put(n);
    const inner = n.slots[0];
    if (how === "(" || how === "[") {
      // the selection stays on what was selected, now inside
      this.anchor = { row: inner.id, i: 0 };
      return this.set(inner, inner.atoms.length);
    }
    this.set(n.k === "root" ? n.slots[1] : inner, n.k === "root" ? 0 : inner.atoms.length);
  }

  /**
   * Backspace deletes the last thing drawn before the caret: a character; the `)` of brackets,
   * which turns faint and puts the caret inside; inside any other structure, its last character.
   * At the start of a slot it takes the structure apart (see `atStart`).
   */
  backspace() {
    const sel = selection(this.state());
    if (sel) return void this.cut(sel);
    this.anchor = null;
    const prev = this.prev();
    if (!prev) return this.atStart();
    if (prev.k === "g") {
      this.row.atoms.splice(this.i - 1, 1);
      this.caret.i--;
      return this.re();
    }
    if (prev.k === "paren" && !prev.ghost) {
      prev.ghost = true;
      return this.set(prev.slots[0], prev.slots[0].atoms.length);
    }
    const o = order(prev);
    const last = prev.slots[o[o.length - 1]];
    last.born = true;
    this.set(last, last.atoms.length);
    this.backspace();
  }

  /** Delete: the mirror of Backspace, on the first thing after the caret. */
  del() {
    const sel = selection(this.state());
    if (sel) return void this.cut(sel);
    this.anchor = null;
    const next = this.next();
    if (!next) return this.atEnd();
    if (next.k === "g") {
      this.row.atoms.splice(this.i, 1);
      return this.re();
    }
    if (next.k === "paren") return this.unwrap(next, false);
    const first = next.slots[order(next)[0]];
    first.born = true;
    this.set(first, 0);
    this.del();
  }

  /**
   * Backspace at the start of a slot: brackets, a fraction (from either slot), a script, a
   * radical go, their content staying where they were (`a/|b` → `a|b`, `x^|2` → `x|2`); an empty
   * one simply goes. A structure with several filled slots steps back to the slot before, or
   * is selected, so the next Backspace removes it whole.
   */
  atStart() {
    const { owner, slot, row } = this.here;
    if (!owner) {
      if (row === this.line.unit) {
        if (!row.atoms.length) this.line.show = null;
        this.re();
        return this.set(this.line.main, this.line.main.atoms.length);
      }
      return;
    }
    if (owner.k === "matrix") return this.cellStart(owner, slot);
    const o = order(owner);
    const p = o.indexOf(slot);
    if (owner.k === "str" && row.atoms.length) return this.select(owner);
    if (owner.k === "root" || owner.k === "big") {
      if (owner.slots.every((s, k) => k === slot || !s.atoms.length)) return this.unwrap(owner, true, slot);
      if (p > 0) {
        const before = owner.slots[o[p - 1]];
        return this.set(before, before.atoms.length);
      }
      return this.select(owner);
    }
    this.unwrap(owner, slot === 1, slot);
  }

  /** Delete at the end of a slot: the mirror of `atStart`. */
  atEnd() {
    const { owner, slot, row } = this.here;
    if (!owner) {
      if (row === this.line.main && this.line.show && !this.line.unit.atoms.length) {
        this.line.show = null;
        this.re();
      }
      return;
    }
    if (owner.k === "matrix") return this.cellEnd(owner, slot);
    const o = order(owner);
    const p = o.indexOf(slot);
    if (owner.k === "str" && row.atoms.length) return this.select(owner);
    if (owner.k === "root" || owner.k === "big") {
      if (owner.slots.every((s, k) => k === slot || !s.atoms.length)) return this.unwrap(owner, false, slot);
      if (p < o.length - 1) return this.set(owner.slots[o[p + 1]], 0);
      return this.select(owner);
    }
    this.unwrap(owner, owner.k === "frac" && slot === 0, slot, true);
  }

  /** The whole of structure `n` selected. */
  select(n: Node) {
    const place = this.placeOf(n)!;
    this.anchor = { row: place.row.id, i: place.at };
    this.set(place.row, place.at + 1);
  }

  /**
   * Structure `n` taken apart, its content left on the row in its place, with the brackets the
   * slot stood for when the text needs them (`(a + b)/2` → `(a + b)2`). The caret goes where the
   * structure's boundary was: between numerator and denominator for a fraction (`junction`).
   */
  unwrap(n: Node, junction: boolean, slot = 0, toEnd = false) {
    const place = this.placeOf(n)!;
    const what = (k: number): keyof typeof NEEDS_BRACKETS | null =>
      n.k === "frac" ? (k === 0 ? "numerator" : "denominator") : n.k === "sup" ? "exponent" : null;
    const content = (k: number): Atom[] => {
      const r = n.slots[k];
      if (!r.atoms.length) return [];
      const kind = what(k);
      const e = rowExpr(r);
      const needs = r.kept || (kind !== null && !!e && NEEDS_BRACKETS[kind](e));
      return needs ? [mkNode("paren", [mkRow(r.atoms)])] : r.atoms;
    };
    let atoms: Atom[];
    let caretAt: number;
    if (n.k === "frac") {
      const num = content(0);
      const den = content(1);
      atoms = [...num, ...den];
      caretAt = junction ? num.length : toEnd ? atoms.length : 0;
    } else if (n.k === "matrix" || n.k === "root" || n.k === "big") {
      atoms = n.k === "matrix" ? n.slots[0].atoms : content(slot);
      caretAt = toEnd ? atoms.length : 0;
    } else {
      atoms = n.k === "str" ? [] : content(0);
      caretAt = toEnd ? atoms.length : 0;
    }
    place.row.atoms.splice(place.at, 1, ...atoms);
    this.re();
    this.set(place.row, place.at + caretAt);
  }

  cellStart(m: Node, slot: number) {
    const cols = m.cols ?? 1;
    const r = Math.floor(slot / cols);
    const c = slot % cols;
    if (c > 0) {
      if (this.columnEmpty(m, c)) this.dropColumn(m, c);
      const cell = m.slots[r * (m.cols ?? 1) + c - 1];
      return this.set(cell, cell.atoms.length);
    }
    if (r > 0) {
      if (m.slots.slice(r * cols, r * cols + cols).every((s) => !s.atoms.length)) {
        m.slots.splice(r * cols, cols);
        this.re();
      }
      const cell = m.slots[r * cols - 1];
      return this.set(cell, cell.atoms.length);
    }
    if (m.slots.every((s) => !s.atoms.length) || m.slots.length === 1) return this.unwrap(m, false);
    this.select(m);
  }

  cellEnd(m: Node, slot: number) {
    const cols = m.cols ?? 1;
    const rows = m.slots.length / cols;
    const r = Math.floor(slot / cols);
    const c = slot % cols;
    if (c < cols - 1) {
      if (this.columnEmpty(m, c + 1)) return this.dropColumn(m, c + 1);
      return this.set(m.slots[slot + 1], 0);
    }
    if (r < rows - 1) {
      const below = m.slots.slice((r + 1) * cols, (r + 2) * cols);
      if (below.every((s) => !s.atoms.length)) {
        m.slots.splice((r + 1) * cols, cols);
        return this.re();
      }
      return this.set(m.slots[(r + 1) * cols], 0);
    }
    if (m.slots.every((s) => !s.atoms.length) || m.slots.length === 1) return this.unwrap(m, false, 0, true);
    this.select(m);
  }

  columnEmpty(m: Node, c: number): boolean {
    const cols = m.cols ?? 1;
    return m.slots.every((s, k) => k % cols !== c || !s.atoms.length);
  }

  dropColumn(m: Node, c: number) {
    const cols = m.cols ?? 1;
    m.slots = m.slots.filter((_, k) => k % cols !== c);
    m.cols = cols - 1;
    this.re();
  }

  // -------------------------------------------------------------------------
  // Moving
  // -------------------------------------------------------------------------

  /** ← →: one position in reading order, into and out of every structure. */
  horizontal(dir: 1 | -1, shift: boolean) {
    this.space = false;
    if (shift) return this.extend(dir);
    const sel = selection(this.state());
    this.anchor = null;
    this.clearBorn();
    if (sel) return this.set(sel.row, dir > 0 ? sel.to : sel.from);
    const list = stops(this.line);
    let k = list.findIndex((p) => p.row === this.caret.row && p.i === this.caret.i);
    do k += dir;
    while (list[k]?.skip);
    const to = list[k];
    if (!to) return void (this.effect = { leave: dir > 0 ? "right" : "left" });
    this.caret = { row: to.row, i: to.i };
  }

  /** ⇧← ⇧→: the selection grows by one thing on its row, or to the whole structure around it. */
  extend(dir: 1 | -1) {
    this.anchor ??= { ...this.caret };
    const sel = selection(this.state());
    const rowId = sel?.row ?? this.caret.row;
    const w = this.w.get(rowId)!;
    // where the moving end is, on the selection's row
    let f: number;
    if (!sel) f = this.caret.i;
    else {
      const caretFirst = this.caretBeforeAnchor(rowId);
      f = caretFirst ? sel.from : sel.to;
      this.anchor = { row: rowId, i: caretFirst ? sel.to : sel.from };
    }
    const to = f + dir;
    if (to >= 0 && to <= w.row.atoms.length) return this.set(w.row, to);
    if (!w.owner || !w.parent) return void (this.effect = { leave: dir > 0 ? "right" : "left" });
    // the whole structure, on the row above
    this.anchor = { row: w.parent.id, i: dir > 0 ? w.at : w.at + 1 };
    this.set(w.parent, dir > 0 ? w.at + 1 : w.at);
  }

  caretBeforeAnchor(rowId: string): boolean {
    const proj = (p: Pos) => {
      const chain = ancestry(this.w, p.row);
      const k = chain.findIndex((x) => x.row === rowId);
      return k <= 0 ? p.i : chain[k].at + 0.5;
    };
    return proj(this.caret) < proj(this.anchor!);
  }

  /**
   * ↑ ↓: between a fraction's numerator and denominator, a superscript and its base, a root's
   * index and radicand, the limits of a sum or integral, a matrix's rows. With nowhere to go in
   * the formula, the editor is told to leave it that way.
   */
  vertical(dir: "up" | "down", pick?: (row: string, atoms: number) => number) {
    this.space = false;
    this.anchor = null;
    this.clearBorn();
    const r = this.row;
    // a script next to the caret
    const near = [this.next(), this.prev()];
    for (const [k, a] of near.entries()) {
      if (!a || a.k === "g") continue;
      if ((dir === "up" && a.k === "sup") || (dir === "down" && (a.k === "sub" || a.k === "index"))) {
        const s = a.slots[0];
        return this.set(s, k === 0 ? 0 : s.atoms.length);
      }
    }
    let id = r.id;
    const share = this.caret.i / Math.max(1, r.atoms.length);
    for (;;) {
      const w = this.w.get(id)!;
      const n = w.owner;
      if (!n || !w.parent) return void (this.effect = { leave: dir });
      const target = verticalSlot(n, w.slot, dir);
      if (target !== null) {
        const t = n.slots[target];
        const i = pick ? pick(t.id, t.atoms.length) : Math.round(share * t.atoms.length);
        return this.set(t, Math.max(0, Math.min(t.atoms.length, i)));
      }
      // out of a script, back to its base
      if ((n.k === "sup" && dir === "down") || ((n.k === "sub" || n.k === "index") && dir === "up")) {
        const next = w.parent.atoms[w.at + 1];
        const prev = w.parent.atoms[w.at - 1];
        if (n.k === "sup" && prev?.k === "sub") return this.set(prev.slots[0], prev.slots[0].atoms.length);
        if (n.k === "sub" && next?.k === "sup") return this.set(next.slots[0], 0);
        return this.set(w.parent, n.k === "sup" ? w.at : w.at + 1);
      }
      id = w.parent.id;
    }
  }
}

function verticalSlot(n: Node, slot: number, dir: "up" | "down"): number | null {
  switch (n.k) {
    case "frac":
      return dir === "down" && slot === 0 ? 1 : dir === "up" && slot === 1 ? 0 : null;
    case "root":
      return dir === "up" && slot === 0 ? 1 : dir === "down" && slot === 1 ? 0 : null;
    case "matrix": {
      const cols = n.cols ?? 1;
      const to = slot + (dir === "down" ? cols : -cols);
      return to >= 0 && to < n.slots.length ? to : null;
    }
    case "big": {
      const d = BIG[`${n.name}/${n.slots.length}`];
      return (dir === "up" ? d?.up : d?.down)?.[slot] ?? null;
    }
    default:
      return null;
  }
}

/** A name ends just before `i` (not a number: `x2` against `12`). */
function endsName(r: Row, i: number): boolean {
  const a = r.atoms[i - 1];
  if (a?.k === "sub" || a?.k === "const") return true;
  if (!isWordChar(a)) return false;
  let k = i - 1;
  while (k > 0 && isWordChar(r.atoms[k - 1])) k--;
  return isNameStart(glyph(r.atoms[k]));
}

/** A value ends just before: a `(` or `[` typed here is a product with it (`2(`, `)(`, `√2(`). */
function endsValueBefore(prev: Atom | undefined): boolean {
  if (!prev) return false;
  if (prev.k === "g") return isDigit(prev.s) || prev.s === "!" || prev.s === "?" || prev.s === ".";
  return prev.k !== "sub" && prev.k !== "cmd";
}

/** The row ends in a value (not in an operator still waiting for one). */
function endsValue(r: Row): boolean {
  return endsValueAt(r, r.atoms.length);
}
function endsValueAt(r: Row, i: number): boolean {
  const a = r.atoms[i - 1];
  if (!a) return false;
  if (a.k === "g") return !isOp(a) && a.s !== " ";
  return a.k !== "cmd";
}

/** A `-` or `+` at `k` is a sign (not a subtraction): at the start, or after an operator. */
function isUnaryAt(r: Row, k: number): boolean {
  const before = r.atoms[k - 1];
  return !before || isOp(before) || glyph(before) === " ";
}

/** Where the value starting at `i` ends, as a `/` or `^` would take it: signs, then up to an operator. */
function operandEnd(r: Row, i: number): number {
  let k = i;
  while (SIGNS.has(glyph(r.atoms[k]) ?? "")) k++;
  if (k === i && isOp(r.atoms[k])) return i;
  while (k < r.atoms.length) {
    const a = r.atoms[k];
    if (a.k === "g" && (isOp(a) || a.s === " ")) break;
    k++;
  }
  return k;
}

/** The exponent's last value would take a unit typed now (`10^-4` then `m`). */
function holdsUnitNow(r: Row): boolean {
  const a = r.atoms[r.atoms.length - 1];
  if (!a) return false;
  if (a.k === "paren") return !a.ghost;
  if (a.k === "sup") return holdsUnitNow(a.slots[0]);
  if (a.k !== "g" || !isDigit(a.s)) return false;
  let k = r.atoms.length - 1;
  while (k > 0 && isWordChar(r.atoms[k - 1])) k--;
  return !isNameStart(glyph(r.atoms[k]));
}

/** `1e` with its exponent's sign still to come: `1e-5` is one number. */
function numberExponentOpen(r: Row): boolean {
  const n = r.atoms.length;
  const e = glyph(r.atoms[n - 1]);
  return (e === "e" || e === "E") && isDigit(glyph(r.atoms[n - 2]));
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface KeyOptions {
  shift?: boolean;
  /** For ↑ ↓: the index to land on in the row reached, from the caret's position on screen. */
  pick?: (row: string, atoms: number) => number;
}

/**
 * One key: a character typed (`"a"`, `"/"`, `" "`), or `Backspace`, `Delete`, `ArrowLeft`,
 * `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `Tab`. The editor's own shortcuts are
 * `symbolic()` (Ctrl+.) and `greek()` (Ctrl+G). `effect.leave` says the caret would leave the
 * formula that way; `effect.command` asks for an app command (`\text`).
 */
export function key(s: EditState, k: string, opts: KeyOptions = {}): EditState {
  const e = new Ed(s);
  e.effect = undefined;
  switch (k) {
    case "Backspace":
      e.space = false;
      e.backspace();
      break;
    case "Delete":
      e.space = false;
      e.del();
      break;
    case "ArrowLeft":
    case "ArrowRight":
      e.horizontal(k === "ArrowRight" ? 1 : -1, !!opts.shift);
      break;
    case "ArrowUp":
    case "ArrowDown":
      e.vertical(k === "ArrowUp" ? "up" : "down", opts.pick);
      break;
    case "Home":
    case "End": {
      e.clearBorn();
      e.space = false;
      const to = k === "Home" ? { row: e.line.main.id, i: 0 } : endOf(e.line);
      if (opts.shift) e.anchor ??= { ...e.caret };
      else e.anchor = null;
      e.caret = to;
      break;
    }
    case "Tab": {
      e.clearBorn();
      const next = nextHole(e.line, e.caret, opts.shift ? -1 : 1);
      if (next) e.caret = next;
      else e.effect = { leave: opts.shift ? "left" : "right" };
      break;
    }
    default:
      if ([...k].length === 1) e.type(k);
  }
  return e.done(s);
}

/** Types each character of `text` (a paste, a template): one undo step. */
export function typeText(s: EditState, text: string, literal = false): EditState {
  const e = new Ed(s);
  const chars = [...text];
  for (let k = 0; k < chars.length; k++) {
    const ch = chars[k];
    // a string's escapes, as the text writes them
    if (literal && e.here.owner?.k === "str" && ch === "\\" && k + 1 < chars.length) {
      const esc = chars[++k];
      e.put(gl(({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[esc] ?? esc));
      continue;
    }
    e.type(ch, literal);
  }
  return e.done(s);
}

/** Pastes linear text at the caret (over the selection), as one step; `a/b + c` is (a/b) + c. */
export function paste(s: EditState, text: string): EditState {
  const typed = typeText(s, text.replace(/\s+/g, " ").trim(), true);
  return { ...typed, space: undefined };
}

/** Inserts a gallery template (`sqrt(?)`, `[?, ?; ?, ?]`) and puts the caret in its first slot. */
export function insertTemplate(s: EditState, template: string): EditState {
  const e = new Ed(s);
  const sel = selection(s);
  if (sel) e.cut(sel);
  e.insertTemplate(template);
  return e.done(s);
}

/** Wraps the selection (or an empty slot at the caret) in a shape: `sqrt`, `abs`, `root`, `(`, `[`, `/`, `^`. */
export function wrapIn(s: EditState, how: "sqrt" | "abs" | "root" | "(" | "[" | "/" | "^"): EditState {
  const sel = selection(s);
  if (!sel && how.length === 1) return key(s, how);
  const e = new Ed(s);
  e.wrap(sel ?? { row: s.caret.row, from: s.caret.i, to: s.caret.i }, how);
  return e.done(s);
}

/** Ctrl+.: show the result symbolically (`→`). */
export function symbolic(s: EditState): EditState {
  const e = new Ed(s);
  e.symbolic();
  return e.done(s);
}

const GREEK: Record<string, string> = Object.fromEntries(
  [..."abgdezhqiklmnxoprstufcyw"]
    .map((c, i) => [c, "αβγδεζηθικλμνξοπρστυφχψω"[i]])
    .concat([..."ABGDEZHQIKLMNXOPRSTUFCYW"].map((c, i) => [c, "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"[i]])),
);
const LATIN = Object.fromEntries(Object.entries(GREEK).map(([l, g]) => [g, l]));

/** Ctrl+G: the letter before the caret becomes Greek, or back (`a` ↔ `α`). */
export function greek(s: EditState): EditState {
  const e = new Ed(s);
  const prev = e.prev();
  const swap = prev?.k === "g" ? (GREEK[prev.s] ?? LATIN[prev.s]) : undefined;
  if (prev?.k === "g" && swap) prev.s = swap;
  return e.done(s);
}

/** Puts the caret at `pos` (a click), extending the selection with `shift`. */
export function setCaret(s: EditState, pos: Pos, shift = false): EditState {
  const e = new Ed(s);
  e.clearBorn();
  e.space = false;
  if (shift) e.anchor ??= { ...e.caret };
  else e.anchor = null;
  if (e.w.has(pos.row)) e.caret = { ...pos };
  e.re();
  return e.done(s);
}

/** The selection's text removed, for Cut. */
export function cutSelection(s: EditState): { state: EditState; text: string } {
  const text = selectedText(s);
  const sel = selection(s);
  if (!sel) return { state: s, text: "" };
  const e = new Ed(s);
  e.cut(sel);
  return { state: e.done(s), text };
}

/** The positions of the empty slots, in reading order. */
function holes(line: Line): Pos[] {
  const out: Pos[] = [];
  const w = locate(line);
  for (const p of stops(line)) {
    const at = w.get(p.row)!;
    const r = at.row;
    if (!r.atoms.length && at.owner && at.owner.k !== "str" && at.owner.k !== "cmd" && !isCallParen(line, at))
      out.push(p);
    else if (glyph(r.atoms[p.i]) === "?") out.push(p);
  }
  return out;
}

function isCallParen(_line: Line, at: Where): boolean {
  if (at.owner?.k !== "paren" || at.owner.ghost || !at.parent) return false;
  const before = at.parent.atoms[at.at - 1];
  return isWordChar(before) || before?.k === "sub";
}

function nextHole(line: Line, caret: Pos, dir: 1 | -1): Pos | null {
  const list = stops(line);
  const at = list.findIndex((p) => p.row === caret.row && p.i === caret.i);
  const hs = holes(line).map((h) => ({ h, k: list.findIndex((p) => p.row === h.row && p.i === h.i) }));
  const found = dir > 0 ? hs.find((x) => x.k > at) : [...hs].reverse().find((x) => x.k < at);
  const wrap = dir > 0 ? hs[0] : hs[hs.length - 1];
  const pick = found ?? (wrap && wrap.k !== at ? wrap : undefined);
  return pick ? pick.h : null;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Undo steps as the linear editor takes them (#119): every key that changes the formula is one
 * step (a paste, a template or a shortcut is one too); moving the caret is none, but a step
 * remembers where the caret was. At most 500.
 */
export class History {
  private steps: EditState[];
  private at = 0;
  constructor(first: EditState) {
    this.steps = [first];
  }
  get current(): EditState {
    return this.steps[this.at];
  }
  /** After each key: a new step if the formula changed, else the caret moves within this one. */
  record(s: EditState) {
    if (s.version === this.current.version || content(s.line) === content(this.current.line)) {
      this.steps[this.at] = s;
      return;
    }
    this.steps.length = this.at + 1;
    this.steps.push(s);
    if (this.steps.length > 500) this.steps.shift();
    this.at = this.steps.length - 1;
  }
  undo(): EditState | null {
    if (this.at === 0) return null;
    return settle(this.steps[--this.at]);
  }
  redo(): EditState | null {
    if (this.at >= this.steps.length - 1) return null;
    return settle(this.steps[++this.at]);
  }
}

// ---------------------------------------------------------------------------
// For drawing (phase 2)
// ---------------------------------------------------------------------------

export interface Hints {
  caret: Pos;
  selection: { row: string; from: number; to: number } | null;
  /** Slots drawn as □: empty rows of structures (not a call's brackets, which may hold nothing). */
  empty: string[];
  /** Operands not typed yet, drawn as □ at that position (`a + □`, `M ≔ □`). */
  missing: Pos[];
  /** Brackets whose `)` hasn't been typed: drawn faint. */
  ghosts: string[];
  /** Fractions the text puts in brackets (`c*(a/b)`): drawn with them, as the formula will be. */
  bracketed: string[];
  /** Superscripts with nothing before them: drawn on a □. */
  noBase: string[];
  /** Slots still open for typing (see `Row.born`). */
  open: string[];
}

/** What phase 2 draws besides the tree itself: the caret, the selection, the □s and faint brackets. */
export function hints(s: EditState): Hints {
  const out: Hints = {
    caret: s.caret,
    selection: selection(s),
    empty: [],
    missing: [],
    ghosts: [],
    bracketed: [],
    noBase: [],
    open: [],
  };
  const w = locate(s.line);
  forEachRow(s.line, (r) => {
    const at = w.get(r.id)!;
    if (r.born) out.open.push(r.id);
    if (!r.atoms.length && at.owner && at.owner.k !== "cmd" && at.owner.k !== "str" && !isCallParen(s.line, at))
      out.empty.push(r.id);
    r.atoms.forEach((a, k) => {
      const before = r.atoms[k - 1];
      if (a.k === "paren" && a.ghost) out.ghosts.push(a.id);
      if (
        a.k === "frac" &&
        before &&
        (glyph(before) === "*" || glyph(before) === "%" || (SIGNS.has(glyph(before) ?? "") && isUnaryAt(r, k - 1)))
      )
        out.bracketed.push(a.id);
      if (a.k === "sup" && (!before || isOp(before))) out.noBase.push(a.id);
      if (isOp(a)) {
        const next = r.atoms[k + 1];
        if (!next || (isOp(next) && !SIGNS.has(glyph(next)!))) out.missing.push({ row: r.id, i: k + 1 });
      }
    });
    if (r === s.line.main && isOp(r.atoms[0]) && !SIGNS.has(glyph(r.atoms[0])!) && glyph(r.atoms[0]) !== "not")
      out.missing.push({ row: r.id, i: 0 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// A tree in one line of text, for tests and the spec (docs/07-math-editing.md)
// ---------------------------------------------------------------------------

const SKETCH_OP: Record<string, string> = { "*": "·", ":=": "≔", "==": "=", and: "∧", or: "∨", not: "¬", " ": "␣" };

/**
 * The tree as one line: `\frac{a}{b}`, `x^{2}`, `A_{net}`, `(a)` (`(a⦆` while its `)` is faint),
 * `M_[i]`, `\mat{a, b; c, d}`, `\sqrt{x}`, `\root{n}{x}`, `|x|`, `\int{a}{b}{f}{x}` (slots in
 * reading order), `'{kN}`, `#{G}`, `"text"`, `\{cmd}`. `□` is an empty slot, `‸` the caret,
 * `«…»` the selection; then ` = unit` or ` →`.
 */
export function sketch(s: EditState): string {
  const sel = selection(s);
  const row = (r: Row): string => {
    let out = "";
    const mark = (i: number) => {
      if (sel?.row === r.id && sel.from === i) out += "«";
      if (sel?.row === r.id && sel.to === i) out += "»";
      if (!s.anchor && s.caret.row === r.id && s.caret.i === i) out += "‸";
    };
    if (!r.atoms.length) {
      if (!s.anchor && s.caret.row === r.id) return "‸";
      return "□";
    }
    r.atoms.forEach((a, i) => {
      mark(i);
      out += atom(a);
    });
    mark(r.atoms.length);
    return out;
  };
  const rowOrEmpty = (x: Row) => (x.atoms.length ? row(x) : !s.anchor && s.caret.row === x.id ? "‸" : "");
  const atom = (a: Atom): string => {
    if (a.k === "g") return SKETCH_OP[a.s] ?? a.s;
    const sl = a.slots.map((x) => (a.k === "str" || a.k === "cmd" ? rowOrEmpty(x) : row(x)));
    switch (a.k) {
      case "frac":
        return `\\frac{${sl[0]}}{${sl[1]}}`;
      case "sup":
        return `^{${sl[0]}}`;
      case "sub":
        return `_{${sl[0]}}`;
      case "paren":
        return `(${a.slots[0].atoms.length ? sl[0] : !s.anchor && s.caret.row === a.slots[0].id ? "‸" : "□"}${a.ghost ? "⦆" : ")"}`;
      case "index":
        return `_[${sl[0]}]`;
      case "matrix": {
        const cols = a.cols ?? 1;
        const rows: string[] = [];
        for (let k = 0; k < sl.length; k += cols) rows.push(sl.slice(k, k + cols).join(", "));
        return `\\mat{${rows.join("; ")}}`;
      }
      case "sqrt":
        return `\\sqrt{${sl[0]}}`;
      case "abs":
        return `|${sl[0]}|`;
      case "root":
        return `\\root{${sl[1]}}{${sl[0]}}`;
      case "big":
        return `\\${a.name}${order(a)
          .map((k) => `{${sl[k]}}`)
          .join("")}`;
      case "str":
        return `"${sl[0]}${a.ghost ? "⦆" : '"'}`;
      case "unit":
        return `'{${sl[0]}}`;
      case "const":
        return `#{${sl[0]}}`;
      case "cmd":
        return `\\{${sl[0]}}`;
    }
  };
  const main = row(s.line.main);
  if (s.line.show === "symbolic") return `${main} →${!s.anchor && s.caret.row === s.line.unit.id ? "‸" : ""}`;
  if (s.line.show === "value") return `${main} = ${row(s.line.unit)}`;
  return main;
}

// ---------------------------------------------------------------------------
// For the editor on the page
// ---------------------------------------------------------------------------

/**
 * Brackets filling a slot the caret is not in become the slot's (`absorb`), as they will be
 * once the edit ends: an arrow or a click out of `e^(x + 1)` draws it as the view draws it. The
 * formula and its text are the same, so it is no new undo step.
 */
export function settleSlots(s: EditState): EditState {
  const e = new Ed(s);
  const inside = new Set(ancestry(e.w, s.caret.row).map((x) => x.row));
  if (s.anchor) for (const x of ancestry(e.w, s.anchor.row)) inside.add(x.row);
  const rows: Row[] = [];
  forEachRow(e.line, (r) => rows.push(r));
  for (const r of rows.reverse()) if (!inside.has(r.id)) e.absorb(r);
  e.re();
  const out = e.done(s);
  return { ...out, version: s.version, effect: s.effect, space: s.space, assign: s.assign, beforeShow: s.beforeShow };
}

/** Every position the caret can be at, as ← → walk them. */
export function positions(s: EditState): Pos[] {
  return stops(s.line)
    .filter((p) => !p.skip)
    .map(({ row, i }) => ({ row, i }));
}

/** The caret in the first empty slot (□ or `?`), if there is one. */
export function toFirstHole(s: EditState): EditState | null {
  const h = holes(s.line)[0];
  return h ? setCaret(s, h) : null;
}

/** Where a row is: the structure it is a slot of (null for the line's rows), and that structure's place. */
export function whereIs(
  s: EditState,
  row: string,
): { owner: Node | null; slot: number; parent: Row | null; at: number; row: Row } | null {
  const w = locate(s.line).get(row);
  return w ? { owner: w.owner, slot: w.slot, parent: w.parent, at: w.at, row: w.row } : null;
}

/** Selects `[from, to)` of a row (the caret at `to`). */
export function selectRange(s: EditState, row: string, from: number, to: number): EditState {
  return setCaret(setCaret(s, { row, i: from }), { row, i: to }, true);
}

/** An empty formula, the caret in it. */
export function empty(opts: { equation?: boolean } = {}): EditState {
  return { ...fresh(emptyLine()), equation: opts.equation };
}

export { print, rawText, constName };
