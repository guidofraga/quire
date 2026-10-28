// Moving between regions from the keyboard: Tab / ⇧Tab in reading order, ⌥ + arrows by
// direction.
import { heights, layout, widths } from "./store";

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxes(): Box[] {
  const l = layout();
  return l.list
    .filter((p) => !p.hidden)
    .map((p) => {
      const [x, y] = l.toScene(p.x, p.y);
      return { id: p.region.id, x, y, w: widths[p.region.id] ?? 0, h: heights[p.region.id] ?? 0 };
    });
}

/** Top to bottom; regions on the same line (overlapping vertically) left to right. */
function readingOrder(): Box[] {
  return boxes().sort((a, b) => {
    const sameLine = a.y < b.y + Math.max(b.h, 1) / 2 && b.y < a.y + Math.max(a.h, 1) / 2;
    return sameLine ? a.x - b.x : a.y - b.y;
  });
}

/** The region after (or before) `from` in reading order; from nothing, the first (or last). */
export function stepRegion(from: string | null, by: 1 | -1): string | null {
  const list = readingOrder();
  if (!list.length) return null;
  const at = from ? list.findIndex((b) => b.id === from) : -1;
  if (at < 0) return list[by > 0 ? 0 : list.length - 1].id;
  return list[at + by]?.id ?? null;
}

/** The nearest region in a direction from `from`, favouring ones straight ahead. */
export function nearestRegion(from: string, dx: number, dy: number): string | null {
  const all = boxes();
  const a = all.find((b) => b.id === from);
  if (!a) return null;
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  let best: [number, string] | null = null;
  for (const b of all) {
    if (b.id === a.id) continue;
    // the gap between the boxes along the direction, and the offset across it
    const ahead = dx
      ? dx > 0
        ? b.x - (a.x + a.w)
        : a.x - (b.x + b.w)
      : dy > 0
        ? b.y - (a.y + a.h)
        : a.y - (b.y + b.h);
    const along = dx ? (b.x + b.w / 2 - cx) * dx : (b.y + b.h / 2 - cy) * dy;
    if (along <= 0 || ahead < -Math.min(a.w, a.h, 8)) continue;
    const across = dx
      ? Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h))
      : Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
    const cost = Math.max(0, ahead) + across * 3;
    if (!best || cost < best[0]) best = [cost, b.id];
  }
  return best?.[1] ?? null;
}
