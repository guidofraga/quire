import { describe, expect, test } from "vitest";
import { deletedWords, placeWords } from "./mathPlace";
import { empty, fromLinear, insertTemplate, key, type EditState } from "./mathTree";

const names = { units: ["kN", "m"], constants: [] };
const typed = (keys: string[], s: EditState = empty()) => keys.reduce((t, k) => key(t, k), s);
const said = (s: EditState) => placeWords(s, names)?.words;

describe("where the caret is, in words", () => {
  test("a fraction's slots, with the fraction read out", () => {
    const s = typed([..."q*L^2/8"]);
    expect(said(s)).toBe("in the denominator of q times L squared over 8");
    expect(said(key(s, "ArrowUp"))).toBe("in the numerator of q times L squared over 8");
  });

  test("scripts, roots and the main line", () => {
    expect(said(typed([..."x^2"]))).toBe("in the exponent");
    expect(said(typed([..."A.net"]))).toBe("in the subscript");
    expect(said(typed([..."sqrt(x"]))).toBe("under the square root");
    expect(said(typed([..."x^2+1"]))).toBe("on the main line");
    expect(said(typed([..."x="]))).toBe("in the unit of the result");
  });

  test("a long structure is not read out: where the caret is comes first", () => {
    expect(said(typed([..."a*b*c*d*e*f*g*h/"]))).toBe("in the denominator");
  });

  test("the branches of an if, a block's lines, a loop's parts", () => {
    const chain = insertTemplate(empty(), "if(?, ?, if(?, ?, ?))");
    const at = (n: number) => typed(Array(n).fill("Tab"), chain);
    expect(said(chain)).toBe("in the if condition");
    expect(said(at(1))).toBe("in the if branch");
    expect(said(at(2))).toBe("in the else if condition");
    expect(said(at(3))).toBe("in the else if branch");
    expect(said(at(4))).toBe("in the else branch");
    const block = key(key(fromLinear("block(a, b)"), "End"), "ArrowLeft");
    expect(said(block)).toBe("on line 2 of 2 of the block");
    expect(said(key(block, "Enter"))).toBe("on line 3 of 3 of the block");
    const loop = insertTemplate(empty(), "for(?, ?, ?)");
    expect(said(loop)).toBe("in the loop variable");
    expect(said(key(loop, "Tab"))).toBe("in the range");
    expect(said(typed(["Tab", "Tab"], loop))).toBe("in the loop body");
  });

  test("the key changes only when the caret goes to another slot, not as it is typed into", () => {
    const s = typed([..."a/b"]);
    const k = placeWords(s, names)!.key;
    expect(placeWords(key(s, "c"), names)!.key).toBe(k);
    expect(placeWords(key(s, "ArrowUp"), names)!.key).not.toBe(k);
  });
});

describe("what a key deleted, in words", () => {
  test("characters, structures, lines and branches", () => {
    expect(deletedWords(typed([..."ab", "Backspace"]).effect!.deleted!, names)).toBe("deleted b");
    expect(deletedWords(typed([..."a+", "Backspace"]).effect!.deleted!, names)).toBe("deleted plus");
    expect(deletedWords(typed([..."a/", "Backspace"]).effect!.deleted!, names)).toBe("removed the fraction");
    const sel = typed([..."2*x", "ArrowLeft", "ArrowLeft", "ArrowLeft"]);
    const cut = key(
      key(key(key(sel, "ArrowRight", { shift: true }), "ArrowRight", { shift: true }), "ArrowRight", { shift: true }),
      "Backspace",
    );
    expect(deletedWords(cut.effect!.deleted!, names)).toBe("deleted 2 times x");
    const block = key(key(key(fromLinear("block(a, b)"), "End"), "ArrowLeft"), "Enter");
    expect(deletedWords(key(block, "Backspace").effect!.deleted!, names)).toBe("removed line 3");
    const chain = key(fromLinear("if(a, 1, if(b, 2, 3))"), "End");
    const del = typed(["ArrowLeft", "Backspace", "Backspace"], chain);
    expect(deletedWords(del.effect!.deleted!, names)).toBe("removed the else branch");
  });
});
