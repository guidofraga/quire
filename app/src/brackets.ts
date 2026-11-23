// The grouping brackets of a math line being typed, for its typeset preview: the pair at the
// caret is highlighted, and a `)` not typed yet (the preview closes it, #164) is drawn faint.
import { createSignal } from "solid-js";
import type { Expr } from "./types";

/** Where the caret is in the math line being typed, and whose view draws that line. */
export const [mathCaret, setMathCaret] = createSignal<{ view: string; at: number } | null>(null);

export interface Brackets {
  /** The grouping pair at the caret, by its order in the line (0 = the first `(`). */
  match: number | null;
  /** Grouping pairs whose `)` hasn't been typed yet. */
  open: Set<number>;
  /** How many grouping pairs the line has. */
  count: number;
}

/**
 * The grouping brackets of `src`, `(a + b)`, told from a call's (`f(x)`, `sqrt(2)`) by what comes
 * before them, as the parser does: a name or a number right before `(` makes it a call's.
 * Strings are skipped. `caret` picks the pair next to the caret, or failing that the innermost
 * pair around it.
 */
export function bracketsOf(src: string, caret: number | null): Brackets {
  const stack: { group: number | null; at: number }[] = [];
  const pairs: { group: number; from: number; to: number | null }[] = [];
  let count = 0;
  let inString = false;
  let last = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      last = c;
      continue;
    }
    if (c === "(" || c === "[") {
      const call = c === "[" || /[\p{L}\p{N}_.'°]/u.test(last);
      const group = call ? null : count++;
      stack.push({ group, at: i });
      if (group !== null) pairs.push({ group, from: i, to: null });
    } else if (c === ")" || c === "]") {
      const open = stack.pop();
      if (open?.group != null) pairs[open.group].to = i;
    }
    if (!/\s/.test(c)) last = c;
  }
  const open = new Set(pairs.filter((p) => p.to === null).map((p) => p.group));
  let match: number | null = null;
  if (caret !== null) {
    // the bracket just before the caret, then just after it, as code editors do
    const touching = (i: number) => pairs.find((p) => p.from === i || p.to === i);
    const next = touching(caret - 1) ?? touching(caret);
    if (next) match = next.group;
    else {
      const around = pairs.filter((p) => p.from < caret && (p.to === null || p.to >= caret));
      match = around.at(-1)?.group ?? null;
    }
  }
  return { match, open, count };
}

/**
 * The tree's `Paren` nodes numbered in reading order: the order their `(` comes in the line,
 * which is the order `bracketsOf` counts them.
 */
export function numberParens(e: Expr): Map<Expr, number> {
  const out = new Map<Expr, number>();
  const walk = (x: Expr) => {
    switch (x.t) {
      case "Paren":
        out.set(x, out.size);
        return walk(x.c);
      case "Unary":
        return walk(x.c[1]);
      case "Factorial":
        return walk(x.c);
      case "Binary":
        walk(x.c[1]);
        return walk(x.c[2]);
      case "Compare":
        walk(x.c[0]);
        return x.c[1].forEach(([, y]) => walk(y));
      case "Call":
        return x.c[1].forEach(walk);
      case "Index":
        walk(x.c[0]);
        return x.c[1].forEach(walk);
      case "Matrix":
        return x.c.forEach((row) => row.forEach(walk));
      case "Range":
        walk(x.c[0]);
        return walk(x.c[1]);
      case "Define":
        walk(x.c.lhs);
        return walk(x.c.rhs);
    }
  };
  walk(e);
  return out;
}

/**
 * Light up the bracket pair at the caret in drawn math (`mo[data-p]`, see math.ts), on the
 * elements already there: drawing the math again at every caret move would replace what is
 * under the mouse, and a double-click on it would be lost.
 */
export function highlightPair(el: Element | undefined, src: string, caret: number | null) {
  if (!el) return;
  const k = caret === null ? null : bracketsOf(src, caret).match;
  for (const mo of el.querySelectorAll("mo[data-p]"))
    mo.classList.toggle("bmatch", mo.getAttribute("data-p") === `${k}`);
}
