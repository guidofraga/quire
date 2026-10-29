// AST → LaTeX, for Copy as LaTeX (papers, Word's equation editor, Overleaf).
import { SYMBOLS } from "./symbols";
import type { BinaryOp, CmpOp, Expr } from "./types";

const GREEK = new Map(SYMBOLS.filter((c) => c.id === "greek" || c.id === "Greek").flatMap((c) => c.items.map((s) => [s.insert, s.name])));
const FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth", "ln", "log", "lg", "exp", "det", "max", "min"]);

let units: ReadonlySet<string> = new Set();

const greek = (s: string) => [...s].map((ch) => (GREEK.has(ch) ? `\\${GREEK.get(ch)} ` : ch)).join("").trim();
const word = (s: string, upright = false) => {
  const g = greek(s);
  if (g !== s) return g;
  if (upright) return `\\mathrm{${s}}`;
  return [...s].length > 1 ? `\\mathit{${s}}` : s;
};

function ident(name: string): string {
  if (units.has(name)) return `\\mathrm{${greek(name)}}`;
  if (name === "∞") return "\\infty";
  const dot = name.indexOf(".");
  if (dot <= 0 || dot === name.length - 1) return word(name);
  const sub = name.slice(dot + 1);
  return `${word(name.slice(0, dot))}_{${word(sub, [...sub].length > 1)}}`;
}

const isUnitTerm = (e: Expr): boolean =>
  e.t === "Unit" || (e.t === "Ident" && units.has(e.c)) || (e.t === "Binary" && e.c[0] === "Pow" && isUnitTerm(e.c[1]));
const unparen = (e: Expr): Expr => (e.t === "Paren" ? e.c : e);
const BIN: Partial<Record<BinaryOp, string>> = { Add: "+", Sub: "-", PlusMinus: "\\pm", Mod: "\\bmod", And: "\\land", Or: "\\lor" };
const CMP: Record<CmpOp, string> = { Eq: "=", Ne: "\\neq", Lt: "<", Le: "\\le", Gt: ">", Ge: "\\ge" };
const d = "\\mathrm{d}";

function call(name: string, args: Expr[]): string {
  const [x, y, z, w] = args.map((a) => t(unparen(a)));
  switch (`${name}/${args.length}`) {
    case "sqrt/1":
      return `\\sqrt{${x}}`;
    case "root/2":
      return `\\sqrt[${y}]{${x}}`;
    case "abs/1":
      return `\\left|${x}\\right|`;
    case "sum/4":
      return `\\sum_{${y}=${z}}^{${w}} ${x}`;
    case "prod/4":
    case "product/4":
      return `\\prod_{${y}=${z}}^{${w}} ${x}`;
    case "int/4":
      return `\\int_{${z}}^{${w}} ${x}\\,${d}${y}`;
    case "int/2":
      return `\\int ${x}\\,${d}${y}`;
    case "diff/2":
      return `\\frac{${d}}{${d}${y}} ${x}`;
    case "diff/3":
      return `\\frac{${d}^{${z}}}{${d}${y}^{${z}}} ${x}`;
    case "lim/3":
    case "limit/3":
      return `\\lim_{${y}\\to ${z}} ${x}`;
    case "series/4":
    case "taylor/4":
      return `\\operatorname{${name}}\\left(${x};\\; ${y} = ${z},\\; ${w}\\right)`;
    case "subs/3":
    case "substitute/3":
      return `\\left.${x}\\right|_{${y} = ${z}}`;
  }
  // the sample/population spellings read as stdev_s, var_p
  const variant = /^(stdev|var)\.([sp])$/.exec(name);
  if (variant) return `\\operatorname{${variant[1]}}_{\\mathrm{${variant[2]}}}\\left(${args.map(t).join(", ")}\\right)`;
  const head = FUNCS.has(name) ? `\\${name}` : name.length > 1 && !name.includes(".") ? `\\operatorname{${name}}` : ident(name);
  return `${head}\\left(${args.map(t).join(", ")}\\right)`;
}

function binary(op: BinaryOp, a: Expr, b: Expr): string {
  switch (op) {
    case "Juxt":
      return `${t(a)}\\,${t(b)}`;
    case "Mul":
      return isUnitTerm(b) ? `${t(a)}\\,${t(b)}` : `${t(a)} \\cdot ${t(b)}`;
    case "Div":
      return `\\frac{${t(unparen(a))}}{${t(unparen(b))}}`;
    case "Pow":
      return `{${t(a)}}^{${t(unparen(b))}}`;
    default:
      return `${t(a)} ${BIN[op] ?? op} ${t(b)}`;
  }
}

function t(e: Expr): string {
  switch (e.t) {
    case "Num":
      return e.c;
    case "Ident":
      return ident(e.c);
    case "Unit":
      return `\\mathrm{${greek(e.c)}}`;
    case "Str":
      return `\\text{“${e.c}”}`;
    case "Placeholder":
      return "\\square";
    case "Paren":
      return `\\left(${t(e.c)}\\right)`;
    case "Unary": {
      const [op, x] = e.c;
      return `${{ Neg: "-", Pos: "+", PlusMinus: "\\pm ", Not: "\\lnot " }[op]}${t(x)}`;
    }
    case "Factorial":
      return `${t(e.c)}!`;
    case "Binary":
      return binary(...e.c);
    case "Compare":
      return [t(e.c[0]), ...e.c[1].map(([op, x]) => `${CMP[op]} ${t(x)}`)].join(" ");
    case "Call":
      return call(...e.c);
    case "Index":
      return `${t(e.c[0])}_{${e.c[1].map(t).join(",")}}`;
    case "Matrix":
      return `\\begin{bmatrix} ${e.c.map((r) => r.map(t).join(" & ")).join(" \\\\ ")} \\end{bmatrix}`;
    case "Range":
      return `${t(e.c[0])} .. ${t(e.c[1])}`;
    case "Define":
      return `${t(e.c.lhs)} ${e.c.global ? "\\equiv" : ":="} ${t(e.c.rhs)}`;
  }
}

/** `input = result` as LaTeX math (no surrounding `$`). */
export function latex(input: Expr, result: Expr | null, unitNames: readonly string[] = []): string {
  units = new Set(unitNames);
  const out = t(input) + (result ? ` = ${t(result)}` : "");
  units = new Set();
  return out;
}
