import { describe, expect, it } from "vitest";
import { spokenMath, spokenName, unitWord } from "./speech";
import type { Expr } from "./types";

const num = (c: string): Expr => ({ t: "Num", c });
const id = (c: string): Expr => ({ t: "Ident", c });
const unit = (c: string): Expr => ({ t: "Unit", c });
const bin = (op: Extract<Expr, { t: "Binary" }>["c"][0], a: Expr, b: Expr): Expr => ({ t: "Binary", c: [op, a, b] });
const define = (lhs: Expr, rhs: Expr): Expr => ({ t: "Define", c: { lhs, rhs, global: false } });

describe("math in words", () => {
  it("reads a definition with its result in units", () => {
    // M := q*L^2/8 = 54 kN·m
    const input = define(id("M"), bin("Div", bin("Mul", id("q"), bin("Pow", id("L"), num("2"))), num("8")));
    const result = bin("Juxt", num("54"), bin("Mul", unit("kN"), unit("m")));
    expect(spokenMath(input, result)).toBe("M is defined as q times L squared over 8, equals 54 kilonewton metres");
  });

  it("reads plain names as units where the engine says they are", () => {
    // q := 12 kN/m
    const input = define(id("q"), bin("Div", bin("Juxt", num("12"), id("kN")), id("m")));
    expect(spokenMath(input, null, ["kN", "m"])).toBe("q is defined as 12 kilonewtons per metre");
    // m is a variable here: m*g
    expect(spokenMath(bin("Mul", id("m"), id("g")), null, [], ["g"])).toBe("m times g");
  });

  it("reads per and powers of units", () => {
    const g = bin("Div", bin("Juxt", num("9.81"), unit("m")), bin("Pow", unit("s"), num("2")));
    expect(spokenMath(id("a"), g)).toBe("a, equals 9.81 metres per second squared");
    expect(spokenMath(bin("Juxt", num("1"), unit("m")))).toBe("1 metre");
    // how results come back: (54 kN)·m
    expect(spokenMath(bin("Mul", bin("Juxt", num("54"), unit("kN")), unit("m")))).toBe("54 kilonewton metres");
  });

  it("reads functions, comparisons and symbolic results", () => {
    const check: Expr = { t: "Compare", c: [id("σ"), [["Le", id("f.y")]]] };
    expect(spokenMath(check)).toBe("sigma is less than or equal to f y");
    const root: Expr = { t: "Call", c: ["sqrt", [bin("Add", id("a"), id("b"))]] };
    expect(spokenMath(root)).toBe("square root of a plus b");
    const d: Expr = { t: "Call", c: ["diff", [{ t: "Call", c: ["M", [id("x")]] }, id("x")]] };
    expect(spokenMath(d, id("V"), [], [], true)).toBe("derivative of M of (x) with respect to x, gives V");
  });

  it("names Greek letters and subscripts", () => {
    expect(spokenName("Δx")).toBe("capital delta x");
    expect(spokenName("A.net")).toBe("A net");
    expect(spokenName("ε_cu")).toBe("epsilon cu");
  });

  it("expands SI prefixes and leaves unknown units alone", () => {
    expect(unitWord("MPa")).toBe("megapascal");
    expect(unitWord("mm", true)).toBe("millimetres");
    expect(unitWord("kgf")).toBe("kilogram-force");
    expect(unitWord("ft", true)).toBe("feet");
    expect(unitWord("xyz")).toBe("xyz");
  });
});
