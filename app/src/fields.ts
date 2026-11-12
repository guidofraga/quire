// The fields of a header or footer (`{page}`, `{date}`, `{title}` …) worked out for a page, and
// the same fields filled in where text is shown: in text regions and table cells.
import { type FieldContext, fillFields } from "./pages";
import { layout, localized, sectionOn, state } from "./store";

/** The number the first page carries (Document ▸ Page ▸ Page numbers). */
export const startNumber = () => (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;

function fileLabel(): string {
  return state.path?.replace(/\/+$/, "").split("/").pop() ?? "Untitled.quire";
}

/** The values fields take on page `k` (0-based). */
export function fieldContext(k: number, pages: number): FieldContext {
  const meta = state.doc.meta ?? {};
  return {
    page: startNumber() + k,
    pages,
    file: fileLabel(),
    title: localized(meta.title, meta.lang),
    author: ((meta.authors as string[] | undefined) ?? []).join(", "),
    company: String(meta.company ?? ""),
    lang: meta.lang,
    now: new Date(),
  };
}

/** `text` with its fields filled in as on page `k` (0-based), of `pages`. */
export function fill(text: string | undefined, k: number, pages: number): string {
  if (!text) return "";
  const c = fieldContext(k, pages);
  if (text.includes("{section}")) c.section = sectionOn(layout(), k, c.lang);
  return fillFields(text, c);
}

/** `text` with its fields filled in for a region on page `k`; the page count is the document's. */
export const fillOnPage = (text: string, k: number) =>
  text.includes("{") ? fill(text, k, layout().contentPages) : text;

/** Fill the fields in the text of an element's HTML, leaving code and math as written. */
export function fillTextFields(root: HTMLElement, k: number) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.nodeValue?.includes("{") && !t.parentElement?.closest("code, pre, math, .raw")) nodes.push(t);
  }
  for (const t of nodes) {
    const filled = fillOnPage(t.nodeValue ?? "", k);
    if (filled !== t.nodeValue) t.nodeValue = filled;
  }
}
