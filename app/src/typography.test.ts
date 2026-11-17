import { describe, expect, it } from "vitest";
import type { Doc } from "./types";
import { bodySize, mathSize, typeset } from "./typography";

const doc = (styles?: Doc["styles"]): Doc => ({ format: "quire/1", styles, regions: [] });

describe("typography", () => {
  it("leaves documents without a typography as they were: 10 pt text and math", () => {
    expect(typeset(doc())).toBe(false);
    expect(bodySize(doc())).toBe(10);
    expect(mathSize(doc({ body: { size: 12 } }))).toBe(10);
  });

  it("typesets text at 10.5 pt with math at the text's size", () => {
    const d = doc({ typography: 2 });
    expect(typeset(d)).toBe(true);
    expect(bodySize(d)).toBe(10.5);
    expect(mathSize(d)).toBe(10.5);
    expect(mathSize(doc({ typography: 2, body: { size: 12 } }))).toBe(12);
  });

  it("keeps sizes a document sets, in either typography", () => {
    expect(bodySize(doc({ typography: 2, body: { size: 9 } }))).toBe(9);
    expect(mathSize(doc({ typography: 2, math: { size: 11 } }))).toBe(11);
    expect(mathSize(doc({ math: { size: 8 } }))).toBe(8);
  });

  it("reads a later typography it doesn't know as its highest", () => {
    expect(typeset(doc({ typography: 3 }))).toBe(true);
  });
});
