import { describe, expect, it } from "vitest";
import { bracketsOf, numberParens } from "./brackets";
import type { Expr } from "./types";

describe("the grouping brackets of a line being typed", () => {
  it("tells grouping brackets from a call's and an index's", () => {
    expect(bracketsOf("q*(L - x)/2", null).count).toBe(1);
    expect(bracketsOf("sqrt(x) + f (y)", null).count).toBe(0);
    expect(bracketsOf("v[i] + [1; 2]", null).count).toBe(0);
    expect(bracketsOf("((a))", null).count).toBe(2);
    // a bracket in a string is text
    expect(bracketsOf('s := "(" + (a)', null).count).toBe(1);
  });

  it("finds the pair next to the caret, else the innermost one around it", () => {
    const line = "(a + (b - c)) * d";
    // just after the inner `)`
    expect(bracketsOf(line, 12).match).toBe(1);
    // just before the outer `(`
    expect(bracketsOf(line, 0).match).toBe(0);
    // inside the outer pair, away from any bracket
    expect(bracketsOf(line, 2).match).toBe(0);
    // outside every pair
    expect(bracketsOf(line, 16).match).toBe(null);
  });

  it("knows which brackets are not closed yet", () => {
    expect([...bracketsOf("q*(L - (x", null).open]).toEqual([0, 1]);
    expect([...bracketsOf("q*(L - (x)", null).open]).toEqual([0]);
    expect(bracketsOf("q*(L - x)", null).open.size).toBe(0);
  });

  it("numbers the tree's brackets in the order their ( comes", () => {
    const inner: Expr = { t: "Paren", c: { t: "Ident", c: "b" } };
    const outer: Expr = { t: "Paren", c: { t: "Binary", c: ["Add", { t: "Ident", c: "a" }, inner] } };
    const last: Expr = { t: "Paren", c: { t: "Ident", c: "d" } };
    const e: Expr = { t: "Binary", c: ["Mul", outer, last] };
    const ids = numberParens(e);
    expect([ids.get(outer), ids.get(inner), ids.get(last)]).toEqual([0, 1, 2]);
  });
});
