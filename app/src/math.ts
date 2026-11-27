// AST → MathML, rendered with the bundled QuireMath (STIX Two Math) font so
// fractions, radicals, stretchy fences and matrices read directly in WebKit and
// Chromium and copy/speak cleanly; see docs/01-architecture.md §3.
import { type Brackets, numberParens } from "./brackets";
import { ifInRows, isIfArgs, SEQ, type Span } from "./mathLinear";
import { prefs } from "./settings";
import { state } from "./store";
import type { BinaryOp, CmpOp, Expr } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mo = (s: string, attrs = "") => `<mo${attrs}>${esc(s)}</mo>`;
const row = (...xs: string[]) => `<mrow>${xs.join("")}</mrow>`;
const space = (em: number, attrs = "") => `<mspace width="${em}em"${attrs}></mspace>`;
/**
 * Brackets around a whole slot (a numerator, an exponent) are the slot's, not drawn. While a
 * formula is edited in place, brackets typed into a slot the caret is still in are drawn: what
 * follows their `)` may still apply to them (docs/07-math-editing.md).
 */
const unparen = (e: Expr): Expr => (e.t === "Paren" && trace?.get(e)?.node?.k !== "paren" ? e.c : e);

// ---------------------------------------------------------------------------
// The formula being edited in place (#165): each part drawn with where it comes from in the
// edit tree, so the editor finds the caret's place on the page. Drawn exactly as the stored
// formula is drawn, with `data-*` attributes added and nothing else.
// ---------------------------------------------------------------------------

/** While drawing the formula being edited: where each expression comes from (mathLinear `traceRow`). */
let trace: Map<Expr, Span> | null = null;

const attr = (name: string, v: string | number) => ` data-${name}="${esc(String(v))}"`;

/** The `k`th operator glyph `e` draws: its row and atom. */
function op_(e: Expr, k = 0): string {
  const s = trace?.get(e);
  const at = s?.ops?.[k];
  return s && at !== undefined ? attr("r", s.row) + attr("a", at) + attr("n", 1) : "";
}

/** `html` (one element) with attributes added to its first tag. */
const withAttrs = (html: string, attrs: string) => (attrs ? html.replace(/^<([a-z]+)/, `<$1${attrs}`) : html);

/** A name or number drawn from atoms `[from, to)` of a row; a name's subscript is its own row. */
function leaf(e: Expr, html: string): string {
  const s = trace?.get(e);
  if (!s || s.from === undefined) return html;
  let out = withAttrs(html, attr("r", s.row) + attr("a", s.from) + attr("n", (s.to ?? s.from) - s.from));
  const sub = s.sub;
  if (sub) {
    const r = sub.slots[0];
    const tags = attr("r", r.id) + attr("a", 0) + attr("n", r.atoms.length) + attr("node", sub.id);
    // `A.` with its subscript still to come: an empty slot under the name
    if (!r.atoms.length || !/<\/mi><mi/.test(out))
      out = `<msub>${out}<mi class="ph"${attr("r", r.id) + attr("hole", 0) + attr("node", sub.id)}>□</mi></msub>`;
    else out = out.replace(/<\/mi><mi/, `</mi><mi${tags}`);
  }
  return out;
}

/** What an expression's root element is in the edit tree: a structure, an empty slot, a name. */
function tagged(e: Expr, html: string): string {
  const s = trace?.get(e);
  if (!s) return html;
  if (s.hole !== undefined) return withAttrs(html, attr("r", s.row) + attr("hole", s.hole));
  const n = s.node;
  switch (e.t) {
    case "Num":
    case "Ident":
    case "Unit":
    case "Const":
    case "Str": {
      const out = leaf(e, html);
      return n ? withAttrs(out, attr("node", n.id)) : out;
    }
  }
  if (!n) return html;
  // a superscript or an index: the script is the structure's box
  if (n.k === "sup" || n.k === "index") return withAttrs(html, attr("script", n.id));
  // a call's brackets, and brackets typed: marked on the brackets themselves (`paren`)
  if (n.k === "paren") return html;
  return withAttrs(html, attr("node", n.id));
}

/** The brackets of `e`, typed in the edit tree: marked for the caret, and faint until their `)` is typed. */
function parens(e: Expr): [string, string] {
  const n = trace?.get(e)?.node;
  if (n?.k !== "paren") return ["", ""];
  return [attr("open", n.id), attr("close", n.id) + (n.ghost ? ' class="ghost"' : "")];
}

/** `A.net` → A with literal subscript net (SMath convention). */
function identParts(name: string): [string, string | null] {
  const dot = name.indexOf(".");
  return dot > 0 && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, null];
}

function mi(text: string, upright = false) {
  return upright ? `<mi mathvariant="normal">${esc(text)}</mi>` : `<mi>${esc(text)}</mi>`;
}

/** Names that resolved to units / constants in the region being rendered. */
let unitNames: ReadonlySet<string> = new Set();
let constantNames: ReadonlySet<string> = new Set();

/**
 * Faint marks on names that may not mean what was meant, each with its explanation as a hover
 * title: the name a definition gives a new meaning to (`T := 300` hides the unit tesla), and
 * names read as units where a variable is usual (`M/W` with no `W` defined).
 */
export interface NameMarks {
  defines?: { name: string; title: string };
  units?: ReadonlyMap<string, string>;
}
let marks: NameMarks = {};

const markAttrs = (cls: string, title: string) => ` class="${cls}" title="${esc(title)}"`;

/** A built-in constant: a plain name that resolved to one, or `#G`. Upright, in its own ink. */
function constant(name: string): string {
  const [base, sub] = identParts(name);
  const k = ` class="k" data-k="constant:${esc(name)}"`;
  return sub === null
    ? `<mi${k} mathvariant="normal">${esc(base)}</mi>`
    : `<msub${k}>${mi(base, true)}${mi(sub, true)}</msub>`;
}

function ident(name: string): string {
  if (unitNames.has(name)) {
    const note = marks.units?.get(name);
    const cls = note ? markAttrs("u asunit", note) : ` class="u"`;
    return `<mi${cls} mathvariant="normal" data-k="unit:${esc(name)}">${esc(name)}</mi>`;
  }
  if (constantNames.has(name)) return constant(name);
  // data-v: the name, for tracing where a variable is defined and used
  const [base, sub] = identParts(name);
  const v = ` data-v="${esc(name)}"`;
  return sub === null ? `<mi${v}>${esc(base)}</mi>` : `<msub${v}>${mi(base)}${mi(sub, sub.length === 1)}</msub>`;
}

const unit = (name: string) => `<mi class="u" mathvariant="normal">${esc(name)}</mi>`;

function isUnitTerm(e: Expr): boolean {
  const isUnit = (x: Expr) => x.t === "Unit" || (x.t === "Ident" && unitNames.has(x.c));
  return isUnit(e) || (e.t === "Binary" && e.c[0] === "Pow" && isUnit(e.c[1]));
}

/** Units alone: `km`, `s^2`, `kN*m`, `(kg*m)`. */
function unitsOnly(e: Expr): boolean {
  switch (e.t) {
    case "Unit":
      return true;
    case "Ident":
      return unitNames.has(e.c);
    case "Paren":
      return unitsOnly(e.c);
    case "Binary": {
      const [op, a, b] = e.c;
      if (op === "Pow") return unitsOnly(a) && b.t === "Num";
      return (op === "Mul" || op === "Juxt" || op === "Div") && unitsOnly(a) && unitsOnly(b);
    }
    default:
      return false;
  }
}

/** A quantity's value side: `80 km`, `5`, `kN`. */
function quantity(e: Expr): boolean {
  if (e.t === "Num" || unitsOnly(e)) return true;
  return e.t === "Binary" && (e.c[0] === "Mul" || e.c[0] === "Juxt") && e.c[1].t === "Num" && unitsOnly(e.c[2]);
}

const tight = (s: string, attrs = "") => mo(s, ` lspace="0" rspace="0"${attrs}`);

/** Units written tight, products with a dot: `(m·s)`, `s²`. */
function unitRow(e: Expr): string {
  if (e.t === "Paren")
    return row(
      mo("(", ' lspace="0" rspace="0" stretchy="false"'),
      unitRow(e.c),
      mo(")", ' lspace="0" rspace="0" stretchy="false"'),
    );
  if (e.t === "Binary" && (e.c[0] === "Mul" || e.c[0] === "Juxt"))
    return row(unitRow(e.c[1]), tight("·"), unitRow(e.c[2]));
  if (e.t === "Binary" && e.c[0] === "Div") return row(unitRow(e.c[1]), tight("/"), unitRow(e.c[2]));
  return m(e);
}

/** `80 km/h` on one line rather than as a fraction (Settings ▸ Appearance). */
const flatUnits = (a: Expr, b: Expr) => prefs.flatUnits && unitsOnly(b) && quantity(a);

const BIN: Partial<Record<BinaryOp, string>> = { Add: "+", Sub: "−", PlusMinus: "±", Mod: "mod", And: "∧", Or: "∨" };
const CMP: Record<CmpOp, string> = { Eq: "=", Ne: "≠", Lt: "<", Le: "≤", Gt: ">", Ge: "≥" };

function binary(op: BinaryOp, a: Expr, b: Expr, at = ""): string {
  switch (op) {
    case "Juxt":
      return row(m(a), space(0.2), m(b));
    case "Mul":
      // a `\name` being typed sits where it is typed, with no dot before it
      if (b.t === "Ident" && b.c.startsWith("\\")) return row(m(a), m(b));
      // a unit after a unit is a compound unit (54 kN·m), as in the unit lists and plots
      if (isUnitTerm(b) && a.t !== "Num" && quantity(a)) return row(m(a), tight("·", at), m(b));
      // numbers and units sit side by side (5.1 m, 2·900 kgf); everything else gets a dot
      return isUnitTerm(b) ? row(m(a), space(0.2, at), m(b)) : row(m(a), mo("·", at), m(b));
    case "Div":
      if (flatUnits(a, b)) return row(m(a), tight("/"), unitRow(b));
      return `<mfrac>${m(unparen(a))}${m(unparen(b))}</mfrac>`;
    case "Pow": {
      const exp = m(unparen(b));
      if (a.t === "Ident") {
        const [base, sub] = identParts(a.c);
        if (sub !== null) {
          // the name with its subscript (tagged as `leaf` tags a name), and the exponent over it
          const name = leaf(a, `<msub>${mi(base)}${mi(sub, sub.length === 1)}</msub>`);
          return name.replace(/^<msub/, "<msubsup").replace(/<\/msub>$/, `${exp}</msubsup>`);
        }
      }
      return `<msup>${m(a)}${exp}</msup>`;
    }
    default:
      return row(m(a), mo(BIN[op] ?? op, at), m(b));
  }
}

/** Arguments with their commas: `a, b`. */
const list = (e: Expr, xs: Expr[]) => xs.map((x, k) => (k ? mo(",", op_(e, k - 1)) : "") + m(x)).join("");

const d = mi("d", true);

// SMath's program constructs stand on rows of their own, every one alike: a column of lines
// with a rule down its left, as in Mathcad. A block's lines are its statements; an `if` or a
// loop puts its body one step in. An `if` is drawn so when it is a chain (`if … else if …
// else`, #175) or holds a program (mathLinear `ifInRows`), and as a statement; a single
// `if(c, a, b)` with plain values stays on one line. A program is centred on the line it sits
// in (MathML's default for a table), so `f(x) :=` and `= result` sit at its middle, whatever
// its kind.

const keyword = (word: string) => `<mtext class="kw">${word}</mtext>`;
const mtr = (html: string) => `<mtr><mtd>${html}</mtd></mtr>`;
/** A line of a program: its cell carries the rule down the program's left (`.q-body`). */
const line = (html: string) => `<mtr><mtd class="q-body">${html}</mtd></mtr>`;
const indented = (html: string) => line(row(space(1.5), html));
/** Rows stacked and left-aligned, centred on the line they sit in. */
const column = (cls: string, rows: string) => `<mtable class="${cls}" columnalign="left">${rows}</mtable>`;
/** A program's lines: rows that touch, so the rule down their left is unbroken. */
const lines = (cls: string, rows: string) =>
  `<mtable class="${cls}" columnalign="left" rowspacing="0">${rows}</mtable>`;

/** A block: one line per statement. */
function program(args: Expr[]): string {
  return lines("q-program", args.map((s) => line(stmt(s))).join(""));
}

/** A statement of a block: an `if` is drawn in rows even with plain values, anything else as usual. */
function stmt(e: Expr): string {
  return e.t === "Call" && e.c[0] === "if" && isIfArgs(e.c[1]) ? tagged(e, ifColumn(e.c[1])) : m(e);
}

/** `if c` / value, then `else if c2` / value for each `if` nested in the else, then `else` / value. */
function ifColumn(args: Expr[]): string {
  let rows = "";
  for (let a = args, word = "if"; ; word = "else if") {
    const [c, v, other] = a;
    rows += line(row(keyword(word), space(0.3), m(c))) + indented(stmt(v));
    if (!other) break;
    if (other.t === "Call" && other.c[0] === "if" && isIfArgs(other.c[1])) {
      a = other.c[1];
      continue;
    }
    rows += line(keyword("else")) + indented(stmt(other));
    break;
  }
  return lines("q-stack", rows);
}

/** `for(i, range, body)`, `for(init, cond, step, body)` and `while(cond, body)`. */
function loop(name: string, args: Expr[]): string {
  const [a, b, c] = args;
  const head =
    name === "while"
      ? row(keyword("while"), space(0.3), m(a))
      : args.length === 3
        ? row(keyword("for"), space(0.3), m(a), mo("∈"), m(b))
        : row(keyword("for"), space(0.3), m(a), mo(","), m(b), mo(","), m(c));
  return lines("q-stack", line(head) + indented(stmt(args[args.length - 1])));
}

/** `sys(e1, …, en, rows, cols)`: the elements in a column under a brace; rows and cols are not shown. */
function system(args: Expr[]): string {
  const rows = args
    .slice(0, -2)
    .map((e) => mtr(m(e)))
    .join("");
  return row(mo("{", ' stretchy="true"'), column("q-sys", rows));
}

function call(name: string, args: Expr[], e?: Expr): string {
  // a row being edited that doesn't read as one expression: its parts as typed
  if (name === SEQ && e) {
    const seps = trace?.get(e)?.seps ?? [];
    const glyph = (s: string) => ({ "*": "·", "-": "−", ":=": "≔", "==": "=", and: "∧", or: "∨", not: "¬" })[s] ?? s;
    return row(...args.map((x, k) => (k ? mo(glyph(seps[k - 1] ?? ""), op_(e, k - 1)) : "") + m(x)));
  }
  if (name === "block") return program(args);
  if (name === "sys" && args.length >= 3) return system(args);
  if ((name === "for" && (args.length === 3 || args.length === 4)) || (name === "while" && args.length === 2)) {
    return loop(name, args);
  }
  if (name === "if" && ifInRows(args)) return ifColumn(args);
  const [x, y, z, w] = args;
  switch (`${name}/${args.length}`) {
    case "sqrt/1":
      return `<msqrt>${m(unparen(x))}</msqrt>`;
    case "root/2":
      return `<mroot>${m(unparen(x))}${m(y)}</mroot>`;
    case "abs/1":
      return row(mo("|"), m(unparen(x)), mo("|"));
    case "sum/4":
    case "prod/4":
    case "product/4": {
      const sym = name === "sum" ? "∑" : "∏";
      const under = row(m(y), mo("="), m(z));
      return row(`<munderover>${mo(sym, ' largeop="true" movablelimits="false"')}${under}${m(w)}</munderover>`, m(x));
    }
    case "int/4":
      return row(`<msubsup>${mo("∫", ' largeop="true"')}${m(z)}${m(w)}</msubsup>`, m(x), space(0.17), d, m(y));
    case "int/2":
      return row(mo("∫", ' largeop="true"'), m(x), space(0.17), d, m(y));
    case "diff/2":
      return row(`<mfrac>${d}${row(d, m(y))}</mfrac>`, m(x));
    case "diff/3":
      return row(`<mfrac><msup>${d}${m(z)}</msup>${row(d, `<msup>${m(y)}${m(z)}</msup>`)}</mfrac>`, m(x));
    case "lim/3":
    case "limit/3":
      return row(`<munder>${mi("lim", true)}${row(m(y), mo("→"), m(z))}</munder>`, m(x));
    case "series/4":
    case "taylor/4":
      return row(mi(name, true), mo("("), m(x), mo(";"), m(y), mo("="), m(z), mo(","), m(w), mo(")"));
    case "subs/3":
    case "substitute/3":
      return `<msub>${row(m(unparen(x)), mo("|", ' stretchy="true"'))}${row(m(y), mo("="), m(z))}</msub>`;
  }
  const [open, close] = e ? parens(e) : ["", ""];
  return row(
    e ? leaf(e, ident(name)) : ident(name),
    mo("(", open),
    e ? list(e, args) : args.map(m).join(mo(",")),
    mo(")", close),
  );
}

/** Document ▸ Results ▸ Group digits: a thin space every three digits, from five digits on. */
let grouping = false;

export function groupDigits(n: string): string {
  return n.replace(/^(-?)(\d{5,})/, (_, sign: string, int: string) => sign + int.replace(/\B(?=(\d{3})+$)/g, "\u2009"));
}

/**
 * The brackets of the line being typed: each pair numbered (`data-p`), for the highlight of the
 * pair at the caret, which follows the caret without drawing the math again (brackets.ts); and
 * a `)` not typed yet marked `ghost`.
 */
let parenMarks = new Map<Expr, { open?: string; close?: string }>();

function markParens(input: Expr, b: Brackets): Map<Expr, { open?: string; close?: string }> {
  const out = new Map<Expr, { open?: string; close?: string }>();
  const ids = numberParens(input);
  // the line and the tree must agree on the brackets, or none is marked rather than a wrong one
  if (!ids.size || ids.size !== b.count) return out;
  for (const [node, k] of ids)
    out.set(node, {
      open: ` data-p="${k}"`,
      close: ` data-p="${k}"${b.open.has(k) ? ' class="ghost"' : ""}`,
    });
  return out;
}

function m(e: Expr): string {
  return trace ? tagged(e, m0(e)) : m0(e);
}

function m0(e: Expr): string {
  switch (e.t) {
    case "Num":
      return `<mn>${esc(grouping ? groupDigits(e.c) : e.c)}</mn>`;
    case "Ident":
      return ident(e.c);
    case "Unit":
      return unit(e.c);
    case "Const":
      return constant(e.c);
    case "Str":
      // the quotes are text: pseudo-elements inside a MathML token stack as separate boxes
      return `<ms class="str">"${esc(e.c)}"</ms>`;
    case "Placeholder":
      return `<mi class="ph">□</mi>`;
    case "Paren": {
      // the pair at the caret is highlighted, a `)` not typed yet is faint (brackets.ts)
      const k = parenMarks.get(e);
      const [open, close] = parens(e);
      return row(mo("(", (k?.open ?? "") + open), m(e.c), mo(")", (k?.close ?? "") + close));
    }
    case "Unary": {
      const [op, x] = e.c;
      return row(mo({ Neg: "−", Pos: "+", PlusMinus: "±", Not: "¬" }[op], op_(e)), m(x));
    }
    case "Factorial":
      return row(m(e.c), mo("!", op_(e)));
    case "Binary":
      return binary(...e.c, op_(e));
    case "Compare":
      return row(
        m(e.c[0]),
        ...e.c[1].map(([cmp, x], k) => mo(CMP[cmp], (cmp === "Eq" ? ' class="beq"' : "") + op_(e, k)) + m(x)),
      );
    case "Call":
      return call(...e.c, e);
    case "Index":
      return `<msub>${m(e.c[0])}${row(list(e, e.c[1]))}</msub>`;
    case "Matrix": {
      const rows = e.c.map((r) => `<mtr>${r.map((c) => `<mtd>${m(c)}</mtd>`).join("")}</mtr>`).join("");
      return row(mo("["), `<mtable>${rows}</mtable>`, mo("]"));
    }
    case "Range":
      return row(m(e.c[0]), mo("..", op_(e)), m(e.c[1]));
    case "Define": {
      const op = mo(e.c.global ? "≡" : "≔", op_(e));
      const lhs = definedName(e.c.lhs);
      return row(lhs, op, m(e.c.rhs));
    }
  }
}

/** The left side of a definition; the name it gives a new meaning to is marked (only once). */
function definedName(lhs: Expr): string {
  const mark = marks.defines;
  if (!mark || lhs.t !== "Ident" || lhs.c !== mark.name) return m(lhs);
  marks = { ...marks, defines: undefined };
  const [base, sub] = identParts(lhs.c);
  const attrs = ` data-v="${esc(lhs.c)}"${markAttrs("redef", mark.title)}`;
  return tagged(
    lhs,
    sub === null ? `<mi${attrs}>${esc(base)}</mi>` : `<msub${attrs}>${mi(base)}${mi(sub, sub.length === 1)}</msub>`,
  );
}

/**
 * One `<math>` element for an input, optionally followed by `= result`. `pending`: the line asks
 * for a result it has none for (an error): `= □`, with the unit typed after it, drawn as while
 * the line is edited in place, so ending the edit moves nothing.
 */
export function mathml(
  input: Expr,
  result?: Expr | null,
  units: readonly string[] = [],
  constants: readonly string[] = [],
  symbolic = false,
  nameMarks: NameMarks = {},
  brackets?: Brackets,
  pending?: { unit: Expr | null },
): string {
  unitNames = new Set(units);
  constantNames = new Set(constants);
  marks = nameMarks;
  parenMarks = brackets ? markParens(input, brackets) : new Map();
  grouping = !!(state.doc.settings as { display?: { groupDigits?: boolean } } | undefined)?.display?.groupDigits;
  const parts = [m(input)];
  parenMarks = new Map();
  unitNames = new Set();
  constantNames = new Set();
  marks = {};
  const res = (html: string) => `<mrow class="res${symbolic ? " sym" : ""}">${html}</mrow>`;
  if (result) parts.push(mo(symbolic ? "→" : "="), res(m(result)));
  else if (pending) {
    const unit = !symbolic && pending.unit ? asUnits(pending.unit) : null;
    parts.push(mo(symbolic ? "→" : "="), res(unit ? row(EMPTY, space(0.2), m(unit)) : EMPTY));
  }
  return `<math>${row(...parts)}</math>`;
}

/** The □ of a result not there. */
const EMPTY = `<mi class="ph">□</mi>`;

/** A row of the edit tree as read for drawing (mathLinear `traceRow`), or markup drawn by hand. */
export type Piece = { expr: Expr; spans: Map<Expr, Span> } | string;

/**
 * The formula being edited in place (#165), drawn as `mathml` draws the stored formula, each
 * part tagged with where it is in the edit tree (`data-r` row and `data-a` atom, `data-node`,
 * `data-hole` for □): opening, typing and closing the edit never move it. After `=`, the result
 * the engine gave, or its number with the unit being typed (`unit`), drawn as units.
 */
export function editingMathml(opts: {
  main: Piece[];
  show: "value" | "symbolic" | null;
  result: Expr | null;
  unit: Piece | null;
  unitRow: string;
  units: readonly string[];
  constants: readonly string[];
  nameMarks: NameMarks;
}): string {
  const draw = (p: Piece) => {
    if (typeof p === "string") return p;
    trace = p.spans;
    try {
      return m(p.expr);
    } finally {
      trace = null;
    }
  };
  unitNames = new Set(opts.units);
  constantNames = new Set(opts.constants);
  marks = opts.nameMarks;
  parenMarks = new Map();
  grouping = !!(state.doc.settings as { display?: { groupDigits?: boolean } } | undefined)?.display?.groupDigits;
  const parts = [opts.main.length === 1 ? draw(opts.main[0]) : row(...opts.main.map(draw))];
  unitNames = new Set();
  constantNames = new Set();
  marks = {};
  if (opts.show) {
    const res = (html: string) =>
      `<mrow class="res${opts.show === "symbolic" ? " sym" : ""}"${attr("unitrow", opts.unitRow)}>${html}</mrow>`;
    const [value] = opts.result ? splitUnit(opts.result) : [null];
    const typed = opts.show === "value" && opts.unit && typeof opts.unit !== "string" ? opts.unit : null;
    if (typed) asUnits(typed.expr);
    parts.push(
      mo(opts.show === "symbolic" ? "→" : "="),
      typed
        ? res(value ? row(m(value), space(0.2), draw(typed)) : row(EMPTY, space(0.2), draw(typed)))
        : res(opts.result ? m(opts.result) : EMPTY),
    );
  }
  return `<math>${row(...parts)}</math>`;
}

/** A result's number and its unit: `12.5 kN·m` → 12.5 and kN·m. */
function splitUnit(e: Expr): [Expr, Expr | null] {
  if (e.t === "Unary" && e.c[0] === "Neg") {
    const [v, u] = splitUnit(e.c[1]);
    return u ? [{ t: "Unary", c: ["Neg", v] }, u] : [e, null];
  }
  if (e.t === "Num") return [e, null];
  // `1250 kN·cm` is ((1250 kN)·cm): the number is the leftmost value, the unit all the rest
  if (e.t === "Binary" && ["Juxt", "Mul", "Div"].includes(e.c[0]) && unitsOnly(e.c[2])) {
    const [v, u] = splitUnit(e.c[1]);
    if (v.t !== "Num" && !(v.t === "Unary" && v.c[1].t === "Num")) return [e, null];
    return [v, u ? { t: "Binary", c: [e.c[0], u, e.c[2]] } : e.c[2]];
  }
  return [e, null];
}

/** The names typed after `=` are units: drawn as the result's units are. Changes `e` in place. */
function asUnits(e: Expr): Expr {
  if (e.t === "Ident") (e as { t: string }).t = "Unit";
  else if (e.t === "Paren" || e.t === "Factorial") asUnits(e.c);
  else if (e.t === "Binary") {
    asUnits(e.c[1]);
    if (e.c[0] !== "Pow") asUnits(e.c[2]);
  } else if (e.t === "Unary") asUnits(e.c[1]);
  return e;
}

/** A name as the math draws it in its meaning: your variable italic, a unit or constant upright. */
export function nameHtml(name: string, kind: "variable" | "function" | "unit" | "constant"): string {
  if (kind === "unit") return `<math>${unit(name)}</math>`;
  if (kind === "constant") return `<math>${constant(name).replace(/ data-k="[^"]*"/, "")}</math>`;
  const [base, sub] = identParts(name);
  const token = sub === null ? `<mi>${esc(base)}</mi>` : `<msub>${mi(base)}${mi(sub, sub.length === 1)}</msub>`;
  return `<math>${token}</math>`;
}

/** A single cell (tables): strings as plain text, everything else as math. */
export function cellHtml(e: Expr): string {
  return e.t === "Str" ? `<span class="cell-text">${esc(e.c)}</span>` : `<math>${m(e)}</math>`;
}

export { esc };

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

/** A linear-syntax value as readable text: `9.80665 'm/'s^2` → `9.80665 m/s²`. */
export function prettyValue(v: string): string {
  const grouped = (state.doc.settings as { display?: { groupDigits?: boolean } } | undefined)?.display?.groupDigits;
  return (grouped ? v.replace(/(^|[^\d.])(\d{5,})/g, (_, pre: string, n: string) => pre + groupDigits(n)) : v)
    .replace(/'/g, "")
    .replace(/\*10\^(-?\d+)/g, (_, e: string) => `·10${[...e].map((c) => SUPERSCRIPT[c]).join("")}`)
    .replace(/\^\(?(-?\d+)\)?/g, (_, e: string) => [...e].map((c) => SUPERSCRIPT[c]).join(""))
    .replace(/\*/g, "·");
}
