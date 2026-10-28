// Rich-text editing for text regions: ProseMirror in the editor, Djot in the document.
//
// Djot → HTML (Rust, `djot_html`) → ProseMirror; ProseMirror → Djot (`toDjot` below).
// Anything the schema can express round-trips; the format bar drives the commands here.
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  type Attrs,
  type MarkType,
  type Node as PMNode,
  DOMParser as PMParser,
  type NodeType,
  Schema,
} from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, EditorState, TextSelection } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import { createSignal } from "solid-js";
import { prefs } from "./settings";
import { completionKey, hideCompletions, showCompletions } from "./Completion";
import { completions, exact, isTemplate, type Sym } from "./symbols";

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
      parseDOM: [1, 2, 3, 4, 5, 6].map((l) => ({
        tag: `h${l}`,
        getAttrs: (d: HTMLElement) => ({ ...readBlockAttrs(d), level: Math.min(l, 3) }),
      })),
      toDOM: (n) => [`h${n.attrs.level}`, blockDom(n.attrs, n.attrs.title ? "title" : ""), 0],
    },
    bullet_list: { group: "block", content: "list_item+", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] },
    ordered_list: { group: "block", content: "list_item+", parseDOM: [{ tag: "ol" }], toDOM: () => ["ol", 0] },
    list_item: { content: "paragraph block*", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
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
  },
  marks: {
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

const MARK_ORDER = ["strong", "em", "strike", "sup", "sub", "underline", "color", "size"];

function wrapMarks(text: string, node: PMNode): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  let core = m[2];
  if (!core) return text;
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
        spanAttrs.push(`color=${mark.attrs.color}`);
        break;
      case "size":
        spanAttrs.push(`size=${mark.attrs.size}`);
        break;
    }
  }
  if (spanAttrs.length) core = `[${core}]{${spanAttrs.join(" ")}}`;
  return m[1] + core + m[3];
}

function inline(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.type === N.hard_break) out += "\\\n";
    else if (child.type === N.math) {
      const expr = String(child.attrs.expr);
      const fence = expr.includes("`") ? "``" : "`";
      out += `$${fence}${expr}${fence}`;
    } else if (child.isText) out += wrapMarks(escapeText(child.text ?? ""), child);
  });
  // a block must not start with something Djot reads as list/heading syntax
  return out.replace(/^(\d+)\.(\s)/, "$1\\.$2").replace(/^([-+])(\s)/, "\\$1$2");
}

function blockAttrLine(attrs: Attrs, extra: string[] = []): string {
  const parts = [...extra];
  if (attrs.align && attrs.align !== "left") parts.push(`.${attrs.align}`);
  if (attrs.size) parts.push(`size=${attrs.size}`);
  if (attrs.font) parts.push(`font="${String(attrs.font).replace(/"/g, "")}"`);
  return parts.length ? `{${parts.join(" ")}}\n` : "";
}

function block(node: PMNode, indent = ""): string {
  switch (node.type) {
    case N.paragraph:
      return indent + blockAttrLine(node.attrs) + inline(node);
    case N.heading:
      return blockAttrLine(node.attrs, node.attrs.title ? [".title"] : []) + "#".repeat(node.attrs.level) + " " + inline(node);
    case N.bullet_list:
    case N.ordered_list: {
      const items: string[] = [];
      node.forEach((li, _, i) => {
        const marker = node.type === N.bullet_list ? "- " : `${i + 1}. `;
        const parts: string[] = [];
        li.forEach((child, __, j) => {
          if (j === 0 && child.type === N.paragraph) parts.push(indent + marker + inline(child));
          else parts.push(block(child, indent + " ".repeat(marker.length)));
        });
        items.push(parts.join("\n\n"));
      });
      return items.join("\n");
    }
    default:
      return "";
  }
}

export function toDjot(doc: PMNode): string {
  const blocks: string[] = [];
  doc.forEach((b) => {
    const text = block(b);
    if (text.trim()) blocks.push(text);
  });
  return blocks.join("\n\n");
}

export function fromHtml(html: string): PMNode {
  const div = document.createElement("div");
  div.innerHTML = html;
  return PMParser.fromSchema(schema).parse(div);
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

export type BlockStyle = "body" | "title" | "h1" | "h2" | "h3";

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
    if (style === "title") return setBlockType(N.heading, { ...keep, level: 1, title: true, align: keep.align ?? "center" })(state, dispatch);
    return setBlockType(N.heading, { ...keep, level: Number(style[1]), title: false })(state, dispatch);
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
  color: (c: string | null) => setMarkAttr(M.color, c ? { color: c } : null),
  size: (s: number | null) => setMarkAttr(M.size, s ? { size: s } : null),
  align: (a: Align) => setBlockAttr("align", a === "left" ? null : a),
  style: setStyle,
  bulletList: toggleList(N.bullet_list),
  orderedList: toggleList(N.ordered_list),
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
      if (e.key === "Enter" || e.key === "Escape" || e.key === "ArrowRight" && this.input.selectionStart === this.input.value.length) {
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
  const items = m[1] ? completions(m[1]) : completions("", 0);
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

/** `content` is editor HTML, or plain text taken literally (spaces included). */
export function createEditor(host: HTMLElement, content: string | { text: string }, hooks: EditorHooks): EditorView {
  const exit = (below: boolean): Command => () => {
    hooks.onExit(below);
    return true;
  };
  const state = EditorState.create({
    doc:
      typeof content === "string"
        ? fromHtml(content || "<p></p>")
        : schema.node("doc", null, [N.paragraph.create(null, content.text ? schema.text(content.text) : null)]),
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
    nodeViews: { math: (node, v, getPos) => new MathChip(node, v, getPos) },
    handleTextInput: (v, from, to, text) => (text === "$" ? dollarMath(v, from, to) : false),
    handleKeyDown: (v, e) => {
      if (completionKey(e)) return true;
      // `\Delta` followed by a space or punctuation becomes Δ
      if (e.key.length === 1 && !/[A-Za-z\\]/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        const m = latexBefore(v);
        const sym = m?.[1] ? exact(m[1]) : undefined;
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
        hooks.onChange(toDjot(next.doc));
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
