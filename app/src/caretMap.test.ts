import { describe, expect, it } from "vitest";
import { pair, tokensOf } from "./caretMap";

const shows = (src: string) => tokensOf(src).map((t) => t.shows);
const pieces = (...texts: string[]) => texts.map((textContent) => ({ textContent }));

describe("matching a typed math line to its drawn formula", () => {
  it("splits a line into the tokens the formula draws, where each was typed", () => {
    expect(shows("M := q*L^2/8")).toEqual(["M", "≔", "q", "·", "L", "^", "2", "/", "8"]);
    expect(tokensOf("A.net := 12 'kN")).toEqual([
      { from: 0, to: 1, shows: "A" },
      { from: 2, to: 5, shows: "net" },
      { from: 6, to: 8, shows: "≔" },
      { from: 9, to: 11, shows: "12" },
      { from: 12, to: 15, shows: "kN" },
    ]);
    expect(shows('s := "a b" + x - 1.5e3')).toEqual(["s", "≔", '"a b"', "+", "x", "−", "1.5e3"]);
    expect(shows("a <= b != ?")).toEqual(["a", "≤", "b", "≠", "□"]);
  });

  it("pairs tokens with pieces, skipping what is drawn as no piece", () => {
    // q*L^2/8: the ^ and / become the power and the fraction, not pieces
    const t = tokensOf("M := q*L^2/8");
    const drawn = pieces("M", "≔", "q", "·", "L", "2", "8");
    const pairs = pair(t, drawn).map(([tok, k]) => [tok.shows, k]);
    expect(pairs).toEqual([
      ["M", 0],
      ["≔", 1],
      ["q", 2],
      ["·", 3],
      ["L", 4],
      ["2", 5],
      ["8", 6],
    ]);
  });

  it("matches grouped digits and skips a call's name drawn as a sign", () => {
    expect(pair(tokensOf("x := 12500"), pieces("x", "≔", "12 500")).length).toBe(3);
    // sqrt( … ) is a radical: its name and brackets are no pieces
    const pairs = pair(tokensOf("y := sqrt(2)"), pieces("y", "≔", "2"));
    expect(pairs.map(([tok]) => tok.shows)).toEqual(["y", "≔", "2"]);
  });
});
