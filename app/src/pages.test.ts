import { describe, expect, it } from "vitest";
import {
  bandLayout,
  contentOn,
  evenPage,
  fillFields,
  HF_DEFAULT_COLOR,
  type HeaderFooter,
  mirrored,
  pageAssets,
  pageGeom,
  pageMatches,
  PX_PER_MM,
  paperPoints,
  scopeLabel,
  toPx,
} from "./pages";
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

  it("fills {section} with the page's heading, and with nothing when there is none", () => {
    expect(fillFields("{section} – {page}", { ...c, section: "Loads" })).toBe("Loads – 2");
    expect(fillFields("{section}", c)).toBe("");
  });

  it("leaves unknown fields as typed", () => {
    expect(fillFields("{nope} {page}", c)).toBe("{nope} 2");
  });
});

describe("headers and footers", () => {
  const hf: HeaderFooter = { left: "Report", right: "{page}", even: { left: "{page}", right: "Even" } };

  it("tells even pages by their printed number", () => {
    expect([0, 1, 2].map((k) => evenPage(k))).toEqual([false, true, false]);
    // numbering that starts at 2 makes the first page even
    expect(evenPage(0, 2)).toBe(true);
  });

  it("shows the even-page content on even pages, and nothing on a first page set apart", () => {
    expect(contentOn(hf, 0)?.left).toBe("Report");
    expect(contentOn(hf, 1)?.right).toBe("Even");
    expect(contentOn(hf, 2)?.left).toBe("Report");
    expect(contentOn(hf, 0, 1, true)).toBeUndefined();
    // without even content, every page shows the band's own slots
    expect(contentOn({ center: "x" }, 1)?.center).toBe("x");
    expect(contentOn(undefined, 0)).toBeUndefined();
  });

  it("starts even pages as a mirror of the odd ones, image included", () => {
    expect(mirrored({ left: "A", center: "B", right: "{page}", image: { src: "assets/a.png" } })).toEqual({
      left: "{page}",
      center: "B",
      right: "A",
      image: { src: "assets/a.png", slot: "right" },
    });
  });

  it("centres the row in the margin by default, as before these settings", () => {
    const l = bandLayout(undefined, undefined, 76);
    expect(l.fontPx).toBeCloseTo((8 * 96) / 72);
    expect(l.offset).toBeCloseTo((76 - l.rowH) / 2);
    expect(l.imageH).toBe(0);
    expect(l.ruleW).toBe(0);
  });

  it("puts the row its distance from the paper's edge, but keeps it inside the margin", () => {
    expect(bandLayout({ distance: "5mm" }, undefined, 76).offset).toBeCloseTo(5 * PX_PER_MM);
    const far = bandLayout({ distance: "50mm", rule: {} }, undefined, 76);
    expect(far.offset + far.rowH + 3 + far.ruleW).toBeCloseTo(76);
  });

  it("sizes an image to half the band by default and never taller than the band", () => {
    const img = { src: "assets/a.png" };
    expect(bandLayout({}, { image: img }, 80).imageH).toBe(40);
    expect(bandLayout({}, { image: { ...img, height: "10mm" } }, 80).imageH).toBe(Math.round(10 * PX_PER_MM));
    expect(bandLayout({}, { image: { ...img, height: "100mm" } }, 80).imageH).toBe(76);
    // the row grows to the image, so the text centres on it
    expect(bandLayout({}, { image: img }, 80).rowH).toBe(40);
  });

  it("draws the rule 0.5 pt by default, or as wide as set", () => {
    expect(bandLayout({ rule: {} }, undefined, 76).ruleW).toBeCloseTo(0.5 * (96 / 72));
    expect(bandLayout({ rule: { width: "1.5pt" } }, undefined, 76).ruleW).toBeCloseTo(2);
  });

  it("follows the band's text size", () => {
    expect(bandLayout({ size: 12 }, undefined, 76).fontPx).toBeCloseTo(16);
  });

  it("names which pages an edit reaches", () => {
    const o = { firstBlank: false, oddEven: false };
    expect(scopeLabel(3, o)).toBe("All pages");
    expect(scopeLabel(0, { ...o, firstBlank: true })).toBe("First page");
    expect(scopeLabel(1, { ...o, firstBlank: true })).toBe("All pages but the first");
    expect(scopeLabel(1, { ...o, oddEven: true })).toBe("Even pages");
    expect(scopeLabel(2, { firstBlank: true, oddEven: true })).toBe("Odd pages but the first");
    expect(scopeLabel(1, { firstBlank: true, oddEven: true })).toBe("Even pages");
  });

  it("lists the images headers and footers use with the backgrounds", () => {
    const d = doc({
      backgrounds: [{ src: "assets/bg.png" }],
      header: { image: { src: "assets/logo.png" }, even: { image: { src: "assets/even.png" } } },
      footer: { left: "x" },
    });
    expect(pageAssets(d)).toEqual(["assets/bg.png", "assets/logo.png", "assets/even.png"]);
  });
});

describe("the default header and footer colour", () => {
  const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("reads at WCAG AA (4.5:1) on white paper", () => {
    expect(1.05 / (luminance(HF_DEFAULT_COLOR) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
