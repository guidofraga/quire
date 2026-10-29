import { describe, expect, it } from "vitest";
import { advance, equalSpans, markerDiameter, markerPath } from "./plotGeometry";

describe("markerDiameter", () => {
  it("draws a dot of size 125 about 50 px across, and an open circle wider than a dot", () => {
    expect(markerDiameter(".", 125)).toBeCloseTo(50, 0);
    expect(markerDiameter("o", 185)).toBeCloseTo(111, 0);
    expect(markerDiameter(".", -3)).toBe(0);
    expect(markerDiameter(".", Number.NaN)).toBe(0);
  });
});

describe("markerPath", () => {
  it("builds arms for +, x and *, and nothing for the circles", () => {
    expect(markerPath("+", 10, 10, 2)).toBe("M8 10L12 10M10 8L10 12");
    expect(markerPath("x", 10, 10, 2)).toBe("M8 8L12 12M8 12L12 8");
    expect(markerPath("*", 0, 0, 1)).toBe(markerPath("+", 0, 0, 1) + markerPath("x", 0, 0, 1));
    expect(markerPath(".", 0, 0, 1)).toBe("");
    expect(markerPath("o", 0, 0, 1)).toBe("");
  });
});

describe("equalSpans", () => {
  it("makes one unit of x as long on the page as one unit of y", () => {
    // 200 px wide for 2 units of x (100 per unit); 100 px tall for 10 units of y (10 per unit)
    const r = equalSpans([0, 2], [0, 10], 200, 100);
    const perX = (r.x[1] - r.x[0]) / 200;
    const perY = (r.y[1] - r.y[0]) / 100;
    expect(perX).toBeCloseTo(perY, 9);
    // the axis with more units per pixel (y) keeps its span
    expect(r.y).toEqual([0, 10]);
  });

  it("grows y about its middle when x has more units per pixel", () => {
    const r = equalSpans([0, 10], [0, 1], 100, 100);
    expect(r.x).toEqual([0, 10]);
    expect(r.y[0] + r.y[1]).toBeCloseTo(1, 9);
    expect(r.y[1] - r.y[0]).toBeCloseTo(10, 9);
  });

  it("leaves unmeasurable spans alone", () => {
    expect(equalSpans([1, 1], [0, 1], 100, 100)).toEqual({ x: [1, 1], y: [0, 1] });
    expect(equalSpans([0, 1], [0, 1], 0, 100)).toEqual({ x: [0, 1], y: [0, 1] });
  });
});

describe("advance", () => {
  it("counts whole frames and keeps the rest", () => {
    // 20 fps: a frame every 50 ms
    expect(advance(120, 20, 0)).toEqual({ steps: 2, carry: expect.closeTo(20, 6) });
    expect(advance(30, 20, 20)).toEqual({ steps: 1, carry: expect.closeTo(0, 6) });
  });

  it("does nothing for a zero rate or a negative time", () => {
    expect(advance(100, 0, 5)).toEqual({ steps: 0, carry: 5 });
    expect(advance(-4, 20, 0)).toEqual({ steps: 0, carry: 0 });
  });
});
