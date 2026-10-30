// Rich-text editing for text regions: ProseMirror in the editor, Djot in the document.
//
// Djot → HTML (Rust, `djot_html`) → ProseMirror; ProseMirror → Djot (`toDjot` below).
// Each top-level block keeps its source: unchanged blocks are written back byte for byte,
// and blocks the schema can't express (tables, code…) are kept as uneditable `djot_block`s.
// The format bar drives the commands here.
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  type Attrs,
  type Mark,
  type MarkType,
  type Node as PMNode,
  DOMParser as PMParser,
  type NodeType,
  Schema,
} from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, EditorState, TextSelection } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import { createEffect, createRoot, createSignal } from "solid-js";
import { type RefStyle, refStyleOf, refText } from "./xref";
import { prefs } from "./settings";
import { runAppCommand } from "./store";
import { completionKey, hideCompletions, showCompletions } from "./Completion";
import { commandsFor, completions, exact, isTemplate, type Sym } from "./symbols";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type Align = "left" | "center" | "right" | "justify";

const blockAttrSpec = { align: { default: null }, size: { default: null }, font: { default: null } };

function readBlockAttrs(el: HTMLElement) {
  // Djot puts heading attributes on the surrounding <section>
  const host = el.closest("section") ?? el;
  const has = (c: string) => el.classList.contains(c) || host.classList.contains(c);
  const attr = (a: string) => el.getAttribute(a) ?? host.getAttribute(a);
  const size = attr("size");
  return {
    align: (["center", "right", "justify"] as const).find(has) ?? null,
    size: size && /^[\d.]+$/.test(size) ? Number(size) : null,
    font: attr("font"),
    title: has("title"),
  };
}

function blockDom(attrs: Attrs, cls = "") {
  const style = [
    attrs.align ? `text-align:${attrs.align}` : "",
    attrs.size ? `font-size:${attrs.size}pt` : "",
    attrs.font ? `font-family:"${String(attrs.font).replace(/"/g, "")}"` : "",
  ]
    .filter(Boolean)
    .join(";");
  return { ...(style ? { style } : {}), ...(cls ? { class: cls } : {}) };
}

/** A tight list's items hold their text directly; a loose one's are paragraphs. */
const isTight = (list: HTMLElement) =>
  ![...list.children].some((li) => [...li.children].some((c) => c.tagName === "P"));

/** A block the editor shows but cannot change: rendered HTML, Djot source written back as is. */
function keptDom(n: PMNode): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "djot-kept";
  dom.title = "This part can't be edited here; it is kept as written";
  const html = String(n.attrs.html);
  if (html.trim()) {
    dom.innerHTML = html;
    // inline math shows its expression; it is evaluated once editing ends
    for (const m of dom.querySelectorAll<HTMLElement>("span.qmath")) m.textContent = m.dataset.expr ?? "";
  } else {
    // a link definition or a comment renders nothing; show its source so it isn't invisible
    const pre = document.createElement("pre");
    pre.textContent = String(n.attrs.src).trim();
    dom.appendChild(pre);
  }
  dom.dataset.djot = String(n.attrs.src);
  dom.dataset.keep = "";
  return dom;
}

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: blockAttrSpec,
      parseDOM: [{ tag: "p", getAttrs: (d) => readBlockAttrs(d as HTMLElement) }],
      toDOM: (n) => ["p", blockDom(n.attrs), 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      defining: true,
      attrs: { ...blockAttrSpec, level: { default: 1 }, title: { default: false } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        getAttrs: (d: HTMLElement) => ({ ...readBlockAttrs(d), level }),
      })),
      toDOM: (n) => [`h${n.attrs.level}`, blockDom(n.attrs, n.attrs.title ? "title" : ""), 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    bullet_list: {
      group: "block",
      content: "list_item+",
      attrs: { tight: { default: true } },
      parseDOM: [{ tag: "ul", getAttrs: (d) => ({ tight: isTight(d as HTMLElement) }) }],
      toDOM: () => ["ul", 0],
    },
    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { start: { default: 1 }, tight: { default: true } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (d) => {
            const el = d as HTMLElement;
            const start = Number(el.getAttribute("start") ?? 1);
            return { start: Number.isInteger(start) && start >= 0 ? start : 1, tight: isTight(el) };
          },
        },
      ],
      toDOM: (n) => ["ol", n.attrs.start === 1 ? {} : { start: String(n.attrs.start) }, 0],
    },
    list_item: { content: "paragraph block*", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
    /** Djot the editor can't represent (a table, code, a footnote…), kept as its source. */
    djot_block: {
      group: "block",
      atom: true,
      selectable: true,
      attrs: { src: { default: "" }, html: { default: "" } },
      parseDOM: [
        {
          tag: "div[data-keep]",
          getAttrs: (d) => {
            const el = d as HTMLElement;
            return { src: el.dataset.djot ?? "", html: el.innerHTML };
          },
        },
      ],
      toDOM: keptDom,
    },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
    math: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { expr: { default: "" } },
      parseDOM: [{ tag: "span.qmath", getAttrs: (d) => ({ expr: (d as HTMLElement).dataset.expr ?? "" }) }],
      toDOM: (n) => ["span", { class: "qmath-edit" }, n.attrs.expr],
    },
    xref: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { id: { default: "" }, style: { default: "" } },
      parseDOM: [
        {
          tag: 'a[href^="#ref:"]',
          // before the link mark, which would otherwise take the <a>
          priority: 60,
          getAttrs: (d) => {
            const a = d as HTMLElement;
            return { id: a.getAttribute("href")!.slice(5), style: refStyleOf(a) };
          },
        },
      ],
      toDOM: (n) => ["span", { class: "qref-edit" }, String(n.attrs.id)],
    },
  },
  marks: {
    // first, so that it is the outermost mark: a link wraps the formatting inside it
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (d) => {
            const href = (d as HTMLElement).getAttribute("href") ?? "";
            return href.startsWith("#ref:") ? false : { href };
          },
        },
      ],
      toDOM: (m) => ["a", { href: m.attrs.href, title: m.attrs.href }, 0],
    },
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    underline: {
      parseDOM: [{ tag: "u" }, { tag: "span.underline", consuming: false }],
      toDOM: () => ["u", 0],
    },
    strike: {
      parseDOM: [{ tag: "del" }, { tag: "s" }, { tag: "span.strike", consuming: false }],
      toDOM: () => ["s", 0],
    },
    highlight: { parseDOM: [{ tag: "mark" }], toDOM: () => ["mark", 0] },
    insert: { parseDOM: [{ tag: "ins" }], toDOM: () => ["ins", 0] },
    sup: { excludes: "sub", parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
    sub: { excludes: "sup", parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },
    color: {
      attrs: { color: {} },
      parseDOM: [
        {
          tag: "span[color]",
          consuming: false,
          getAttrs: (d) => {
            const c = (d as HTMLElement).getAttribute("color") ?? "";
            return /^#[0-9a-f]{3,8}$/i.test(c) ? { color: c } : false;
          },
        },
      ],
      toDOM: (m) => ["span", { style: `color:${m.attrs.color}` }, 0],
    },
    size: {
      attrs: { size: {} },
      parseDOM: [
        {
          tag: "span[size]",
          consuming: false,
          getAttrs: (d) => {
            const s = (d as HTMLElement).getAttribute("size") ?? "";
            return /^[\d.]+$/.test(s) ? { size: Number(s) } : false;
          },
        },
      ],
      toDOM: (m) => ["span", { style: `font-size:${m.attrs.size}pt` }, 0],
    },
    // verbatim: its text is written as is, so it is innermost
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  },
});

const N = schema.nodes;
const M = schema.marks;

// ---------------------------------------------------------------------------
// ProseMirror → Djot
// ---------------------------------------------------------------------------

const DJOT_SPECIAL = /[\\*_[\]{}`~^$<>#|"]/g;

export function escapeText(t: string): string {
  return t.replace(DJOT_SPECIAL, "\\$&");
}

const MARK_ORDER = ["strong", "em", "strike", "highlight", "insert", "sup", "sub", "underline", "color", "size"];

/** Inline code: a fence longer than any run of backticks inside, padded if it touches one. */
function verbatim(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = /^`|`$/.test(text) ? " " : "";
  return fence + pad + text + pad + fence;
}

function wrapMarks(text: string, node: PMNode): string {
  // Djot markers can't sit next to a space, so spaces at either end go outside them
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const code = M.code.isInSet(node.marks);
  if (!code && !m[2]) return text;
  let core = code ? verbatim(text) : escapeText(m[2]);
  const spanAttrs: string[] = [];
  const marks = [...node.marks].sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
  for (const mark of marks) {
    switch (mark.type.name) {
      case "strong":
        core = `*${core}*`;
        break;
      case "em":
        core = `_${core}_`;
        break;
      case "strike":
        core = `{-${core}-}`;
        break;
      case "highlight":
        core = `{=${core}=}`;
        break;
      case "insert":
        core = `{+${core}+}`;
        break;
      case "sup":
        core = `^${core}^`;
        break;
      case "sub":
        core = `~${core}~`;
        break;
      case "underline":
        spanAttrs.push(".underline");
        break;
      case "color":
        spanAttrs.push(`color="${mark.attrs.color}"`);
        break;
      case "size":
        spanAttrs.push(`size=${mark.attrs.size}`);
        break;
    }
  }
  if (spanAttrs.length) core = `[${core}]{${spanAttrs.join(" ")}}`;
  return code ? core : m[1] + core + m[3];
}

/** A link destination Djot reads back unchanged: it ends at the first `)`, so encode those. */
function linkDest(href: string): string {
  return href.replace(/[()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function inlineNode(child: PMNode): string {
  if (child.type === N.hard_break) return "\\\n";
  if (child.type === N.math) {
    const expr = String(child.attrs.expr);
    const fence = expr.includes("`") ? "``" : "`";
    return `$${fence}${expr}${fence}`;
  }
  if (child.type === N.xref) return `[](#ref:${child.attrs.id})${child.attrs.style ? `{.${child.attrs.style}}` : ""}`;
  return child.isText ? wrapMarks(child.text ?? "", child) : "";
}

/** Make literal what Djot would read as the start of another block (a list, a div, a rule). */
function literalStart(text: string): string {
  return text
    .replace(
      /^(\(?)(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)([.)])(?=\s|$)/,
      (_, open, n, delim) => `${open ? "\\(" : ""}${n}\\${delim}`,
    )
    .replace(/^([-+])(?=\s|$)/, "\\$1")
    .replace(/^:(?=:*(\s|$))/, "\\:")
    .replace(/^-(?=(\s*-){2,}\s*(\n|$))/, "\\-");
}

function inline(node: PMNode): string {
  let out = "";
  let link: Mark | null = null;
  let text = "";
  const flush = () => {
    out += link ? `[${text}](${linkDest(String(link.attrs.href))})` : text;
    text = "";
  };
  node.forEach((child) => {
    const l = M.link.isInSet(child.marks) ?? null;
    if (l !== link && !(l && link?.eq(l))) {
      flush();
      link = l;
    }
    text += inlineNode(child);
  });
  flush();
  return literalStart(out);
}

function blockAttrLine(attrs: Attrs, extra: string[] = []): string {
  const parts = [...extra];
  if (attrs.align && attrs.align !== "left") parts.push(`.${attrs.align}`);
  if (attrs.size) parts.push(`size=${attrs.size}`);
  if (attrs.font) parts.push(`font="${String(attrs.font).replace(/"/g, "")}"`);
  return parts.length ? `{${parts.join(" ")}}\n` : "";
}

/** Prefix the lines of a block: the first with `first`, the others with `rest` (blank lines stay blank). */
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line ? rest + line : rest.trimEnd()))
    .join("\n");
}

function blocks(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    const text = block(child);
    if (text.trim()) parts.push(text);
  });
  return parts.join("\n\n");
}

function block(node: PMNode): string {
  switch (node.type) {
    case N.paragraph:
      return blockAttrLine(node.attrs) + inline(node);
    case N.heading:
      return (
        blockAttrLine(node.attrs, node.attrs.title ? [".title"] : []) +
        "#".repeat(node.attrs.level) +
        " " +
        inline(node)
      );
    case N.blockquote:
      return prefixLines(blocks(node), "> ", "> ");
    case N.bullet_list:
    case N.ordered_list: {
      const items: string[] = [];
      node.forEach((li, _, i) => {
        const marker = node.type === N.bullet_list ? "- " : `${node.attrs.start + i}. `;
        const parts: string[] = [];
        li.forEach((child) => parts.push(block(child)));
        items.push(prefixLines(parts.join("\n\n"), marker, " ".repeat(marker.length)));
      });
      return items.join(node.attrs.tight ? "\n" : "\n\n");
    }
    case N.djot_block:
      return String(node.attrs.src).trimEnd();
    default:
      return "";
  }
}

/** A top-level block as it was loaded, with its source (blank lines after it included). */
export interface Loaded {
  node: PMNode;
  src: string;
}

/**
 * The document as Djot. Blocks still as they were loaded (`loaded`, in order) are written
 * back exactly as their source, so editing one paragraph never rewrites the others.
 */
export function toDjot(doc: PMNode, loaded: readonly Loaded[] = []): string {
  const tail = (src: string) => src.slice(src.trimEnd().length);
  const used = new Set<number>();
  // structural equality, so a block typed in and then undone is still written as it was
  const match = (node: PMNode, from: number) => {
    for (let i = from; i < loaded.length; i++) if (!used.has(i) && loaded[i].node.eq(node)) return i;
    for (let i = 0; i < from; i++) if (!used.has(i) && loaded[i].node.eq(node)) return i;
    return -1;
  };
  let out = "";
  let prev = -1; // the loaded block written last, if the last one written was loaded
  doc.forEach((node) => {
    const found = match(node, prev + 1);
    const text = found >= 0 ? loaded[found].src.trimEnd() : block(node);
    if (found < 0 && !text.trim()) return;
    if (found >= 0) used.add(found);
    // between blocks that were neighbours, the blank lines that were there
    if (out) out += prev >= 0 && found === prev + 1 ? tail(loaded[prev].src) : "\n\n";
    out += text;
    prev = found;
  });
  // the source ended with its last block, and whatever followed it
  if (prev >= 0 && prev === loaded.length - 1) out += tail(loaded[prev].src);
  return out;
}

/** Editor content from the HTML of `djot_html`: one node per top-level block of the source. */
export function parseEditable(html: string): { doc: PMNode; loaded: Loaded[] } {
  const parser = PMParser.fromSchema(schema);
  const div = document.createElement("div");
  div.innerHTML = html;
  const wrappers = [...div.children].filter((el): el is HTMLElement => el.hasAttribute("data-djot"));
  if (!wrappers.length) return { doc: parser.parse(div), loaded: [] };
  const loaded = wrappers.map((el) => {
    const src = el.dataset.djot ?? "";
    const nodes: PMNode[] = [];
    if (!el.hasAttribute("data-keep")) parser.parse(el).forEach((n) => nodes.push(n));
    // anything that isn't exactly one block is kept as written rather than guessed at
    const node = nodes.length === 1 ? nodes[0] : N.djot_block.create({ src, html: el.innerHTML });
    return { node, src };
  });
  return {
    doc: schema.node(
      "doc",
      null,
      loaded.map((l) => l.node),
    ),
    loaded,
  };
}

export function fromHtml(html: string): PMNode {
  return parseEditable(html).doc;
}

// ---------------------------------------------------------------------------
// Commands (used by the format bar and shortcuts)
// ---------------------------------------------------------------------------

function setMarkAttr(type: MarkType, attrs: Attrs | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(type);
      if (attrs) tr.addStoredMark(type.create(attrs));
    } else {
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

function setBlockAttr(name: string, value: unknown): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    const { from, to } = state.selection;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === N.paragraph || node.type === N.heading) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, [name]: value });
        return false;
      }
      return true;
    });
    dispatch?.(tr);
    return true;
  };
}

export type BlockStyle = "body" | "title" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** The paragraph or heading the selection starts in (also for Select All). */
function currentBlock(state: EditorState): PMNode {
  let found: PMNode | null = null;
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, Math.max(to, from + 1), (n) => {
    if (!found && n.isTextblock) found = n;
    return !found;
  });
  return found ?? state.selection.$from.parent;
}

function keepAttrs(state: EditorState) {
  const node = currentBlock(state);
  return { align: node.attrs.align ?? null, size: node.attrs.size ?? null, font: node.attrs.font ?? null };
}

export function setStyle(style: BlockStyle): Command {
  return (state, dispatch) => {
    const keep = keepAttrs(state);
    if (style === "body") return setBlockType(N.paragraph, keep)(state, dispatch);
    if (style === "title")
      return setBlockType(N.heading, { ...keep, level: 1, title: true, align: keep.align ?? "center" })(
        state,
        dispatch,
      );
    return setBlockType(N.heading, { ...keep, level: Number(style[1]), title: false })(state, dispatch);
  };
}

/** The link the selection is in or covers: its whole extent in the textblock, and where it leads. */
export function linkAt(state: EditorState): { from: number; to: number; href: string } | null {
  const { $from, from, to, empty } = state.selection;
  if (!empty) {
    let href: string | null = null;
    state.doc.nodesBetween(from, to, (n) => {
      href ??= (M.link.isInSet(n.marks)?.attrs.href as string | undefined) ?? null;
    });
    return href === null ? null : { from, to, href };
  }
  const start = $from.start();
  type Run = { from: number; to: number; mark: Mark };
  let run: Run | null = null;
  let found: Run | null = null;
  $from.parent.forEach((child, offset) => {
    const mark = M.link.isInSet(child.marks);
    const at = start + offset;
    if (mark && run && run.to === at && run.mark.eq(mark)) run.to += child.nodeSize;
    else run = mark ? { from: at, to: at + child.nodeSize, mark } : null;
    if (run && run.from <= $from.pos && $from.pos <= run.to) found = { ...run };
  });
  const link = found as Run | null;
  return link ? { from: link.from, to: link.to, href: String(link.mark.attrs.href) } : null;
}

/** What a typed address means: a web address unless it says otherwise. */
export function normalizeHref(text: string): string {
  const t = text.trim();
  if (!t || /^(https?:|mailto:|#)/i.test(t)) return t;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(t)) return `mailto:${t}`;
  return `https://${t}`;
}

/** Link the selection, or change the link around the caret; `null` removes it. */
function setLink(href: string | null): Command {
  return (state, dispatch) => {
    const link = linkAt(state);
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (link) tr.removeMark(link.from, link.to, M.link);
    if (href) {
      if (link) tr.addMark(link.from, link.to, M.link.create({ href }));
      else if (!empty) tr.addMark(from, to, M.link.create({ href }));
      // nothing selected: the address itself becomes the linked text
      else tr.insert(from, schema.text(href, [M.link.create({ href })]));
    } else if (!link) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

function inList(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    if (inList(state, type)) return liftListItem(N.list_item)(state, dispatch);
    return wrapInList(type)(state, dispatch);
  };
}

export const commands = {
  bold: toggleMark(M.strong),
  italic: toggleMark(M.em),
  underline: toggleMark(M.underline),
  strike: toggleMark(M.strike),
  sup: toggleMark(M.sup),
  sub: toggleMark(M.sub),
  code: toggleMark(M.code),
  link: setLink,
  color: (c: string | null) => setMarkAttr(M.color, c ? { color: c } : null),
  size: (s: number | null) => setMarkAttr(M.size, s ? { size: s } : null),
  align: (a: Align) => setBlockAttr("align", a === "left" ? null : a),
  style: setStyle,
  bulletList: toggleList(N.bullet_list),
  orderedList: toggleList(N.ordered_list),
  /** A cross-reference to a heading, figure or table, at the caret. */
  insertRef:
    (id: string, style: RefStyle): Command =>
    (state, dispatch) => {
      dispatch?.(state.tr.replaceSelectionWith(N.xref.create({ id, style })).scrollIntoView());
      return true;
    },
  insertMath: ((state, dispatch) => {
    const node = N.math.create({ expr: "" });
    dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  }) as Command,
  undo,
  redo,
};

// ---------------------------------------------------------------------------
// Active editor (one at a time) and its state, for the format bar
// ---------------------------------------------------------------------------

const [activeView, setActiveView] = createSignal<EditorView | null>(null);
const [revision, setRevision] = createSignal(0);
export { activeView };

export function run(cmd: Command) {
  const view = activeView();
  if (!view) return;
  cmd(view.state, view.dispatch, view);
  view.focus();
}

export function editorState(): EditorState | null {
  revision();
  return activeView()?.state ?? null;
}

export function markActive(name: keyof typeof M): boolean {
  const state = editorState();
  if (!state) return false;
  const type = M[name];
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** Where the link at the selection leads, or null. */
export function currentLink(): string | null {
  const state = editorState();
  return state ? (linkAt(state)?.href ?? null) : null;
}

export function currentMarkAttr(name: "color" | "size"): unknown {
  const state = editorState();
  if (!state) return null;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  return M[name].isInSet(marks)?.attrs[name] ?? null;
}

export function currentStyle(): BlockStyle {
  const state = editorState();
  const node = state && currentBlock(state);
  if (!node || node.type !== N.heading) return "body";
  return node.attrs.title ? "title" : (`h${node.attrs.level}` as BlockStyle);
}

export function currentAlign(): Align {
  const state = editorState();
  return ((state && currentBlock(state).attrs.align) as Align | null) ?? "left";
}

export function listActive(kind: "bullet" | "ordered"): boolean {
  const state = editorState();
  return !!state && inList(state, kind === "bullet" ? N.bullet_list : N.ordered_list);
}

/** Plain text of the editor, for the "was this a definition?" check. */
export function plainText(view: EditorView): string {
  return view.state.doc.textContent;
}

// ---------------------------------------------------------------------------
// Inline math as an editable chip inside the text
// ---------------------------------------------------------------------------

/**
 * `$expr$` typed in text becomes live math. As in Pandoc, the opening $ must be followed
 * and the closing one preceded by a non-space (or `= `, which shows the result), so prices
 * ($5 and $10) stay text.
 */
const DOLLAR_MATH = /(^|[^\\\p{L}\p{N}$])\$([^\s$\ufffc](?:[^$\ufffc]*[^\s$\ufffc])?|[^\s$\ufffc][^$\ufffc]*=\s+)$/u;

function dollarMath(view: EditorView, from: number, to: number): boolean {
  const $from = view.state.doc.resolve(from);
  if (!$from.parent.inlineContent || from !== to) return false;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const m = DOLLAR_MATH.exec(before);
  if (!m) return false;
  const start = from - m[2].length - 1;
  const tr = view.state.tr.replaceWith(start, to, N.math.create({ expr: m[2].trim() }));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView());
  return true;
}

/** A cross-reference inside the text being edited: shows what it reads, kept current. */
class RefChip implements NodeView {
  dom: HTMLElement;
  private dispose: () => void;

  constructor(node: PMNode) {
    this.dom = document.createElement("span");
    this.dom.className = "qref-chip";
    this.dom.contentEditable = "false";
    const id = String(node.attrs.id);
    const style = node.attrs.style as RefStyle;
    this.dispose = createRoot((dispose) => {
      createEffect(() => {
        const text = refText(id, style);
        this.dom.textContent = text ?? "missing reference";
        this.dom.classList.toggle("missing", text === null);
      });
      return dispose;
    });
  }

  destroy() {
    this.dispose();
  }

  stopEvent() {
    return false;
  }

  ignoreMutation() {
    return true;
  }
}

class MathChip implements NodeView {
  dom: HTMLElement;
  input: HTMLInputElement;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.dom = document.createElement("span");
    this.dom.className = "qmath-chip";
    this.dom.contentEditable = "false";
    this.input = document.createElement("input");
    this.input.value = node.attrs.expr;
    this.input.placeholder = "math";
    this.input.spellcheck = false;
    this.fit();
    this.input.addEventListener("input", () => {
      this.fit();
      const pos = getPos();
      if (pos !== undefined) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { expr: this.input.value }));
    });
    this.input.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" ||
        e.key === "Escape" ||
        (e.key === "ArrowRight" && this.input.selectionStart === this.input.value.length)
      ) {
        e.preventDefault();
        const pos = getPos();
        if (pos !== undefined) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
          view.focus();
        }
      }
      e.stopPropagation();
    });
    this.dom.appendChild(this.input);
    if (!node.attrs.expr) queueMicrotask(() => this.input.focus());
  }

  fit() {
    this.input.style.width = `${Math.max(4, this.input.value.length + 1)}ch`;
  }

  update(node: PMNode) {
    if (node.type !== N.math) return false;
    if (this.input.value !== node.attrs.expr) {
      this.input.value = node.attrs.expr;
      this.fit();
    }
    return true;
  }

  selectNode() {
    this.input.focus();
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// `\name` shortcuts and inserting symbols
// ---------------------------------------------------------------------------

const LATEX_BEFORE = /\\([A-Za-z]*)$/;

function latexBefore(view: EditorView): RegExpExecArray | null {
  const { $from, empty } = view.state.selection;
  if (!prefs.latex || !empty || !$from.parent.isTextblock) return null;
  return LATEX_BEFORE.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"));
}

/** Put a symbol (text) or a structure (an inline math chip) at the selection. */
function insertSym(view: EditorView, sym: Sym, from: number, to: number) {
  if (sym.command) {
    // a `\` command: the typed `\ref` goes, then the command runs at the caret
    view.dispatch(view.state.tr.delete(from, to));
    view.focus();
    runAppCommand(sym.command);
    return;
  }
  const tr = view.state.tr;
  if (isTemplate(sym)) tr.replaceWith(from, to, N.math.create({ expr: sym.insert }));
  else tr.insertText(sym.insert, from, to);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function updateCompletion(view: EditorView) {
  const m = latexBefore(view);
  if (!m) return hideCompletions();
  const at = view.state.selection.from;
  const coords = view.coordsAtPos(at);
  const items = m[1] ? completions(m[1], 8, "text") : commandsFor("text");
  if (!items.length) return hideCompletions();
  showCompletions(coords.left, coords.bottom + 4, items, (sym) => insertSym(view, sym, at - m[0].length, at));
}

/** Insert plain text into the active text editor. */
export function insertText(text: string) {
  const view = activeView();
  if (!view) return false;
  view.dispatch(view.state.tr.insertText(text).scrollIntoView());
  view.focus();
  return true;
}

/** Insert live math (e.g. a structure template) into the active text editor. */
export function insertMathChip(expr: string) {
  const view = activeView();
  if (!view) return false;
  view.dispatch(view.state.tr.replaceSelectionWith(N.math.create({ expr })).scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------
// Editor construction
// ---------------------------------------------------------------------------

export interface EditorHooks {
  onChange(djot: string): void;
  /** `below`: continue under the box (⌘↩), as Enter does for math. */
  onExit(below: boolean): void;
  /** Return true to swallow the key (used to turn "word :" back into math). */
  onKey?(view: EditorView, e: KeyboardEvent): boolean;
}

function literalDoc(text: string): PMNode {
  return schema.node("doc", null, [N.paragraph.create(null, text ? schema.text(text) : null)]);
}

/** Whether Djot can be edited as the literal text it is, since writing it back changes nothing. */
export function isLiteral(src: string): boolean {
  return toDjot(literalDoc(src)) === src;
}

/** `content` is editor HTML, or plain text taken literally (spaces included). */
export function createEditor(host: HTMLElement, content: string | { text: string }, hooks: EditorHooks): EditorView {
  const exit =
    (below: boolean): Command =>
    () => {
      hooks.onExit(below);
      return true;
    };
  const { doc, loaded } =
    typeof content === "string" ? parseEditable(content || "<p></p>") : { doc: literalDoc(content.text), loaded: [] };
  const state = EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        "Mod-b": toggleMark(M.strong),
        "Mod-i": toggleMark(M.em),
        "Mod-u": toggleMark(M.underline),
        "Shift-Enter": (s, d) => {
          d?.(s.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
          return true;
        },
        Enter: splitListItem(N.list_item),
        Tab: sinkListItem(N.list_item),
        "Shift-Tab": liftListItem(N.list_item),
        Escape: exit(false),
        "Mod-Enter": exit(true),
      }),
      keymap(baseKeymap),
    ],
  });
  const view = new EditorView(host, {
    state,
    nodeViews: { math: (node, v, getPos) => new MathChip(node, v, getPos), xref: (node) => new RefChip(node) },
    handleTextInput: (v, from, to, text) => (text === "$" ? dollarMath(v, from, to) : false),
    handleKeyDown: (v, e) => {
      if (completionKey(e)) return true;
      // `\Delta` followed by a space or punctuation becomes Δ
      if (e.key.length === 1 && !/[A-Za-z\\]/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        const m = latexBefore(v);
        const sym = m?.[1] ? exact(m[1], "text") : undefined;
        if (m && sym) {
          const at = v.state.selection.from;
          insertSym(v, sym, at - m[0].length, at);
          hideCompletions();
          if (e.key === " " || isTemplate(sym)) return true;
        }
      }
      return hooks.onKey?.(v, e) ?? false;
    },
    handleDOMEvents: {
      blur: () => {
        hideCompletions();
        return false;
      },
    },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      setRevision((r) => r + 1);
      if (tr.docChanged) {
        hooks.onChange(toDjot(next.doc, loaded));
        updateCompletion(view);
      } else if (tr.selectionSet) hideCompletions();
    },
  });
  view.dom.addEventListener("focus", () => {
    setActiveView(view);
    setRevision((r) => r + 1);
  });
  setActiveView(view);
  view.dom.classList.add("rich-editor");
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  return view;
}

/** Put the caret where the user clicked (editing started from a click). */
export function placeCaret(view: EditorView, x: number, y: number) {
  const pos = view.posAtCoords({ left: x, top: y });
  if (pos) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos.pos)));
}

export function releaseEditor(view: EditorView) {
  hideCompletions();
  if (activeView() === view) setActiveView(null);
  view.destroy();
}
