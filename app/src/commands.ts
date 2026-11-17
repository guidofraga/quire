// What ⌘K offers and in what order: the commands by area (as the menus group them), the ones
// used lately first, and the notebook's commands first in a notebook and last outside one.
// No UI here, so the order can be tested; Palette.tsx draws it.
import type { IconName } from "./icons";

export type Area = "File" | "Edit" | "Insert" | "View" | "Format" | "Notebook" | "Help";
export type Group = "Recent" | Area | "Go to" | "Symbols";

export interface Command {
  id: string;
  label: string;
  /** Its shortcut, shown on the right. */
  keys: string;
  area: Area;
  icon: IconName;
}

export interface Item {
  label: string;
  /** Shortcut or what kind of item this is, shown on the right. */
  hint: string;
  group: Group;
  icon: IconName;
  /** A command's id, so it can be remembered as recent. */
  command?: string;
  run: () => void;
}

/** The areas in the menus' order. */
export const AREAS: Area[] = ["File", "Edit", "Insert", "View", "Format", "Notebook", "Help"];

/** The order groups are listed in: a notebook's commands lead in a notebook and trail outside one. */
export function groupOrder(inNotebook: boolean): Group[] {
  const areas = AREAS.filter((a) => a !== "Notebook");
  return [
    "Recent",
    ...(inNotebook ? ["Notebook" as const] : []),
    ...areas,
    ...(inNotebook ? [] : ["Notebook" as const]),
    "Go to",
    "Symbols",
  ];
}

// ---------------------------------------------------------------------------
// Recent commands, newest first, kept in local storage (which a private window may refuse)
// ---------------------------------------------------------------------------

const KEY = "quire.palette.recent";
const KEEP = 8;
/** How many recent commands the palette shows. */
export const RECENT_SHOWN = 5;

export function recentCommands(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string) {
  try {
    const list = [id, ...recentCommands().filter((x) => x !== id)].slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // nothing kept: the palette still works, without recent commands
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Lower is better; null when it doesn't match. Prefix, word start, anywhere, then letters in order. */
export function score(label: string, query: string): number | null {
  const l = label.toLowerCase();
  if (l.startsWith(query)) return 0;
  if (new RegExp(`(^|[\\s(—-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(l)) return 1;
  if (l.includes(query)) return 2;
  let i = 0;
  for (const ch of l) if (ch === query[i]) i++;
  return i === query.length ? 3 : null;
}

export interface Section {
  group: Group;
  items: Item[];
}

/**
 * The items to show for `query`, in sections. Recent commands come first (moved out of their
 * area), then each group in `groupOrder`; with a query, the best-matching group leads and a
 * group keeps its place among groups that match as well.
 */
export function arrange(all: Item[], query: string, recent: string[], inNotebook: boolean, limit = 150): Section[] {
  const order = groupOrder(inNotebook);
  const q = query.trim().toLowerCase();
  const recentAt = (it: Item) => (it.command ? recent.indexOf(it.command) : -1);
  // the few most recent commands that are on offer now
  const offered = new Set(
    recent
      .filter((id) => all.some((it) => it.command === id && (!q || score(it.label, q) !== null)))
      .slice(0, RECENT_SHOWN),
  );
  const groupOf = (it: Item): Group => (it.command && offered.has(it.command) ? "Recent" : it.group);
  const scored = all.flatMap((item, at) => {
    if (!q) return item.group === "Symbols" ? [] : [{ item, s: 0, at }];
    const s = score(item.label, q);
    return s === null ? [] : [{ item, s, at }];
  });
  const best = new Map<Group, number>();
  for (const x of scored) best.set(groupOf(x.item), Math.min(best.get(groupOf(x.item)) ?? 9, x.s));
  // outside a notebook its commands rank a step lower than they match
  const rank = (g: Group) => (best.get(g)! + (g === "Notebook" && !inNotebook ? 1 : 0)) * 100 + order.indexOf(g);
  scored.sort((a, b) => {
    const [ga, gb] = [groupOf(a.item), groupOf(b.item)];
    if (ga !== gb) return rank(ga) - rank(gb);
    if (ga === "Recent") return recentAt(a.item) - recentAt(b.item);
    return a.s - b.s || a.at - b.at;
  });
  const out: Section[] = [];
  for (const { item } of scored.slice(0, limit)) {
    const group = groupOf(item);
    if (out.at(-1)?.group !== group) out.push({ group, items: [] });
    out.at(-1)!.items.push(item);
  }
  return out;
}
