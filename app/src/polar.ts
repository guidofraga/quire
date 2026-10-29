// Polar plots (SMath's polar graph): a series r(θ) is sampled like y(x), with θ on the
// horizontal axis and r on the vertical one; this turns the samples into points on the
// plane and lays out the circles and rays of the grid.

/** Radians per unit of the angle axis: `deg`, `°`, `grad`, `rev`; anything else is radians. */
export function angleFactor(unit: string): number {
  const u = unit.trim().replace(/^'/, "");
  if (u === "deg" || u === "°") return Math.PI / 180;
  if (u === "grad" || u === "gon") return Math.PI / 200;
  if (u === "rev") return 2 * Math.PI;
  return 1;
}

/** A sample as a point (x right, y up); a negative r points the other way, as usual. */
export function toPlane(theta: number, r: number, factor: number): [number, number] {
  const a = theta * factor;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** Round radius steps (1, 2, 2.5, 5 × 10ⁿ) up to the largest |r|: the grid's circles. */
export function rings(rMax: number, count = 4): number[] {
  if (!(rMax > 0) || !Number.isFinite(rMax)) return [1];
  const raw = rMax / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = step; v < rMax + step * 0.999; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** The rays of the grid, in degrees: every 30°. */
export const RAYS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

/** The sample nearest to a point on the plane (in plot units), for the hover readout. */
export function nearest(
  series: { xs: (number | null)[]; ys: (number | null)[] }[],
  factor: number,
  px: number,
  py: number,
): { s: number; k: number } | null {
  let best: { s: number; k: number } | null = null;
  let bestD = Infinity;
  for (let s = 0; s < series.length; s++) {
    const { xs, ys } = series[s];
    for (let k = 0; k < xs.length; k++) {
      const t = xs[k];
      const r = ys[k];
      if (t === null || r === null || !Number.isFinite(t) || !Number.isFinite(r)) continue;
      const [x, y] = toPlane(t, r, factor);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { s, k };
      }
    }
  }
  return best;
}
