// Small text helpers: design-check verdicts, names under the caret, result formatting, pasted cells.
import { describe, expect, it } from "vitest";
import { isComparison, verdictOf } from "./checks";
import { groupDigits, mathml, prettyValue } from "./math";
import { nameAt } from "./trace";
import { parseTsv } from "./TableEditor";
import type { Expr } from "./types";

describe("verdictOf", () => {
  it.each(["OK", "ok", '"OK"', " Pass ", "passed", "atende", "cumple", "erfüllt", "sí"])("%j passes", (t) => {
    expect(verdictOf(t)).toBe(true);
  });
  it.each(["FAIL", "fails", '"NG"', "not ok", "não atende", "no cumple", "nein"])("%j fails", (t) => {
    expect(verdictOf(t)).toBe(false);
  });
  it.each(["", null, undefined, "maybe", "OK then", "12 kN"])("%j is no verdict", (t) => {
    expect(verdictOf(t)).toBeNull();
  });
});

describe("isComparison", () => {
  const cmp: Expr = { t: "Compare", c: [{ t: "Ident", c: "σ" }, [["Le", { t: "Ident", c: "f.y" }]]] };
  it("recognises plain and defined comparisons", () => {
    expect(isComparison(cmp)).toBe(true);
    expect(isComparison({ t: "Define", c: { lhs: { t: "Ident", c: "ok" }, rhs: cmp, global: false } })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isComparison({ t: "Ident", c: "σ" })).toBe(false);
    expect(
      isComparison({ t: "Define", c: { lhs: { t: "Ident", c: "x" }, rhs: { t: "Num", c: "1" }, global: false } }),
    ).toBe(false);
    expect(isComparison(null)).toBe(false);
  });
});

describe("nameAt", () => {
  const line = "M := q*L.span^2/8";
  it("finds the dotted name around the caret", () => {
    expect(nameAt(line, line.indexOf("L"))).toBe("L.span");
    expect(nameAt(line, line.indexOf("span") + 2)).toBe("L.span");
    expect(nameAt(line, 0)).toBe("M");
    expect(nameAt(line, 1)).toBe("M");
  });
  it("ignores numbers, operators and unit marks", () => {
    expect(nameAt(line, line.indexOf("2"))).toBeNull();
    expect(nameAt(line, line.indexOf(":") + 1)).toBeNull();
    expect(nameAt("10*'m", 4)).toBeNull();
  });
  it("reads non-Latin names", () => {
    expect(nameAt("σ.max := 3", 2)).toBe("σ.max");
  });
});

describe("groupDigits", () => {
  it("groups from five digits on", () => {
    expect(groupDigits("1234")).toBe("1234");
    expect(groupDigits("12500")).toBe("12 500");
    expect(groupDigits("-1234567.891")).toBe("-1 234 567.891");
  });
});

describe("prettyValue", () => {
  it("drops unit marks and writes powers and products", () => {
    expect(prettyValue("9.80665 'm/'s^2")).toBe("9.80665 m/s²");
    expect(prettyValue("54 'kN*'m")).toBe("54 kN·m");
    expect(prettyValue("1.5*10^-3 'm^(-1)")).toBe("1.5·10⁻³ m⁻¹");
  });
});

describe("mathml", () => {
  const num = (c: string): Expr => ({ t: "Num", c });
  const unit = (c: string): Expr => ({ t: "Unit", c });
  const mul = (a: Expr, b: Expr): Expr => ({ t: "Binary", c: ["Mul", a, b] });
  const tightDot = '<mo lspace="0" rspace="0">·</mo>';
  it("writes compound units with a dot, as unit lists and plots do", () => {
    expect(mathml(mul(mul(num("54"), unit("kN")), unit("m")))).toContain(tightDot);
    expect(mathml(mul(unit("kN"), unit("m")))).toContain(tightDot);
  });
  it("keeps a number and its unit side by side", () => {
    expect(mathml(mul(num("5.1"), unit("m")))).not.toContain("·");
  });
});

describe("parseTsv", () => {
  it("splits rows and cells", () => {
    expect(parseTsv("a\tb\r\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("unquotes Excel-quoted cells", () => {
    expect(parseTsv('"say ""hi"""\t"two\nlines"')).toEqual([['say "hi"', "two\nlines"]]);
  });
  it("keeps empty cells", () => {
    expect(parseTsv("\tx\t")).toEqual([["", "x", ""]]);
  });
});

describe("parseTsv edge cases", () => {
  it("reads what copying cells writes", () => {
    expect(parseTsv('a\t"x\ty"\n"1\n2"\tb')).toEqual([
      ["a", "x\ty"],
      ["1\n2", "b"],
    ]);
  });
  it("keeps a stray quote that does not close a cell as text", () => {
    expect(parseTsv('5" pipe\tb\n"open')).toEqual([['5" pipe', "b"], ['"open']]);
  });
  it("reads an empty clipboard as one empty cell", () => {
    expect(parseTsv("")).toEqual([[""]]);
  });
});
