// What a region says, in a sentence, for screen readers: spoken when the keyboard selects
// it, and read in place of the typeset math.
import { isComparison, mathCheck } from "./checks";
import type { NameMarks } from "./math";
import { prefs } from "./settings";
import { spokenMath } from "./speech";
import { layout, localized, state } from "./store";
import type { Redefines, RegionView } from "./types";

const plain = (html: string | undefined) =>
  html ? (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim() : "";

const short = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `Redefines tesla (unit)`: the hover title on a definition that hides a built-in. */
export const redefinesText = (r: Redefines) => `Redefines ${r.title} (${r.kind})`;

/** `W is the unit watt; if you meant a variable, define it above`. */
export function unitNoteText(n: { name: string; unit?: string }) {
  const what = n.unit ? `the unit ${n.unit}` : "a unit";
  return `${n.name} is ${what}; if you meant a variable, define it above`;
}

/** The faint marks on a math region's names (Settings ▸ Flag ambiguous names). */
export function nameMarks(v: RegionView | undefined): NameMarks {
  if (!v || !prefs.nameNotes) return {};
  const read = v.namesReadAsUnits ?? [];
  return {
    defines: v.redefines && { name: v.redefines.name, title: redefinesText(v.redefines) },
    units: read.length ? new Map(read.map((n) => [n.name, unitNoteText(n)])) : undefined,
  };
}

/** A math region in words, with its result, check verdict, name marks and error. */
export function mathWords(id: string, withError = true): string {
  const r = layout().byId.get(id)?.region;
  const v = state.views[id];
  if (!r) return "";
  const check = mathCheck(r, v);
  const comparison = check !== null && isComparison(v?.input);
  const words = v?.input
    ? spokenMath(v.input, r.show && !comparison ? v.result : null, v.units, v.constants, r.show === "symbolic")
    : (r.expr ?? "");
  const verdict = check === null ? "" : check ? ", check passes" : ", check fails";
  const marks = nameMarks(v);
  const notes = [marks.defines?.title, ...(marks.units?.values() ?? [])].filter(Boolean).map((t) => `. ${t}`);
  const error = withError && v?.error ? `. Error: ${v.error}` : "";
  return `${words}${verdict}${notes.join("")}${error}`;
}

/** A solve block in words: how many constraints, then its solution or why there is none. */
export function solveWords(id: string): string {
  const r = layout().byId.get(id)?.region;
  if (r?.kind !== "solve") return "";
  const n = Array.isArray(r.given) ? r.given.length : 0;
  const head = `Solve block, ${n} ${n === 1 ? "constraint" : "constraints"}`;
  const f = state.views[`${id}:f`];
  if (f?.error) return `${head}. Error: ${f.error}`;
  const result = f?.input ? spokenMath(f.input, r.show === "value" ? f.result : null, f.units, f.constants) : "";
  return result ? `${head}. ${result}` : head;
}

/** The selected region, as a screen reader should hear it. */
export function describeRegion(id: string): string {
  const p = layout().byId.get(id);
  if (!p) return "";
  const r = p.region;
  const html = state.report?.html ?? {};
  const caption = r.caption ? plain(html[`${id}:caption`]) || localized(r.caption.text) : "";
  const withCaption = (s: string) => (caption ? `${s}, ${caption}` : s);
  switch (r.kind) {
    case "math":
      return `Math: ${mathWords(id)}`;
    case "text":
      return `${p.number ? `Heading ${p.number}: ` : "Text: "}${short(plain(html[id]) || localized(r.text, state.doc.meta?.lang))}`;
    case "table": {
      const rows = (r.rows as unknown[][] | undefined) ?? [];
      const name = r.name as string | undefined;
      return withCaption(`Table${name ? ` ${name}` : ""}, ${rows.length} rows, ${rows[0]?.length ?? 0} columns`);
    }
    case "plot2d":
    case "plot3d":
      return withCaption(
        `${r.kind === "plot3d" ? "3D plot" : "Plot"}${state.views[id]?.error ? `. Error: ${state.views[id]!.error}` : ""}`,
      );
    case "image":
      return withCaption("Image");
    case "area":
      return `Area${plain(html[`${id}:title`]) ? ` ${plain(html[`${id}:title`])}` : ""}, ${r.collapsed ? "collapsed" : "expanded"}`;
    case "toc":
      return String(r.title ?? (r.of === "checks" ? "Summary of checks" : "Contents"));
    case "solve":
      return solveWords(id);
    case "pagebreak":
      return "Page break";
    case "unreadable":
      return "A region this version of Quire can't read";
    default:
      return r.kind;
  }
}
