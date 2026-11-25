// The structural editor's trees against the engine itself (crates/quire-web as WebAssembly, the
// web version's engine): every formula in the repository's documents goes through the editor
// and back, and random typing always gives text the engine reads as the editor drew it.
//
// Needs app/web-public/quire_web.wasm (`npm run wasm`; CI builds it before the unit tests). Without
// it these tests are skipped locally and fail on CI. QUIRE_ROUNDTRIP_CORPUS names a folder of
// .quire/.quirez/.sm files to run the round trip over as well.
import { describe, expect, test } from "vitest";
import type { Expr } from "./types";
import { empty, fromExpr, fromLinear, key, settleSlots, toExpr, toLinear, type EditState } from "./mathTree";
import { print } from "./mathLinear";
import { mathml } from "./math";
import { drawLine } from "./mathDraw";

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc?: string): string & Uint8Array;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  statSync(p: string): { isDirectory(): boolean };
}
const fs: Fs = await import(/* @vite-ignore */ "node:" + "fs");
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;
// the repository, from this file (app/src/…)
const ROOT = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "")).replace(/app\/src\/[^/]*$/, "");
const WASM = env.env.QUIRE_WASM ?? `${ROOT}app/web-public/quire_web.wasm`;
const haveEngine = fs.existsSync(WASM);
if (!haveEngine && env.env.CI) throw new Error(`the engine is not built: ${WASM} (npm run wasm)`);

interface Engine {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  call(c: number, cl: number, b: number, bl: number): number;
  result_ptr(): number;
  result_ok(): number;
}
let engine: Engine | null = null;
if (haveEngine) {
  const module = await WebAssembly.compile(fs.readFileSync(WASM) as unknown as BufferSource);
  const imports: WebAssembly.Imports = {};
  for (const i of WebAssembly.Module.imports(module))
    (imports[i.module] ??= {})[i.name] = () => {
      throw new Error(`engine called ${i.name}`);
    };
  engine = (await WebAssembly.instantiate(module, imports)).exports as unknown as Engine;
}
const enc = new TextEncoder();
const dec = new TextDecoder();
function call<T>(cmd: string, body: unknown): T {
  const x = engine!;
  const put = (s: string): [number, number] => {
    const b = enc.encode(s);
    const p = x.alloc(b.length);
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    return [p, b.length];
  };
  const [c, cl] = put(cmd);
  const [b, bl] = put(JSON.stringify(body));
  const len = x.call(c, cl, b, bl);
  const answer = JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, x.result_ptr(), len)));
  if (!x.result_ok()) throw new Error(String(answer));
  return answer as T;
}
interface Parsed {
  expr: Expr | null;
  print: string | null;
  error: string | null;
  lenient: Expr | null;
}
const parse = (src: string) => call<Parsed>("parse", { src });

// ---------------------------------------------------------------------------
// The formulas in the repository's documents
// ---------------------------------------------------------------------------

/** Every line of math a document holds: math regions, solve blocks, math inside text. */
function formulas(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.expr === "string") out.push(o.expr);
    if (typeof o.find === "string") out.push(o.find);
    for (const k of ["guesses", "given"])
      if (Array.isArray(o[k])) out.push(...(o[k] as unknown[]).filter((x): x is string => typeof x === "string"));
    if (o.kind === "text" && typeof o.text === "string")
      for (const m of o.text.matchAll(/\$`([^`]+)`/g)) out.push(m[1]);
    Object.values(o).forEach(walk);
  };
  walk(doc);
  return out.filter((s) => s.trim());
}

/** A document file or folder, opened as the app opens it (SMath files are converted). */
function openDoc(path: string): unknown {
  if (fs.statSync(path).isDirectory()) return JSON.parse(fs.readFileSync(`${path}/document.json`, "utf8"));
  const bytes = fs.readFileSync(path) as unknown as Uint8Array;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return call("open_bytes", { data: btoa(bin) });
}

function docsIn(dir: string, keep: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (keep(e.name)) out.push(p);
    else if (e.isDirectory()) out.push(...docsIn(p, keep));
  }
  return out;
}

const IN_REPO = [
  ...docsIn(`${ROOT}crates/quire-service/templates`, (n) => n.endsWith(".json")),
  ...docsIn(`${ROOT}docs/examples`, (n) => n.endsWith(".quire")),
  ...docsIn(`${ROOT}crates`, (n) => n.endsWith(".quire") || n.endsWith(".sm")).filter((p) => p.includes("/fixtures/")),
  ...docsIn(`${ROOT}app/src-tauri/tests/fixtures`, (n) => n.endsWith(".quire")),
];

const strip = (e: unknown): unknown => JSON.parse(JSON.stringify(e));
/** `e` without its bracket nodes: what it means, however it was written. */
const meaning = (e: unknown): unknown =>
  JSON.parse(JSON.stringify(e), (_, v) => (v && typeof v === "object" && v.t === "Paren" ? v.c : v));

interface Tally {
  formulas: number;
  unparsed: number;
  sameTree: number;
  sameText: number;
  typedSame: number;
  failures: string[];
}

/** `parse(toLinear(fromExpr(parse(s)))) == parse(s)`, and the same for the tree typing builds. */
function roundTrip(sources: string[]): Tally {
  const t: Tally = { formulas: 0, unparsed: 0, sameTree: 0, sameText: 0, typedSame: 0, failures: [] };
  for (const s of sources) {
    t.formulas++;
    const p = parse(s);
    if (!p.expr) {
      t.unparsed++;
      continue;
    }
    const text = toLinear(fromExpr(p.expr));
    const back = parse(text);
    if (JSON.stringify(strip(back.expr)) === JSON.stringify(strip(p.expr))) t.sameTree++;
    else t.failures.push(`fromExpr: ${s}  →  ${text}`);
    if (text === p.print) t.sameText++;
    // typing the canonical text builds the same formula
    const typed = toLinear(fromLinear(p.print!));
    if (JSON.stringify(strip(parse(typed).expr)) === JSON.stringify(strip(p.expr))) t.typedSame++;
    else t.failures.push(`typed:    ${p.print}  →  ${typed}`);
  }
  return t;
}

const report = (name: string, t: Tally) =>
  `${name}: ${t.formulas} formulas (${t.unparsed} not parsing, skipped); round trip ${t.sameTree}/${t.formulas - t.unparsed}, ` +
  `same text ${t.sameText}, typed ${t.typedSame}/${t.formulas - t.unparsed}` +
  (t.failures.length ? `\n  ${t.failures.slice(0, 30).join("\n  ")}` : "");

describe.skipIf(!haveEngine)("against the engine", () => {
  test("the TypeScript printer prints as the engine does", () => {
    for (const s of [
      "M := q*L^2/8",
      "e^(-t/(2 s))",
      "[\n  1, 2, 3;\n  4, 5, 6;\n  7, 8, 9\n]",
      's := "a \\"b\\""',
      "-10^2 'm",
      "a and not b or c",
    ]) {
      const p = parse(s);
      expect(print(p.expr!)).toBe(p.print);
    }
  });

  test("every formula in the repository's documents survives the editor", () => {
    const sources = IN_REPO.flatMap((p) => formulas(openDoc(p)));
    const t = roundTrip(sources);
    console.info(report(`in-repo corpus (${IN_REPO.length} documents)`, t));
    expect(t.formulas).toBeGreaterThan(100);
    expect(t.failures).toEqual([]);
    expect(t.sameText).toBe(t.formulas - t.unparsed);
  });

  test("typing a formula with brackets around random parts of it builds that formula", () => {
    // nested brackets, calls in brackets, brackets that are a whole slot, operators after `)`
    const seeds = [
      "(1 - cos(α))/2",
      "ln(abs((x - r)/(x + r)))",
      "sqrt((1 - cos(α))/2)",
      "(2*n - 1)!",
      "x^(2*n)/(2*n)!",
      "(x ≠ 0) and (y ≠ 0)",
      "not (a < b) or c",
      "2 and b",
      "f(g(h(x)))^2",
      "e^(-(x - μ)^2/(2*σ^2))",
      "abs(sqrt((a + b)))!",
      "M := q*L^2/8 - (w*L)/(2*(a + b))",
      "[f(a), (b + c)/2; -(d), e!]",
    ];
    const sources = [...seeds, ...IN_REPO.flatMap((p) => formulas(openDoc(p)))].filter((s) => parse(s).expr);
    let seed = Number(env.env.MATHTREE_SEED ?? 173);
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.floor(seed / 65536) / 32768;
    };
    const isExpr = (v: object) =>
      typeof (v as { t?: unknown }).t === "string" && Object.keys(v).every((k) => k === "t" || k === "c");
    // every sub-expression wrapped in brackets with probability p, at any depth
    const vary = (v: unknown, p: number): unknown => {
      if (Array.isArray(v)) return v.map((x) => vary(x, p));
      if (!v || typeof v !== "object") return v;
      if (!isExpr(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, vary(x, p)]));
      const e = v as { t: string; c?: unknown };
      const inner = "c" in e ? { ...e, c: vary(e.c, p) } : e;
      const r = rand();
      // sometimes twice: `((a + b))/2`
      return r < p / 4 ? { t: "Paren", c: { t: "Paren", c: inner } } : r < p ? { t: "Paren", c: inner } : inner;
    };
    const rounds = Number(env.env.MATHTREE_ROUNDS ?? 4);
    let checked = 0;
    const bad: string[] = [];
    for (let r = 0; r < rounds; r++)
      for (const s of sources) {
        const e = parse(s).expr!;
        const varied = { ...e, c: vary((e as { c?: unknown }).c, 0.15 + 0.3 * rand()) } as Expr;
        const text = print(varied);
        const want = parse(text).expr;
        // brackets where the text can't have them (`2 ('m)`): not a formula
        if (!want || JSON.stringify(strip(want)) !== JSON.stringify(strip(varied))) continue;
        checked++;
        const typed = toLinear(fromLinear(text));
        if (JSON.stringify(strip(parse(typed).expr)) !== JSON.stringify(strip(want))) bad.push(`${text}  →  ${typed}`);
      }
    console.info(
      `bracketed: ${checked} formulas typed, ${bad.length} built otherwise\n  ${bad.slice(0, 30).join("\n  ")}`,
    );
    expect(checked).toBeGreaterThan(500);
    expect(bad).toEqual([]);
  });

  test.skipIf(!env.env.QUIRE_ROUNDTRIP_CORPUS)("QUIRE_ROUNDTRIP_CORPUS survives the editor", () => {
    const dir = env.env.QUIRE_ROUNDTRIP_CORPUS!;
    const files = docsIn(dir, (n) => /\.(quire|quirez|sm)$/i.test(n));
    const sources: string[] = [];
    let unreadable = 0;
    for (const f of files) {
      try {
        sources.push(...formulas(openDoc(f)));
      } catch {
        unreadable++;
      }
    }
    const t = roundTrip(sources);
    console.info(report(`${dir} (${files.length} files, ${unreadable} not opened)`, t));
    expect(t.failures).toEqual([]);
  });

  test("a formula edited in place is drawn exactly as the view draws it, when the edit starts and ends", () => {
    // what the editor adds for the caret may differ, and nothing else
    const bare = (html: string) => html.replace(/ data-(?:r|a|n|node|hole|script|open|close|unitrow)="[^"]*"/g, "");
    const said = { result: null, units: [], constants: [] };
    const sources = IN_REPO.flatMap((p) => formulas(openDoc(p))).filter((s) => parse(s).expr);
    const bad: string[] = [];
    for (const s of sources) {
      const e = parse(s).expr!;
      // opening it: the tree built from what the engine read
      const opened = bare(drawLine(fromExpr(e), said));
      if (opened !== mathml(e)) bad.push(`opened: ${s}\n    ${opened}\n    ${mathml(e)}`);
      // typing it and leaving it: the tree typing built, against the text it stores
      const typed = settleSlots(key(fromLinear(parse(s).print!), "End"));
      const stored = parse(toLinear(typed)).expr;
      if (!stored) continue;
      const drawn = bare(drawLine(typed, said));
      if (drawn !== mathml(stored)) bad.push(`typed: ${s}\n    ${drawn}\n    ${mathml(stored)}`);
    }
    console.info(
      `drawn in place: ${sources.length} formulas, ${bad.length} drawn otherwise\n  ${bad.slice(0, 12).join("\n  ")}`,
    );
    expect(sources.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  test("every prefix of a line typed previews as the engine previews that text", () => {
    const lines = IN_REPO.flatMap((p) => formulas(openDoc(p))).filter((s) => parse(s).expr && !s.includes("\n"));
    let checked = 0;
    const bad: string[] = [];
    for (const line of lines.slice(0, 120)) {
      const chars = [...parse(line).print!];
      for (let n = 1; n <= chars.length; n++) {
        const prefix = chars.slice(0, n).join("");
        if (!prefix.trim() || /[=→]\s*$/.test(prefix)) continue;
        const ours = toLinear(fromLinear(prefix));
        const theirs = parse(prefix).lenient;
        if (!theirs) continue;
        checked++;
        const mine = parse(ours).lenient;
        if (JSON.stringify(strip(mine)) !== JSON.stringify(strip(theirs))) bad.push(`${prefix}  →  ${ours}`);
      }
    }
    console.info(`prefixes: ${checked} checked, ${bad.length} differ\n  ${bad.slice(0, 30).join("\n  ")}`);
    expect(bad).toEqual([]);
  });

  test("random typing never breaks, and the engine reads what the editor drew", () => {
    let seed = Number(env.env.MATHTREE_SEED ?? 165);
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.floor(seed / 65536) % n;
    };
    const KEYS = [
      ..."abcxyLMq0123456789",
      ..."+-*/^().,;[]=:' !#\"<>~%α°",
      "Tab",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    let complete = 0;
    let sequences = 0;
    for (let run = 0; run < Number(env.env.MATHTREE_RUNS ?? 1500); run++) {
      sequences++;
      let s: EditState = empty();
      for (let k = 0; k < 25; k++) {
        const kk = KEYS[rand(KEYS.length)];
        s = key(s, kk, { shift: rand(6) === 0 });
      }
      const text = toLinear(s);
      const mine = toExpr(s);
      if (!mine || s.line.show || !text.trim()) continue;
      complete++;
      if (env.env.MATHTREE_SHOW && run < 15) console.info(text);
      const theirs = parse(text);
      expect(theirs.error, `${text}`).toBeNull();
      expect(meaning(theirs.expr), text).toEqual(meaning(mine));
    }
    console.info(
      `random typing: ${sequences} sequences of 25 keys, ${complete} ended in a readable formula, all read alike`,
    );
    expect(complete).toBeGreaterThan(100);
  });
});
