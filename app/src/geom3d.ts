// 3D plots without the DOM, for Plot3D.tsx: the data's box, an orthographic camera turned by
// azimuth and tilted by elevation, a colour scale for heights and round tick values. No WebGL:
// a few thousand faces draw fast enough on a canvas, and print the same.

export type Vec3 = [number, number, number];

/** As saved in a plot3d region's `camera` (docs/02-file-format.md §4.7). */
export interface Camera {
  /** Turn around the vertical axis, degrees (SMath's default view looks from the front left). */
  azimuth: number;
  /** Tilt above the horizontal, degrees, −89…89. */
  elevation: number;
  /** How far the eye is from the box; 3 fits it to the plot, less zooms in. */
  distance: number;
}

export const DEFAULT_CAMERA: Camera = { azimuth: -50, elevation: 25, distance: 3 };

/** The camera a region saved, with the defaults for what it leaves out or got wrong. */
export function cameraOf(saved: unknown): Camera {
  const c = (saved && typeof saved === "object" ? saved : {}) as Partial<Record<keyof Camera, unknown>>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    azimuth: num(c.azimuth, DEFAULT_CAMERA.azimuth),
    elevation: Math.max(-89, Math.min(89, num(c.elevation, DEFAULT_CAMERA.elevation))),
    distance: Math.max(0.75, Math.min(10, num(c.distance, DEFAULT_CAMERA.distance))),
  };
}

/** How much larger than at the standard distance the box is drawn. */
export const zoomOf = (cam: Camera) => DEFAULT_CAMERA.distance / cam.distance;

/** Each axis's [min, max] over the finite values; a flat axis gets ±0.5 of room. */
export function bounds(
  points: { xs: (number | null)[]; ys: (number | null)[]; zs: (number | null)[] }[],
): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    [p.xs, p.ys, p.zs].forEach((vs, a) => {
      for (const v of vs) {
        if (v === null || !Number.isFinite(v)) continue;
        lo[a] = Math.min(lo[a], v);
        hi[a] = Math.max(hi[a], v);
      }
    });
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(lo[a])) [lo[a], hi[a]] = [0, 1];
    else if (lo[a] === hi[a]) [lo[a], hi[a]] = [lo[a] - 0.5, hi[a] + 0.5];
  }
  return [lo, hi];
}

/** A point of the data scaled into the cube −1…1 on every axis. */
export function normalize(p: Vec3, [lo, hi]: [Vec3, Vec3]): Vec3 {
  return [0, 1, 2].map((a) => ((p[a] - lo[a]) / (hi[a] - lo[a])) * 2 - 1) as Vec3;
}

/**
 * A point of the cube on the screen: [right, up, depth], depth growing away from the
 * viewer (draw the deepest first). z is up; the camera turns around it, then tilts.
 */
export function project([x, y, z]: Vec3, cam: Camera): Vec3 {
  const az = (cam.azimuth * Math.PI) / 180;
  const el = (cam.elevation * Math.PI) / 180;
  const xr = x * Math.cos(az) - y * Math.sin(az);
  const yr = x * Math.sin(az) + y * Math.cos(az);
  return [xr, z * Math.cos(el) + yr * Math.sin(el), yr * Math.cos(el) - z * Math.sin(el)];
}

/** Heights from low to high: blue, cyan, green, yellow, red (t from 0 to 1). */
export function heat(t: number): string {
  const stops: Vec3[] = [
    [49, 54, 149],
    [69, 160, 210],
    [96, 190, 120],
    [245, 220, 80],
    [215, 48, 39],
  ];
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const f = u - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Round values (1, 2, 2.5, 5 × 10ⁿ) inside [lo, hi], about `count` of them. */
export function ticks3(lo: number, hi: number, count = 4): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  if (!(raw > 0)) return [lo];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  return out;
}

/** The faces of a grid of points (`cols` to a row) whose four corners were all computed. */
export function faces(s: {
  cols: number;
  xs: (number | null)[];
  ys: (number | null)[];
  zs: (number | null)[];
}): Vec3[][] {
  const out: Vec3[][] = [];
  const n = s.cols;
  if (n < 2) return out;
  const rows = Math.floor(s.zs.length / n);
  const at = (k: number): Vec3 | null => {
    const p = [s.xs[k], s.ys[k], s.zs[k]];
    return p.every((v) => typeof v === "number" && Number.isFinite(v)) ? (p as Vec3) : null;
  };
  for (let j = 0; j + 1 < rows; j++)
    for (let i = 0; i + 1 < n; i++) {
      const quad = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i].map(at);
      if (quad.every((p) => p !== null)) out.push(quad as Vec3[]);
    }
  return out;
}
