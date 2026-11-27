import { describe, expect, test } from "vitest";
import {
  cutSelection,
  empty,
  fromExpr,
  fromLinear,
  greek,
  hints,
  History,
  insertTemplate,
  key,
  paste,
  plainWords,
  selectedText,
  selection,
  setCaret,
  sketch,
  symbolic,
  toExpr,
  toLinear,
  wrapIn,
  type EditState,
} from "./mathTree";
import { print } from "./mathLinear";
import { naturalKeys } from "./naturalKeys";
import type { Expr } from "./types";

interface Fs {
  readFileSync(p: string, enc: string): string;
  writeFileSync(p: string, s: string): void;
}
const fs: Fs = await import(/* @vite-ignore */ "node:" + "fs");
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ROOT = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "")).replace(/app\/src\/[^/]*$/, "");

const NAMED: Record<string, string> = {
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "⌫": "Backspace",
  "⌦": "Delete",
  "⌥←": "WordLeft",
  "⌥→": "WordRight",
};

/**
 * Keys as the spec writes them: characters as typed (`␣` is Space), `{←}` `{⇧→}` `{⌫}` `{⌦}`
 * `{Home}` `{End}` `{Tab}` `{Ctrl+.}` `{Ctrl+G}`. A leading `⟦text⟧` opens a formula already
 * written (the caret at its end, put there by hand).
 */
function run(keys: string, start: EditState = empty()): EditState {
  let s = start;
  const open = /^⟦(.*?)⟧/u.exec(keys);
  if (open) {
    s = key(fromLinear(open[1]), "End");
    keys = keys.slice(open[0].length);
  }
  for (const m of keys.matchAll(/\{([^}]+)\}|([\s\S])/gu)) {
    if (m[1] === "Ctrl+.") s = symbolic(s);
    else if (m[1] === "Ctrl+G") s = greek(s);
    else if (m[1]) {
      const shift = m[1].startsWith("⇧");
      const k = m[1].replace("⇧", "");
      s = key(s, NAMED[k] ?? k, { shift });
    } else s = key(s, m[2] === "␣" ? " " : m[2]);
  }
  return s;
}

/** The state as the spec's second column shows it, with what the editor is asked to do. */
function shown(s: EditState): string {
  const effect = s.effect?.leave
    ? ` ⟶ leave ${s.effect.leave}`
    : s.effect?.command
      ? ` ⟶ \\${s.effect.command}`
      : s.effect?.finish
        ? " ⟶ finish"
        : "";
  return sketch(s) + effect;
}

// ---------------------------------------------------------------------------
// The spec's tables, row by row
// ---------------------------------------------------------------------------

// the inline math table has its own columns, and its own test (inlineMath.test.ts)
const SPEC = fs
  .readFileSync(`${ROOT}docs/07-math-editing.md`, "utf8")
  .replace(/\n## Inline math in text\n[\s\S]*?(?=\n## )/, "\n");
const code = (cell: string) => /^`(.*)`$/u.exec(cell.trim())?.[1].replace(/\\\|/g, "|");
const rows = SPEC.split("\n")
  .filter((l) => l.startsWith("| `"))
  .map((l) => l.split(/(?<!\\)\|/).slice(1, -1))
  .map((cells) => ({ keys: code(cells[0]), tree: code(cells[1]), linear: code(cells[2]) }))
  .filter((r): r is { keys: string; tree: string; linear: string } => r.keys !== undefined && r.tree !== undefined);

describe("the keystroke spec (docs/07-math-editing.md)", () => {
  test("has its tables", () => expect(rows.length).toBeGreaterThan(150));
  if (env.MATHTREE_DUMP) {
    test("dump", () => {
      const lines = fs
        .readFileSync(env.MATHTREE_DUMP!, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((k) => {
          if (k.startsWith("## ")) return `\n${k}\n`;
          const s = run(k);
          return `| \`${k}\` | \`${shown(s).replace(/\|/g, "\\|")}\` | \`${toLinear(s).replace(/\|/g, "\\|")}\` |  |`;
        });
      fs.writeFileSync(`${env.MATHTREE_DUMP}.out`, lines.join("\n"));
    });
  }
  test.each(rows)("$keys", ({ keys, tree, linear }) => {
    const s = run(keys);
    expect(shown(s)).toBe(tree);
    expect(toLinear(s)).toBe(linear === "" ? "" : linear);
  });
});

// ---------------------------------------------------------------------------
// What holds whatever is typed
// ---------------------------------------------------------------------------

const KEYS = [
  ..."abxyLMq0123456789+-*/^().,;[]=:' !#\"<>~%α°\\",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Tab",
];
function random(seed: number) {
  return (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor(seed / 65536) % n;
  };
}
/** Random formulas, each after a random run of keys. */
function* states(count: number, length = 30): Generator<EditState> {
  const rand = random(1650);
  for (let r = 0; r < count; r++) {
    let s = empty();
    for (let k = 0; k < length; k++) s = key(s, KEYS[rand(KEYS.length)], { shift: rand(7) === 0 });
    yield s;
  }
}

/** Programs to start from: Structures ▸ Programming's templates, and programs opened from their text. */
const PROGRAM_TEMPLATES = ["if(?, ?, ?)", "if(?, ?, if(?, ?, ?))", "for(?, ?, ?)", "while(?, ?)", "block(?, ?)"];
const PROGRAM_TEXTS = [
  'grade(x) := if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))',
  "total(n) := block(s := 0, for(i, 1..n, s := s + i), s)",
  "if(a, block(x, y), 2)",
  "block(for(i, 1..n, s), t)",
  "fact(n) := block(p := 1, k := 1, while(k ≤ n, block(p := p*k, k := k + 1)), p)",
  "for(i := 1, i ≤ n, i := i + 2, c := c + 1)",
  "if(x > 0, 1, -1)",
];
/** The keys typed in programs: every other key, and Enter, `,`, word jumps, `else if `. */
const PROGRAM_KEYS = [
  ...KEYS,
  ...["Enter", "Enter", "Enter", ",", "WordLeft", "WordRight", "else if ", "else ", "if ", "for i in ", "while "],
];

/** Random programs: a template or a program opened, then a random run of keys. */
function* programStates(count: number, length = 30): Generator<EditState> {
  const rand = random(175);
  for (let r = 0; r < count; r++) {
    let s =
      r % 2
        ? insertTemplate(empty(), PROGRAM_TEMPLATES[rand(PROGRAM_TEMPLATES.length)])
        : key(fromLinear(PROGRAM_TEXTS[rand(PROGRAM_TEXTS.length)]), "End");
    // a few steps in, so the keys land anywhere in it
    for (let k = rand(12); k > 0; k--) s = key(s, "ArrowLeft");
    for (let k = 0; k < length; k++) {
      const kk = PROGRAM_KEYS[rand(PROGRAM_KEYS.length)];
      if (kk.length > 1 && kk.includes(" ")) for (const ch of kk) s = key(s, ch);
      else s = key(s, kk, { shift: rand(7) === 0 });
    }
    yield s;
  }
}

/** Every caret position, walking → from the start. */
function walk(s: EditState, dir: "ArrowRight" | "ArrowLeft"): string[] {
  let t = key(s, dir === "ArrowRight" ? "Home" : "End");
  const seen = [`${t.caret.row}:${t.caret.i}`];
  for (let n = 0; n < 2000; n++) {
    const next = key(t, dir);
    if (next.effect?.leave) return seen;
    t = next;
    seen.push(`${t.caret.row}:${t.caret.i}`);
  }
  throw new Error("trapped");
}

// thousands of random key sequences: about a second here, several on a slow CI runner
const SUITES = [
  ["whatever is typed", states],
  ["whatever is typed in a program (if, else if, for, while, block)", programStates],
] as const;
describe.each(SUITES)("%s", (_, states) => {
  test("no key throws, and the caret is always somewhere on the line", { timeout: 60_000 }, () => {
    let n = 0;
    for (const s of states(3000)) {
      n++;
      const h = hints(s);
      expect(h.caret).toBe(s.caret);
      const sel = selection(s);
      if (sel) expect(sel.from).toBeLessThan(sel.to);
      expect(typeof toLinear(s)).toBe("string");
    }
    expect(n).toBe(3000);
  });

  test("→ visits every position once, from the start to the end, and ← the same backwards", { timeout: 60_000 }, () => {
    for (const s of states(400)) {
      const right = walk(s, "ArrowRight");
      // never a dead step: each → lands somewhere new
      expect(new Set(right).size).toBe(right.length);
      const left = walk(s, "ArrowLeft");
      expect(left).toEqual([...right].reverse());
    }
  });

  test("↑ and ↓ never trap the caret: they move or say which way to leave", { timeout: 60_000 }, () => {
    for (const s of states(400)) {
      let t = s;
      for (let n = 0; n < 50; n++) {
        const up = key(t, "ArrowUp");
        if (up.effect?.leave === "up") break;
        expect(`${up.caret.row}:${up.caret.i}`).not.toBe(`${t.caret.row}:${t.caret.i}`);
        t = up;
        if (n === 49) throw new Error("↑ never left");
      }
    }
  });

  test("Backspace from the end, or Delete from the start, empties any formula", { timeout: 60_000 }, () => {
    for (const s of states(400)) {
      for (const [k, from] of [
        ["Backspace", "End"],
        ["Delete", "Home"],
      ] as const) {
        let t = key(key(s, from), "Escape");
        let n = 0;
        while (toLinear(t) !== "" && n++ < 600) {
          t = key(t, k);
          // stuck at the line's edge with more after it: move on, as a user would
          if (!selection(t) && t.version === key(t, k).version && toLinear(key(t, k)) === toLinear(t)) {
            const moved = key(t, k === "Backspace" ? "ArrowLeft" : "ArrowRight");
            if (moved.effect?.leave) t = key(t, k === "Backspace" ? "End" : "Home");
            else t = moved;
          }
        }
        expect(toLinear(t), sketch(s)).toBe("");
      }
    }
  });

  test("the selection is always one slice of one row", { timeout: 60_000 }, () => {
    for (const s of states(500)) {
      let t = s;
      for (const k of ["ArrowLeft", "WordLeft", "ArrowUp", "ArrowRight", "WordRight", "ArrowRight"]) {
        t = key(t, k, { shift: true });
        const sel = selection(t);
        if (sel) expect(sel.from).toBeLessThan(sel.to);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Programs typed as written: keywords and Enter, or their linear text, build the same tree
// ---------------------------------------------------------------------------

/** The tree as a formula, without ids, the caret or slots open for typing. */
const formula = (s: EditState) =>
  JSON.stringify(s.line, (k, v) => (k === "id" || k === "born" || k === "auto" ? undefined : v));

/** Random programs, nested any way: ifs with else ifs and elses, for and while loops, blocks of lines. */
function randomProgram(rand: (n: number) => number): Expr {
  const id = (c: string): Expr => ({ t: "Ident", c });
  const num = (c: string): Expr => ({ t: "Num", c });
  const call = (name: string, ...args: Expr[]): Expr => ({ t: "Call", c: [name, args] });
  const define = (lhs: string, rhs: Expr): Expr => ({ t: "Define", c: { lhs: id(lhs), rhs, global: false } });
  const add = (a: Expr, b: Expr): Expr => ({ t: "Binary", c: ["Add", a, b] });
  const cmp = (a: Expr, b: Expr): Expr => ({ t: "Compare", c: [a, [[["Lt", "Ge", "Eq"][rand(3)] as "Lt", b]]] });
  const names = ["s", "c", "x", "k"];
  const name = () => names[rand(names.length)];
  const leaf = (): Expr =>
    [
      () => define(name(), add(id(name()), num(String(rand(9) + 1)))),
      () => id(name()),
      () => ({ t: "Str", c: "AB"[rand(2)] }) as Expr,
      () => call("if", cmp(id(name()), num("2")), num("1"), num("0")),
    ][rand(4)]();
  const value = (d: number): Expr => {
    if (d > 2 || rand(3) === 0) return leaf();
    if (rand(3) === 0) return call("block", ...Array.from({ length: 2 + rand(2) }, () => value(d + 1)));
    return prog(d + 1);
  };
  const prog = (d: number): Expr => {
    switch (rand(3)) {
      case 0: {
        // a chain: `if`, `else if`s, maybe an else
        const links = 1 + rand(3);
        const build = (k: number): Expr =>
          k === links - 1
            ? rand(2)
              ? call("if", cmp(id(name()), num(String(k))), value(d))
              : call("if", cmp(id(name()), num(String(k))), value(d), value(d))
            : call("if", cmp(id(name()), num(String(k))), value(d), build(k + 1));
        return build(0);
      }
      case 1:
        return call("for", id("i"), { t: "Range", c: [num("1"), id("n")] }, value(d));
      default:
        return call("while", cmp(id(name()), id("n")), value(d));
    }
  };
  switch (rand(3)) {
    case 0:
      return prog(0);
    case 1:
      return define("f", prog(0));
    default:
      return define("f", call("block", define("s", num("0")), prog(0), id("s")));
  }
}

/** Types keys as the spec writes them: characters, and named keys such as `Enter`. */
const typed = (keys: string[]) => keys.reduce((s, k) => key(s, k), empty());

describe("a program typed as written", { timeout: 60_000 }, () => {
  test("keywords and Enter build the tree its linear text builds, and the same text", () => {
    const rand = random(175);
    const sources = [...PROGRAM_TEXTS.map((t) => toExpr(fromLinear(t))!)];
    for (let k = 0; k < 600; k++) sources.push(randomProgram(rand));
    let checked = 0;
    for (const e of sources) {
      const keys = naturalKeys(e);
      if (!keys) continue;
      checked++;
      const text = print(e);
      const byKeywords = typed(keys);
      expect(toLinear(byKeywords), `${text}\n  ${keys.join(" ")}`).toBe(text);
      const byText = key(fromLinear(text), "End");
      expect(formula(byKeywords), text).toBe(formula(byText));
    }
    expect(checked).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// Building trees, and back to text
// ---------------------------------------------------------------------------

describe("trees from text and from the engine's trees", () => {
  test("fromLinear opens what MathEditor holds, the `=` and the unit included", () => {
    expect(sketch(fromLinear("M := q*L^2/8 = kN*m"))).toBe("M≔\\frac{q·L^{2}}{8} = kN·m‸");
    expect(toLinear(fromLinear("M := q*L^2/8 = kN*m"))).toBe("M := q*L^2/8 = kN*m");
    expect(toLinear(fromLinear("y →"))).toBe("y →");
    expect(toLinear(fromLinear("x ="))).toBe("x =");
    // unfinished, as the preview reads it
    expect(sketch(fromLinear("q*(L - x"))).toBe("q·(L-x‸⦆");
    // `==` and a lone `=` inside an expression are comparisons
    expect(toLinear(fromLinear("a == b"))).toBe("a == b");
    // a string's escapes
    expect(toLinear(fromLinear('s := "a \\"b\\""'))).toBe('s := "a \\"b\\""');
  });

  test("fromExpr builds the tree the parser's tree describes", () => {
    const pow = { t: "Binary", c: ["Pow", { t: "Ident", c: "L" }, { t: "Num", c: "2" }] } as const;
    const num = { t: "Binary", c: ["Mul", { t: "Ident", c: "q" }, pow] } as const;
    const e = {
      t: "Define",
      c: { lhs: { t: "Ident", c: "M" }, rhs: { t: "Binary", c: ["Div", num, { t: "Num", c: "8" }] }, global: false },
    } as const;
    const s = fromExpr(e as never, "value", "kN*m");
    expect(sketch(s)).toBe("M≔\\frac{q·L^{2}}{8}‸ = kN·m");
    expect(toLinear(s)).toBe("M := q*L^2/8 = kN*m");
    // nothing is open for typing in an opened formula
    expect(hints(s).open).toEqual([]);
  });

  test("brackets around a whole slot are the slot's, kept in the text only where typed", () => {
    expect(toLinear(fromLinear("(a + b)/2"))).toBe("(a + b)/2");
    expect(sketch(fromLinear("(a + b)/2"))).toBe("\\frac{a+b}{2‸}");
    expect(toLinear(fromLinear("x^(2)"))).toBe("x^(2)");
    expect(toLinear(fromLinear("sqrt((a))"))).toBe("sqrt((a))");
    expect(toLinear(fromLinear("e^(x + 1)"))).toBe("e^(x + 1)");
  });

  test("a fraction taken apart keeps the brackets its text needed", () => {
    // Backspace at the start of the denominator of (a + b)/2
    expect(toLinear(run("⟦(a + b)/2⟧{←}{←}{⌫}"))).toBe("(a + b)*2");
    expect(sketch(run("⟦(a + b)/2⟧{←}{←}{⌫}"))).toBe("(a+b)‸2");
  });

  test("plainWords reads a line of words for prose detection", () => {
    expect(plainWords(run("Area"))).toBe("Area");
    expect(plainWords(run("A␣medida"))).toBe("A*medida".replace("*", " "));
    expect(plainWords(run("a+b"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Clipboard, templates, shapes
// ---------------------------------------------------------------------------

describe("clipboard and templates", () => {
  test("copy and cut give linear text; paste types it", () => {
    const s = run("M:=q*L^2/8{⇧←}{⇧←}");
    expect(selectedText(s)).toBe("q*L^2/8");
    const { state, text } = cutSelection(s);
    expect(text).toBe("q*L^2/8");
    expect(toLinear(state)).toBe("M := ?");
    expect(toLinear(paste(state, text))).toBe("M := q*L^2/8");
    // a paste is read as typed text is: `a/b + c` is (a/b) + c
    expect(sketch(paste(empty(), "a/b + c"))).toBe("\\frac{a}{b}+c‸");
    // a paste over a selection replaces it
    expect(toLinear(paste(run("x+y{⇧←}"), "2*z"))).toBe("x + 2*z");
  });

  test("a gallery template goes in with the caret in its first slot", () => {
    expect(sketch(insertTemplate(empty(), "sqrt(?)"))).toBe("\\sqrt{‸}");
    expect(sketch(insertTemplate(empty(), "[?, ?; ?, ?]"))).toBe("\\mat{‸, □; □, □}");
    expect(sketch(insertTemplate(empty(), "int(?, x, ?, ?)"))).toBe("\\int{‸}{□}{□}{x}");
    expect(sketch(insertTemplate(run("2*"), "(?)/(?)"))).toBe("2·\\frac{‸}{□}");
    expect(sketch(insertTemplate(empty(), "log(?, 10)"))).toBe("log(‸?,10)");
  });

  test("a selection is wrapped in a shape", () => {
    expect(sketch(wrapIn(run("a+b{⇧←}{⇧←}{⇧←}"), "sqrt"))).toBe("\\sqrt{a+b‸}");
    expect(sketch(wrapIn(run("x{⇧←}"), "abs"))).toBe("|x‸|");
    expect(sketch(wrapIn(run("8{⇧←}"), "root"))).toBe("\\root{‸}{8}");
    expect(sketch(wrapIn(empty(), "sqrt"))).toBe("\\sqrt{‸}");
  });

  test("Tab goes to the next empty slot, then leaves", () => {
    const s = insertTemplate(empty(), "[?, ?; ?, ?]");
    expect(sketch(key(s, "Tab"))).toBe("\\mat{□, ‸; □, □}");
    expect(key(run("a+b"), "Tab").effect?.leave).toBe("right");
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe("undo", () => {
  test("every key that changes the formula is a step; moving the caret is none", () => {
    let s = empty();
    const h = new History(s);
    for (const k of ["a", "/", "b", "ArrowLeft", "ArrowLeft", "+", "c"]) {
      s = key(s, k);
      h.record(s);
    }
    // ← ← from the end of the denominator: its start, then the end of the numerator
    expect(toLinear(h.current)).toBe("(a + c)/b");
    const back = [h.undo(), h.undo(), h.undo(), h.undo(), h.undo()].map((x) => x && toLinear(x));
    expect(back).toEqual(["(a + ?)/b", "a/b", "a/?", "a", ""]);
    expect(h.undo()).toBeNull();
    expect(toLinear(h.redo()!)).toBe("a");
  });

  test("a step brings back the caret it had, and nothing left open for typing", () => {
    let s = run("x^2");
    const h = new History(empty());
    h.record(s);
    s = key(s, "+");
    h.record(s);
    const back = h.undo()!;
    expect(sketch(back)).toBe("x^{2‸}");
    // the exponent no longer closes at an operator: the caret was put back, not typed into
    expect(sketch(key(back, "+"))).toBe("x^{2+‸}");
  });

  test("a paste or a template is one step", () => {
    const h = new History(empty());
    h.record(paste(empty(), "a+b*c"));
    expect(toLinear(h.undo()!)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// For drawing
// ---------------------------------------------------------------------------

describe("hints for drawing", () => {
  test("empty slots, missing operands, faint brackets, bracketed fractions, bare scripts", () => {
    const h = hints(run("(a+"));
    expect(h.ghosts.length).toBe(1);
    expect(h.missing.length).toBe(1);
    expect(hints(run("/")).empty.length).toBe(2);
    expect(hints(run("f(")).empty.length).toBe(1);
    expect(hints(run("f(){←}")).empty.length).toBe(0);
    expect(hints(run("c*{Ctrl+.}")).missing.length).toBe(1);
    expect(hints(run("c*/")).bracketed.length).toBe(1);
    expect(hints(run("^")).noBase.length).toBe(1);
    expect(hints(run("a/")).open.length).toBe(1);
    expect(hints(run("a/{←}")).open.length).toBe(0);
  });

  test("a click puts the caret, and ends typing into open slots", () => {
    const s = run("a/b");
    const clicked = setCaret(s, { row: s.line.main.id, i: 0 });
    expect(sketch(clicked)).toBe("‸\\frac{a}{b}");
    expect(hints(clicked).open).toEqual([]);
  });
});
