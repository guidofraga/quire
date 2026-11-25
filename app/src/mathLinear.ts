// The structural editor's trees (mathTree.ts) as Quire's linear syntax: each row read as the
// engine's parser reads text (crates/quire-ast/src/parser.rs), giving an `Expr`, and that printed
// as crates/quire-ast/src/printer.rs prints it, so a formula edited in 2D is stored exactly as
// if it had been typed: canonical spacing, and parentheses only where precedence needs them.
// The round-trip tests (mathTree.engine.test.ts) hold both ports to the Rust originals.
import type { BinaryOp, CmpOp, Expr, UnaryOp } from "./types";
import type { Atom, Node, Row } from "./mathTree";

// ---------------------------------------------------------------------------
// Characters, as the lexer classes them
// ---------------------------------------------------------------------------

const one = (s: string | null | undefined): s is string => !!s && [...s].length === 1;
export const isDigit = (s: string | null | undefined): boolean => one(s) && s >= "0" && s <= "9";
/** `is_ident_start`: a letter, `_`, `∞`, `…` or `°` (`°C`, `30°`). */
export const isNameStart = (s: string | null | undefined): boolean => one(s) && /[\p{L}_∞…°]/u.test(s);
/** `is_ident_continue`: letters, digits, `_` and primes (σ′). */
export const isNameCont = (s: string | null | undefined): boolean => one(s) && /[\p{L}\p{N}_′″‴]/u.test(s);
/** What a quoted unit's name is made of (`'kN`, `'°C`, `'%`). */
export const isUnitChar = (s: string | null | undefined): boolean => one(s) && /[\p{L}\p{N}_°%‰¤]/u.test(s);

/** Operator glyphs, in their canonical spelling. */
export const OPS = new Set([
  "+",
  "-",
  "*",
  "%",
  "±",
  "!",
  ",",
  ";",
  "<",
  ">",
  "≤",
  "≥",
  "≠",
  "==",
  ":=",
  "≡",
  "..",
  "and",
  "or",
  "not",
]);
const KEYWORDS = new Set(["and", "or", "not"]);
const CMP: Record<string, CmpOp> = { "==": "Eq", "≠": "Ne", "<": "Lt", "≤": "Le", ">": "Gt", "≥": "Ge" };

const glyph = (a: Atom | undefined): string | null => (a && a.k === "g" ? a.s : null);

/** The text of a slot made of characters only (a subscript, a quoted unit, a string). */
export function rowText(r: Row): string {
  return r.atoms.map((a) => (a.k === "g" ? a.s : a.k === "sub" ? `.${rowText(a.slots[0])}` : "")).join("");
}

/** A name with its literal subscript, `A.net`; a dot that nothing follows yet is left out. */
function subText(r: Row): string {
  return rowText(r).replace(/\.+$/, "");
}

/** The name in a `#` constant's slot, `k.B`; empty unless it starts as a name must. */
export function constName(r: Row): string {
  const name = r.atoms
    .map((a) =>
      a.k === "g"
        ? isNameCont(a.s) || isNameStart(a.s)
          ? a.s
          : ""
        : a.k === "sub" && subText(a.slots[0])
          ? `.${subText(a.slots[0])}`
          : "",
    )
    .join("");
  return isNameStart([...name][0]) ? name : "";
}

/** A quoted unit's name, `g.e`: its dots only between characters, as the lexer reads it. */
export function unitName(r: Row): string {
  return rowText(r)
    .replace(/[^\p{L}\p{N}_°%‰¤.]/gu, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

// ---------------------------------------------------------------------------
// Rows as tokens
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; s: string }
  | { t: "name"; s: string }
  | { t: "kw"; s: string }
  | { t: "op"; s: string }
  /** A structure that is a value: a fraction, brackets, a matrix, a radical, a string, a unit… */
  | { t: "node"; n: Node }
  /** A superscript or an index: they apply to what comes before them. */
  | { t: "sup"; n: Node }
  | { t: "index"; n: Node }
  | { t: "hole" }
  | { t: "eof" };

/** A row's atoms as the lexer would read the same characters (crates/quire-ast/src/lexer.rs). */
function lex(atoms: Atom[]): Tok[] {
  const out: Tok[] = [];
  const g = (j: number) => glyph(atoms[j]);
  let i = 0;
  while (i < atoms.length) {
    const a = atoms[i];
    if (a.k !== "g") {
      if (a.k === "sup") out.push({ t: "sup", n: a });
      else if (a.k === "index") out.push({ t: "index", n: a });
      // a subscript with no name before it, a `\command` not finished, a `'` or `#` with
      // no name yet: nothing yet, as the forgiving lexer reads them
      else if (
        a.k !== "sub" &&
        a.k !== "cmd" &&
        !(a.k === "unit" && !unitName(a.slots[0])) &&
        !(a.k === "const" && !constName(a.slots[0]))
      )
        out.push({ t: "node", n: a });
      i++;
      continue;
    }
    const s = a.s;
    if (s === " ") {
      i++;
      continue;
    }
    if (s === "?") {
      out.push({ t: "hole" });
      i++;
      continue;
    }
    if (isDigit(s) || (s === "." && isDigit(g(i + 1)))) {
      let j = i;
      let text = "";
      while (isDigit(g(j))) text += g(j++);
      if (g(j) === ".") {
        text += ".";
        j++;
        while (isDigit(g(j))) text += g(j++);
      }
      const e = g(j);
      if (e === "e" || e === "E") {
        let k = j + 1;
        const sign = g(k) === "+" || g(k) === "-" ? g(k++) : "";
        if (isDigit(g(k))) {
          text += e + sign;
          j = k;
          while (isDigit(g(j))) text += g(j++);
        }
      }
      out.push({ t: "num", s: text });
      i = j;
      continue;
    }
    if (isNameStart(s)) {
      let j = i + 1;
      let text = s;
      while (isNameCont(g(j))) text += g(j++);
      const next = atoms[j];
      let sub = "";
      if (next?.k === "sub") {
        sub = subText(next.slots[0]);
        j++;
      }
      if (!sub && KEYWORDS.has(text)) out.push({ t: "kw", s: text });
      else out.push({ t: "name", s: sub ? `${text}.${sub}` : text });
      i = j;
      continue;
    }
    if (KEYWORDS.has(s)) out.push({ t: "kw", s: a.s });
    // a lone `.` is a subscript or decimal not finished yet: left out, as the forgiving lexer does
    else if (s !== ".") out.push({ t: "op", s });
    i++;
  }
  out.push({ t: "eof" });
  return out;
}

// ---------------------------------------------------------------------------
// Rows as expressions: parser.rs's precedence climbing, over tokens
// ---------------------------------------------------------------------------

const DEFINE = 1;
const OR = 2;
const AND = 3;
const NOT = 4;
const COMPARE = 5;
const RANGE = 6;
const ADD = 7;
const MUL = 8;
const UNARY = 9;
const ATOM = 10;

/** A row that doesn't read as one expression even with its gaps filled (`a + * b`, `(1, 2)`). */
class Unreadable extends Error {}

const bin = (op: BinaryOp, a: Expr, b: Expr): Expr => ({ t: "Binary", c: [op, a, b] });
const HOLE: Expr = { t: "Placeholder" };
const BINARY: Record<string, BinaryOp> = {
  "+": "Add",
  "-": "Sub",
  "±": "PlusMinus",
  "*": "Mul",
  "%": "Mod",
  or: "Or",
  and: "And",
};

/**
 * Whether a unit written after a power is taken by the whole power (`10^-4 m`, `10^(2) m`): the
 * parser holds it for the power when the exponent's last value is a number, or brackets. After
 * brackets (the exponent printed in them, or ending in them) only a plain name or a quoted unit
 * is held, not a call (`x^(2) f(y)`).
 */
function holdsUnit(r: Row, exp: Expr): "num" | "paren" | null {
  if (r.kept || NEEDS_BRACKETS.exponent(exp)) return "paren";
  const toks = lex(r.atoms);
  const last = toks[toks.length - 2];
  if (!last) return null;
  if (last.t === "num") return "num";
  if (last.t === "sup") {
    const inner = rowExpr(last.n.slots[0], true);
    return inner ? holdsUnit(last.n.slots[0], inner) : null;
  }
  return last.t === "node" && last.n.k === "paren" ? "paren" : null;
}

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private exponent: boolean,
  ) {}

  private peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }
  private bump(): Tok {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  private isParen(t: Tok) {
    return t.t === "node" && t.n.k === "paren";
  }

  all(): Expr {
    const e = this.expr(DEFINE);
    if (this.peek().t !== "eof") throw new Unreadable();
    return e;
  }

  private expr(min: number): Expr {
    let [lhs, level] = this.prefix(min);
    for (;;) {
      const t = this.peek();
      let at: number;
      let implicit = false;
      if (t.t === "op" && t.s in CMP) at = COMPARE;
      else if (t.t === "op" && (t.s === ":=" || t.s === "≡")) at = DEFINE;
      else if (t.t === "kw" && t.s === "or") at = OR;
      else if (t.t === "kw" && t.s === "and") at = AND;
      else if (t.t === "op" && t.s === "..") at = RANGE;
      else if (t.t === "op" && (t.s === "+" || t.s === "-" || t.s === "±")) at = ADD;
      else if (t.t === "op" && (t.s === "*" || t.s === "%")) at = MUL;
      // two values side by side that the text has no way to write: a product (`2(x + 1)`)
      else if (t.t === "num" || t.t === "name" || t.t === "node" || t.t === "hole") {
        at = MUL;
        implicit = true;
      } else break;
      const takes = at === COMPARE || at === RANGE ? level > at : level >= at;
      if (min > at || !takes) break;
      if (at === DEFINE) {
        const global = (this.bump() as { s: string }).s === "≡";
        lhs = { t: "Define", c: { lhs, rhs: this.expr(DEFINE), global } };
      } else if (at === COMPARE) {
        const rest: [CmpOp, Expr][] = [];
        for (let c = this.peek(); c.t === "op" && c.s in CMP; c = this.peek()) {
          this.bump();
          rest.push([CMP[c.s], this.expr(RANGE)]);
        }
        lhs = { t: "Compare", c: [lhs, rest] };
      } else if (at === RANGE) {
        this.bump();
        lhs = { t: "Range", c: [lhs, this.expr(ADD)] };
      } else {
        const op = implicit ? "Mul" : BINARY[(this.bump() as { s: string }).s];
        lhs = bin(op, lhs, this.expr(at + 1));
      }
      level = at;
    }
    return lhs;
  }

  private prefix(min: number): [Expr, number] {
    const t = this.peek();
    if (t.t === "kw" && t.s === "not" && min <= NOT) {
      this.bump();
      return [{ t: "Unary", c: ["Not", this.expr(NOT)] }, NOT];
    }
    const op: UnaryOp | null =
      t.t === "op" ? (t.s === "-" ? "Neg" : t.s === "+" ? "Pos" : t.s === "±" ? "PlusMinus" : null) : null;
    if (!op) return [this.power(), ATOM];
    this.bump();
    return [{ t: "Unary", c: [op, this.expr(UNARY)] }, UNARY];
  }

  private power(): Expr {
    let e = this.postfix();
    while (this.peek().t === "sup") {
      const n = (this.bump() as { n: Node }).n;
      const exp = this.slot(n.slots[0], true);
      e = bin("Pow", e, exp);
      // `10^-4 m^3`: a unit after the power multiplies the whole power
      const held = this.exponent ? null : holdsUnit(n.slots[0], exp);
      const next = this.peek();
      const takes =
        held === "num"
          ? this.unitNext()
          : held === "paren" &&
            ((next.t === "name" && !this.isParen(this.peek(1)) && this.peek(1).t !== "index") ||
              (next.t === "node" && next.n.k === "unit"));
      if (takes) return bin("Juxt", e, this.unitTerm());
    }
    return e;
  }

  /** A unit the value before it takes: a name, a quoted unit or a `#` constant. */
  private unitNext(): boolean {
    const t = this.peek();
    return t.t === "name" || (t.t === "node" && (t.n.k === "unit" || t.n.k === "const"));
  }

  private unitTerm(): Expr {
    const t = this.peek();
    const next = this.peek(1);
    let unit: Expr;
    // `2 sin(x)`, `3 v[i]`
    if (t.t === "name" && (this.isParen(next) || next.t === "index")) unit = this.postfix();
    else {
      this.bump();
      if (t.t === "name") unit = { t: "Ident", c: t.s };
      else if (t.t === "node" && t.n.k === "unit") unit = { t: "Unit", c: unitName(t.n.slots[0]) };
      else if (t.t === "node" && t.n.k === "const") unit = { t: "Const", c: constName(t.n.slots[0]) };
      else throw new Unreadable();
    }
    if (this.peek().t === "sup") unit = bin("Pow", unit, this.slot((this.bump() as { n: Node }).n.slots[0], true));
    return unit;
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t === "op" && t.s === "!") {
        this.bump();
        e = { t: "Factorial", c: e };
      } else if (t.t === "index") {
        this.bump();
        e = { t: "Index", c: [e, args(t.n.slots[0], true)] };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.t) {
      case "num": {
        this.bump();
        const num: Expr = { t: "Num", c: t.s };
        return this.unitNext() && !this.exponent ? bin("Juxt", num, this.unitTerm()) : num;
      }
      case "name": {
        this.bump();
        const next = this.peek();
        if (this.isParen(next)) {
          this.bump();
          const paren = (next as { n: Node }).n;
          return { t: "Call", c: [t.s, args(paren.slots[0], !!paren.ghost)] };
        }
        return this.quotedUnitAfter({ t: "Ident", c: t.s });
      }
      case "hole":
        this.bump();
        return HOLE;
      case "node":
        this.bump();
        return this.node(t.n);
      default:
        // a value not typed yet, at the end or before an operator: an empty slot
        return HOLE;
    }
  }

  /** `x '°C`, `(-20) '°C`: a quoted unit after a name or brackets applies to it. */
  private quotedUnitAfter(e: Expr): Expr {
    const t = this.peek();
    return t.t === "node" && t.n.k === "unit" && !this.exponent ? bin("Juxt", e, this.unitTerm()) : e;
  }

  private node(n: Node): Expr {
    const s = n.slots;
    switch (n.k) {
      case "paren": {
        const paren: Expr = { t: "Paren", c: parseRow(s[0], false) };
        // `10^(-4) m^3`: in an exponent, the unit after brackets is the power's
        return this.exponent ? paren : this.quotedUnitAfter(paren);
      }
      case "matrix": {
        const cols = n.cols ?? 1;
        const rows: Expr[][] = [];
        for (let r = 0; r * cols < s.length; r++) rows.push(s.slice(r * cols, r * cols + cols).map((c) => slot(c)));
        const m: Expr = { t: "Matrix", c: rows };
        const t = this.peek();
        const unit =
          ((t.t === "name" && !this.isParen(this.peek(1)) && this.peek(1).t !== "index") ||
            (t.t === "node" && t.n.k === "unit")) &&
          !this.exponent;
        return unit ? bin("Juxt", m, this.unitTerm()) : m;
      }
      case "frac":
        return bin("Div", slot(s[0]), slot(s[1]));
      case "sqrt":
      case "abs":
        return { t: "Call", c: [n.k, [slot(s[0])]] };
      case "root":
        return { t: "Call", c: ["root", [slot(s[0]), slot(s[1])]] };
      case "big":
        return { t: "Call", c: [n.name ?? "", s.map((r) => slot(r))] };
      case "str":
        return { t: "Str", c: rowText(s[0]) };
      case "unit":
        return { t: "Unit", c: unitName(s[0]) };
      case "const":
        return this.quotedUnitAfter({ t: "Const", c: constName(s[0]) });
      default:
        throw new Unreadable();
    }
  }

  /** A slot of a superscript: read in the exponent, where values take no units. */
  private slot(r: Row, exponent: boolean): Expr {
    return slot(r, exponent);
  }
}

/** A row read as one expression; an empty row is an empty slot. */
function parseRow(r: Row, exponent: boolean): Expr {
  return new Parser(lex(r.atoms), exponent).all();
}

/** A structure's slot: its brackets, when it keeps the ones typed around it (`x^(2)`), are put back. */
function slot(r: Row, exponent = false): Expr {
  const e = parseRow(r, exponent);
  return r.kept ? { t: "Paren", c: e } : e;
}

/**
 * A call's or an index's arguments: the row split at its commas. Empty brackets are a call with
 * no arguments (`f()`) once closed, and an empty slot while their `)` is still to come (`f(□`).
 */
function args(r: Row, open: boolean): Expr[] {
  if (!r.atoms.length) return open ? [HOLE] : [];
  const parts: Atom[][] = [[]];
  for (const a of r.atoms) {
    if (glyph(a) === ",") parts.push([]);
    else parts[parts.length - 1].push(a);
  }
  return parts.map((atoms) => new Parser(lex(atoms), false).all());
}

/** What a row says, as the engine would parse it; null when it doesn't read as an expression. */
export function rowExpr(r: Row, exponent = false): Expr | null {
  try {
    return slot(r, exponent);
  } catch (e) {
    if (e instanceof Unreadable) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Expressions as text: a port of crates/quire-ast/src/printer.rs
// ---------------------------------------------------------------------------

const P_ADDITIVE = 6;
const P_MULTIPLICATIVE = 7;
const P_UNARY = 8;
const P_POWER = 10;
const P_POSTFIX = 11;

const isQuantity = (e: Expr) => e.t === "Binary" && e.c[0] === "Juxt";

function level(op: BinaryOp): number {
  switch (op) {
    case "Or":
      return 1;
    case "And":
      return 2;
    case "Add":
    case "Sub":
    case "PlusMinus":
      return P_ADDITIVE;
    case "Mul":
    case "Div":
    case "Mod":
      return P_MULTIPLICATIVE;
    case "Pow":
      return P_POWER;
    case "Juxt":
      return 9;
  }
}

/** How tightly `e` binds as printed, loosest 0 (printer.rs `prec`). */
export function prec(e: Expr): number {
  if (e.t === "Define") return 0;
  if (e.t === "Unary" && e.c[0] === "Not") return 3;
  if (e.t === "Compare") return 4;
  if (e.t === "Range") return 5;
  if (isQuantity(e)) return 9;
  if (e.t === "Binary") return level(e.c[0]);
  if (e.t === "Unary") return P_UNARY;
  if (e.t === "Factorial" || e.t === "Index") return P_POSTFIX;
  return 12;
}

/** Printed without brackets, `e` would end in a unit taken by a value (`2 m`, `-4 'm`). */
export function endsInQuantity(e: Expr): boolean {
  return e.t === "Unary" && e.c[0] !== "Not" ? endsInQuantity(e.c[1]) : isQuantity(e);
}

/** Whether the slots that draw no brackets need them in the text (`(a + b)/2`, `x^(2 m)`). */
export const NEEDS_BRACKETS = {
  numerator: (e: Expr) => prec(e) < P_MULTIPLICATIVE,
  denominator: (e: Expr) => prec(e) < P_MULTIPLICATIVE + 1,
  exponent: (e: Expr) => prec(e) < P_UNARY || endsInQuantity(e),
};

/** A JSON-compatible string literal (printer.rs `quote_str`). */
export function quoteStr(s: string): string {
  let out = '"';
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return `${out}"`;
}

const UNARY_SYMBOL: Record<UnaryOp, string> = { Neg: "-", Pos: "+", PlusMinus: "±", Not: "not " };
const BINARY_SYMBOL: Record<BinaryOp, string> = {
  Or: "or",
  And: "and",
  Add: "+",
  Sub: "-",
  PlusMinus: "±",
  Mul: "*",
  Div: "/",
  Mod: "%",
  Pow: "^",
  Juxt: " ",
};
const CMP_SYMBOL: Record<CmpOp, string> = { Eq: "==", Ne: "≠", Lt: "<", Le: "≤", Gt: ">", Ge: "≥" };

/** `e` in canonical linear syntax (printer.rs `print`). */
export function print(e: Expr): string {
  const out: string[] = [];
  write(out, e);
  return out.join("");
}

function child(out: string[], e: Expr, min: number) {
  if (prec(e) < min) {
    out.push("(");
    write(out, e);
    out.push(")");
  } else write(out, e);
}

function list(out: string[], xs: Expr[]) {
  xs.forEach((x, i) => {
    if (i > 0) out.push(", ");
    write(out, x);
  });
}

function write(out: string[], e: Expr) {
  switch (e.t) {
    case "Num":
    case "Ident":
      out.push(e.c);
      return;
    case "Unit":
      out.push(`'${e.c}`);
      return;
    case "Const":
      out.push(`#${e.c}`);
      return;
    case "Str":
      out.push(quoteStr(e.c));
      return;
    case "Placeholder":
      out.push("?");
      return;
    case "Paren":
      out.push("(");
      write(out, e.c);
      out.push(")");
      return;
    case "Unary": {
      const [op, x] = e.c;
      out.push(UNARY_SYMBOL[op]);
      child(out, x, op === "Not" ? 3 : P_UNARY);
      return;
    }
    case "Factorial":
      child(out, e.c, P_POSTFIX);
      out.push("!");
      return;
    case "Binary": {
      const [op, a, b] = e.c;
      if (op === "Juxt") {
        write(out, a);
        out.push(" ");
        write(out, b);
        return;
      }
      if (op === "Pow") {
        child(out, a, P_POSTFIX);
        out.push("^");
        if (endsInQuantity(b)) {
          out.push("(");
          write(out, b);
          out.push(")");
        } else child(out, b, P_UNARY);
        return;
      }
      const p = level(op);
      child(out, a, p);
      out.push(op === "Mul" || op === "Div" ? BINARY_SYMBOL[op] : ` ${BINARY_SYMBOL[op]} `);
      child(out, b, p + 1);
      return;
    }
    case "Compare": {
      const [first, rest] = e.c;
      child(out, first, 5);
      for (const [op, x] of rest) {
        out.push(` ${CMP_SYMBOL[op]} `);
        child(out, x, 5);
      }
      return;
    }
    case "Call":
      out.push(e.c[0], "(");
      list(out, e.c[1]);
      out.push(")");
      return;
    case "Index":
      child(out, e.c[0], P_POSTFIX);
      out.push("[");
      list(out, e.c[1]);
      out.push("]");
      return;
    case "Matrix": {
      const rows = e.c;
      const cells = rows.length * (rows[0]?.length ?? 0);
      const printed = rows.map((r) => r.map(print).join(", "));
      if (cells <= 6) out.push("[", printed.join("; "), "]");
      else out.push("[\n", printed.map((r) => `  ${r}`).join(";\n"), "\n]");
      return;
    }
    case "Range":
      child(out, e.c[0], P_ADDITIVE);
      out.push("..");
      child(out, e.c[1], P_ADDITIVE);
      return;
    case "Define":
      child(out, e.c.lhs, 1);
      out.push(e.c.global ? " ≡ " : " := ");
      write(out, e.c.rhs);
      return;
  }
}

// ---------------------------------------------------------------------------
// A row that doesn't read as an expression, written as it stands
// ---------------------------------------------------------------------------

/** The characters of a row that doesn't parse (`a + * b`), so the engine can say what is wrong. */
export function rawText(r: Row): string {
  return r.atoms
    .map((a): string => {
      if (a.k === "g") {
        if (a.s === " ") return " ";
        if (OPS.has(a.s) && a.s !== "!")
          return a.s === "*" || a.s === "," ? `${a.s}${a.s === "," ? " " : ""}` : ` ${a.s} `;
        return a.s;
      }
      const s = a.slots;
      switch (a.k) {
        case "frac":
          return `(${rawText(s[0])})/(${rawText(s[1])})`;
        case "sup":
          return `^(${rawText(s[0])})`;
        case "sub":
          return `.${rawText(s[0])}`;
        case "paren":
          return `(${rawText(s[0])})`;
        case "index":
          return `[${rawText(s[0])}]`;
        case "matrix": {
          const cols = a.cols ?? 1;
          const rows: string[] = [];
          for (let k = 0; k < s.length; k += cols)
            rows.push(
              s
                .slice(k, k + cols)
                .map(rawText)
                .join(", "),
            );
          return `[${rows.join("; ")}]`;
        }
        case "sqrt":
        case "abs":
          return `${a.k}(${rawText(s[0])})`;
        case "root":
          return `root(${rawText(s[0])}, ${rawText(s[1])})`;
        case "big":
          return `${a.name}(${s.map(rawText).join(", ")})`;
        case "str":
          return quoteStr(rowText(s[0]));
        case "unit":
          return ` '${unitName(s[0])}`;
        case "const":
          return `#${constName(s[0])}`;
        case "cmd":
          return `\\${rowText(s[0])}`;
      }
      return "";
    })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** A row in linear syntax: canonical when it reads as an expression, as it stands when not. */
export function rowLinear(r: Row): string {
  const e = rowExpr(r);
  return e ? print(e) : rawText(r);
}
