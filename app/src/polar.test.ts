import { describe, expect, it } from "vitest";
import { angleFactor, nearest, rings, toPlane } from "./polar";

describe("polar plots", () => {
  it("reads the angle axis in its unit", () => {
    expect(angleFactor("deg")).toBeCloseTo(Math.PI / 180);
    expect(angleFactor("'°")).toBeCloseTo(Math.PI / 180);
    expect(angleFactor("rev")).toBeCloseTo(2 * Math.PI);
    expect(angleFactor("")).toBe(1);
    expect(angleFactor("rad")).toBe(1);
  });

  it("puts samples on the plane, a negative r pointing the other way", () => {
    const [x, y] = toPlane(90, 2, Math.PI / 180);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(2);
    const [nx, ny] = toPlane(0, -1, 1);
    expect(nx).toBeCloseTo(-1);
    expect(ny).toBeCloseTo(0);
  });

  it("draws round circles up to the largest radius", () => {
    expect(rings(1)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(rings(37)).toEqual([10, 20, 30, 40]);
    expect(rings(0)).toEqual([1]);
  });

  it("finds the sample under the pointer, skipping gaps", () => {
    const series = [{ xs: [0, 90, null], ys: [1, 1, 5] }, { xs: [180], ys: [3] }];
    expect(nearest(series, Math.PI / 180, 0.1, 0.9)).toEqual({ s: 0, k: 1 });
    expect(nearest(series, Math.PI / 180, -2.5, 0)).toEqual({ s: 1, k: 0 });
    expect(nearest([], 1, 0, 0)).toBeNull();
  });
});
