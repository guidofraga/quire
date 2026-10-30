import { describe, expect, it } from "vitest";
import { fillFields, pageGeom, pageMatches, PX_PER_MM, paperPoints, toPx } from "./pages";
import type { Doc } from "./types";

const doc = (page: Doc["page"]): Doc => ({ format: "quire/1", meta: { title: "T" }, regions: [], page });

describe("toPx", () => {
  it("converts lengths with units", () => {
    expect(toPx("25.4mm", 0)).toBeCloseTo(96);
    expect(toPx("2.54 cm", 0)).toBeCloseTo(96);
    expect(toPx("1in", 0)).toBe(96);
    expect(toPx("72pt", 0)).toBe(96);
    expect(toPx("12", 0)).toBe(12);
    expect(toPx(40, 0)).toBe(40);
  });

  it("falls back on anything it cannot read", () => {
    expect(toPx("wide", 7)).toBe(7);
    expect(toPx("10 furlongs", 7)).toBe(7);
    expect(toPx(undefined, 7)).toBe(7);
  });
});

describe("pageGeom", () => {
  it("defaults to A4 portrait with 20 mm margins", () => {
    const g = pageGeom(doc(undefined));
    expect(g.paperW).toBeCloseTo(210 * PX_PER_MM);
    expect(g.paperH).toBeCloseTo(297 * PX_PER_MM);
    expect(g.margins.left).toBeCloseTo(20 * PX_PER_MM);
    expect(g.contentW).toBeCloseTo(170 * PX_PER_MM);
    expect(g.contentH).toBeCloseTo(257 * PX_PER_MM);
  });

  it("swaps sides in landscape", () => {
    const g = pageGeom(doc({ paper: "Letter", orientation: "landscape" }));
    expect(g.paperW).toBeCloseTo(279.4 * PX_PER_MM);
    expect(g.paperH).toBeCloseTo(215.9 * PX_PER_MM);
  });

  it("reads custom sizes and margins", () => {
    const g = pageGeom(
      doc({ paper: ["100mm", "200mm"], margins: { top: "1cm", right: "0mm", bottom: "1cm", left: "0mm" } }),
    );
    expect(g.contentW).toBeCloseTo(100 * PX_PER_MM);
    expect(g.contentH).toBeCloseTo(180 * PX_PER_MM);
  });

  it("never leaves less than 100 px of content", () => {
    const g = pageGeom(
      doc({ paper: ["50mm", "50mm"], margins: { top: "30mm", right: "30mm", bottom: "30mm", left: "30mm" } }),
    );
    expect(g.contentW).toBe(100);
    expect(g.contentH).toBe(100);
  });

  it("gives the paper in points for the print engine", () => {
    const pt = paperPoints(pageGeom(doc({ paper: "A4" })));
    expect(pt.widthPt).toBeCloseTo(595.28, 1);
    expect(pt.heightPt).toBeCloseTo(841.89, 1);
  });
});

describe("pageMatches", () => {
  it.each([
    [undefined, 3, true],
    ["all", 3, true],
    ["odd", 3, true],
    ["odd", 4, false],
    ["even", 4, true],
    ["1", 1, true],
    ["1", 2, false],
    ["2-4", 3, true],
    ["2-4", 5, false],
    ["1, 3", 3, true],
    ["1,3", 2, false],
    [" Odd ", 1, true],
  ])("%j on page %i → %s", (spec, n, want) => {
    expect(pageMatches(spec as string | undefined, n)).toBe(want);
  });
});

describe("fillFields", () => {
  const c = {
    page: 2,
    pages: 5,
    file: "beam.quire",
    title: "Beam",
    author: "Ana",
    company: "ACME",
    lang: "en-US",
    now: new Date(2026, 0, 31, 9, 5),
  };

  it("fills every field", () => {
    expect(fillFields("{title} – {file} – Page {page} of {pages} – {author}, {company}", c)).toBe(
      "Beam – beam.quire – Page 2 of 5 – Ana, ACME",
    );
    expect(fillFields("{date}", c)).toBe(c.now.toLocaleDateString("en-US"));
    expect(fillFields("{time}", c)).toContain("09:05".slice(1));
  });

  it("leaves unknown fields as typed", () => {
    expect(fillFields("{nope} {page}", c)).toBe("{nope} 2");
  });
});
