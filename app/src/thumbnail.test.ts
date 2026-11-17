import { describe, expect, it } from "vitest";
import { thumbnail } from "./thumbnail";
import type { Doc } from "./types";

describe("template thumbnails", () => {
  const doc: Doc = {
    format: "quire/1",
    page: { paper: "A4", header: { left: "{title}", rule: {} } },
    regions: [
      { id: "t", kind: "text", at: [0, 0], text: "{.title}\n# A title" },
      { id: "m", kind: "math", at: [0, 60], expr: "L:=7 m", note: "span" },
      {
        id: "x",
        kind: "table",
        at: [0, 100],
        columns: [{ width: 100 }, { width: 200 }],
        rows: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
      { id: "b", kind: "pagebreak", at: [0, 300] },
      { id: "p", kind: "plot2d", at: [0, 320], size: [300, 200] },
    ],
  };

  it("draws the first page on paper of the document's size", () => {
    const t = thumbnail(doc);
    expect(Math.round(t.width)).toBe(794);
    expect(Math.round(t.height)).toBe(1123);
    const kinds = t.shapes.map((s) => s.kind);
    expect(kinds).toContain("title");
    expect(kinds).toContain("math");
    expect(kinds).toContain("note");
    expect(kinds).toContain("box");
    // the plot is after the page break: not on the first page
    expect(kinds).not.toContain("curve");
  });

  it("keeps every shape inside the printable column", () => {
    const long = { ...doc, regions: [{ id: "t", kind: "text", at: [500, 0], text: "word ".repeat(400) }] } as Doc;
    const t = thumbnail(long);
    const right = t.width - 20 * (96 / 25.4);
    for (const s of t.shapes) expect(s.x + s.w).toBeLessThanOrEqual(right + 0.01);
    expect(t.shapes.filter((s) => s.kind === "line").length).toBeGreaterThan(5);
  });
});
