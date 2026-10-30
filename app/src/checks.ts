// Design checks: a comparison shown with `=` (`σ ≤ f.y =`), or a result that reads as
// pass or fail (`if(…, "OK", "FAIL")`), in math or in a table cell. They are marked ✓ / ✗,
// counted in the status bar and listed by Insert ▸ Summary of Checks.
import { createMemo, createRoot } from "solid-js";
import { layout, localized, state } from "./store";
import type { Expr, Region, RegionView } from "./types";

const PASS = /^(ok|pass(es|ed)?|yes|safe|satisfied|sim|atende|ok!|conforme|cumple|si|sí|erfüllt|ja)$/i;
const FAIL = /^(fail(s|ed)?|no|not ok|unsafe|ng|falha|não|nao|não atende|nao atende|no cumple|nicht erfüllt|nein)$/i;

/** "OK" → true, "FAIL" → false, anything else → null. */
export function verdictOf(text: string | null | undefined): boolean | null {
  const t = (text ?? "").trim().replace(/^"|"$/g, "").trim();
  if (PASS.test(t)) return true;
  if (FAIL.test(t)) return false;
  return null;
}

/** A comparison, possibly defined: `σ ≤ f.y`, `ok := σ ≤ f.y`. */
export const isComparison = (e: Expr | null | undefined): boolean =>
  !!e && (e.t === "Compare" || (e.t === "Define" && e.c.rhs.t === "Compare"));

/** Whether a math region is a check, and whether it passes. */
export function mathCheck(r: Region, v: RegionView | undefined): boolean | null {
  if (r.kind !== "math" || !r.show || !v?.resultText || v.error) return null;
  if (isComparison(v.input)) return v.resultText.trim() !== "0";
  return v.result?.t === "Str" ? verdictOf(v.result.c) : null;
}

export interface Check {
  id: string;
  pass: boolean;
  /** For tables: the cell, and the row's first cell as its name. */
  cell?: [number, number];
  row?: string;
  page: number;
}

const sameCheck = (a: Check, b: Check) =>
  a.id === b.id && a.pass === b.pass && a.page === b.page && a.row === b.row && a.cell?.join() === b.cell?.join();

/** Every check in reading order; unchanged by a layout change that moves no check. */
export const checks = createRoot(() =>
  createMemo(
    (): Check[] => {
      const out: Check[] = [];
      for (const p of layout().list) {
        if (p.hidden) continue;
        const r = p.region;
        const v = state.views[r.id];
        const m = mathCheck(r, v);
        if (m !== null) out.push({ id: r.id, pass: m, page: p.page });
        v?.cells?.forEach((row, i) =>
          row.forEach((cell, j) => {
            const c = cell.error ? null : verdictOf(cell.text);
            const rows = Array.isArray(r.rows) ? (r.rows as string[][]) : [];
            if (c !== null) out.push({ id: r.id, pass: c, cell: [i, j], row: rows[i]?.[0] ?? "", page: p.page });
          }),
        );
      }
      return out;
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((c, i) => sameCheck(c, b[i])) },
  ),
);

export const failing = () => checks().filter((c) => !c.pass);

/** A table's name for a check in it: its caption, else its name. */
export const tableName = (r: Region) =>
  (r.caption ? localized(r.caption.text, state.doc.meta?.lang) : "") || (r.name as string | undefined) || "Table";

/** The region checks are found in, for labels. */
export const regionOf = (id: string) => layout().byId.get(id)?.region;
