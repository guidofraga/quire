// Inline math in text typed in place (#165, phase 3b): docs/07-math-editing.md § Inline math in
// text, row by row, and what holds whatever is typed across the text and its formulas. The rows
// run in inlineSim.ts: ProseMirror's state for the text, and at the boundary and in a formula the
// very functions the editor on the page runs.
import { EditorState, TextSelection } from "prosemirror-state";
import { history } from "prosemirror-history";
import { describe, expect, test } from "vitest";
import { InlineSim, paragraphs } from "./inlineSim";
import { doubleDollar, edgeKey, enterFromText, mathIndex, openAt } from "./inlineMath";
import { fromLinear, key } from "./mathTree";
import { schema, toDjot } from "./richtext";

interface Fs {
  readFileSync(p: string, enc: string): string;
  writeFileSync(p: string, s: string): void;
}
const fs: Fs = await import(/* @vite-ignore */ "node:" + "fs");
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ROOT = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "")).replace(/app\/src\/[^/]*$/, "");

// ---------------------------------------------------------------------------
// The spec's table
// ---------------------------------------------------------------------------

const SPEC = fs.readFileSync(`${ROOT}docs/07-math-editing.md`, "utf8");
const SECTION = SPEC.split("\n## Inline math in text\n")[1]?.split("\n## ")[0] ?? "";
/** A cell's code: `…`, or ``…`` when it holds a backtick. */
const code = (cell: string) => /^(`+) ?(.*?) ?\1$/u.exec(cell.trim())?.[2].replace(/\\\|/g, "|");
const ROWS = SECTION.split("\n")
  .filter((l) => l.startsWith("| `"))
  .map((l) => l.split(/(?<!\\)\|/).slice(1, -1))
  .map((c) => ({ keys: code(c[0])!, before: code(c[1])!, after: code(c[2])!, djot: code(c[3]) ?? "" }));

describe("the boundary keys (docs/07-math-editing.md § Inline math in text)", () => {
  test("has its table", () => expect(ROWS.length).toBeGreaterThan(25));
  if (env.MATHTREE_DUMP) {
    test("dump", () => {
      const lines = fs
        .readFileSync(env.MATHTREE_DUMP!, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [before, keys] = l.split(" ⇒ ");
          const sim = new InlineSim(before).keys(keys);
          const djot = sim.djot();
          const fence = djot.includes("`") ? "``" : "`";
          const pad = fence.length > 1 ? " " : "";
          return `| \`${keys}\` | \`${before}\` | \`${sim.shown()}\` | ${fence}${pad}${djot}${pad}${fence} |  |`;
        });
      fs.writeFileSync(`${env.MATHTREE_DUMP}.out`, lines.join("\n"));
    });
  }
  test.each(ROWS)("$before: $keys", ({ keys, before, after, djot }) => {
    const sim = new InlineSim(before).keys(keys);
    expect(sim.shown()).toBe(after);
    expect(sim.djot()).toBe(djot);
  });
});

// ---------------------------------------------------------------------------
// The boundary, function by function
// ---------------------------------------------------------------------------

describe("inlineMath.ts", () => {
  const at = (spec: string) => paragraphs(spec).state;

  test("← → Backspace Delete next to a formula go into it; with a selection, or apart from one, they don't", () => {
    expect(enterFromText(at("x ‸$a$"), "ArrowRight")).toEqual({ pos: 3, start: "start" });
    expect(enterFromText(at("x $a$‸"), "ArrowLeft")).toEqual({ pos: 3, start: "end" });
    expect(enterFromText(at("x $a$‸"), "Backspace")).toEqual({ pos: 3, start: "end", then: "Backspace" });
    expect(enterFromText(at("‸$a$"), "Delete")).toEqual({ pos: 1, start: "start", then: "Delete" });
    expect(enterFromText(at("x‸ $a$"), "ArrowRight")).toBeNull();
    expect(enterFromText(at("x $a$‸"), "ArrowRight")).toBeNull();
    const s = at("x $a$ y");
    const ranged = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 5)));
    expect(enterFromText(ranged, "ArrowRight")).toBeNull();
  });

  test("Backspace at a formula's first position and Delete at its last belong to the text", () => {
    const s = key(fromLinear("a/b"), "End");
    expect(edgeKey(s, "Delete")).toBe("forward");
    expect(edgeKey(s, "Backspace")).toBeNull();
    expect(edgeKey(key(s, "Home"), "Backspace")).toBe("back");
    expect(edgeKey(key(key(s, "Home"), "End", { shift: true }), "Backspace")).toBeNull();
    // after `=`, the last position is in the unit
    const shown = key(fromLinear("x ="), "End");
    expect(edgeKey(shown, "Delete")).toBe("forward");
  });

  test("$$ opens a formula; a dollar alone, a price, stays text", () => {
    const s = at("costs ‸");
    expect(doubleDollar(s, 7, 7, "$")).toBeNull();
    const twice = s.apply(s.tr.insertText("$"));
    expect(doubleDollar(twice, 8, 8, "$")).toBe(7);
    const price = at("costs $5 or ‸");
    expect(doubleDollar(price, 13, 13, "$")).toBeNull();
    const word = at("US‸");
    const w = word.apply(word.tr.insertText("$"));
    expect(doubleDollar(w, 4, 4, "$")).toBeNull();
  });

  test("a formula's number is its place among the text's inline math, empty ones and kept blocks considered", () => {
    const kept = schema.nodes.djot_block.create({
      src: "| $`k` |",
      html: '<table><tr><td><span class="qmath" data-expr="k"></span></td></tr></table>',
    });
    const p = (...exprs: string[]) =>
      schema.nodes.paragraph.create(
        null,
        exprs.map((e) => schema.nodes.math.create({ expr: e })),
      );
    const doc = schema.node("doc", null, [p("a", ""), kept, p("b")]);
    const positions: number[] = [];
    doc.descendants((n, pos) => {
      if (n.type.name === "math") positions.push(pos);
    });
    expect(positions.map((pos) => mathIndex(doc, pos))).toEqual([0, null, 2]);
  });

  test("an empty formula isn't written to the Djot while it is typed", () => {
    const doc = paragraphs("x $$ y").state.doc;
    expect(toDjot(doc, [], { dropEmptyMath: true })).toBe("x  y");
    // as before with the setting off
    expect(toDjot(doc)).toBe("x $`` y");
  });
});

// ---------------------------------------------------------------------------
// What holds whatever is typed across the text and its formulas
// ---------------------------------------------------------------------------

const KEYS = [
  ..."ab12+-*/^().= $",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "Tab",
  "Enter",
  "Escape",
  "⌘Z",
  "⌘⇧Z",
  "Inline math",
];
const STARTS = [
  "‸",
  "x ‸$a/b$ y",
  "The moment $M := q*L^2/8$‸ at midspan.",
  "$a$$b$‸",
  "a ‸ ¶ $x^2$ b ¶ c $sqrt(y)$",
  "$if(x > 0, 1, -1)$ and $[1, 2; 3, 4]$‸",
  "‸$x =$ and $e^(-t/2)$",
];
function random(seed: number) {
  return (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor(seed / 65536) % n;
  };
}
const RUNS = Number(env.INLINE_RUNS ?? 600);

/** Every position of the document a text caret walks, in order, formulas as one step each way. */
function walk(sim: InlineSim, k: "ArrowRight" | "ArrowLeft", limit: number): boolean {
  for (let n = 0; n < limit; n++) {
    const before = sim.shown();
    sim.key(k);
    if (!sim.formula && sim.shown() === before) return true;
  }
  return false;
}

describe("random keys across text and inline formulas", () => {
  test(`never throw, never trap the caret, and keep the Djot what the paragraphs say (${RUNS} runs)`, () => {
    const rand = random(165);
    let opened = 0;
    for (let run = 0; run < RUNS; run++) {
      const sim = new InlineSim(STARTS[run % STARTS.length]);
      const n = 10 + rand(40);
      for (let k = 0; k < n; k++) {
        const key = KEYS[rand(KEYS.length)];
        // Esc in the text would end the edit; here it goes on
        if (key === "Escape" && !sim.formula) continue;
        try {
          sim.key(key);
        } catch (e) {
          throw new Error(`${STARTS[run % STARTS.length]} after ${JSON.stringify(sim.log)}: ${e}`);
        }
        const where = `${STARTS[run % STARTS.length]} after ${JSON.stringify(sim.log)}`;
        if (sim.formula) opened++;
        // a formula is open exactly when the text's selection is on it
        expect(openAt(sim.state), where).toBe(sim.formula?.pos ?? null);
        // the Djot holds each formula's text, and no empty one
        const exprs: string[] = [];
        sim.state.doc.descendants((node) => {
          if (node.type.name === "math" && String(node.attrs.expr).trim()) exprs.push(String(node.attrs.expr));
        });
        const djot = sim.djot();
        const written = [...djot.matchAll(/\$(`+)(.*?)\1/gsu)].map((m) => m[2]);
        expect(written, `${where}\n${djot}`).toEqual(exprs);
      }
      // never trapped: → reaches the end of the text, ← its start, through every formula
      expect(walk(sim, "ArrowRight", 400), `→ from ${sim.shown()}`).toBe(true);
      expect(sim.state.selection.to, `${sim.shown()} after ${JSON.stringify(sim.log)}`).toBe(
        TextSelection.atEnd(sim.state.doc).to,
      );
      expect(walk(sim, "ArrowLeft", 400), `← from ${sim.shown()}`).toBe(true);
      expect(sim.state.selection.from, `${sim.shown()} after ${JSON.stringify(sim.log)}`).toBe(
        TextSelection.atStart(sim.state.doc).from,
      );
    }
    expect(opened).toBeGreaterThan(RUNS);
  });

  test("undo all the way back gives the text it started from; redo all the way, the text it ended with", () => {
    const rand = random(3);
    for (let run = 0; run < 200; run++) {
      const sim = new InlineSim(STARTS[run % STARTS.length]);
      const start = sim.djot();
      for (let k = 0; k < 25; k++) {
        const key = KEYS[rand(KEYS.length - 3)];
        if (key !== "Escape") sim.key(key);
      }
      const end = sim.djot();
      for (let k = 0; k < 200; k++) sim.key("⌘Z");
      expect(sim.djot(), JSON.stringify(sim.log)).toBe(start);
      for (let k = 0; k < 200; k++) sim.key("⌘⇧Z");
      expect(sim.djot(), JSON.stringify(sim.log)).toBe(end);
    }
  });
});

// a state built by hand is a paragraph like the spec's
test("paragraphs() reads the spec's notation", () => {
  const { state } = paragraphs("x ‸$a/b$ y ¶ z");
  expect(state.doc.childCount).toBe(2);
  expect(state.selection.from).toBe(3);
  expect(new InlineSim("x ‸$a/b$ y ¶ z").shown()).toBe("x ‸$a/b$ y ¶ z");
  expect(EditorState.create({ doc: state.doc, plugins: [history()] }).doc.eq(state.doc)).toBe(true);
});
