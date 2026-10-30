// Inserting symbols, structures, constants and units from the equation galleries.
import { createSignal } from "solid-js";
import { api } from "./api";
import { mathml } from "./math";
import { insertIntoMath } from "./MathEditor";
import { activeView, insertMathChip, insertText } from "./richtext";
import { insertAtCaret } from "./store";
import { STRUCTURES } from "./symbols";
import type { Doc, Library } from "./types";

/**
 * Insert at the right place: into the math being edited, into the text being edited
 * (structures become live math there), or as a new math region at the insertion point.
 */
export function insertSnippet(text: string, opts: { template?: boolean } = {}) {
  if (insertIntoMath(text)) return;
  if (activeView()) {
    if (opts.template) insertMathChip(text);
    else insertText(text);
    return;
  }
  insertAtCaret("math", text);
}

// ---------------------------------------------------------------------------
// Typeset previews of the structure templates (parsed by the engine once)
// ---------------------------------------------------------------------------

const [previews, setPreviews] = createSignal<Record<string, string>>({});
export { previews };
let previewsRequested = false;

export function loadPreviews() {
  if (previewsRequested) return;
  previewsRequested = true;
  const items = STRUCTURES.flatMap((c) => c.items);
  const doc: Doc = {
    format: "quire/1",
    regions: items.map((it, i) => ({
      id: `tpl${String(i).padStart(3, "0")}`,
      kind: "math",
      at: [0, i * 20],
      expr: it.insert,
    })),
  };
  api
    .report(doc)
    .then((r) => {
      const out: Record<string, string> = {};
      r.regions.forEach((v) => {
        const i = Number(v.id.slice(3));
        if (v.input && items[i]) out[items[i].name] = mathml(v.input);
      });
      setPreviews(out);
    })
    .catch(() => {
      previewsRequested = false;
    });
}

// ---------------------------------------------------------------------------
// Constants and units (from the engine)
// ---------------------------------------------------------------------------

const [library, setLibrary] = createSignal<Library | null>(null);
export { library };

export function loadLibrary() {
  if (library()) return;
  api
    .library()
    .then(setLibrary)
    .catch(() => {});
}

export { prettyValue as valueText } from "./math";
