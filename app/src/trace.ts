// Where a variable comes from: with the caret on a name (or the pointer over one, or a
// definition selected), its definitions and every line that reads it are highlighted;
// ⌘-click (Ctrl-click) on a name jumps to the definition that applies there.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { layout, revealRegion, state } from "./store";
import type { Expr } from "./types";

const [caretName, setCaretName] = createSignal<string | null>(null);
const [hoverName, setHoverName] = createSignal<string | null>(null);
export { setCaretName };

/** `f(x)` → `f`, `v[2]` → `v`. */
export const baseName = (defines: string | null | undefined) => (defines ? defines.split(/[([]/)[0] : null);

function selectedDefinition(): string | null {
  if (state.editing || state.selection.length !== 1) return null;
  return baseName(state.views[state.selection[0]]?.defines);
}

/** The name being traced. */
export const tracedName = () => caretName() ?? hoverName() ?? selectedDefinition();

/** Names an expression reads (not the names it defines, and not units). */
function reads(e: Expr | null, units: ReadonlySet<string>, out: Set<string>) {
  if (!e) return out;
  switch (e.t) {
    case "Ident":
      if (!units.has(e.c)) out.add(e.c);
      break;
    case "Call":
      out.add(e.c[0]);
      e.c[1].forEach((a) => reads(a, units, out));
      break;
    case "Define": {
      // the parameters of f(x) := … are its own, not the document's
      const own = new Set(e.c.lhs.t === "Call" ? e.c.lhs.c[1].flatMap((p) => (p.t === "Ident" ? [p.c] : [])) : []);
      const inner = reads(e.c.rhs, units, new Set());
      if (e.c.lhs.t === "Index") e.c.lhs.c[1].forEach((i) => reads(i, units, inner));
      for (const n of inner) if (!own.has(n)) out.add(n);
      break;
    }
    default:
      for (const child of children(e)) reads(child, units, out);
  }
  return out;
}

function children(e: Expr): Expr[] {
  const found: Expr[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      if ("t" in x) found.push(x as Expr);
      else Object.values(x).forEach(walk);
    }
  };
  walk((e as { c?: unknown }).c);
  return found;
}

interface Line {
  id: string;
  defines: string | null;
  global: boolean;
  reads: Set<string>;
}

/** Math regions in reading order, with what each defines and reads. */
const lines = createRoot(() =>
  createMemo((): Line[] =>
    layout()
      .list.filter((p) => p.region.kind === "math" || p.region.kind === "table")
      .map((p) => {
        const v = state.views[p.region.id];
        const input = v?.input ?? null;
        return {
          id: p.region.id,
          defines: baseName(v?.defines),
          global: input?.t === "Define" && input.c.global,
          reads: reads(input, new Set(v?.units ?? []), new Set()),
        };
      }),
  ),
);

/** The regions defining and reading the traced name. */
export const trace = createRoot(() =>
  createMemo(() => {
    const name = tracedName();
    if (!name) return null;
    const defs = new Set<string>();
    const uses = new Set<string>();
    for (const l of lines()) {
      if (l.defines === name) defs.add(l.id);
      if (l.reads.has(name)) uses.add(l.id);
    }
    return defs.size || uses.size ? { name, defs, uses } : null;
  }),
);

/** The definition of `name` that the region `from` sees: the last one above it, else a global one. */
export function definitionFor(name: string, from: string): string | null {
  const all = lines();
  const at = all.findIndex((l) => l.id === from);
  for (let i = (at < 0 ? all.length : at) - 1; i >= 0; i--) if (all[i].defines === name) return all[i].id;
  return (
    all.find((l) => l.defines === name && l.global)?.id ??
    all.find((l) => l.defines === name && l.id !== from)?.id ??
    null
  );
}

const IDENT = /[\p{L}\p{N}_.]/u;

/** The name the caret is on in linear math (`L.span` in `M := q*L.span^2/8`), if any. */
export function nameAt(text: string, at: number): string | null {
  let a = at;
  let b = at;
  while (a > 0 && IDENT.test(text[a - 1])) a--;
  while (b < text.length && IDENT.test(text[b])) b++;
  const word = text.slice(a, b).replace(/^\.+|\.+$/g, "");
  if (!word || !/^\p{L}/u.test(word) || text[a - 1] === "'") return null;
  return word;
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

export function installTrace() {
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as Element).closest?.(".region [data-v]");
    clearTimeout(hoverTimer);
    if (!el) return setHoverName(null);
    const name = el.getAttribute("data-v");
    hoverTimer = setTimeout(() => setHoverName(name), 150);
  });
  // ⌘-click / Ctrl-click a name: go to its definition (a ⌘-drag still moves the region)
  let down: [number, number] | null = null;
  document.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]), true);
  document.addEventListener(
    "click",
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const el = (e.target as Element).closest?.(".region [data-v]");
      const region = el?.closest<HTMLElement>("[data-region]")?.dataset.region;
      if (!el || !region || state.editing === region) return;
      const def = definitionFor(el.getAttribute("data-v")!, region);
      if (!def || def === region) return;
      e.preventDefault();
      e.stopPropagation();
      revealRegion(def);
    },
    true,
  );
  // the traced name, marked wherever it is written
  const style = document.createElement("style");
  document.head.append(style);
  createRoot(() =>
    createEffect(() => {
      const t = trace();
      style.textContent = t
        ? `.region [data-v="${CSS.escape(t.name)}"] { background: var(--trace-name); border-radius: 2px; }`
        : "";
    }),
  );
}
