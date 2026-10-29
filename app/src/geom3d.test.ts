import { describe, expect, it } from "vitest";
import { bounds, DEFAULT_CAMERA, heat, normalize, project, ticks3 } from "./geom3d";

describe("3D plots", () => {
  it("boxes the data, giving a flat axis some room", () => {
    const [lo, hi] = bounds([{ xs: [0, 2, null], ys: [5, 5], zs: [-1, 3, NaN] }]);
    expect(lo).toEqual([0, 4.5, -1]);
    expect(hi).toEqual([2, 5.5, 3]);
    expect(normalize([1, 5, 3], [lo, hi])).toEqual([0, 0, 1]);
  });

  it("looks from the front: up is z, depth grows away from the viewer", () => {
    const cam = { azimuth: 0, elevation: 0, zoom: 1 };
    expect(project([0, 0, 1], cam).map((v) => Number(v.toFixed(9)))).toEqual([0, 1, 0]);
    const [, , near] = project([0, -1, 0], cam);
    const [, , far] = project([0, 1, 0], cam);
    expect(far).toBeGreaterThan(near);
    // seen from above, the top of the box is nearer than its bottom
    const above = { ...DEFAULT_CAMERA, elevation: 60 };
    expect(project([0, 0, 1], above)[2]).toBeLessThan(project([0, 0, -1], above)[2]);
  });

  it("colours heights and rounds tick values", () => {
    expect(heat(0)).toBe("rgb(49, 54, 149)");
    expect(heat(1)).toBe("rgb(215, 48, 39)");
    expect(heat(NaN)).toBe(heat(0));
    expect(ticks3(-2, 2)).toEqual([-2, -1, 0, 1, 2]);
    expect(ticks3(0, 37)).toEqual([0, 10, 20, 30]);
  });
});
