// 3D plots (SMath's 3D graph): pure geometry for Plot3D.tsx — the data's box, an
// orthographic camera turned by azimuth and tilted by elevation, a colour scale for heights
// and round tick values. No WebGL: a few thousand quads draw fast enough on a canvas.

export type Vec3 = [number, number, number];

export interface Camera {
  /** Turn around the vertical axis, degrees (SMath's default view looks from the front left). */
  azimuth: number;
  /** Tilt above the horizontal, degrees, −89…89. */
  elevation: number;
  /** 1 = the box fills the plot. */
  zoom: number;
}

export const DEFAULT_CAMERA: Camera = { azimuth: -50, elevation: 25, zoom: 1 };

/** Each axis's [min, max] over the finite values; a flat axis gets ±0.5 of room. */
export function bounds(points: { xs: (number | null)[]; ys: (number | null)[]; zs: (number | null)[] }[]): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    [p.xs, p.ys, p.zs].forEach((vs, a) => {
      for (const v of vs) {
        if (v === null || !Number.isFinite(v)) continue;
        lo[a] = Math.min(lo[a], v);
        hi[a] = Math.max(hi[a], v);
      }
    });
  }
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
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
