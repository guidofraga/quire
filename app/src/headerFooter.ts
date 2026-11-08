// Headers and footers edited on the page: while editing, fields are chips (one unit to delete,
// named in words); in the document they stay the `{page}` text of docs/02-file-format.md §3.

export type Band = "header" | "footer";
export type Slot = "left" | "center" | "right";
export const SLOTS: Slot[] = ["left", "center", "right"];

/** The fields a header or footer can hold, with the name its chip shows. */
export const FIELDS: [key: string, name: string][] = [
  ["page", "Page"],
  ["pages", "Pages"],
  ["date", "Date"],
  ["time", "Time"],
  ["file", "File"],
  ["title", "Title"],
  ["author", "Author"],
  ["company", "Company"],
  ["section", "Section"],
];

const NAMES = new Map(FIELDS);
export const fieldName = (key: string) => NAMES.get(key) ?? key;

/** A slot's text in pieces: plain text, or a field. Unknown `{words}` stay text. */
export type Token = string | { field: string };

export function toTokens(text: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (!NAMES.has(m[1])) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ field: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function fromTokens(tokens: Token[]): string {
  return tokens.map((t) => (typeof t === "string" ? t : `{${t.field}}`)).join("");
}

/** A field's chip: not editable inside, so Backspace takes it as one piece. */
export function chip(doc: Document, key: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = "hf-chip";
  el.contentEditable = "false";
  el.dataset.field = key;
  el.textContent = fieldName(key);
  return el;
}

/** Show a slot's text in an editable element, fields as chips. */
export function renderSlot(el: HTMLElement, text: string) {
  el.replaceChildren(
    ...toTokens(text).map((t) =>
      typeof t === "string" ? el.ownerDocument.createTextNode(t) : chip(el.ownerDocument, t.field),
    ),
  );
}

/** The text a slot (or part of one) stands for: chips back to `{page}`, on one line. */
export function readSlot(root: Node): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
    else if (n instanceof HTMLElement && n.dataset.field) out += `{${n.dataset.field}}`;
    else if (n.nodeName === "BR") out += " ";
    else n.childNodes.forEach(walk);
  };
  walk(root);
  // the editor writes no-break spaces for spaces at the ends; a header is one line
  return out.replace(/ /g, " ").replace(/[\r\n]+/g, " ");
}

/**
 * Turn `{page}` typed by hand into a chip, keeping the caret after it. Returns whether
 * anything changed.
 */
export function chipTypedFields(el: HTMLElement): boolean {
  let changed = false;
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  for (const node of [...el.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const tokens = toTokens(node.nodeValue ?? "");
    if (!tokens.some((t) => typeof t !== "string")) continue;
    const caret = sel?.anchorNode === node ? sel.anchorOffset : -1;
    const parts = tokens.map((t) => (typeof t === "string" ? doc.createTextNode(t) : chip(doc, t.field)));
    node.replaceWith(...parts);
    changed = true;
    if (caret < 0 || !sel) continue;
    // the caret stays where it was in the text: inside a piece of text, or after a chip
    const r = doc.createRange();
    let at = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const len = typeof t === "string" ? t.length : t.field.length + 2;
      if (caret <= at + len || i === tokens.length - 1) {
        if (typeof t === "string") r.setStart(parts[i], Math.min(caret - at, len));
        else r.setStartAfter(parts[i]);
        break;
      }
      at += len;
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return changed;
}

const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * Undo inside one editing session: snapshots of the band (its slots, and its image, rule and
 * type from the toolbar), typing coalesced.
 */
export class SlotHistory<T = Record<Slot, string>> {
  private past: T[] = [];
  private future: T[] = [];
  private last = 0;
  private lastSlot: Slot | null = null;

  /** Call before a change; typing in the same slot within `quiet` ms joins the previous step. */
  before(state: T, slot: Slot, typing: boolean, now = Date.now(), quiet = 1000) {
    const joins = typing && slot === this.lastSlot && now - this.last < quiet && this.past.length > 0;
    if (!joins) this.past.push(copy(state));
    this.future.length = 0;
    this.last = typing ? now : 0;
    this.lastSlot = slot;
  }

  undo(state: T): T | null {
    if (!this.past.length) return null;
    const prev = this.past.pop()!;
    this.future.push(copy(state));
    this.last = 0;
    return prev;
  }

  redo(state: T): T | null {
    if (!this.future.length) return null;
    const next = this.future.pop()!;
    this.past.push(copy(state));
    this.last = 0;
    return next;
  }
}
