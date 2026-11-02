// What a region says, in a sentence, for screen readers: spoken when the keyboard selects
// it, and read in place of the typeset math.
import { isComparison, mathCheck } from "./checks";
import { spokenMath } from "./speech";
import { layout, localized, state } from "./store";

const plain = (html: string | undefined) =>
  html ? (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim() : "";

const short = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A math region in words, with its result, check verdict and error. */
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
  const error = withError && v?.error ? `. Error: ${v.error}` : "";
  return `${words}${verdict}${error}`;
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
    case "unreadable":
      return "A region this version of Quire can't read";
    default:
      return r.kind;
  }
}
