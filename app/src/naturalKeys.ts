// For tests (mathTree.test.ts, mathTree.engine.test.ts): the keys that type a program as a
// person writes it in the 2D editor, with keywords and Enter rather than its linear text
// (docs/07-math-editing.md § Typing programs): `if x > 0` Enter `1` Enter `else` Enter `-1`.
// Parts with no keyword form (a condition, a one-line `if` inside a sum) are typed as text.
import { print } from "./mathLinear";
import type { Expr } from "./types";

type Call = { t: "Call"; c: [string, Expr[]] };
const isCall = (e: Expr, name: string): boolean => e.t === "Call" && e.c[0] === name;
const argsOf = (e: Expr) => (e as Call).c[1];
const ifArgs = (e: Expr) => isCall(e, "if") && (argsOf(e).length === 2 || argsOf(e).length === 3);
/**
 * A block typed line by line: two lines or more (one line is its statement alone), the first not
 * a block itself (a value holding just a block is that block's lines).
 */
const lines = (e: Expr) => isCall(e, "block") && argsOf(e).length >= 2 && !isCall(argsOf(e)[0], "block");
/** A program with a keyword form: `if`, `for i in range`, `while`. */
function typable(e: Expr): boolean {
  if (ifArgs(e)) return true;
  if (isCall(e, "for")) return argsOf(e).length === 3 && argsOf(e)[0].t === "Ident";
  return isCall(e, "while") && argsOf(e).length === 2;
}

/** `if c1` / v1 / `else if c2` / v2 / `else` / v3: the chain's branches and its else. */
function chain(e: Call): { pairs: [Expr, Expr][]; other: Expr | null } {
  const pairs: [Expr, Expr][] = [];
  let a = e.c[1];
  for (;;) {
    pairs.push([a[0], a[1]]);
    if (a.length === 3 && ifArgs(a[2])) {
      a = (a[2] as Call).c[1];
      continue;
    }
    return { pairs, other: a.length === 3 ? a[2] : null };
  }
}

/** How many levels below its own line the caret ends after typing `e` (Enter climbs one each). */
function depth(e: Expr): number {
  if (e.t === "Define") return typable(e.c.rhs) ? depth(e.c.rhs) : 0;
  if (!typable(e)) return 0;
  const c = e as Call;
  if (c.c[0] === "if") {
    const { pairs, other } = chain(c);
    if (other && lines(other) && ifArgs(argsOf(other)[0])) return 1;
    return 1 + bodyDepth(other ?? pairs[pairs.length - 1][1]);
  }
  return 1 + bodyDepth(c.c[1][c.c[1].length - 1]);
}
const bodyDepth = (v: Expr) => (lines(v) ? depth((v as Call).c[1].at(-1)!) : depth(v));

const text = (e: Expr) => [...print(e)];
const enters = (n: number) => Array<string>(n).fill("Enter");

/** A line: a program by its keywords, a definition of one after its `:=`, anything else as text. */
function item(e: Expr): string[] {
  if (e.t === "Define" && typable(e.c.rhs)) return [...text(e.c.lhs), e.c.global ? "~" : ":", ...program(e.c.rhs)];
  return typable(e) ? program(e) : text(e);
}

/** A branch's or a body's value: its lines, Enter between them. */
function body(v: Expr): string[] {
  if (!lines(v)) return item(v);
  const ss = (v as Call).c[1];
  return ss.flatMap((s, k) => (k ? [...enters(1 + depth(ss[k - 1])), ...item(s)] : item(s)));
}

function program(e: Expr): string[] {
  const [name, args] = (e as Call).c;
  if (name === "while") return [..."while ", ...text(args[0]), "Enter", ...body(args[1])];
  if (name === "for") return [..."for ", ...text(args[0]), ..." in ", ...text(args[1]), "Enter", ...body(args[2])];
  const { pairs, other } = chain(e as Call);
  const out: string[] = [];
  pairs.forEach(([c, v], k) => {
    if (k) out.push(...enters(1 + bodyDepth(pairs[k - 1][1])), ..."else if ");
    else out.push(..."if ");
    out.push(...text(c), "Enter", ...body(v));
  });
  // `else` then `if ` is `else if`: an else whose lines start with an `if` is typed as its text
  const otherKeys = (v: Expr) => (lines(v) && ifArgs(argsOf(v)[0]) ? text(v) : body(v));
  if (other) out.push(...enters(1 + bodyDepth(pairs[pairs.length - 1][1])), ..."else", "Enter", ...otherKeys(other));
  return out;
}

/**
 * The keys of `e` typed as a person writes it, from an empty formula: a definition whose body is
 * a block starts it with Enter after `:=`. Null when `e` has no program to type so.
 */
export function naturalKeys(e: Expr): string[] | null {
  if (e.t === "Define" && lines(e.c.rhs)) return [...text(e.c.lhs), e.c.global ? "~" : ":", "Enter", ...body(e.c.rhs)];
  if (e.t === "Define" ? !typable(e.c.rhs) : !typable(e)) return null;
  return item(e);
}
