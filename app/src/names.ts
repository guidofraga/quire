// What a name typed in math can mean where it is: your variable or function, a unit, a constant.
// The engine lists the meanings (`api.complete`); this finds the name at the caret, keeps the
// answers for the edit so typing stays instant, and works out the next meaning for ⌥Enter.
import { unwrap } from "solid-js/store";
import { api } from "./api";
import { state } from "./store";
import type { Completion, UnitChoice } from "./types";

/** A name in linear math: `[from, to)` covers it with its `'` or `#`; `typed` is the part before the caret. */
export interface NameSpan {
  from: number;
  to: number;
  name: string;
  /** `'` (always the unit), `#` (always the constant) or "". */
  marker: string;
  typed: string;
}

// `°` starts a name too: `20 °C`
const NAME_CHAR = /[\p{L}\p{N}_.°]/u;

/** The name the caret is in or right after (`T` in `2T|`, `L.span` in `q*L.sp|an`), if any. */
export function nameSpan(text: string, caret: number): NameSpan | null {
  let a = caret;
  let b = caret;
  while (a > 0 && NAME_CHAR.test(text[a - 1])) a--;
  while (b < text.length && NAME_CHAR.test(text[b])) b++;
  // a number in front is not part of the name: `2T`, `1.5m`
  let s = a;
  while (s < b && /[\p{N}.]/u.test(text[s])) s++;
  if (s >= b || !/[\p{L}°]/u.test(text[s]) || caret < s) return null;
  let e = b;
  while (e > s && text[e - 1] === ".") e--;
  const marker = s === a && (text[s - 1] === "'" || text[s - 1] === "#") ? text[s - 1] : "";
  return { from: s - marker.length, to: e, name: text.slice(s, e), marker, typed: text.slice(s, Math.min(caret, e)) };
}

/**
 * Where a unit goes: right after a number (`20 C`, `20C`, `1.5e3 m`), or after a unit that
 * follows one (`9.81 m/s`, `5 kN*m`). `from` is where the name starts, before any `'`.
 */
export function unitPosition(text: string, from: number): boolean {
  return /(?:^|[^\p{L}\p{N}_.])\p{N}+(?:\.\p{N}*)?(?:[eE][+-]?\p{N}+)?\s*(?:'?[\p{L}°][\p{L}\p{N}_.°]*(?:\^\p{N}+)?\s*[*/·]\s*)*$/u.test(
    text.slice(0, from),
  );
}

/** The meanings of `name` in the order ⌥Enter visits them: yours, then the unit, then the constant. */
export function cycleOrder(entries: Completion[], name: string): Completion[] {
  const exact = entries.filter((c) => c.name === name);
  const first = (...kinds: Completion["kind"][]) => exact.find((c) => kinds.includes(c.kind));
  return [first("variable", "function"), first("unit"), first("constant")].filter((c): c is Completion => !!c);
}

/**
 * Which of `order` the name means as written. A `'` or `#` says so; a plain name is your
 * variable when you defined one above, else (the engine's rule) the unit right after a number
 * and the constant anywhere else, whichever exists.
 */
export function currentMeaning(order: Completion[], span: NameSpan, text: string): number {
  const written = text.slice(span.from, span.to);
  const exact = order.findIndex((c) => c.insert === written);
  if (exact >= 0) return exact;
  const kinds = order.map((c) => c.kind);
  if (span.marker === "'") return kinds.indexOf("unit");
  if (span.marker === "#") return kinds.indexOf("constant");
  const yours = kinds.findIndex((k) => k === "variable" || k === "function");
  if (yours >= 0) return yours;
  const afterNumber = /[\p{N}.]\s*$/u.test(text.slice(0, span.from));
  const [preferred, other] = afterNumber ? ["unit", "constant"] : ["constant", "unit"];
  return kinds.includes(preferred as Completion["kind"])
    ? kinds.indexOf(preferred as Completion["kind"])
    : kinds.indexOf(other as Completion["kind"]);
}

/** The words a screen reader says for each kind (the list shows a glyph instead). */
export const KIND_WORD: Record<Completion["kind"], string> = {
  variable: "variable",
  function: "function",
  unit: "unit",
  constant: "constant",
};

// ---------------------------------------------------------------------------
// The engine's answers, kept for the edit: the regions above don't change while one is being
// typed, so a prefix asked once is answered from memory, and a longer one from a shorter one
// while the engine is asked.
// ---------------------------------------------------------------------------

let forRegion = "";
const known = new Map<string, Completion[]>();
const asked = new Map<string, Promise<Completion[]>>();
const knownChoices = new Map<string, UnitChoice[]>();
const askedChoices = new Map<string, Promise<UnitChoice[]>>();

/** Forget the answers (a new edit begins: the regions above may have changed). */
export function forgetMeanings(regionId: string) {
  forRegion = regionId;
  known.clear();
  asked.clear();
  knownChoices.clear();
  askedChoices.clear();
}

/** Ask the engine once per key, keep the answer for the edit. */
function cached<T>(
  regionId: string,
  key: string,
  have: Map<string, T[]>,
  pending: Map<string, Promise<T[]>>,
  ask: () => Promise<T[]>,
): Promise<T[]> {
  if (regionId !== forRegion) forgetMeanings(regionId);
  const hit = have.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = ask().then(
      (list) => {
        if (forRegion === regionId) have.set(key, list);
        return list;
      },
      () => [] as T[],
    );
    pending.set(key, p);
  }
  return p;
}

/**
 * `query` loosely in `text`: its letters in order, any case. While the engine's ranked answer
 * for a longer query is on its way, the shorter one's is narrowed with this.
 */
export function looselyIn(query: string, text: string): boolean {
  const hay = text.toLowerCase();
  let at = 0;
  for (const ch of query.toLowerCase()) {
    at = hay.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

/** What can go where a unit is typed, `query` so far, best first (a fuzzy search, `20 C|`). */
export function unitMeanings(regionId: string, query: string): Promise<Completion[]> {
  return cached(regionId, `unit:${query}`, known, asked, () => api.completeUnits(unwrap(state.doc), regionId, query));
}

/** The unit answer known for `query`: its own (`exact`), or a shorter query's, narrowed. */
export function knownUnitMeanings(regionId: string, query: string): { list: Completion[]; exact: boolean } | null {
  if (regionId !== forRegion) return null;
  const hit = known.get(`unit:${query}`);
  if (hit) return { list: hit, exact: true };
  for (let n = query.length - 1; n >= 1; n--) {
    const shorter = known.get(`unit:${query.slice(0, n)}`);
    if (shorter) return { list: shorter.filter((c) => looselyIn(query, `${c.name} ${c.title ?? ""}`)), exact: false };
  }
  return null;
}

/** The units the result of `expr` can be shown in that match `query`, best first. */
export function showInChoices(regionId: string, expr: string, query: string): Promise<UnitChoice[]> {
  return cached(regionId, `${expr}=${query}`, knownChoices, askedChoices, () =>
    api.showIn(unwrap(state.doc), regionId, query),
  );
}

/** The answer known for `query` after `=`, as {@link knownUnitMeanings}. */
export function knownShowIn(
  regionId: string,
  expr: string,
  query: string,
): { list: UnitChoice[]; exact: boolean } | null {
  if (regionId !== forRegion) return null;
  const hit = knownChoices.get(`${expr}=${query}`);
  if (hit) return { list: hit, exact: true };
  return null;
}

/** What names starting with `prefix` can mean in the region, from the engine. */
export function meanings(regionId: string, prefix: string): Promise<Completion[]> {
  return cached(regionId, prefix, known, asked, () => api.complete(unwrap(state.doc), regionId, prefix));
}

/**
 * The meanings already known for `prefix`: its own answer (`exact`), or the answer for the
 * longest shorter prefix, narrowed. A unit with a prefix (`kN`) is only listed once typed in
 * full, so a narrowed answer is shown while the exact one is asked for.
 */
export function knownMeanings(regionId: string, prefix: string): { list: Completion[]; exact: boolean } | null {
  if (regionId !== forRegion) return null;
  const hit = known.get(prefix);
  if (hit) return { list: hit, exact: true };
  for (let n = prefix.length - 1; n >= 0; n--) {
    const shorter = known.get(prefix.slice(0, n));
    if (shorter) return { list: shorter.filter((c) => c.name.startsWith(prefix)), exact: false };
  }
  return null;
}
