// Plot geometry that needs no DOM: marker sizes and shapes, equal scales and animation timing.
// Plot.tsx draws with these, and they are tested on their own (plotGeometry.test.ts).

/**
 * Pixels per unit of SMath's size for a filled `.` marker: a size of 125 is about 50 px across,
 * as in the PlanetaryGear screenshot (examples/PlanetaryGear.png).
 */
export const DOT_PX_PER_SIZE = 0.4;

/**
 * Pixels per unit of SMath's size for an open `o`: its ring is wider than a dot of the same size
 * (a size of 185 is about 112 px across in the same screenshot).
 */
export const RING_PX_PER_SIZE = 0.6;

/** The pixel diameter of a marker of this shape and SMath size. */
export function markerDiameter(shape: string, size: number): number {
  const per = shape === "o" ? RING_PX_PER_SIZE : DOT_PX_PER_SIZE;
  return Number.isFinite(size) && size > 0 ? size * per : 0;
}

/**
 * SVG path data for a `+`, `x` or `*` centred on (cx, cy), with arms of radius `r`. A `.` or an
 * `o` is a circle, not a path, so it gives "".
 */
export function markerPath(shape: string, cx: number, cy: number, r: number): string {
  const plus = `M${cx - r} ${cy}L${cx + r} ${cy}M${cx} ${cy - r}L${cx} ${cy + r}`;
  const cross = `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx - r} ${cy + r}L${cx + r} ${cy - r}`;
  if (shape === "+") return plus;
  if (shape === "x") return cross;
  if (shape === "*") return plus + cross;
  return "";
}

/**
 * The two axis spans, changed so that one unit of x is as long on the page as one unit of y.
 * The axis that has more units per pixel keeps its span; the other grows about its middle.
 * Spans that cannot be measured (a zero or a non-finite width) are returned unchanged.
 */
export function equalSpans(
  x: [number, number],
  y: [number, number],
  width: number,
  height: number,
): { x: [number, number]; y: [number, number] } {
  const ux = (x[1] - x[0]) / width;
  const uy = (y[1] - y[0]) / height;
  if (!(width > 0 && height > 0) || !Number.isFinite(ux) || !Number.isFinite(uy) || ux <= 0 || uy <= 0 || ux === uy) {
    return { x, y };
  }
  if (ux > uy) {
    const mid = (y[0] + y[1]) / 2;
    const half = (ux * height) / 2;
    return { x, y: [mid - half, mid + half] };
  }
  const mid = (x[0] + x[1]) / 2;
  const half = (uy * width) / 2;
  return { x: [mid - half, mid + half], y };
}

/**
 * How far an animation moves on after `elapsed` ms at `fps` frames a second. `carry` is the time
 * left over from the last call; the result carries the time still unused.
 */
export function advance(elapsed: number, fps: number, carry: number): { steps: number; carry: number } {
  if (!(fps > 0) || !Number.isFinite(elapsed) || elapsed < 0) return { steps: 0, carry };
  const period = 1000 / fps;
  const total = carry + elapsed;
  const steps = Math.floor(total / period);
  return { steps, carry: total - steps * period };
}
