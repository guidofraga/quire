// AST → MathML. WebKit and Chromium both implement MathML Core, which gives real
// fractions, radicals, stretchy fences and matrices. This is the interim renderer
// until the Rust typesetter (quire-layout) lands; see docs/01-architecture.md §3.
import { prefs } from "./settings";
import type { BinaryOp, CmpOp, Expr } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mo = (s: string, attrs = "") => `<mo${attrs}>${esc(s)}</mo>`;
const row = (...xs: string[]) => `<mrow>${xs.join("")}</mrow>`;
const space = (em: number) => `<mspace width="${em}em"></mspace>`;
const unparen = (e: Expr): Expr => (e.t === "Paren" ? e.c : e);

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

function ident(name: string): string {
  if (unitNames.has(name)) return `<mi class="u" mathvariant="normal" data-k="unit:${esc(name)}">${esc(name)}</mi>`;
  if (constantNames.has(name)) {
    const [base, sub] = identParts(name);
    const k = ` class="k" data-k="constant:${esc(name)}"`;
    return sub === null ? `<mi${k}>${esc(base)}</mi>` : `<msub${k}>${mi(base)}${mi(sub, true)}</msub>`;
  }
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

const tight = (s: string) => mo(s, ' lspace="0" rspace="0"');

/** Units written tight, products with a dot: `(m·s)`, `s²`. */
function unitRow(e: Expr): string {
  if (e.t === "Paren") return row(mo("(", ' lspace="0" rspace="0" stretchy="false"'), unitRow(e.c), mo(")", ' lspace="0" rspace="0" stretchy="false"'));
  if (e.t === "Binary" && (e.c[0] === "Mul" || e.c[0] === "Juxt")) return row(unitRow(e.c[1]), tight("·"), unitRow(e.c[2]));
  if (e.t === "Binary" && e.c[0] === "Div") return row(unitRow(e.c[1]), tight("/"), unitRow(e.c[2]));
  return m(e);
}

/** `80 km/h` on one line rather than as a fraction (Settings ▸ Appearance). */
const flatUnits = (a: Expr, b: Expr) => prefs.flatUnits && unitsOnly(b) && quantity(a);

const BIN: Partial<Record<BinaryOp, string>> = { Add: "+", Sub: "−", PlusMinus: "±", Mod: "mod", And: "∧", Or: "∨" };
const CMP: Record<CmpOp, string> = { Eq: "=", Ne: "≠", Lt: "<", Le: "≤", Gt: ">", Ge: "≥" };

function binary(op: BinaryOp, a: Expr, b: Expr): string {
  switch (op) {
    case "Juxt":
      return row(m(a), space(0.2), m(b));
    case "Mul":
      // numbers and units sit side by side (5.1 m, 2·900 kgf); everything else gets a dot
      return isUnitTerm(b) ? row(m(a), space(0.2), m(b)) : row(m(a), mo("·"), m(b));
    case "Div":
      if (flatUnits(a, b)) return row(m(a), tight("/"), unitRow(b));
      return `<mfrac>${m(unparen(a))}${m(unparen(b))}</mfrac>`;
    case "Pow": {
      const exp = m(unparen(b));
      if (a.t === "Ident") {
        const [base, sub] = identParts(a.c);
        if (sub !== null) return `<msubsup>${mi(base)}${mi(sub, sub.length === 1)}${exp}</msubsup>`;
      }
      return `<msup>${m(a)}${exp}</msup>`;
    }
    default:
      return row(m(a), mo(BIN[op] ?? op), m(b));
  }
}

const d = mi("d", true);

function call(name: string, args: Expr[]): string {
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
      return row(`<munder>${mi("lim", true)}${row(m(y), mo("→"), m(z))}</munder>`, m(x));
  }
  return row(ident(name), mo("("), args.map(m).join(mo(",")), mo(")"));
}

function m(e: Expr): string {
  switch (e.t) {
    case "Num":
      return `<mn>${esc(e.c)}</mn>`;
    case "Ident":
      return ident(e.c);
    case "Unit":
      return unit(e.c);
    case "Str":
      return `<ms class="str">${esc(e.c)}</ms>`;
    case "Placeholder":
      return `<mi class="ph">□</mi>`;
    case "Paren":
      return row(mo("("), m(e.c), mo(")"));
    case "Unary": {
      const [op, x] = e.c;
      return row(mo({ Neg: "−", Pos: "+", PlusMinus: "±", Not: "¬" }[op]), m(x));
    }
    case "Factorial":
      return row(m(e.c), mo("!"));
    case "Binary":
      return binary(...e.c);
    case "Compare":
      return row(m(e.c[0]), ...e.c[1].map(([op, x]) => mo(CMP[op], op === "Eq" ? ' class="beq"' : "") + m(x)));
    case "Call":
      return call(...e.c);
    case "Index":
      return `<msub>${m(e.c[0])}${row(e.c[1].map(m).join(mo(",")))}</msub>`;
    case "Matrix": {
      const rows = e.c.map((r) => `<mtr>${r.map((c) => `<mtd>${m(c)}</mtd>`).join("")}</mtr>`).join("");
      return row(mo("["), `<mtable>${rows}</mtable>`, mo("]"));
    }
    case "Range":
      return row(m(e.c[0]), mo(".."), m(e.c[1]));
    case "Define":
      return row(m(e.c.lhs), mo(e.c.global ? "≡" : "≔"), m(e.c.rhs));
  }
}

/** One `<math>` element for an input, optionally followed by `= result`. */
export function mathml(
  input: Expr,
  result?: Expr | null,
  units: readonly string[] = [],
  constants: readonly string[] = [],
  symbolic = false,
): string {
  unitNames = new Set(units);
  constantNames = new Set(constants);
  const parts = [m(input)];
  unitNames = new Set();
  constantNames = new Set();
  if (result) parts.push(mo(symbolic ? "→" : "="), `<mrow class="res${symbolic ? " sym" : ""}">${m(result)}</mrow>`);
  return `<math>${row(...parts)}</math>`;
}

/** A single cell (tables): strings as plain text, everything else as math. */
export function cellHtml(e: Expr): string {
  return e.t === "Str" ? `<span class="cell-text">${esc(e.c)}</span>` : `<math>${m(e)}</math>`;
}

export { esc };

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/** A linear-syntax value as readable text: `9.80665 'm/'s^2` → `9.80665 m/s²`. */
export function prettyValue(v: string): string {
  return v
    .replace(/'/g, "")
    .replace(/\*10\^(-?\d+)/g, (_, e: string) => `·10${[...e].map((c) => SUPERSCRIPT[c]).join("")}`)
    .replace(/\^\(?(-?\d+)\)?/g, (_, e: string) => [...e].map((c) => SUPERSCRIPT[c]).join(""))
    .replace(/\*/g, "·");
}
