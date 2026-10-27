// Edit ▸ Find (⌘F): search math, text, notes, captions and area titles; replace in place.
import { createMemo, createRoot, createSignal } from "solid-js";
import { escapeText } from "./richtext";
import { findDraft, layout, localized, mutate, revealRegion, state } from "./store";
import type { Localized, Region } from "./types";

export const [findOpen, setFindOpen] = createSignal(false);
export const [replaceOpen, setReplaceOpen] = createSignal(false);
export const [query, setQuery] = createSignal("");
export const [replacement, setReplacement] = createSignal("");
// names in math are case-sensitive (M is not m)
export const [matchCase, setMatchCase] = createSignal(true);
export const [wholeWord, setWholeWord] = createSignal(false);

const WORD = "[\\p{L}\\p{N}_]";

function pattern(): RegExp | null {
  const q = query();
  if (!q) return null;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(wholeWord() ? `(?<!${WORD})${esc}(?!${WORD})` : esc, matchCase() ? "gu" : "giu");
}

/** What a reader sees of a Djot paragraph: no attribute blocks, no escapes. */
const plain = (djot: string) => djot.replace(/\{[^}\n]*\}/g, "").replace(/\\(.)/g, "$1");

function searchable(r: Region, lang?: string): string[] {
  const out = [r.expr, r.note, localized(r.title, lang), localized(r.caption?.text, lang)];
  if (r.kind === "text") out.push(plain(localized(r.text, lang)));
  return out.filter((s): s is string => !!s);
}

export interface Hit {
  id: string;
  count: number;
}

export const hits = createRoot(() =>
  createMemo<Hit[]>(() => {
    const re = pattern();
    if (!re || !findOpen()) return [];
    const lang = state.doc.meta?.lang;
    const out: Hit[] = [];
    for (const p of layout().list) {
      const count = searchable(p.region, lang).reduce((n, s) => n + (s.match(re)?.length ?? 0), 0);
      if (count) out.push({ id: p.region.id, count });
    }
    return out;
  }),
);

export const hitIds = createRoot(() => createMemo(() => new Set(hits().map((h) => h.id))));
export const occurrences = () => hits().reduce((n, h) => n + h.count, 0);
/** Index of the selected region among the hits, or -1. */
export const currentHit = () => hits().findIndex((h) => h.id === state.selection[0]);

export function openFind(withReplace = false) {
  setFindOpen(true);
  if (withReplace) setReplaceOpen(true);
  queueMicrotask(() => {
    const input = document.querySelector<HTMLInputElement>(".findbar input");
    input?.focus();
    input?.select();
  });
}

export function findStep(dir: 1 | -1) {
  const list = hits();
  if (!list.length) return;
  const i = currentHit();
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  revealRegion(list[next].id);
}

function replaceIn(r: Region, re: RegExp): number {
  let n = 0;
  const swap = (s: string) =>
    s.replace(re, () => {
      n++;
      return replacement();
    });
  // Djot source: leave attribute blocks alone and escape what is put in; a match split by
  // markup isn't replaced, which is also what a reader would expect
  const swapDjot = (s: string) =>
    s
      .split(/(\{[^}\n]*\})/)
      .map((part, i) => (i % 2 ? part : part.replace(re, () => (n++, escapeText(replacement())))))
      .join("");
  const each = (v: Localized, fn: (s: string) => string): Localized =>
    typeof v === "string" ? fn(v) : Object.fromEntries(Object.entries(v).map(([k, s]) => [k, fn(s)]));
  if (r.expr) r.expr = swap(r.expr);
  if (r.note) r.note = swap(r.note);
  if (r.title) r.title = each(r.title, swap);
  if (r.caption) r.caption.text = each(r.caption.text, swap);
  if (r.kind === "text" && r.text) r.text = each(r.text, swapDjot);
  return n;
}

/** Replace in the given regions (one undo step); returns how many were replaced. */
export function replaceHits(ids: string[]): number {
  const re = pattern();
  if (!re || !ids.length) return 0;
  let n = 0;
  mutate((d) => {
    for (const id of ids) {
      const r = findDraft(d, id);
      if (r) n += replaceIn(r, re);
    }
  });
  return n;
}
