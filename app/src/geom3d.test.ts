import { describe, expect, it } from "vitest";
import {
  bounds,
  cameraOf,
  DEFAULT_CAMERA,
  every,
  faces,
  heat,
  normalize,
  project,
  stepFor,
  ticks3,
  type Vec3,
  zoomOf,
} from "./geom3d";

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

  it("turns the front of the box to the right as the azimuth grows, as a drag to the right does", () => {
    // the front edge's middle, nearest the viewer at azimuth 0
    const front: Vec3 = [0, -1, 0];
    const at = (azimuth: number) => project(front, { azimuth, elevation: 0, distance: 3 })[0];
    expect(at(0)).toBeCloseTo(0);
    expect(at(20)).toBeGreaterThan(0);
    expect(at(-20)).toBeLessThan(0);
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

  it("thins a large surface to every few rows and columns, keeping its edges", () => {
    expect(every(10, 3)).toEqual([0, 3, 6, 9]);
    expect(every(11, 3)).toEqual([0, 3, 6, 9, 10]);
    expect(every(1, 4)).toEqual([0]);
    // 1000 × 1000 heights: about a million faces, drawn as at most 12 000 while turning
    const n = 1000;
    const big = {
      cols: n,
      xs: Array.from({ length: n * n }, (_, k) => k % n),
      ys: Array.from({ length: n * n }, (_, k) => Math.floor(k / n)),
      zs: Array.from({ length: n * n }, (_, k) => Math.sin(k)),
    };
    const step = stepFor(big, 12_000);
    const thin = faces(big, step);
    expect(thin.length).toBeLessThanOrEqual(12_000);
    expect(thin.length).toBeGreaterThan(6_000);
    // the corners of the whole surface are still corners of the thinned one
    const corners = thin.flat().map((p) => `${p[0]},${p[1]}`);
    for (const c of ["0,0", `${n - 1},0`, `0,${n - 1}`, `${n - 1},${n - 1}`]) expect(corners).toContain(c);
    // a small surface is drawn whole
    expect(stepFor({ cols: 41, zs: new Array(41 * 41) }, 12_000)).toBe(1);
  });
});
