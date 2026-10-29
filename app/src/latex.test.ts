import { describe, expect, it } from "vitest";
import { latex } from "./latex";
import { completions, exact, isTemplate } from "./symbols";
import type { Expr } from "./types";

const id = (c: string): Expr => ({ t: "Ident", c });
const num = (c: string): Expr => ({ t: "Num", c });
const unit = (c: string): Expr => ({ t: "Unit", c });
const bin = (op: "Add" | "Mul" | "Div" | "Pow" | "Juxt", a: Expr, b: Expr): Expr => ({ t: "Binary", c: [op, a, b] });
const call = (name: string, ...args: Expr[]): Expr => ({ t: "Call", c: [name, args] });

describe("latex", () => {
  it("writes a definition with a fraction and a power", () => {
    const e: Expr = { t: "Define", c: { lhs: id("M"), rhs: bin("Div", bin("Mul", id("q"), bin("Pow", id("L"), num("2"))), num("8")), global: false } };
    expect(latex(e, null)).toBe("M := \\frac{q \\cdot {L}^{2}}{8}");
  });

  it("subscripts dotted names and spells out Greek letters", () => {
    expect(latex(id("f.y"), null)).toBe("f_{y}");
    expect(latex(id("A.net"), null)).toBe("A_{\\mathrm{net}}");
    expect(latex(id("σ"), null)).toBe("\\sigma");
    expect(latex(id("span"), null)).toBe("\\mathit{span}");
  });

  it("sets units upright with a thin space", () => {
    expect(latex(id("M"), bin("Mul", num("54"), bin("Mul", unit("kN"), unit("m"))))).toBe("M = 54 \\cdot \\mathrm{kN}\\,\\mathrm{m}");
    expect(latex(bin("Mul", num("2"), id("m")), null, ["m"])).toBe("2\\,\\mathrm{m}");
  });

  it("knows calculus and named functions", () => {
    expect(latex(call("int", id("f"), id("x"), num("0"), num("1")), null)).toBe("\\int_{0}^{1} f\\,\\mathrm{d}x");
    expect(latex(call("sqrt", id("x")), null)).toBe("\\sqrt{x}");
    expect(latex(call("sin", id("x")), null)).toBe("\\sin\\left(x\\right)");
    expect(latex(call("lsolve", id("A"), id("b")), null)).toBe("\\operatorname{lsolve}\\left(A, b\\right)");
    expect(latex(call("stdev.s", id("v")), null)).toBe("\\operatorname{stdev}_{\\mathrm{s}}\\left(v\\right)");
    expect(latex(call("Stdev", id("v")), null)).toBe("\\operatorname{Stdev}\\left(v\\right)");
  });

  it("writes symbolic series, substitutions and limits", () => {
    expect(latex(call("series", call("exp", id("x")), id("x"), num("0"), num("4")), null)).toBe(
      "\\operatorname{series}\\left(\\exp\\left(x\\right);\\; x = 0,\\; 4\\right)",
    );
    expect(latex(call("subs", bin("Pow", id("x"), num("2")), id("x"), id("a")), null)).toBe("\\left.{x}^{2}\\right|_{x = a}");
    expect(latex(call("lim", call("exp", id("x")), id("x"), { t: "Unary", c: ["Neg", id("∞")] }), id("∞"))).toBe(
      "\\lim_{x\\to -\\infty} \\exp\\left(x\\right) = \\infty",
    );
  });

  it("writes comparisons and matrices", () => {
    expect(latex({ t: "Compare", c: [id("σ"), [["Le", id("f.y")]]] }, null)).toBe("\\sigma \\le f_{y}");
    expect(latex({ t: "Matrix", c: [[num("1"), num("2")], [num("3"), num("4")]] }, null)).toBe(
      "\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}",
    );
  });

  it("does not leak units into the next call", () => {
    latex(id("m"), null, ["m"]);
    expect(latex(id("m"), null)).toBe("m");
  });
});

describe("symbols", () => {
  it("finds a symbol by its LaTeX name", () => {
    expect(exact("alpha")?.insert).toBe("α");
    expect(exact("Delta")?.insert).toBe("Δ");
    expect(exact("nosuchthing")).toBeUndefined();
  });

  it("puts the exact match first, then shorter names", () => {
    expect(completions("eps").map((s) => s.name)).toEqual(["epsilon"]);
    const names = completions("var").map((s) => s.name);
    expect(names).toContain("varepsilon");
    expect(names.map((n) => n.length)).toEqual([...names.map((n) => n.length)].sort((a, b) => a - b));
    expect(completions("alpha")[0].name).toBe("alpha");
  });

  it("matches case-insensitively after case-sensitive matches", () => {
    const names = completions("delta").map((s) => s.name);
    expect(names.indexOf("delta")).toBeLessThan(names.indexOf("Delta"));
  });

  it("lists commands only where they apply", () => {
    expect(completions("te", 8, "math")[0].command).toBe("to_text");
    expect(completions("te", 8, "text").some((s) => s.command)).toBe(false);
    expect(completions("ma", 8, "text")[0].command).toBe("insert_math");
  });

  it("respects the limit", () => {
    expect(completions("", 5)).toHaveLength(5);
  });

  it("tells templates from plain symbols", () => {
    expect(isTemplate(exact("sqrt")!)).toBe(true);
    expect(isTemplate(exact("alpha")!)).toBe(false);
  });
});
