import { describe, expect, it } from "vitest";
import { findOpen, hits, query, replaceHits, replacement, setFindOpen, setQuery, setReplacement } from "./find";
import { loadDoc, setState, state, undo } from "./store";
import type { RegionView } from "./types";

describe("find and replace across region kinds", () => {
  it("finds and replaces in math, solve blocks and spreadsheet tables as one undo step", () => {
    loadDoc(
      {
        format: "quire/1",
        regions: [
          { id: "m1", kind: "math", at: [0, 0], expr: "L := 6 m" },
          {
            id: "s1",
            kind: "solve",
            at: [0, 40],
            guesses: ["L := 5 m"],
            given: ["L > 0 m"],
            find: "L := find(L)",
          },
          {
            id: "t1",
            kind: "table",
            at: [0, 160],
            rows: [
              ["Span L", "=L*2"],
              ["Half", "=L/2"],
            ],
          },
        ],
      },
      null,
    );
    setFindOpen(true);
    setQuery("L");
    setReplacement("span");
    expect(hits()).toEqual([
      { id: "m1", count: 1 },
      { id: "s1", count: 4 },
      { id: "t1", count: 3 },
    ]);
    const replaced = replaceHits(["m1", "s1", "t1"]);
    expect(replaced).toBe(8);
    expect(state.doc.regions[0].expr).toBe("span := 6 m");
    expect(state.doc.regions[1].guesses).toEqual(["span := 5 m"]);
    expect(state.doc.regions[1].given).toEqual(["span > 0 m"]);
    expect(state.doc.regions[1].find).toBe("span := find(span)");
    expect(state.doc.regions[2].rows).toEqual([
      ["Span span", "=span*2"],
      ["Half", "=span/2"],
    ]);
    undo();
    expect(state.doc.regions[0].expr).toBe("L := 6 m");
    expect(state.doc.regions[1].find).toBe("L := find(L)");
    expect(state.doc.regions[2].rows?.[0]).toEqual(["Span L", "=L*2"]);
    setFindOpen(false);
    setQuery("");
    setReplacement("");
    expect(findOpen()).toBe(false);
    expect(query()).toBe("");
    expect(replacement()).toBe("");
  });

  it("finds the results shown on the page, and replaces only what was typed (#155)", () => {
    loadDoc(
      {
        format: "quire/1",
        regions: [
          { id: "m1", kind: "math", at: [0, 0], expr: "M := q*L^2/8", show: "value" },
          { id: "m2", kind: "math", at: [0, 40], expr: "V := 330 kN" },
          {
            id: "t1",
            kind: "table",
            at: [0, 80],
            rows: [
              ["120 kN", "=SUM(A1:A2)"],
              ["210 kN", "x"],
            ],
          },
        ],
      },
      null,
    );
    const view = (id: string, more: Partial<RegionView>) => ({ id, error: null, resultText: null, ...more });
    setState("views", {
      m1: view("m1", { resultText: "123.11 kN*m" }),
      // a definition without `=` shows no result, though the engine works one out
      m2: view("m2", { resultText: "330 kN" }),
      t1: view("t1", {
        cells: [
          [
            { result: null, text: "120 kN", error: null, formula: false },
            { result: null, text: "330 kN", error: null, formula: true },
          ],
        ],
      }),
    } as unknown as Record<string, RegionView>);
    setFindOpen(true);
    setQuery("123.11");
    expect(hits()).toEqual([{ id: "m1", count: 1 }]);
    // as the page writes the unit
    setQuery("kN·m");
    expect(hits()).toEqual([{ id: "m1", count: 1 }]);
    // the worked-out cell, and the typed 330 in m2, but not m2's unshown result
    setQuery("330");
    expect(hits()).toEqual([
      { id: "m2", count: 1 },
      { id: "t1", count: 1 },
    ]);
    // Replace changes only what was typed: the formula, never the shown value
    setReplacement("440");
    expect(replaceHits(["m2", "t1"])).toBe(1);
    expect(state.doc.regions[1].expr).toBe("V := 440 kN");
    expect(state.doc.regions[2].rows?.[0]).toEqual(["120 kN", "=SUM(A1:A2)"]);
    setFindOpen(false);
    setQuery("");
    setReplacement("");
  });
});
