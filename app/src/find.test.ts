import { describe, expect, it } from "vitest";
import { findOpen, hits, query, replaceHits, replacement, setFindOpen, setQuery, setReplacement } from "./find";
import { loadDoc, state, undo } from "./store";

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
          {
            id: "sk1",
            kind: "sketch",
            at: [0, 260],
            elements: [
              { type: "member", from: ["0 m", "0 m"], to: ["L", "0 m"] },
              { type: "udl", from: ["0 m", "0 m"], to: ["L", "0 m"], label: "Span {L}" },
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
      { id: "sk1", count: 3 },
    ]);
    const replaced = replaceHits(["m1", "s1", "t1", "sk1"]);
    expect(replaced).toBe(11);
    expect(state.doc.regions[0].expr).toBe("span := 6 m");
    expect(state.doc.regions[1].guesses).toEqual(["span := 5 m"]);
    expect(state.doc.regions[1].given).toEqual(["span > 0 m"]);
    expect(state.doc.regions[1].find).toBe("span := find(span)");
    expect(state.doc.regions[2].rows).toEqual([
      ["Span span", "=span*2"],
      ["Half", "=span/2"],
    ]);
    expect(state.doc.regions[3].elements).toEqual([
      { type: "member", from: ["0 m", "0 m"], to: ["span", "0 m"] },
      { type: "udl", from: ["0 m", "0 m"], to: ["span", "0 m"], label: "Span {span}" },
    ]);
    undo();
    expect(state.doc.regions[0].expr).toBe("L := 6 m");
    expect(state.doc.regions[1].find).toBe("L := find(L)");
    expect(state.doc.regions[2].rows?.[0]).toEqual(["Span L", "=L*2"]);
    expect(state.doc.regions[3].elements?.[0]).toEqual({ type: "member", from: ["0 m", "0 m"], to: ["L", "0 m"] });
    setFindOpen(false);
    setQuery("");
    setReplacement("");
    expect(findOpen()).toBe(false);
    expect(query()).toBe("");
    expect(replacement()).toBe("");
  });
});
