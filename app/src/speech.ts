// Math in words, for screen readers: `M := q*L^2/8 =` reads "M is defined as q times
// L squared over 8, equals 54 kilonewton metres". The rendered MathML is hidden from
// assistive technology and this is read instead, so every engine reads it the same way.
import type { BinaryOp, CmpOp, Expr } from "./types";

const GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ϑ: "theta",
  ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", ο: "omicron", π: "pi", ρ: "rho", σ: "sigma", ς: "sigma",
  τ: "tau", υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
};

/** `σ.max` → "sigma max", `Δ` → "capital delta", `ħ` → "h bar". */
export function spokenName(name: string): string {
  const word = (s: string) =>
    [...s]
      .map((ch) => {
        if (GREEK[ch]) return ` ${GREEK[ch]} `;
        const lower = ch.toLowerCase();
        if (lower !== ch && GREEK[lower]) return ` capital ${GREEK[lower]} `;
        if (ch === "ħ") return " h bar ";
        if (ch === "_" || ch === ".") return " ";
        return ch;
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  return word(name);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Whole unit names: symbol → [singular, plural]. */
const UNIT_WORDS: Record<string, [string, string]> = {
  in: ["inch", "inches"],
  ft: ["foot", "feet"],
  yd: ["yard", "yards"],
  mi: ["mile", "miles"],
  lb: ["pound", "pounds"],
  lbf: ["pound-force", "pounds-force"],
  kip: ["kip", "kips"],
  ksi: ["ksi", "ksi"],
  psi: ["psi", "psi"],
  kgf: ["kilogram-force", "kilograms-force"],
  tf: ["tonne-force", "tonnes-force"],
  tonnef: ["tonne-force", "tonnes-force"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
  deg: ["degree", "degrees"],
  "°": ["degree", "degrees"],
  "°C": ["degree Celsius", "degrees Celsius"],
  "°F": ["degree Fahrenheit", "degrees Fahrenheit"],
  "Δ°C": ["degree Celsius difference", "degrees Celsius difference"],
  rad: ["radian", "radians"],
  mol: ["mole", "moles"],
  bar: ["bar", "bar"],
  atm: ["atmosphere", "atmospheres"],
  ha: ["hectare", "hectares"],
  "%": ["percent", "percent"],
};

/** Units that take SI prefixes: symbol → [singular, plural]. */
const SI_BASE: Record<string, [string, string]> = {
  m: ["metre", "metres"],
  g: ["gram", "grams"],
  s: ["second", "seconds"],
  t: ["tonne", "tonnes"],
  N: ["newton", "newtons"],
  Pa: ["pascal", "pascals"],
  J: ["joule", "joules"],
  W: ["watt", "watts"],
  Hz: ["hertz", "hertz"],
  V: ["volt", "volts"],
  A: ["ampere", "amperes"],
  Ω: ["ohm", "ohms"],
  K: ["kelvin", "kelvin"],
  L: ["litre", "litres"],
  l: ["litre", "litres"],
  C: ["coulomb", "coulombs"],
  F: ["farad", "farads"],
  Wh: ["watt hour", "watt hours"],
  cd: ["candela", "candelas"],
};

const PREFIX: Record<string, string> = {
  G: "giga",
  M: "mega",
  k: "kilo",
  h: "hecto",
  da: "deca",
  d: "deci",
  c: "centi",
  m: "milli",
  μ: "micro",
  µ: "micro",
  u: "micro",
  n: "nano",
  p: "pico",
  T: "tera",
};

/** `kN` → "kilonewton(s)"; an unknown symbol is read as it is. */
export function unitWord(symbol: string, plural = false): string {
  const pick = (w: [string, string]) => w[plural ? 1 : 0];
  if (UNIT_WORDS[symbol]) return pick(UNIT_WORDS[symbol]);
  if (SI_BASE[symbol]) return pick(SI_BASE[symbol]);
  for (const [p, word] of Object.entries(PREFIX)) {
    if (symbol.length > p.length && symbol.startsWith(p) && SI_BASE[symbol.slice(p.length)]) {
      return word + pick(SI_BASE[symbol.slice(p.length)]);
    }
  }
  return symbol;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

const CMP: Record<CmpOp, string> = {
  Eq: "is equal to",
  Ne: "is not equal to",
  Lt: "is less than",
  Le: "is less than or equal to",
  Gt: "is greater than",
  Ge: "is greater than or equal to",
};

const BIN: Partial<Record<BinaryOp, string>> = {
  Add: "plus",
  Sub: "minus",
  PlusMinus: "plus or minus",
  Mod: "mod",
  And: "and",
  Or: "or",
  Mul: "times",
};

interface Ctx {
  units: ReadonlySet<string>;
  constants: ReadonlySet<string>;
}

const unparen = (e: Expr): Expr => (e.t === "Paren" ? e.c : e);

function isUnit(e: Expr, cx: Ctx): boolean {
  return e.t === "Unit" || (e.t === "Ident" && cx.units.has(e.c));
}

/** Units alone: `kN*m`, `m/s^2`. */
function unitsOnly(e: Expr, cx: Ctx): boolean {
  if (isUnit(e, cx)) return true;
  if (e.t === "Paren") return unitsOnly(e.c, cx);
  if (e.t !== "Binary") return false;
  const [op, a, b] = e.c;
  if (op === "Pow") return unitsOnly(a, cx) && (b.t === "Num" || (b.t === "Unary" && b.c[1].t === "Num"));
  return (op === "Mul" || op === "Juxt" || op === "Div") && unitsOnly(a, cx) && unitsOnly(b, cx);
}

/** A number, maybe with units: `5`, `12 kN`. */
function quantity(e: Expr, cx: Ctx): boolean {
  if (e.t === "Num") return true;
  return e.t === "Binary" && (e.c[0] === "Mul" || e.c[0] === "Juxt") && e.c[1].t === "Num" && unitsOnly(e.c[2], cx);
}

function power(b: Expr, cx: Ctx): string {
  const n = unparen(b);
  if (n.t === "Num" && n.c === "2") return "squared";
  if (n.t === "Num" && n.c === "3") return "cubed";
  return `to the power ${say(n, cx)}`;
}

/** Units in words; `plural` makes the last unit of the numerator plural (54 kilonewton metres). */
function sayUnits(e: Expr, cx: Ctx, plural: boolean): string {
  switch (e.t) {
    case "Unit":
    case "Ident":
      return unitWord(e.c, plural);
    case "Paren":
      return sayUnits(e.c, cx, plural);
    case "Binary": {
      const [op, a, b] = e.c;
      if (op === "Pow") {
        const n = unparen(b);
        if (n.t === "Unary" && n.c[0] === "Neg") return `per ${sayUnits(a, cx, false)}${n.c[1].t === "Num" && n.c[1].c === "1" ? "" : ` ${power(n.c[1], cx)}`}`;
        return `${sayUnits(a, cx, plural)} ${power(b, cx)}`;
      }
      if (op === "Div") return `${sayUnits(a, cx, plural)} per ${sayUnits(b, cx, false)}`;
      return `${sayUnits(a, cx, false)} ${sayUnits(b, cx, plural)}`;
    }
    default:
      return say(e, cx);
  }
}

const isOne = (s: string) => /^[+-]?1(\.0*)?$/.test(s);

function sayNum(n: string): string {
  // 1.5*10^3 and 1.5e3 read as numbers, not letters
  return n.replace(/^-/, "minus ").replace(/e([+-]?\d+)$/i, (_, x: string) => ` times 10 to the ${x}`);
}

function binary(op: BinaryOp, a: Expr, b: Expr, cx: Ctx): string {
  switch (op) {
    case "Mul":
    case "Juxt":
      // a quantity: 54 kilonewton metres, also when written (54 kN)·m
      if (unitsOnly(b, cx) && a.t === "Binary" && (a.c[0] === "Mul" || a.c[0] === "Juxt") && a.c[1].t === "Num" && unitsOnly(a.c[2], cx))
        return binary("Juxt", a.c[1], { t: "Binary", c: ["Mul", a.c[2], b] }, cx);
      if (unitsOnly(b, cx) && !unitsOnly(a, cx)) return `${say(a, cx)} ${sayUnits(b, cx, !(a.t === "Num" && isOne(a.c)))}`;
      if (op === "Juxt") return `${say(a, cx)} ${say(b, cx)}`;
      return `${say(a, cx)} times ${say(b, cx)}`;
    case "Div":
      if (unitsOnly(a, cx) && unitsOnly(b, cx)) return sayUnits({ t: "Binary", c: [op, a, b] }, cx, true);
      // 12 kN/m, 9.81 m/s^2: "per", not a fraction
      if (unitsOnly(b, cx) && quantity(a, cx)) return `${say(a, cx)} per ${sayUnits(b, cx, false)}`;
      return `${say(a, cx)} over ${say(b, cx)}`;
    case "Pow":
      return `${say(a, cx)} ${power(b, cx)}`;
    default:
      return `${say(a, cx)} ${BIN[op] ?? op} ${say(b, cx)}`;
  }
}

function call(name: string, args: Expr[], cx: Ctx): string {
  // SMath's program constructs, read as the steps they are
  if (name === "block") return `block: ${args.map((e, i) => (i === 0 ? "first " : "") + say(e, cx)).join("; then ")}`;
  if (name === "if" && (args.length === 2 || args.length === 3)) {
    return `if ${say(args[0], cx)}, then ${say(args[1], cx)}${args.length === 3 ? `, otherwise ${say(args[2], cx)}` : ""}`;
  }
  if (name === "for" && args.length === 3) return `for each ${say(args[0], cx)} in ${say(args[1], cx)}, do ${say(args[2], cx)}`;
  if (name === "for" && args.length === 4) {
    return `for ${say(args[0], cx)}, while ${say(args[1], cx)}, step ${say(args[2], cx)}, do ${say(args[3], cx)}`;
  }
  if (name === "while" && args.length === 2) return `while ${say(args[0], cx)}, do ${say(args[1], cx)}`;
  if (name === "sys" && args.length >= 3) return `system of ${args.slice(0, -2).map((e) => say(e, cx)).join(", ")}`;
  const [x, y, z, w] = args.map((e) => say(unparen(e), cx));
  switch (`${name}/${args.length}`) {
    case "sqrt/1":
      return `square root of ${x}`;
    case "root/2":
      return `root ${y} of ${x}`;
    case "abs/1":
      return `absolute value of ${x}`;
    case "sum/4":
      return `sum over ${y} from ${z} to ${w} of ${x}`;
    case "prod/4":
    case "product/4":
      return `product over ${y} from ${z} to ${w} of ${x}`;
    case "int/4":
      return `integral from ${z} to ${w} of ${x} d ${y}`;
    case "int/2":
      return `integral of ${x} d ${y}`;
    case "diff/2":
      return `derivative of ${x} with respect to ${y}`;
    case "diff/3":
      return `derivative number ${z} of ${x} with respect to ${y}`;
    case "lim/3":
      return `limit as ${y} approaches ${z} of ${x}`;
  }
  return `${spokenName(name)} of (${args.map((e) => say(e, cx)).join(", ")})`;
}

function say(e: Expr, cx: Ctx): string {
  switch (e.t) {
    case "Num":
      return sayNum(e.c);
    case "Ident":
      return cx.units.has(e.c) ? unitWord(e.c) : spokenName(e.c);
    case "Unit":
      return unitWord(e.c);
    case "Str":
      return `"${e.c}"`;
    case "Placeholder":
      return "blank";
    case "Paren":
      return `(${say(e.c, cx)})`;
    case "Unary": {
      const [op, x] = e.c;
      return `${{ Neg: "minus", Pos: "plus", PlusMinus: "plus or minus", Not: "not" }[op]} ${say(x, cx)}`;
    }
    case "Factorial":
      return `${say(e.c, cx)} factorial`;
    case "Binary":
      return binary(e.c[0], e.c[1], e.c[2], cx);
    case "Compare":
      return [say(e.c[0], cx), ...e.c[1].map(([op, x]) => `${CMP[op]} ${say(x, cx)}`)].join(" ");
    case "Call":
      return call(e.c[0], e.c[1], cx);
    case "Index":
      return `${say(e.c[0], cx)} sub ${e.c[1].map((x) => say(x, cx)).join(", ")}`;
    case "Matrix": {
      const rows = e.c;
      const cols = rows[0]?.length ?? 0;
      const body = rows.map((r) => r.map((x) => say(x, cx)).join(", ")).join("; ");
      return `matrix, ${rows.length} by ${cols}: ${body}`;
    }
    case "Range":
      return `${say(e.c[0], cx)} to ${say(e.c[1], cx)}`;
    case "Define":
      return `${say(e.c.lhs, cx)} ${e.c.global ? "is defined everywhere as" : "is defined as"} ${say(e.c.rhs, cx)}`;
  }
}

/** A math line in words, with its result: "M is defined as q times L squared over 8, equals 54 kilonewton metres". */
export function spokenMath(
  input: Expr,
  result?: Expr | null,
  units: readonly string[] = [],
  constants: readonly string[] = [],
  symbolic = false,
): string {
  const cx: Ctx = { units: new Set(units), constants: new Set(constants) };
  const text = say(input, cx);
  if (!result) return text;
  // the result's own unit names are units even where the input had none
  const rcx: Ctx = { units: new Set([...units, ...unitNames(result)]), constants: cx.constants };
  return `${text}, ${symbolic ? "gives" : "equals"} ${say(result, rcx)}`;
}

/** Plain names in a result that are units (results print units as plain names). */
function unitNames(e: Expr): string[] {
  const out: string[] = [];
  const walk = (x: Expr) => {
    if (x.t === "Unit") out.push(x.c);
    else if (x.t === "Paren" || x.t === "Factorial") walk(x.c);
    else if (x.t === "Unary") walk(x.c[1]);
    else if (x.t === "Binary") {
      walk(x.c[1]);
      walk(x.c[2]);
    }
  };
  walk(e);
  return out;
}
