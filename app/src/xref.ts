// Cross-references: "see Figure 2", "Table 1", "Section 2.1", "on page 4", kept current as
// the document changes. In text they are empty links to a region, `[](#ref:<id>)`, with
// an optional style class: `{.num}` (2.1), `{.page}` (page 4) or `{.title}` (its caption).
import { refLabel } from "./labels";
import { layout, localized, state, type Placed } from "./store";

export type RefStyle = "" | "num" | "page" | "title";

export interface Target {
  id: string;
  kind: "heading" | "figure" | "table";
  /** "2.1", "3": the number shown in the document. */
  number: string;
  /** The heading or caption text. */
  title: string;
  page: number;
}

const textOf = (html: string | undefined, selector?: string) => {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html");
  const el = (selector ? doc.querySelector(selector) : null) ?? doc.body;
  return el.textContent?.replace(/\s+/g, " ").trim() ?? "";
};

function target(p: Placed): Target | null {
  if (!p.number) return null;
  const r = p.region;
  const start = (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
  const page = layout().pageView ? p.page + start : 0;
  if (r.kind === "text") {
    return { id: r.id, kind: "heading", number: p.number, title: textOf(state.report?.html[r.id], "h1, h2, h3, h4, h5, h6"), page };
  }
  if (!r.caption) return null;
  const caption = textOf(state.report?.html[`${r.id}:caption`]) || localized(r.caption.text);
  return { id: r.id, kind: r.kind === "table" ? "table" : "figure", number: p.number, title: caption, page };
}

/** Everything a reference can point at, in reading order. */
export function targets(): Target[] {
  return layout()
    .list.filter((p) => !p.hidden)
    .map(target)
    .filter((t): t is Target => t !== null);
}

const label = (t: Target) => refLabel(t.kind === "heading" ? "section" : t.kind, t.number);

/** What a reference reads, or null when its target is gone. */
export function refText(id: string, style: RefStyle = ""): string | null {
  const p = layout().byId.get(id);
  const t = p ? target(p) : null;
  if (!t) return null;
  const headingsNumbered = state.doc.styles?.numbering?.headings !== "";
  switch (style) {
    case "num":
      return t.number;
    case "page":
      return t.page ? `page ${t.page}` : "page ?";
    case "title":
      return t.title || label(t);
    default:
      return t.kind === "heading" && !headingsNumbered ? `“${t.title}”` : label(t);
  }
}

export const refStyleOf = (el: Element): RefStyle =>
  (["num", "page", "title"].find((c) => el.classList.contains(c)) as RefStyle | undefined) ?? "";

/** Fill the references in rendered text (`<a href="#ref:id">`) with their current text. */
export function fillRefs(el: HTMLElement) {
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href^="#ref:"]')) {
    const id = a.getAttribute("href")!.slice(5);
    const text = refText(id, refStyleOf(a));
    a.classList.add("xref");
    a.classList.toggle("xref-missing", text === null);
    a.dataset.ref = id;
    a.textContent = text ?? "missing reference";
    a.title = text === null ? "What this pointed to was deleted" : "Click to go there";
  }
}

/** Clicking a reference in rendered text goes to what it points at. */
export function installRefs(reveal: (id: string) => void) {
  const hit = (e: Event) => (e.target as Element).closest?.("a.xref[data-ref]") as HTMLAnchorElement | null;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const a = hit(e);
      if (!a || a.closest(".ProseMirror") || a.classList.contains("xref-missing")) return;
      e.preventDefault();
      e.stopPropagation();
      reveal(a.dataset.ref!);
    },
    true,
  );
  // never follow the link itself
  document.addEventListener("click", (e) => hit(e) && e.preventDefault(), true);
}
