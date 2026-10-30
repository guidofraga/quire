// Clipboard formats. Regions travel between windows, documents and sessions as JSON, both
// as a custom type and inside the HTML (the async clipboard API and some systems keep only
// the standard types). Other apps get HTML (formatted text, MathML, tables) and plain text.
// What other apps paste in becomes regions: lines of text, LaTeX as linear math, HTML tables.
import { exact } from "./symbols";
import type { Region } from "./types";

export const REGIONS_TYPE = "application/x-quire-regions";

/** Copied regions, with the images they show as `data:` URLs (they live in another bundle). */
export interface Clip {
  regions: Region[];
  assets: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Regions on the clipboard
// ---------------------------------------------------------------------------

/** Every bundle asset the regions refer to (images, in areas too). */
export function assetRefs(regions: Region[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (k === "src" && typeof x === "string" && x.startsWith("assets/")) out.add(x);
        else walk(x);
      }
  };
  walk(regions);
  return out;
}

export function encodeClip(clip: Clip): string {
  return JSON.stringify({ quire: 1, regions: clip.regions, assets: clip.assets });
}

export function decodeClip(json: string | null | undefined): Clip | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<Clip> | Region[];
    // earlier versions put the bare region list on the clipboard
    if (Array.isArray(v)) return validRegions(v) ? { regions: v, assets: {} } : null;
    if (!v || !validRegions(v.regions)) return null;
    const assets = v.assets && typeof v.assets === "object" ? v.assets : {};
    return {
      regions: v.regions,
      assets: Object.fromEntries(Object.entries(assets).filter(([, u]) => typeof u === "string")),
    };
  } catch {
    return null;
  }
}

const validRegions = (v: unknown): v is Region[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((r) => r && typeof r === "object" && typeof r.kind === "string" && Array.isArray(r.at) && r.at.length === 2);

const CLIP_ATTR = "data-quire-clip";

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The HTML put on the clipboard: what other apps show, carrying the regions for Quire. */
export function clipHtml(body: string, clip: Clip): string {
  return `<meta charset="utf-8"><div ${CLIP_ATTR}="${toBase64(encodeClip(clip))}">${body}</div>`;
}

/** Regions carried in HTML copied from Quire. */
export function clipFromHtml(html: string | null | undefined): Clip | null {
  const m = html && new RegExp(`${CLIP_ATTR}="([A-Za-z0-9+/=]+)"`).exec(html);
  if (!m) return null;
  try {
    return decodeClip(fromBase64(m[1]));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML for other apps (Word, Google Docs, Pages, mail)
// ---------------------------------------------------------------------------

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Rendered Quire HTML made self-contained: Djot's size/font/color attributes become inline
 * styles, MathML gets its namespace (Word looks for it), cross-references become plain text,
 * and the app's classes and data attributes go.
 */
export function portableHtml(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  for (const el of root.querySelectorAll<HTMLElement>("[size],[font],[color]")) {
    const size = el.getAttribute("size");
    if (size && /^[\d.]+$/.test(size)) el.style.fontSize = `${size}pt`;
    const font = el.getAttribute("font");
    if (font) el.style.fontFamily = `"${font.replace(/"/g, "")}"`;
    const color = el.getAttribute("color");
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) el.style.color = color;
    for (const a of ["size", "font", "color"]) el.removeAttribute(a);
  }
  for (const a of root.querySelectorAll('a[href^="#"]')) {
    const span = document.createElement("span");
    span.textContent = a.textContent;
    a.replaceWith(span);
  }
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes])
      if (a.name === "class" || a.name.startsWith("data-") || a.name === "title") el.removeAttribute(a.name);
  }
  let out = root.innerHTML;
  out = out.replace(/<math(?![^>]*xmlns)/g, `<math xmlns="${MATHML_NS}"`);
  return out;
}

/** A math region: its MathML (with the result), with the linear text for apps without MathML. */
export function mathParagraph(mathml: string, linear: string): string {
  const withAlt = mathml.replace(/^<math\b/, `<math alttext="${escapeHtml(linear)}"`);
  return `<p>${portableHtml(withAlt)}</p>`;
}

export function tableHtml(
  rows: string[][],
  opts: { headerRow?: boolean; headerColumn?: boolean; align?: (string | undefined)[] } = {},
): string {
  const cell = "border:1px solid #999;padding:2px 6px";
  const body = rows
    .map((row, r) => {
      const cells = row.map((text, c) => {
        const head = (r === 0 && opts.headerRow) || (c === 0 && opts.headerColumn);
        const tag = head ? "th" : "td";
        const align = opts.align?.[c];
        const style = align && align !== "left" ? `${cell};text-align:${align}` : cell;
        return `<${tag} style="${style}">${escapeHtml(text).replace(/\n/g, "<br>")}</${tag}>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<table style="border-collapse:collapse">${body}</table>`;
}

/** Cells as tab-separated text, quoted where needed (what spreadsheets read). */
export function tsv(rows: string[][]): string {
  const cell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(cell).join("\t")).join("\n");
}

/** Text of rendered HTML, one line per paragraph (for `text/plain`). */
export function htmlText(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html.replace(/<br\s*\/?>/gi, "\n");
  for (const block of root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, div, blockquote, pre")) block.append("\n");
  for (const m of root.querySelectorAll("math")) m.replaceWith(m.getAttribute("alttext") ?? m.textContent ?? "");
  return (root.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pasting HTML tables (web pages, Word, Excel, Google Sheets)
// ---------------------------------------------------------------------------

function cellText(cell: Element): string {
  const c = cell.cloneNode(true) as Element;
  for (const br of c.querySelectorAll("br")) br.replaceWith("\n");
  for (const p of c.querySelectorAll("p, div, li")) p.append("\n");
  return (c.textContent ?? "")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The table in pasted HTML, when the HTML is essentially that table (a selection of cells
 * in a spreadsheet, a table copied from Word or a web page). Merged cells are spread over
 * the cells they cover, the text going in the first.
 */
export function tableFromHtml(html: string | null | undefined): { rows: string[][]; header: boolean } | null {
  if (!html || !/<table/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  // text outside the table (a paragraph around it) means this is a document, not cells
  const rest = doc.body.cloneNode(true) as HTMLElement;
  for (const t of rest.querySelectorAll("table, style, script, title, meta")) t.remove();
  if ((rest.textContent ?? "").replace(/[\s ]/g, "")) return null;

  const rows: string[][] = [];
  const taken: boolean[][] = [];
  const trs = [...table.querySelectorAll("tr")].filter((tr) => tr.closest("table") === table);
  trs.forEach((tr, r) => {
    rows[r] ??= [];
    taken[r] ??= [];
    let c = 0;
    for (const cell of tr.children) {
      if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
      while (taken[r][c]) c++;
      const span = Math.max(1, Math.min(50, Number(cell.getAttribute("colspan")) || 1));
      const down = Math.max(1, Math.min(500, Number(cell.getAttribute("rowspan")) || 1));
      for (let dr = 0; dr < down; dr++) {
        rows[r + dr] ??= [];
        taken[r + dr] ??= [];
        for (let dc = 0; dc < span; dc++) {
          rows[r + dr][c + dc] = dr === 0 && dc === 0 ? cellText(cell) : "";
          taken[r + dr][c + dc] = true;
        }
      }
      c += span;
    }
  });
  const width = Math.max(0, ...rows.map((r) => r.length));
  const grid = rows.slice(0, Math.max(trs.length, 1)).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  if (!width || grid.every((r) => r.every((c) => !c))) return null;
  const first = trs[0];
  const header =
    !!first && (first.parentElement?.tagName === "THEAD" || [...first.children].some((c) => c.tagName === "TH"));
  return { rows: grid, header };
}

// ---------------------------------------------------------------------------
// Pasting text: one region per line, math or prose
// ---------------------------------------------------------------------------

export type Piece = { kind: "math"; text: string } | { kind: "text"; text: string };

const DEFINITION = /^[\p{L}][\p{L}\p{N}_.']*(\([^()]*\))?\s*(:=|≔|≡|::=|=|←)/u;
const FIRST_WORD = /^([\p{L}][\p{L}\p{N}_.]*)\s/u;
const MATHY = /(:=|=|[+\-*/^<>≤≥≠→]|\d)/;

/**
 * Math or text, by the rules for typing: a word followed by a space starts text, unless the
 * line is plainly a definition or an evaluation (`E = 210 GPa`, `f(x) := x^2`).
 */
export function classifyLine(line: string, isProse: (s: string) => boolean): Piece {
  const t = line.trim();
  const math = (): Piece => ({ kind: "math", text: (latexToLinear(t) ?? t).split("\n")[0] });
  if (/^(\$.*\$|\\\[.*\\\]|\\\(.*\\\))$/s.test(t) || DEFINITION.test(t)) return math();
  const first = FIRST_WORD.exec(t);
  if (first && isProse(first[1])) return { kind: "text", text: t };
  if (isProse(t)) return { kind: "text", text: t };
  if (isLatex(t)) return math();
  const words = t.split(/\s+/).length;
  if (words === 1 || (MATHY.test(t) && words <= 6)) return { kind: "math", text: t };
  return { kind: "text", text: t };
}

/** Pasted text as regions: a LaTeX display block as its equations, otherwise one per line. */
export function piecesFromText(text: string, isProse: (s: string) => boolean): Piece[] {
  const src = text.replace(/\r\n?/g, "\n").trim();
  if (!src) return [];
  const block = /^(\$\$|\\\[|\\begin\{)/.test(src) ? latexToLinear(src) : null;
  if (block !== null)
    return block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ kind: "math", text: l }));
  return src
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => classifyLine(l, isProse));
}

// ---------------------------------------------------------------------------
// LaTeX → linear syntax
// ---------------------------------------------------------------------------

const LATEX_HINT = /\\[A-Za-z]+|\\[,;:!]|[_^]\{|^\s*\$.*\$\s*$|^\s*\\[[(]/s;

/** Is this LaTeX (rather than linear math, which also has `^` and `_`)? */
export const isLatex = (s: string) => LATEX_HINT.test(s);

type Tok = { k: "cmd" | "ch" | "num" | "word"; v: string } | { k: "sp" };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/s.exec(s.slice(i));
      if (!m) break;
      out.push({ k: "cmd", v: m[1] });
      i += m[0].length;
      // a command name ends at the first non-letter; the spaces after it are not juxtaposition
      if (/^[A-Za-z]/.test(m[1])) while (s[i] === " ") i++;
    } else if (/\s|~/.test(ch)) {
      while (i < s.length && /\s|~/.test(s[i])) i++;
      out.push({ k: "sp" });
    } else if (/\d/.test(ch) || (ch === "." && /\d/.test(s[i + 1] ?? ""))) {
      const m = /^\d*(?:\.\d+)?(?:\{,\}\d+)?/.exec(s.slice(i))!;
      out.push({ k: "num", v: m[0].replace("{,}", ".") });
      i += m[0].length;
    } else if (/\p{L}/u.test(ch)) {
      const m = /^[\p{L}][\p{L}\p{N}]*/u.exec(s.slice(i))!;
      out.push({ k: "word", v: m[0] });
      i += m[0].length;
    } else {
      out.push({ k: "ch", v: ch });
      i++;
    }
  }
  return out;
}

/** A converted operand: its text and how tightly it binds (3 atom, 2 product, 1 sum, 0 relation). */
interface Operand {
  op?: undefined;
  s: string;
  p: number;
  kind: "num" | "ident" | "paren" | "fn" | "str" | "group" | "big";
  /** Big operators: `sum`, `prod`, `int`, `lim` with their limits. */
  big?: { name: string; lower: string | null; upper: string | null };
  /** Spaces before it (juxtaposition in LaTeX source). */
  spaced?: boolean;
}
interface Op {
  op: string;
}
type Item = Operand | Op;

const FUNCS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "coth",
  "arcsin",
  "arccos",
  "arctan",
  "ln",
  "log",
  "lg",
  "exp",
  "det",
  "min",
  "max",
]);
const ARC: Record<string, string> = { arcsin: "asin", arccos: "acos", arctan: "atan", lg: "log10" };
const FONT_CMDS = new Set([
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "mathtt",
  "mathnormal",
  "boldsymbol",
  "bm",
  "mathbb",
  "mathcal",
  "operatorname",
  "textnormal",
]);
const TEXT_CMDS = new Set(["text", "textrm", "textit", "textbf", "mbox", "textsf"]);
const IGNORE = new Set([
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "limits",
  "nolimits",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "Biggl",
  "Biggr",
  "middle",
  "nonumber",
  "notag",
  "label",
]);
const SPACES = new Set([",", ";", ":", "!", " ", "quad", "qquad", "enspace", "thinspace"]);
const OPS: Record<string, string> = {
  cdot: "*",
  times: "*",
  ast: "*",
  div: "/",
  pm: "±",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  lt: "<",
  gt: ">",
  coloneqq: ":=",
  coloneq: ":=",
  equiv: "≡",
  to: "→",
  rightarrow: "→",
  approx: "=",
  cdots: "",
  ldots: "",
  dots: "",
};
const ENVS_MATRIX = new Set(["matrix", "bmatrix", "pmatrix", "vmatrix", "Bmatrix", "Vmatrix", "smallmatrix", "array"]);

class LatexParser {
  i = 0;
  constructor(readonly toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isCh(v: string, t = this.peek()) {
    return !!t && t.k === "ch" && t.v === v;
  }
  isCmd(v: string, t = this.peek()) {
    return !!t && t.k === "cmd" && t.v === v;
  }
  skipSpaces() {
    while (this.peek()?.k === "sp") this.i++;
  }

  /** Items up to a closing token (not consumed). */
  items(stop: (t: Tok) => boolean): Item[] {
    const out: Item[] = [];
    let spaced = false;
    for (;;) {
      const t = this.peek();
      if (!t || stop(t)) break;
      if (t.k === "sp") {
        this.i++;
        spaced = true;
        continue;
      }
      if (t.k === "ch" && (t.v === "^" || t.v === "_")) {
        this.i++;
        const last = out[out.length - 1];
        const arg = this.arg();
        if (last && last.op === undefined)
          out[out.length - 1] = t.v === "^" ? this.power(last, arg) : this.subscript(last, arg);
        continue;
      }
      if (t.k === "ch" && t.v === "'" && out.length && out[out.length - 1].op === undefined) {
        this.i++;
        (out[out.length - 1] as Operand).s += "'";
        continue;
      }
      if (t.k === "ch" && t.v === "!" && out.length && out[out.length - 1].op === undefined) {
        this.i++;
        const last = out[out.length - 1] as Operand;
        out[out.length - 1] = { s: `${wrap(last, 3)}!`, p: 3, kind: "group" };
        continue;
      }
      const item = this.item(out);
      if (item && item.op === undefined) item.spaced = spaced;
      spaced = false;
      if (item) out.push(item);
    }
    return out;
  }

  /** One argument: a `{group}` or a single token. */
  arg(): Operand {
    this.skipSpaces();
    const t = this.peek();
    if (this.isCh("{")) {
      this.i++;
      const items = this.items((x) => this.isCh("}", x));
      this.i++;
      return join(items);
    }
    if (!t) return { s: "?", p: 3, kind: "ident" };
    if (t.k === "num") {
      // `x^23` is x to the 23 in linear text but x² then 3 in LaTeX
      this.i++;
      if (t.v.length > 1 && /^\d+$/.test(t.v)) {
        this.toks.splice(this.i, 0, { k: "num", v: t.v.slice(1) });
        return { s: t.v[0], p: 3, kind: "num" };
      }
      return { s: t.v, p: 3, kind: "num" };
    }
    if (t.k === "word" && t.v.length > 1) {
      this.i++;
      this.toks.splice(this.i, 0, { k: "word", v: t.v.slice(1) });
      return { s: t.v[0], p: 3, kind: "ident" };
    }
    const item = this.item([]);
    return item && item.op === undefined ? item : { s: item?.op ?? "?", p: 3, kind: "ident" };
  }

  /** The raw text of a `{group}` (for `\text`, environment names). */
  rawGroup(): string {
    this.skipSpaces();
    if (!this.isCh("{")) {
      const t = this.toks[this.i++];
      return t && t.k !== "sp" ? t.v : "";
    }
    this.i++;
    let depth = 1;
    let s = "";
    for (let t = this.peek(); t; t = this.peek()) {
      this.i++;
      if (this.isCh("{", t)) depth++;
      if (this.isCh("}", t) && --depth === 0) break;
      if (t.k === "sp") s += " ";
      else if (t.k === "cmd") s += SPACES.has(t.v) ? " " : (exact(t.v, "math")?.insert ?? t.v);
      else s += t.v;
    }
    return s.trim();
  }

  power(base: Operand, exp: Operand): Operand {
    if (base.kind === "big") return { ...base, big: { ...base.big!, upper: exp.s } };
    if (exp.s === "°" || exp.s === "circ") return { s: `${base.s} °`, p: 2, kind: "group" };
    const e = exp.p < 3 || exp.s.startsWith("-") ? `(${exp.s})` : exp.s;
    return { s: `${wrap(base, 3)}^${e}`, p: 3, kind: base.kind === "fn" ? "fn" : "group", big: base.big };
  }

  subscript(base: Operand, sub: Operand): Operand {
    if (base.kind === "big") return { ...base, big: { ...base.big!, lower: sub.s } };
    if (base.kind === "ident" && /^[\p{L}\p{N}]+$/u.test(sub.s)) return { ...base, s: `${base.s}.${sub.s}` };
    return { s: `${wrap(base, 3)}[${sub.s}]`, p: 3, kind: "group" };
  }

  item(before: Item[]): Item | null {
    const t = this.toks[this.i++];
    switch (t.k) {
      case "num":
        return { s: t.v, p: 3, kind: "num" };
      case "word":
        return FUNCS.has(t.v) ? { s: ARC[t.v] ?? t.v, p: 3, kind: "fn" } : { s: t.v, p: 3, kind: "ident" };
      case "sp":
        return null;
      case "ch":
        return this.char(t.v, before);
      case "cmd":
        return this.command(t.v);
    }
  }

  char(c: string, before: Item[]): Item | null {
    switch (c) {
      case "{": {
        const items = this.items((x) => this.isCh("}", x));
        this.i++;
        return join(items);
      }
      case "(":
      case "[": {
        const close = c === "(" ? ")" : "]";
        const items = this.items((x) => this.isCh(close, x) || this.isCmd("right", x));
        this.closeDelimiter(close);
        return { s: `${c}${join(items).s}${close}`, p: 3, kind: "paren" };
      }
      case "|": {
        const items = this.items((x) => this.isCh("|", x) || this.isCmd("right", x));
        this.closeDelimiter("|");
        return { s: `abs(${join(items).s})`, p: 3, kind: "group" };
      }
      case "}":
      case ")":
      case "]":
      case "&":
        return null;
      case ":":
        if (this.isCh("=")) {
          this.i++;
          return { op: ":=" };
        }
        return { op: ":" };
      case "−":
        return { op: "-" };
      case "·":
      case "×":
        return { op: "*" };
      case "=":
        // `==` is a comparison in Quire too
        if (this.isCh("=")) {
          this.i++;
          return { op: "==" };
        }
        return { op: "=" };
      case "<":
      case ">":
        if (this.isCh("=")) {
          this.i++;
          return { op: c === "<" ? "≤" : "≥" };
        }
        return { op: c };
      case "+":
      case "-":
      case "*":
      case "/":
      case ",":
      case ";":
      case "±":
      case "≤":
      case "≥":
      case "≠":
      case "≔":
      case "≡":
      case "→":
        return { op: c === "≔" ? ":=" : c };
      default:
        void before;
        return /\p{L}|[∞°]/u.test(c) ? { s: c, p: 3, kind: "ident" } : { op: c };
    }
  }

  /** After `\left( … `: eat `\right)` or the plain closing delimiter. */
  closeDelimiter(close: string) {
    if (this.isCmd("right")) {
      this.i += 2; // `\right` and its delimiter
      return;
    }
    if (this.isCh(close)) this.i++;
  }

  command(name: string): Item | null {
    if (IGNORE.has(name)) {
      if (name === "label") this.rawGroup();
      return null;
    }
    if (SPACES.has(name)) return null;
    if (Object.hasOwn(OPS, name)) return OPS[name] ? { op: OPS[name] } : null;
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac": {
        const num = this.arg();
        const den = this.arg();
        // d/dx f and ∂/∂x f: a derivative of what follows
        const dn = /^(?:d|∂)(?:\^(\d+))?$/.exec(num.s);
        const dd = /^(?:d|∂)\*?([\p{L}][\p{L}\p{N}.]*)(?:\^(\d+))?$/u.exec(den.s.replace(/\s/g, ""));
        if (dn && dd) return { s: "", p: 3, kind: "big", big: { name: "diff", lower: dd[1], upper: dn[1] ?? null } };
        return { s: `${wrap(num, 2)}/${wrap(den, 3)}`, p: 2, kind: "group" };
      }
      case "sqrt": {
        this.skipSpaces();
        let n: string | null = null;
        if (this.isCh("[")) {
          this.i++;
          n = join(this.items((x) => this.isCh("]", x))).s;
          this.i++;
        }
        const x = this.arg();
        return { s: n ? `root(${x.s}, ${n})` : `sqrt(${x.s})`, p: 3, kind: "group" };
      }
      case "left": {
        const t = this.toks[this.i++];
        const open =
          t?.k === "cmd"
            ? (({ "{": "(", lvert: "|", vert: "|", "|": "|", langle: "(" } as Record<string, string>)[t.v] ?? "(")
            : ((t as { v?: string })?.v ?? "(");
        if (open === "|") return this.char("|", []);
        if (open === ".") {
          const items = this.items((x) => this.isCmd("right", x));
          this.closeDelimiter(")");
          return join(items);
        }
        return this.char(open === "[" ? "[" : "(", []);
      }
      case "right":
        this.i++;
        return null;
      case "lvert":
      case "vert":
        return this.char("|", []);
      case "{":
        return this.char("(", []);
      case "}":
        return null;
      case "%":
        return { s: "%", p: 3, kind: "ident" };
      case "\\":
        return { op: "\n" };
      case "circ":
        return { s: "°", p: 3, kind: "ident" };
      case "sum":
      case "prod":
      case "int":
      case "lim":
        return { s: "", p: 3, kind: "big", big: { name: name === "prod" ? "prod" : name, lower: null, upper: null } };
      case "begin":
        return this.environment(this.rawGroup());
      case "end":
        this.rawGroup();
        return null;
      case "partial":
        return { s: "∂", p: 3, kind: "ident" };
    }
    if (FONT_CMDS.has(name)) {
      const a = this.arg();
      return name === "operatorname"
        ? { ...a, kind: FUNCS.has(a.s) ? "fn" : "ident" }
        : a.kind === "num"
          ? a
          : { ...a, kind: a.p === 3 ? "ident" : a.kind };
    }
    if (TEXT_CMDS.has(name)) {
      const raw = this.rawGroup();
      const quoted = /^[“"](.*)[”"]$/s.exec(raw);
      // a quoted text is a string (`\text{“OK”}`, as Copy as LaTeX writes it); a word, a unit
      if (!quoted && /^[\p{L}][\p{L}\p{N}]*$/u.test(raw)) return { s: raw, p: 3, kind: "ident" };
      return { s: JSON.stringify(quoted ? quoted[1] : raw), p: 3, kind: "str" };
    }
    // `\Delta L`, `\delta x`: one name, as engineers write a change in L
    if ((name === "Delta" || name === "delta") && this.peek()?.k === "word") {
      const w = this.toks[this.i++] as { v: string };
      return { s: (name === "Delta" ? "Δ" : "δ") + w.v, p: 3, kind: "ident" };
    }
    if (FUNCS.has(name)) return { s: ARC[name] ?? name, p: 3, kind: "fn" };
    const sym = exact(name, "math");
    if (sym && !sym.insert.includes("?") && sym.insert) {
      const ch = sym.insert;
      return /\p{L}|[∞∂∇ħ]/u.test(ch)
        ? { s: ch, p: 3, kind: "ident" }
        : { op: ch === "×" || ch === "·" ? "*" : ch === "÷" ? "/" : ch };
    }
    return { s: name, p: 3, kind: "ident" };
  }

  environment(env: string): Item | null {
    const name = env.replace(/\*$/, "");
    if (name === "array") this.rawGroup();
    const stop = (x: Tok) => this.isCmd("end", x);
    if (ENVS_MATRIX.has(name)) {
      const rows: string[][] = [[]];
      for (;;) {
        const items = this.items((x) => stop(x) || this.isCh("&", x) || this.isCmd("\\", x));
        rows[rows.length - 1].push(join(items).s);
        const t = this.toks[this.i++];
        if (!t || this.isCmd("end", t)) break;
        if (this.isCmd("\\", t)) rows.push([]);
      }
      this.rawGroup();
      const body = rows
        .filter((r) => r.some(Boolean))
        .map((r) => r.join(", "))
        .join("; ");
      return name === "vmatrix" || name === "Vmatrix"
        ? { s: `det([${body}])`, p: 3, kind: "group" }
        : { s: `[${body}]`, p: 3, kind: "paren" };
    }
    // equation, align, gather…: the lines become separate equations; `&` only aligns
    const items = this.items(stop);
    this.i++;
    this.rawGroup();
    return { s: join(items).s, p: 0, kind: "group" };
  }
}

const wrap = (o: Operand, min: number) => (o.p < min ? `(${o.s})` : o.s);

const PREC: Record<string, number> = { "+": 1, "-": 1, "±": 1, "*": 2, "/": 2 };

/** Items as linear text: operators spaced as Quire prints them, juxtaposition made explicit. */
function join(input: Item[]): Operand {
  // a name and parentheses right after it: a call (`f(x)`, `M(x)`)
  input = input.reduce<Item[]>((out, it) => {
    const last = out[out.length - 1];
    if (
      last &&
      last.op === undefined &&
      last.kind === "ident" &&
      it.op === undefined &&
      it.kind === "paren" &&
      it.s.startsWith("(") &&
      !it.spaced
    )
      out[out.length - 1] = { s: last.s + it.s, p: 3, kind: "group", spaced: last.spaced };
    else out.push(it);
    return out;
  }, []);
  // functions take the operand after them; big operators take what follows up to + or −
  const items: Item[] = [];
  for (let k = 0; k < input.length; k++) {
    const it = input[k];
    if (it.op !== undefined || (it.kind !== "fn" && it.kind !== "big")) {
      items.push(it);
      continue;
    }
    if (it.kind === "fn") {
      const next = input[k + 1];
      if (next && next.op === undefined) {
        k++;
        const arg = next.kind === "paren" && next.s.startsWith("(") ? next.s.slice(1, -1) : next.s;
        const pow = /^(\w+)\^(.+)$/.exec(it.s);
        items.push({
          s: pow ? `${pow[1]}(${arg})^${pow[2]}` : `${it.s}(${arg})`,
          p: 3,
          kind: "group",
          spaced: it.spaced,
        });
      } else items.push({ ...it, kind: "ident" });
      continue;
    }
    // sum, prod, int, lim, d/dx
    const body: Item[] = [];
    let k2 = k + 1;
    let dx: string | null = null;
    for (; k2 < input.length; k2++) {
      const x = input[k2];
      if (x.op !== undefined && x.op !== "*" && x.op !== "/") break;
      if (
        it.big!.name === "int" &&
        x.op === undefined &&
        (x.s === "d" || x.s === "∂") &&
        input[k2 + 1] &&
        input[k2 + 1].op === undefined
      ) {
        dx = (input[k2 + 1] as Operand).s;
        k2 += 2;
        break;
      }
      // `dx` typed as one word
      if (
        it.big!.name === "int" &&
        x.op === undefined &&
        x.kind === "ident" &&
        /^d\p{L}$/u.test(x.s) &&
        (k2 + 1 === input.length || input[k2 + 1].op !== undefined)
      ) {
        dx = x.s.slice(1);
        k2 += 1;
        break;
      }
      // d/dx applies to one factor (`d/dx f(x)`)
      if (it.big!.name === "diff" && body.length) break;
      body.push(x);
    }
    k = k2 - 1;
    const b = join(body).s || "?";
    const { name, lower, upper } = it.big!;
    let s: string;
    if (name === "diff") s = upper && upper !== "1" ? `diff(${b}, ${lower}, ${upper})` : `diff(${b}, ${lower})`;
    else if (name === "int")
      s = lower !== null && upper !== null ? `int(${b}, ${dx ?? "x"}, ${lower}, ${upper})` : `int(${b}, ${dx ?? "x"})`;
    else if (name === "lim") {
      const [v, to] = (lower ?? "x→0").split("→");
      s = `lim(${b}, ${v.trim()}, ${(to ?? "0").trim()})`;
    } else {
      const m = /^([\p{L}][\p{L}\p{N}.]*)\s*=\s*(.+)$/u.exec(lower ?? "");
      s = m ? `${name}(${b}, ${m[1]}, ${m[2]}, ${upper ?? "?"})` : `${name}(${b}, ?, ?, ?)`;
    }
    items.push({ s, p: 3, kind: "group", spaced: it.spaced });
  }

  let s = "";
  let p = 3;
  let prev: Item | null = null;
  let kind: Operand["kind"] = "group";
  let operands = 0;
  for (const it of items) {
    if (it.op !== undefined) {
      const op = it.op;
      if (op === "\n") s = `${s.trimEnd()}\n`;
      else if (op === "," || op === ";") s += `${op} `;
      else if (op === "*" || op === "/" || op === "^") s += op;
      else if ((op === "-" || op === "+") && (!prev || prev.op !== undefined))
        s += op; // unary
      else s += ` ${op} `;
      p = Math.min(p, PREC[op] ?? 0);
      if ((op === "-" || op === "+") && !prev) p = Math.min(p, 1);
      prev = it;
      continue;
    }
    if (prev && prev.op === undefined) {
      // a number and a name: implicit multiplication (`2 x`, `5 kN`)
      if (prev.kind === "num" && it.kind !== "num" && it.kind !== "paren") s += " ";
      else s += "*";
      p = Math.min(p, 2);
    }
    s += it.s;
    kind = it.kind;
    operands++;
    prev = it;
  }
  s = s.replace(/ {2,}/g, " ").trim();
  return operands === 1 && items.length === 1
    ? (items[0] as Operand)
    : { s, p, kind: operands === 1 && p === 3 ? kind : "group" };
}

/**
 * LaTeX (from a paper, Overleaf, Word's equation editor, Copy as LaTeX) as Quire's linear
 * syntax: `\frac{q L^2}{8}` → `q*L^2/8`, `\sqrt{x}`, `x^{2}`, `A_{net}` → `A.net`, Greek
 * commands, matrices, sums and integrals. A plain `name = …` becomes a definition. Several
 * lines (`align`, `\\`) come back separated by newlines. `null` when it isn't LaTeX.
 */
export function latexToLinear(src: string): string | null {
  if (!isLatex(src)) return null;
  let s = src.trim();
  s = s.replace(/^\$\$([\s\S]*)\$\$$/, "$1").replace(/^\$([\s\S]*)\$$/, "$1");
  s = s.replace(/^\\\[([\s\S]*)\\\]$/, "$1").replace(/^\\\(([\s\S]*)\\\)$/, "$1");
  s = s.replace(/(^|[^\\])%.*$/gm, "$1");
  const parser = new LatexParser(tokenize(s));
  const lines: string[] = [];
  for (;;) {
    const items = parser.items(() => false);
    const text = join(items).s;
    lines.push(...text.split("\n"));
    if (parser.i >= parser.toks.length) break;
    parser.i++;
  }
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // `F = m a` in a paper defines F; `= …` only evaluates when nothing follows it
      const m = /^([\p{L}][\p{L}\p{N}_.']*(?:\([^()]*\))?) = (?!.* = )(.+)$/u.exec(l);
      return m && !l.includes(":=") ? `${m[1]} := ${m[2]}` : l;
    })
    .join("\n");
}
