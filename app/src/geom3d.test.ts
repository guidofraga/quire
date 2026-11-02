import { describe, expect, it } from "vitest";
import { bounds, cameraOf, DEFAULT_CAMERA, faces, heat, normalize, project, ticks3, zoomOf } from "./geom3d";

describe("3D plots", () => {
  it("boxes the data, giving a flat axis some room", () => {
    const [lo, hi] = bounds([{ xs: [0, 2, null], ys: [5, 5], zs: [-1, 3, NaN] }]);
    expect(lo).toEqual([0, 4.5, -1]);
    expect(hi).toEqual([2, 5.5, 3]);
    expect(normalize([1, 5, 3], [lo, hi])).toEqual([0, 0, 1]);
    expect(bounds([])).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]);
  });

  it("looks from the front: up is z, depth grows away from the viewer", () => {
    const cam = { azimuth: 0, elevation: 0, distance: 3 };
    expect(project([0, 0, 1], cam).map((v) => Number(v.toFixed(9)))).toEqual([0, 1, 0]);
    const [, , near] = project([0, -1, 0], cam);
    const [, , far] = project([0, 1, 0], cam);
    expect(far).toBeGreaterThan(near);
    // seen from above, the top of the box is nearer than its bottom
    const above = { ...DEFAULT_CAMERA, elevation: 60 };
    expect(project([0, 0, 1], above)[2]).toBeLessThan(project([0, 0, -1], above)[2]);
  });

  it("reads a saved camera, keeping what is missing or wrong at the defaults", () => {
    expect(cameraOf(undefined)).toEqual(DEFAULT_CAMERA);
    expect(cameraOf({ azimuth: 30, elevation: 120, distance: "far" })).toEqual({
      azimuth: 30,
      elevation: 89,
      distance: 3,
    });
    expect(zoomOf({ ...DEFAULT_CAMERA, distance: 1.5 })).toBe(2);
  });

  it("makes faces of a grid, leaving out those with a gap", () => {
    // 3 points to a row, 2 rows: two faces; a gap at the last point drops the second
    const grid = { cols: 3, xs: [1, 2, 3, 1, 2, 3], ys: [1, 1, 1, 2, 2, 2], zs: [0, 1, 2, 3, 4, 5] };
    expect(faces(grid)).toEqual([
      [
        [1, 1, 0],
        [2, 1, 1],
        [2, 2, 4],
        [1, 2, 3],
      ],
      [
        [2, 1, 1],
        [3, 1, 2],
        [3, 2, 5],
        [2, 2, 4],
      ],
    ]);
    expect(faces({ ...grid, zs: [0, 1, 2, 3, 4, null] })).toHaveLength(1);
    expect(faces({ ...grid, cols: 0 })).toEqual([]);
  });

  it("colours heights and rounds tick values", () => {
    expect(heat(0)).toBe("rgb(49, 54, 149)");
    expect(heat(1)).toBe("rgb(215, 48, 39)");
    expect(heat(NaN)).toBe(heat(0));
    expect(ticks3(-2, 2)).toEqual([-2, -1, 0, 1, 2]);
    expect(ticks3(0, 37)).toEqual([0, 10, 20, 30]);
  });
});
