import { describe, expect, it } from "vitest";
import { buildSketchScene, DEFAULT_SKETCH_SIZE, describeSketch, fitSketch } from "./sketchGeometry";
import type { SketchElement, SketchView } from "./types";

function starterBeam(spanMeters: number, qLabel = "q = 10.6 kN/m"): { elements: SketchElement[]; view: SketchView } {
  const elements: SketchElement[] = [
    { type: "member", from: ["0 m", "0 m"], to: ["L", "0 m"] },
    { type: "support", at: ["0 m", "0 m"], kind: "pin" },
    { type: "support", at: ["L", "0 m"], kind: "roller" },
    { type: "udl", from: ["0 m", "0 m"], to: ["L", "0 m"], label: "q = {q}" },
    { type: "dimension", from: ["0 m", "0 m"], to: ["L", "0 m"], offset: -40 },
  ];
  const s = (si: number) => ({ si, dim: "m" });
  const view: SketchView = {
    values: {
      "0.from.0": s(0),
      "0.from.1": s(0),
      "0.to.0": s(spanMeters),
      "0.to.1": s(0),
      "1.at.0": s(0),
      "1.at.1": s(0),
      "2.at.0": s(spanMeters),
      "2.at.1": s(0),
      "3.from.0": s(0),
      "3.from.1": s(0),
      "3.to.0": s(spanMeters),
      "3.to.1": s(0),
      "4.from.0": s(0),
      "4.from.1": s(0),
      "4.to.0": s(spanMeters),
      "4.to.1": s(0),
    },
    labels: {
      "3": qLabel,
      "4": `${spanMeters} m`,
    },
    errors: {},
    reads: ["L", "q"],
  };
  return { elements, view };
}

describe("sketchGeometry", () => {
  it("fits simply supported beam inside viewport with room for UDL above and dimension below", () => {
    const { elements, view } = starterBeam(6);
    const [w, h] = DEFAULT_SKETCH_SIZE;
    const scene = buildSketchScene(elements, view, w, h);
    expect(scene.items).toHaveLength(5);
    expect(scene.errors).toHaveLength(0);

    // Every generated text sits strictly inside the SVG viewport
    for (const item of scene.items) {
      for (const t of item.texts) {
        expect(t.x).toBeGreaterThan(0);
        expect(t.x).toBeLessThan(w);
        expect(t.y).toBeGreaterThan(8);
        expect(t.y).toBeLessThan(h);
      }
    }

    expect(describeSketch(elements, view)).toBe(
      "Beam 6 m long, pin at left, roller at right, uniform load q = 10.6 kN/m",
    );
  });

  it("preserves isotropic x/y proportions when model aspect changes", () => {
    const elements: SketchElement[] = [
      { type: "member", from: ["0 m", "0 m"], to: ["0 m", "3 m"] },
      { type: "member", from: ["0 m", "3 m"], to: ["L", "3 m"] },
    ];
    const mkView = (L: number): SketchView => ({
      values: {
        "0.from.0": { si: 0, dim: "m" },
        "0.from.1": { si: 0, dim: "m" },
        "0.to.0": { si: 0, dim: "m" },
        "0.to.1": { si: 3, dim: "m" },
        "1.from.0": { si: 0, dim: "m" },
        "1.from.1": { si: 3, dim: "m" },
        "1.to.0": { si: L, dim: "m" },
        "1.to.1": { si: 3, dim: "m" },
      },
      labels: {},
      errors: {},
      reads: ["L"],
    });

    const fit6 = fitSketch(elements, mkView(6), 480, 220);
    const fit12 = fitSketch(elements, mkView(12), 480, 220);
    // 1 m in x equals 1 m in y (with y inverted)
    expect(fit6.sx(1) - fit6.sx(0)).toBeCloseTo(fit6.sy(0) - fit6.sy(1), 6);
    expect(fit12.sx(1) - fit12.sx(0)).toBeCloseTo(fit12.sy(0) - fit12.sy(1), 6);
    // Wider frame has a larger width-to-height screen ratio
    const ratio6 = (fit6.sx(6) - fit6.sx(0)) / (fit6.sy(0) - fit6.sy(3));
    const ratio12 = (fit12.sx(12) - fit12.sx(0)) / (fit12.sy(0) - fit12.sy(3));
    expect(ratio6).toBeCloseTo(2, 5);
    expect(ratio12).toBeCloseTo(4, 5);
  });

  it("isolates element errors while keeping valid elements rendered", () => {
    const elements: SketchElement[] = [
      { type: "member", from: ["0 m", "0 m"], to: ["4 m", "0 m"] },
      { type: "support", at: ["0 m", "0 m"], kind: "fixed" },
      { type: "point", at: ["bad", "0 m"], label: "P" },
      { type: "moment", at: ["4 m", "0 m"], sense: "ccw", label: "M" },
      { type: "label", at: ["2 m", "0 m"], text: "Midspan", anchor: "above" },
    ];
    const s = (si: number) => ({ si, dim: "m" });
    const view: SketchView = {
      values: {
        "0.from.0": s(0),
        "0.from.1": s(0),
        "0.to.0": s(4),
        "0.to.1": s(0),
        "1.at.0": s(0),
        "1.at.1": s(0),
        "3.at.0": s(4),
        "3.at.1": s(0),
        "4.at.0": s(2),
        "4.at.1": s(0),
      },
      labels: { "3": "M", "4": "Midspan" },
      errors: { "2": "bad is not defined" },
      reads: [],
    };
    const scene = buildSketchScene(elements, view, 480, 220);
    expect(scene.items.map((it) => it.index)).toEqual([0, 1, 3, 4]);
    expect(scene.errors).toEqual([{ index: 2, message: "bad is not defined" }]);
  });
});
