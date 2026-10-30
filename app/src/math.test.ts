// SMath programs (block, if, for, while, sys) drawn as rows, and the same programs read aloud.
import { describe, expect, it } from "vitest";
import { mathml } from "./math";
import { spokenMath } from "./speech";
import type { Expr } from "./types";

const num = (c: string): Expr => ({ t: "Num", c });
const id = (c: string): Expr => ({ t: "Ident", c });
const call = (name: string, ...args: Expr[]): Expr => ({ t: "Call", c: [name, args] });
const define = (lhs: string, rhs: Expr): Expr => ({ t: "Define", c: { lhs: id(lhs), rhs, global: false } });
const rowsOf = (html: string) => (html.match(/<mtr>/g) ?? []).length;

describe("programs as rows", () => {
  it("draws a block as a left-aligned column with a rule", () => {
    const html = mathml(call("block", define("x", num("1")), define("y", num("2"))));
    expect(html).toContain('class="q-program"');
    expect(html).toContain('columnalign="left"');
    expect(rowsOf(html)).toBe(2);
    expect(html).not.toContain("block");
  });

  it("draws an if with assignments as if, indented body, else, indented body", () => {
    const html = mathml(
      call("if", { t: "Compare", c: [id("path"), [["Eq", num("0")]]] }, define("p", num("1")), define("p", num("2"))),
    );
    expect(html).toContain('class="q-stack"');
    expect(html.indexOf(">if<")).toBeGreaterThan(-1);
    expect(html.indexOf(">if<")).toBeLessThan(html.indexOf(">else<"));
    expect(html.indexOf(">else<")).toBeLessThan(html.lastIndexOf("≔"));
    expect(rowsOf(html)).toBe(4);
  });

  it("draws a two-argument if without else", () => {
    const html = mathml(call("if", id("c"), define("p", num("1"))));
    expect(rowsOf(html)).toBe(2);
    expect(html).not.toContain("else");
  });

  it("keeps a plain if inside arithmetic on one line", () => {
    const html = mathml({ t: "Binary", c: ["Add", num("1"), call("if", id("c"), num("1"), num("2"))] });
    expect(html).not.toContain("q-stack");
    expect(html).toContain("<mo>+</mo>");
  });

  it("draws a plain if as rows when it is a statement of a block", () => {
    const html = mathml(call("block", define("x", num("0")), call("if", id("c"), num("1"), num("2"))));
    expect(html).toContain('class="q-stack"');
    expect(html).toContain(">else<");
  });

  it("draws a for loop header with its body indented", () => {
    const html = mathml(call("for", id("i"), { t: "Range", c: [num("1"), id("n")] }, define("s", id("i"))));
    expect(html).toContain("∈");
    expect(html).toContain(">for<");
    expect(html).toContain('class="q-stack"');
    expect(rowsOf(html)).toBe(2);
  });

  it("draws a C-style for and a while loop", () => {
    const cFor = mathml(
      call(
        "for",
        define("i", num("0")),
        { t: "Compare", c: [id("i"), [["Lt", num("5")]]] },
        define("i", num("1")),
        define("s", id("i")),
      ),
    );
    expect(cFor).toContain(">for<");
    expect(cFor).not.toContain("∈");
    const loop = mathml(call("while", id("go"), define("x", num("1"))));
    expect(loop).toContain(">while<");
    expect(rowsOf(loop)).toBe(2);
  });

  it("draws a block body inside a loop as a nested column", () => {
    const html = mathml(call("while", id("go"), call("block", define("x", num("1")))));
    expect(html.match(/class="q-program"/g)?.length).toBe(1);
  });

  it("draws a sys as its elements under a brace, without rows and cols", () => {
    const html = mathml(call("sys", id("A"), id("B"), num("3"), num("1")));
    expect(html).toContain('stretchy="true"');
    expect(html).toContain("{");
    expect(rowsOf(html)).toBe(2);
    expect(html).not.toContain("<mn>3</mn>");
    expect(html).not.toContain("<mn>1</mn>");
  });

  it("puts the header of a block in its first row, in the same table", () => {
    const html = mathml(define("f", call("block", define("x", num("1")), define("y", num("2")))));
    expect(html.match(/<mtable/g)?.length).toBe(1);
    const table = html.indexOf('<mtable class="q-program"');
    const op = html.indexOf("≔");
    expect(table).toBeGreaterThan(-1);
    expect(op).toBeGreaterThan(table);
    expect(op).toBeLessThan(html.indexOf('class="q-body"'));
    expect(rowsOf(html)).toBe(2);
  });

  it("nests blocks", () => {
    const html = mathml(call("block", define("x", num("1")), call("block", define("y", num("2")))));
    expect(html.match(/class="q-program"/g)?.length).toBe(2);
  });
});

describe("programs in words", () => {
  it("reads a block as first, then", () => {
    const block = call("block", define("x", num("1")), define("y", num("2")));
    expect(spokenMath(block)).toBe("block: first x is defined as 1; then y is defined as 2");
  });

  it("reads an if with its else", () => {
    const branch = call("if", id("c"), define("x", num("1")), define("x", num("2")));
    expect(spokenMath(branch)).toBe("if c, then x is defined as 1, otherwise x is defined as 2");
  });

  it("reads loops and systems", () => {
    expect(spokenMath(call("for", id("i"), { t: "Range", c: [num("1"), id("n")] }, define("s", id("i"))))).toBe(
      "for each i in 1 to n, do s is defined as i",
    );
    expect(spokenMath(call("while", id("go"), define("x", num("1"))))).toBe("while go, do x is defined as 1");
    expect(spokenMath(call("sys", id("A"), id("B"), num("3"), num("1")))).toBe("system of A, B");
  });
});
