// Math typed into the typeset formula itself (#165, Settings ▸ Editing ▸ Edit math in place):
// the formula on the page is the editor. Keys go to the edit tree (mathTree.ts), which is drawn
// at every keystroke exactly as the stored formula is drawn (mathDraw.ts), so nothing moves when
// the edit starts, while it goes on, or when it ends. A hidden field takes the keyboard (IME,
// dead keys and dictation arrive in it as composed text); the caret and the selection are drawn
// over the formula from where the browser laid out each part. The stored text is still linear
// (`M := q*L^2/8`), written only when the formula changes. The keys: docs/07-math-editing.md.
import { createEffect, on, onCleanup, onMount, untrack } from "solid-js";
import { announce } from "./a11y";
import { setCaretName } from "./trace";
import { paletteOpen } from "./Palette";
import { prefs } from "./settings";
import { isMac } from "./api";
import { announceFirst, completionKey, hideCompletions, type Item, openList, showCompletions } from "./Completion";
import { nameHtml, prettyValue } from "./math";
import { drawLine, type Said } from "./mathDraw";
import { deletedWords, placeWords } from "./mathPlace";
import { isDigit, isNameCont, isNameStart, OPS, rawText, rowText } from "./mathLinear";
import {
  cutSelection,
  fromExpr,
  fromLinear,
  greek,
  History,
  insertTemplate,
  key,
  paste,
  plainWords,
  positions,
  selectedText,
  selection,
  selectRange,
  setCaret,
  settleSlots,
  symbolic,
  toFirstHole,
  toLinear,
  type Atom,
  type Deleted,
  type EditState,
  type Node,
  type Pos,
  type Row,
} from "./mathTree";
import { editNext, looksLikeProse, type MathLine, setInPlace } from "./MathEditor";
import {
  cycleOrder,
  currentMeaning,
  forgetMeanings,
  KIND_WORD,
  knownMeanings,
  knownShowIn,
  knownUnitMeanings,
  looselyIn,
  meanings,
  type NameSpan,
  showInChoices,
  unitMeanings,
  unitPosition,
} from "./names";
import type { Completion, Region, UnitChoice } from "./types";
import { latexToLinear } from "./clipboard";
import { commandsFor, completions, exact, type Sym } from "./symbols";
import {
  commitBelow,
  commitEditing,
  convertEditing,
  editClickPoint,
  editText,
  layout,
  runAppCommand,
  setLive,
  setState,
  splitShow,
  state,
} from "./store";

/** Where the caret goes in the next formula opened by leaving this one with an arrow. */
let entry: "start" | "end" | null = null;

const POPULAR = ["alpha", "beta", "gamma", "delta", "Delta", "theta", "lambda", "mu", "sigma", "omega", "phi", "sqrt"]
  .map((n) => exact(n))
  .filter((x): x is Sym => !!x);

/** The parts of the drawn formula that say where they are in the tree, found once per drawing. */
interface Tagged {
  tokens: Map<string, { el: Element; a: number; n: number }[]>;
  holes: Map<string, { el: Element; at: number }[]>;
  nodes: Map<string, Element>;
  scripts: Map<string, Element>;
  opens: Map<string, Element>;
  closes: Map<string, Element>;
  /** A block drawn from a definition's header (`f(x) :=` level with its first line): its statements' cells. */
  parts: Map<string, Element[]>;
  unitRow: Element | null;
}

const scratch = document.createElement("template");

/**
 * `el`'s content made `html` by changing only what differs: a key changes a character or two,
 * and only those are laid out again, not the whole formula.
 */
function morph(el: Element, html: string) {
  scratch.innerHTML = html;
  sync(el, scratch.content);
}

function sync(to: ParentNode, from: ParentNode) {
  const want = [...from.childNodes];
  let have = to.firstChild;
  for (const w of want) {
    if (!have) {
      to.appendChild(w);
      continue;
    }
    const next = have.nextSibling;
    if (have.nodeType === 3 && w.nodeType === 3) {
      if (have.nodeValue !== w.nodeValue) have.nodeValue = w.nodeValue;
    } else if (have.nodeType === 1 && w.nodeType === 1 && (have as Element).localName === (w as Element).localName) {
      const a = have as Element;
      const b = w as Element;
      for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
      for (const at of [...b.attributes]) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
      sync(a, b);
    } else to.replaceChild(w, have);
    have = next;
  }
  while (have) {
    const next = have.nextSibling;
    to.removeChild(have);
    have = next;
  }
}

/** A row of the tree: the structure it is a slot of, and where that structure is. */
interface Where {
  row: Row;
  owner: Node | null;
  slot: number;
  parent: Row | null;
  at: number;
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}
const boxOf = (r: DOMRect): Box => ({ l: r.left, r: r.right, t: r.top, b: r.bottom });
/** Programs: drawn on rows of their own, so a caret beside one is as tall as it. */
const PROGRAM_KINDS = new Set(["if", "block", "for", "while"]);
const TEXT = new Set(["mi", "mn", "mo", "ms", "mtext"]);

/** The caret on screen: its x and the top and bottom of its line, in window coordinates. */
interface Spot {
  x: number;
  t: number;
  b: number;
}

/** A name at the caret, as the name lists and ⌥Enter work on it. */
interface NameHere {
  row: string;
  /** What the name covers on its row (with its `'` or `#` structure, or its subscript). */
  from: number;
  to: number;
  name: string;
  typed: string;
  marker: "" | "'" | "#";
  /** A unit goes here (`20 C`, `9.81 m/s`). */
  unit: boolean;
  /** A number is right before it. */
  afterNumber: boolean;
}

export function MathInPlace(props: { r: Region; line?: MathLine; said: () => Said }) {
  let mathEl!: HTMLSpanElement;
  let caretEl!: HTMLDivElement;
  let selEl!: HTMLDivElement;
  let sink!: HTMLTextAreaElement;
  const viewId = untrack(() => props.line?.view ?? props.r.id);
  const owner = untrack(() => props.line?.owner ?? props.r.id);
  const live = (text: string) => (props.line ? props.line.onInput(text) : setLive(props.r.id, text));
  const initialText = untrack(() => props.line?.text ?? editText(props.r));
  const equation = untrack(() => !!props.line?.equation);

  // ---- the edit tree ----

  const begin = (): EditState => {
    const v = untrack(() => state.views[viewId]);
    const { show, unit } = splitShow(initialText);
    // the tree of what the engine read, when it read this very text; else as typing it builds it
    const s = v?.input
      ? fromExpr(v.input, show || null, unit ?? "", { equation })
      : fromLinear(initialText, { equation });
    return settleSlots(key(s, "End"));
  };
  let s = begin();
  const history = new History(s);
  const initialTree = toLinear(s);
  /** What was last written to the document: nothing until the formula changes. */
  let sent = initialText;

  /** The formula changed (or the caret moved): draw it, write it, update the lists, and say where the caret went. */
  const changed = (opts: { record?: boolean; typing?: boolean; deleted?: Deleted } = {}) => {
    s = settleSlots(s);
    if (opts.record !== false) history.record(s);
    draw();
    const text = toLinear(s);
    // a formula changed back to what it was keeps the text it was stored with
    const out = text === initialTree ? initialText : text;
    if (out !== sent) {
      sent = out;
      live(out);
    }
    updateLists(!!opts.typing);
    traceName();
    speak(opts.deleted);
  };

  // ---- for a screen reader: where the caret is, when that changes, and what was deleted ----

  let lastPlace = "";
  const speak = (deleted?: Deleted) => {
    const names = { units: props.said().units, constants: props.said().constants };
    const place = placeWords(s, names);
    const moved = !!place && place.key !== lastPlace;
    if (place) lastPlace = place.key;
    const words = [deleted ? deletedWords(deleted, names) : "", moved ? place.words : ""].filter(Boolean);
    if (words.length) announce(words.join(", "));
  };

  /** Enter outside a program, or on its empty last line, or ⌘Enter anywhere: the edit ends, the insertion point under it. */
  const finish = () => {
    hideCompletions();
    if (props.line) props.line.onEnter();
    else commitBelow(props.r.id);
  };

  const effect = () => {
    const e = s.effect;
    if (!e) return;
    s = { ...s, effect: undefined };
    if (e.finish) return finish();
    if (e.command) {
      if (e.command === "to_text") {
        const text = toLinear(s).trimEnd();
        convertEditing("text", text ? `${text} ` : "");
      } else runAppCommand(e.command);
    } else if (e.leave) leave(e.leave);
  };

  /** Off the formula's edge: the next line of the block or the next region, with the caret where it came in. */
  const leave = (dir: "left" | "right" | "up" | "down") => {
    const by = dir === "right" || dir === "down" ? 1 : -1;
    entry = by > 0 ? "start" : "end";
    if (props.line?.onTab(by)) return;
    editNext(owner, by);
    if (state.editing === owner) entry = null;
  };

  /** One key or character, given to the tree. */
  const press = (k: string, opts: { shift?: boolean; pick?: boolean } = {}) => {
    const before = s.version;
    const from = opts.pick ? spot(s.caret) : null;
    s = key(s, k, {
      shift: opts.shift,
      pick: from ? (row, n) => nearest(row, n, from.x) : undefined,
      choose: from ? (rows) => nearestRow(rows, from.x) : undefined,
    });
    const deleted = s.effect?.deleted;
    changed({ record: true, typing: s.version !== before && [...k].length === 1, deleted });
    effect();
  };

  const type = (text: string) => {
    const chars = [...text.replace(/\r\n?/g, "\n")];
    for (const ch of chars) {
      // a word and a space at the start of a new region: prose, not math (as in the linear editor)
      if (ch === " " && proseHere()) {
        convertEditing("text", `${plainWords(s) ?? ""} `);
        return;
      }
      press(ch);
      if (state.editing !== owner) return;
    }
  };

  const proseHere = () => {
    if (props.line || !state.editingFresh || s.line.show || s.anchor) return false;
    if (s.caret.row !== s.line.main.id || s.caret.i !== s.line.main.atoms.length) return false;
    const words = plainWords(s);
    return !!words && looksLikeProse(words, props.r.id);
  };

  const travel = (redo: boolean) => {
    const to = redo ? history.redo() : history.undo();
    if (!to) return;
    s = to;
    changed({ record: false });
  };

  // ---- drawing ----

  let html = "";
  /** The tagged parts of what is drawn, found once per drawing. */
  let index: Tagged | null = null;

  const draw = () => {
    const next = drawLine(s, props.said());
    if (next !== html) {
      html = next;
      morph(mathEl, next);
      index = null;
    }
    place();
  };

  const tagged = () => {
    if (index) return index;
    const ix: Tagged = {
      tokens: new Map(),
      holes: new Map(),
      nodes: new Map(),
      scripts: new Map(),
      opens: new Map(),
      closes: new Map(),
      parts: new Map(),
      unitRow: mathEl.querySelector("[data-unitrow]"),
    };
    const push = <T,>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
    for (const el of mathEl.querySelectorAll<HTMLElement>(
      "[data-r],[data-node],[data-script],[data-open],[data-close],[data-part]",
    )) {
      const d = el.dataset;
      if (d.r !== undefined && d.hole !== undefined) push(ix.holes, d.r, { el, at: Number(d.hole) });
      else if (d.r !== undefined && d.a !== undefined)
        push(ix.tokens, d.r, { el, a: Number(d.a), n: Number(d.n ?? 1) });
      if (d.node) ix.nodes.set(d.node, el);
      if (d.script) ix.scripts.set(d.script, el);
      if (d.open) ix.opens.set(d.open, el);
      if (d.close) ix.closes.set(d.close, el);
      if (d.part) push(ix.parts, d.part, el);
    }
    return (index = ix);
  };

  /** Each row of the tree, and where it is: worked out once for each state of the line. */
  const trees = new WeakMap<object, Map<string, Where>>();
  const tree = (): Map<string, Where> => {
    const known = trees.get(s.line);
    if (known) return known;
    const out = new Map<string, Where>();
    const walk = (r: Row, owner: Node | null, slot: number, parent: Row | null, at: number) => {
      out.set(r.id, { row: r, owner, slot, parent, at });
      r.atoms.forEach((a, k) => {
        if (a.k !== "g") a.slots.forEach((x, j) => walk(x, a, j, r, k));
      });
    };
    walk(s.line.main, null, 0, null, 0);
    walk(s.line.unit, null, 1, null, 0);
    trees.set(s.line, out);
    return out;
  };
  const whereIs = (_: EditState, id: string): Where | null => tree().get(id) ?? null;

  /** The text node of a drawn token (a name, a number, an operator, or the name in an msub). */
  const textOf = (el: Element): Text | null => {
    const tok = TEXT.has(el.localName) ? el : el.firstElementChild;
    const t = tok?.firstChild;
    return t && t.nodeType === 3 ? (t as Text) : null;
  };

  const range = document.createRange();
  /** The box of characters `[a, b)` of a text node: the line's full height at that font. */
  const textBox = (t: Text, a: number, b: number): Box | null => {
    try {
      range.setStart(t, Math.max(0, Math.min(a, t.length)));
      range.setEnd(t, Math.max(0, Math.min(b, t.length)));
      const r = range.getBoundingClientRect();
      return r.height ? boxOf(r) : null;
    } catch {
      return null;
    }
  };

  /** Where atom `k` of a token's atoms is in its text: `\alpha`'s `a` after the `\`, `12 345`'s digits around the gap. */
  const offsets = (row: Row, tok: { a: number; n: number }, text: string): number[] | null => {
    const out: number[] = [];
    let at = 0;
    for (let k = tok.a; k < tok.a + tok.n; k++) {
      const g = row.atoms[k];
      if (!g || g.k !== "g") return null;
      const found = text.indexOf(g.s, at);
      if (found < 0) return null;
      out.push(found);
      at = found + g.s.length;
    }
    out.push(at);
    return out;
  };

  /** The box of atom `k` of a row as drawn: a character, an operator, a structure. */
  const atomBox = (row: Row, k: number): Box | null => {
    const a = row.atoms[k];
    if (!a) return null;
    const ix = tagged();
    if (a.k === "g") {
      const tok = ix.tokens.get(row.id)?.find((t) => t.a <= k && k < t.a + t.n);
      if (!tok) return null;
      const t = textOf(tok.el);
      if (!t || tok.el.localName === "mspace") return boxOf(tok.el.getBoundingClientRect());
      if (tok.n === 1 && tok.el.localName === "mo") return boxOf(tok.el.getBoundingClientRect());
      const offs = offsets(row, tok, t.data);
      if (!offs) return boxOf(tok.el.getBoundingClientRect());
      const i = k - tok.a;
      return textBox(t, offs[i], offs[i] + a.s.length);
    }
    const box = (el: Element | undefined | null) => (el ? boxOf(el.getBoundingClientRect()) : null);
    if (a.k === "sup" || a.k === "index") {
      const el = ix.scripts.get(a.id);
      return box(el?.lastElementChild);
    }
    if (a.k === "paren") {
      const o = box(ix.opens.get(a.id));
      const c = box(ix.closes.get(a.id));
      return o && c ? { l: o.l, r: c.r, t: Math.min(o.t, c.t), b: Math.max(o.b, c.b) } : (o ?? c);
    }
    const parts = ix.nodes.has(a.id) ? null : ix.parts.get(a.id);
    if (parts?.length)
      return parts
        .map((el) => boxOf(el.getBoundingClientRect()))
        .reduce((x, y) => ({
          l: Math.min(x.l, y.l),
          r: Math.max(x.r, y.r),
          t: Math.min(x.t, y.t),
          b: Math.max(x.b, y.b),
        }));
    return box(ix.nodes.get(a.id));
  };

  const isOpGlyph = (a: Atom | undefined) => !!a && a.k === "g" && OPS.has(a.s) && a.s !== "!";

  /** The top and bottom of a row's line: of a character in it, near `i` if there is one. */
  const lineOf = (row: Row, i: number): { t: number; b: number } | null => {
    const near = [i - 1, i, ...row.atoms.map((_, k) => k)];
    for (const k of near) {
      const a = row.atoms[k];
      if (a?.k !== "g") continue;
      const tok = tagged()
        .tokens.get(row.id)
        ?.find((t) => t.a <= k && k < t.a + t.n);
      const t = tok && textOf(tok.el);
      const b = t && textBox(t, 0, t.length);
      if (b) return b;
    }
    const hole = tagged().holes.get(row.id)?.[0];
    const t = hole && textOf(hole.el);
    const b = t && textBox(t, 0, t.length);
    return b ?? null;
  };

  /** Where the caret at `p` is drawn. */
  const spot = (p: Pos): Spot | null => {
    const row = tree().get(p.row)?.row;
    if (!row) return null;
    const ix = tagged();
    const n = row.atoms.length;
    const i = p.i;
    const prev = i > 0 ? atomBox(row, i - 1) : null;
    const next = i < n ? atomBox(row, i) : null;
    const holeEl = ix.holes.get(row.id)?.find((h) => h.at === i)?.el;
    const hole = holeEl ? boxOf(holeEl.getBoundingClientRect()) : null;
    const opBefore = isOpGlyph(row.atoms[i - 1]);
    let x: number | null = null;
    // in an empty slot, or where an operand is still to come: the caret is in the □
    if (hole && (!prev || opBefore)) x = hole.l;
    else if (prev && !(opBefore && next)) x = prev.r;
    else if (next) x = next.l;
    else if (prev) x = prev.r;
    if (x === null) {
      // the nearest thing drawn on either side
      for (let k = i - 2; k >= 0 && x === null; k--) x = atomBox(row, k)?.r ?? null;
      for (let k = i + 1; k < n && x === null; k++) x = atomBox(row, k)?.l ?? null;
    }
    const w = whereIs(s, row.id);
    if (x === null) {
      // an empty row with no □: a call's brackets with nothing in them, the unit after `=`
      const own = w?.owner;
      const open = own && ix.opens.get(own.id);
      if (open) x = open.getBoundingClientRect().right;
      else if (row.id === s.line.unit.id && ix.unitRow) x = ix.unitRow.getBoundingClientRect().right;
      else if (own && ix.nodes.get(own.id)) {
        const r = ix.nodes.get(own.id)!.getBoundingClientRect();
        x = (r.left + r.right) / 2;
      } else x = mathEl.getBoundingClientRect().right;
    }
    // the height of the line the caret is on: its font's
    const near = (a: Atom | undefined, b: Box | null) => (a?.k === "g" && b ? b : null);
    let line: { t: number; b: number } | null =
      near(row.atoms[i - 1], prev) ?? near(row.atoms[i], next) ?? (hole && textOf(holeEl!) ? lineOf(row, i) : null);
    line ??= lineOf(row, i);
    // beside a structure on a line with nothing else (a branch holding a block): as tall as it
    const beside = !line && PROGRAM_KINDS.has(row.atoms[i]?.k ?? row.atoms[i - 1]?.k ?? "g") ? (next ?? prev) : null;
    if (beside) line = { t: beside.t, b: beside.b };
    for (let up = w; !line && up?.parent; up = whereIs(s, up.parent.id)) {
      // nothing typed in this row: a structure's middle, at the size of the line around it
      const el = up.owner && (ix.nodes.get(up.owner.id) ?? ix.scripts.get(up.owner.id));
      const around = lineOf(up.parent, up.at);
      if (el && around) {
        const r = el.getBoundingClientRect();
        const h = around.b - around.t;
        line = { t: (r.top + r.bottom) / 2 - h / 2, b: (r.top + r.bottom) / 2 + h / 2 };
      } else line = around;
    }
    if (!line) {
      const r = mathEl.getBoundingClientRect();
      line = { t: r.top, b: r.bottom };
    }
    return { x, t: line.t, b: line.b };
  };

  /** Of several slots on one line (↑ ↓ onto `for i ∈ 1..n`), the one nearest to screen x. */
  const nearestRow = (rows: string[], x: number): string => {
    let best = rows[0];
    let d = Infinity;
    for (const id of rows) {
      const row = tree().get(id)?.row;
      for (let i = 0; row && i <= row.atoms.length; i++) {
        const sp = spot({ row: id, i });
        if (sp && Math.abs(sp.x - x) < d) {
          d = Math.abs(sp.x - x);
          best = id;
        }
      }
    }
    return best;
  };

  /** The landing index in `row` (↑ ↓) nearest to screen x. */
  const nearest = (rowId: string, n: number, x: number): number => {
    let best = 0;
    let d = Infinity;
    for (let i = 0; i <= n; i++) {
      const sp = spot({ row: rowId, i });
      if (sp && Math.abs(sp.x - x) < d) {
        d = Math.abs(sp.x - x);
        best = i;
      }
    }
    return best;
  };

  /** The caret position nearest to a point on screen: the slot under it first (a numerator, an exponent). */
  const hit = (cx: number, cy: number): Pos | null => {
    let best: Pos | null = null;
    let score = Infinity;
    // on the result: the unit it is shown in, which is where typing there goes
    const res = s.line.show ? tagged().unitRow?.getBoundingClientRect() : null;
    const onResult = !!res && cx >= res.left;
    for (const p of positions(s)) {
      if (onResult && p.row !== s.line.unit.id) continue;
      const sp = spot(p);
      if (!sp) continue;
      const dy = cy < sp.t ? sp.t - cy : cy > sp.b ? cy - sp.b : 0;
      // inside the line's height a deeper (smaller) slot wins a tie
      const v = Math.abs(sp.x - cx) + dy * 4 + (sp.b - sp.t) * 0.01;
      if (v < score) {
        score = v;
        best = p;
      }
    }
    return best;
  };

  // ---- the caret and the selection on screen ----

  /** Page coordinates: what the caret and the selection are placed in (the region, zoomed with the page). */
  const frame = () => {
    const base = (mathEl.offsetParent as HTMLElement | null) ?? mathEl.parentElement!;
    const r = base.getBoundingClientRect();
    const scale = r.width / (base.offsetWidth || 1) || 1;
    return {
      x: (cx: number) => (cx - r.left) / scale - base.clientLeft,
      y: (cy: number) => (cy - r.top) / scale - base.clientTop,
      scale,
    };
  };

  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(blinkTimer));

  const place = () => {
    const f = frame();
    const dpr = window.devicePixelRatio || 1;
    const sel = selection(s);
    // crisp: a whole number of device pixels wide, on a device pixel
    const snap = (v: number) => Math.round(v * f.scale * dpr) / (f.scale * dpr);
    if (sel) {
      caretEl.style.display = "none";
      const row = tree().get(sel.row)?.row;
      let box: Box | null = null;
      for (let k = sel.from; row && k < sel.to; k++) {
        const b = atomBox(row, k);
        if (b)
          box = box
            ? { l: Math.min(box.l, b.l), r: Math.max(box.r, b.r), t: Math.min(box.t, b.t), b: Math.max(box.b, b.b) }
            : b;
      }
      const a = spot({ row: sel.row, i: sel.from });
      const z = spot({ row: sel.row, i: sel.to });
      if (a && z)
        box = box ? { ...box, l: Math.min(box.l, a.x), r: Math.max(box.r, z.x) } : { l: a.x, r: z.x, t: a.t, b: a.b };
      if (box) {
        Object.assign(selEl.style, {
          display: "block",
          left: `${snap(f.x(box.l))}px`,
          top: `${snap(f.y(box.t))}px`,
          width: `${snap(f.x(box.r)) - snap(f.x(box.l))}px`,
          height: `${snap(f.y(box.b)) - snap(f.y(box.t))}px`,
        });
      } else selEl.style.display = "none";
    } else selEl.style.display = "none";
    const sp = spot(s.caret);
    if (!sp) return;
    const width = Math.max(1, Math.round(1.5 * f.scale * dpr)) / (f.scale * dpr);
    const left = snap(f.x(sp.x) - width / 2);
    const top = snap(f.y(sp.t));
    const height = snap(f.y(sp.b)) - top;
    if (!sel) {
      Object.assign(caretEl.style, {
        display: "block",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      // steady while typing, then blinking as macOS does
      caretEl.classList.remove("blink");
      clearTimeout(blinkTimer);
      blinkTimer = setTimeout(() => caretEl.classList.add("blink"), 500);
    }
    // the field that takes the keyboard sits at the caret: the IME's window opens there
    Object.assign(sink.style, { left: `${left}px`, top: `${top}px`, height: `${height}px` });
    // the □ the caret is in, and the brackets around it, light up
    const ix = tagged();
    for (const el of mathEl.querySelectorAll(".on, .bmatch")) el.classList.remove("on", "bmatch");
    if (!sel) {
      ix.holes
        .get(s.caret.row)
        ?.find((h) => h.at === s.caret.i)
        ?.el.classList.add("on");
      const pair = pairAt();
      if (pair) {
        ix.opens.get(pair)?.classList.add("bmatch");
        ix.closes.get(pair)?.classList.add("bmatch");
      }
    }
  };

  /** The brackets the caret is next to, or failing that inside: the pair to light up (#173). */
  const pairAt = (): string | null => {
    const row = tree().get(s.caret.row)?.row;
    if (!row) return null;
    const isPair = (a: Atom | undefined): a is Node => !!a && a.k === "paren";
    const before = row.atoms[s.caret.i - 1];
    const after = row.atoms[s.caret.i];
    if (isPair(before)) return before.id;
    if (isPair(after)) return after.id;
    for (let w = whereIs(s, row.id); w?.parent; w = whereIs(s, w.parent.id))
      if (w.owner?.k === "paren") return w.owner.id;
    return null;
  };

  // ---- the name at the caret, and the lists ----

  const nameHere = (): NameHere | null => {
    if (s.anchor) return null;
    const w = whereIs(s, s.caret.row);
    if (!w) return null;
    const own = w.owner;
    // inside `'kN` or `#G`: the whole structure is the name
    if ((own?.k === "unit" || own?.k === "const") && w.parent) {
      const name = rowText(w.row);
      const typed = rowText({ ...w.row, atoms: w.row.atoms.slice(0, s.caret.i) });
      return {
        row: w.parent.id,
        from: w.at,
        to: w.at + 1,
        name,
        typed,
        marker: own.k === "unit" ? "'" : "#",
        unit: own.k === "unit" || unitPosition(textBefore(w.parent, w.at), textBefore(w.parent, w.at).length),
        afterNumber: isDigit(glyphAt(w.parent, w.at - 1)),
      };
    }
    // in a name's subscript: the name with it
    let row = w.row;
    let i = s.caret.i;
    let inSub = "";
    if (own?.k === "sub" && w.parent) {
      inSub = rowText({ ...w.row, atoms: w.row.atoms.slice(0, s.caret.i) });
      row = w.parent;
      i = w.at + 1;
    }
    const word = (a: Atom | undefined) => !!a && a.k === "g" && isNameCont(a.s);
    let a = inSub ? w.at : i;
    let b = inSub ? w.at : i;
    while (a > 0 && word(row.atoms[a - 1])) a--;
    while (b < row.atoms.length && word(row.atoms[b])) b++;
    // digits in front are a number: `2T`
    while (a < b && !isNameStart(glyphAt(row, a))) a++;
    if (a >= b || i < a) return null;
    let to = b;
    let sub = "";
    if (row.atoms[b]?.k === "sub") {
      sub = rowText((row.atoms[b] as Node).slots[0]).replace(/\.+$/, "");
      to = b + 1;
    }
    const letters = row.atoms
      .slice(a, b)
      .map((x) => (x.k === "g" ? x.s : ""))
      .join("");
    const name = sub ? `${letters}.${sub}` : letters;
    const typed = inSub
      ? `${letters}.${inSub}`
      : row.atoms
          .slice(a, i)
          .map((x) => (x.k === "g" ? x.s : ""))
          .join("");
    const before = textBefore(row, a);
    return {
      row: row.id,
      from: a,
      to,
      name,
      typed,
      marker: "",
      unit: unitPosition(before, before.length),
      afterNumber: /[\p{N}.]\s*$/u.test(before),
    };
  };

  const glyphAt = (r: Row, k: number) => {
    const a = r.atoms[k];
    return a?.k === "g" ? a.s : null;
  };
  /** The row before `at` as text, for telling where a unit goes. */
  const textBefore = (r: Row, at: number) => {
    const text = rawText({ ...r, atoms: r.atoms.slice(0, at) });
    // `2m`: the parser reads a number then a name even without the space
    return at > 0 && r.atoms[at - 1]?.k === "g" && isDigit(glyphAt(r, at - 1)) ? `${text} ` : text;
  };

  /** The name at the caret replaced by `insert` (a list's pick, ⌥Enter): one undo step. */
  const replaceName = (here: NameHere, insert: string) => {
    s = paste(selectRange(s, here.row, here.from, here.to), insert);
    rewriting = true;
    changed();
    rewriting = false;
  };
  let rewriting = false;

  /** Where the lists open: under the caret, or above its line when there is no room. */
  const listPoint = (): [number, number, number] => {
    const sp = spot(s.caret) ?? { x: 0, t: 0, b: 0 };
    return [sp.x, sp.b + 4, sp.t - 4];
  };

  const cmdHere = (): Node | null => {
    const w = whereIs(s, s.caret.row);
    return w?.owner?.k === "cmd" && !s.anchor ? w.owner : null;
  };
  const inUnit = () => s.line.show === "value" && s.caret.row === s.line.unit.id && !s.anchor;

  const updateLists = (typing = false) => {
    if (rewriting) {
      nameGen++;
      clearTimeout(nameTimer);
      return;
    }
    if (cmdHere()) return symbolList();
    if (inUnit()) return unitList();
    nameList(typing);
  };

  /** `\name` being typed: the symbols it may become (Enter or Tab takes one). */
  const symbolList = () => {
    const cmd = cmdHere();
    if (!cmd || !prefs.latex) return hideCompletions();
    const typed = rowText(cmd.slots[0]);
    const items = typed ? completions(typed, 8, "math") : [...commandsFor("math"), ...POPULAR];
    const [x, y, top] = listPoint();
    showCompletions(
      x,
      y,
      items,
      (sym) => {
        // the shortcut's letters become the chosen name, and a space ends it as typing would
        const w = whereIs(s, cmd.slots[0].id);
        if (!w?.parent) return;
        s = selectRange(s, cmd.slots[0].id, 0, cmd.slots[0].atoms.length);
        for (const ch of sym.name) s = key(s, ch);
        s = key(s, " ");
        changed();
        effect();
      },
      false,
      "symbols",
      top,
    );
  };

  const toItem = (c: Completion): Item => {
    const about =
      c.kind === "unit" && c.title
        ? [c.title, c.quantity].filter(Boolean).join(" · ")
        : c.kind === "constant" && c.title
          ? c.title
          : prettyValue(c.preview);
    return {
      name: c.name,
      insert: c.insert,
      note: about,
      kind: c.kind,
      html: `${c.quotedOnly ? "'" : ""}${nameHtml(c.name, c.kind)}`,
      speak: `${c.name}, ${KIND_WORD[c.kind]}, ${about}`,
    };
  };

  let nameTimer: ReturnType<typeof setTimeout> | undefined;
  let nameGen = 0;
  onCleanup(() => clearTimeout(nameTimer));

  /** The meanings of the name at the caret: asked for (Ctrl+Space), or by themselves after two letters. */
  const nameList = (typing: boolean, ask = false) => {
    const gen = ++nameGen;
    clearTimeout(nameTimer);
    const open = openList();
    const namesOpen = open?.list === "names";
    const asked = ask || (namesOpen && !open.soft);
    const found = nameHere();
    const here: NameHere | null =
      found ??
      (ask && !s.anchor
        ? {
            row: s.caret.row,
            from: s.caret.i,
            to: s.caret.i,
            name: "",
            typed: "",
            marker: "",
            unit: false,
            afterNumber: false,
          }
        : null);
    const prefix = here ? (asked ? here.typed || here.name : here.typed) : "";
    const unitHere = !!here && here.marker !== "#" && here.unit;
    const atEnd = !!here && (found ? here.typed.length >= here.name.length || here.typed === here.name : true);
    const starts =
      typing &&
      atEnd &&
      (unitHere ? /^[\p{L}°]/u.test(prefix) : /^\p{L}{2}/u.test(prefix)) &&
      !["and", "or", "not", "mod"].includes(prefix.toLowerCase());
    if (!here || !(asked || (prefix && (namesOpen || starts)))) {
      if (open) hideCompletions();
      return;
    }
    if (open && !namesOpen) hideCompletions();
    const version = s.version;
    const search = unitHere && !!prefix;
    let toSay = ask;
    const show = (all: Completion[]) => {
      if (gen !== nameGen || s.version !== version || document.activeElement !== sink) return;
      const fits = (c: Completion) =>
        (search || c.name.startsWith(prefix)) &&
        (here.marker === "'" ? c.kind === "unit" : here.marker === "#" ? c.kind === "constant" : true);
      const items = all.filter(fits).slice(0, 100).map(toItem);
      const written = `${here.marker}${here.name}`;
      const same = items.length === 1 && items[0].insert === written;
      if (!items.length || (!asked && same)) {
        if (openList()?.list === "names") hideCompletions();
        if (toSay) announce(`Nothing named ${prefix || "here"}`);
        toSay = false;
        return;
      }
      const [x, y, top] = listPoint();
      showCompletions(x, y, items, (item) => replaceName(nameHere() ?? here, item.insert), !asked, "names", top);
      if (toSay) announceFirst();
      toSay = false;
    };
    const query = here.marker === "'" ? `'${prefix}` : prefix;
    const known = search ? knownUnitMeanings(viewId, query) : knownMeanings(viewId, prefix);
    if (known) show(known.list);
    if (known?.exact) return;
    const lookUp = () => (search ? unitMeanings(viewId, query) : meanings(viewId, prefix));
    nameTimer = setTimeout(() => void lookUp().then(show), asked ? 0 : 150);
  };

  /** ⌥Enter: the name at the caret takes its next meaning here (yours → unit → constant). */
  const cycleName = async () => {
    const here = nameHere();
    if (!here) return announce("No name at the caret");
    const version = s.version;
    const order = cycleOrder(await meanings(viewId, here.name), here.name);
    if (s.version !== version || state.editing !== owner) return;
    if (order.length < 2) {
      const only = order[0];
      return announce(
        only ? `${here.name} is only a ${KIND_WORD[only.kind]} here` : `${here.name} has no other meaning here`,
      );
    }
    // as the text writes it, for telling which meaning it has now
    const written = `${here.marker}${here.name}`;
    const before = here.afterNumber ? "1 " : "";
    const span: NameSpan = {
      from: before.length,
      to: before.length + written.length,
      name: here.name,
      marker: here.marker,
      typed: here.typed,
    };
    const next = order[(currentMeaning(order, span, before + written) + 1) % order.length];
    replaceName(here, next.insert);
    announce(`${next.name}, ${KIND_WORD[next.kind]}, ${prettyValue(next.preview)}`);
  };

  // after `=`: the units the result can be shown in, each with the result in it
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let showGen = 0;
  onCleanup(() => clearTimeout(showTimer));
  const unitList = () => {
    const gen = ++showGen;
    clearTimeout(showTimer);
    const choices = state.views[viewId]?.unitChoices ?? [];
    const unitRow = s.line.unit;
    if (!inUnit() || s.caret.i !== unitRow.atoms.length || !choices.length) return hideCompletions();
    const text = toLinear(s);
    const { expr, unit } = splitShow(text);
    const typed = unit ?? "";
    const version = s.version;
    const open = (list: UnitChoice[]) => {
      if (gen !== showGen || s.version !== version || document.activeElement !== sink) return;
      const items: Sym[] = list.map((c) => ({
        name: c.unit,
        insert: c.unit,
        label: prettyValue(`'${c.unit.replace(/\*/g, "*'").replace(/\//g, "/'")}`),
        note: prettyValue(c.text),
        detail: c.title,
      }));
      if (!items.length || (items.length === 1 && items[0].name === unit)) return hideCompletions();
      // below the whole formula, so the result stays in view
      const [x, , top] = listPoint();
      const y = (mathEl.closest(".region")?.getBoundingClientRect().bottom ?? listPoint()[1]) + 6;
      showCompletions(
        x,
        y,
        items,
        (sym) => {
          const u = s.line.unit;
          s = paste(
            u.atoms.length ? selectRange(s, u.id, 0, u.atoms.length) : setCaret(s, { row: u.id, i: 0 }),
            sym.insert,
          );
          changed();
        },
        true,
        "units",
        top,
      );
    };
    if (!typed) return open(choices);
    const known = knownShowIn(viewId, expr, typed);
    open(known ? known.list : choices.filter((c) => looselyIn(typed, `${c.unit} ${c.title ?? ""}`)));
    if (known) return;
    showTimer = setTimeout(() => void showInChoices(viewId, expr, typed).then(open), 150);
  };
  // the choices arrive with the evaluation after `=` is typed
  createEffect(
    on(
      () => state.views[viewId]?.unitChoices,
      () => document.activeElement === sink && inUnit() && unitList(),
      { defer: true },
    ),
  );

  /** The variable at the caret is traced on the page (where it is defined and used). */
  const traceName = () => {
    const here = nameHere();
    setCaretName(here && !here.marker ? here.name : null);
  };

  // ---- keys ----

  let composing = false;

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (composing || e.isComposing || e.keyCode === 229) return;
    const k = e.key;
    const space = e.code === "Space" || k === " ";
    const listKey = e.ctrlKey ? !e.metaKey && !e.altKey : isMac && e.altKey && !e.metaKey;
    if (space && listKey) {
      e.preventDefault();
      if (cmdHere()) symbolList();
      else if (inUnit()) unitList();
      else nameList(false, true);
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && k === "Enter") {
      e.preventDefault();
      hideCompletions();
      void cycleName();
      return;
    }
    if (completionKey(e)) {
      e.preventDefault();
      return;
    }
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const lower = k.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (lower === "z" || (lower === "y" && !e.metaKey))) {
      e.preventDefault();
      travel(lower === "y" || e.shiftKey);
      return;
    }
    if (mod && !e.altKey && lower === "a") {
      e.preventDefault();
      s = setCaret(setCaret(s, { row: s.line.main.id, i: 0 }), positions(s).at(-1)!, true);
      changed({ record: false });
      return;
    }
    // copy, cut and paste arrive as their own events
    if (mod && ["c", "x", "v"].includes(lower)) return;
    if (e.ctrlKey && k === ".") {
      e.preventDefault();
      s = symbolic(s);
      changed();
      return;
    }
    if (e.ctrlKey && lower === "g") {
      e.preventDefault();
      s = greek(s);
      changed();
      return;
    }
    switch (k) {
      case "Enter":
        e.preventDefault();
        hideCompletions();
        // in a program Enter adds a line (docs/07-math-editing.md); ⌘Enter ends the edit from anywhere
        if (e.metaKey || e.ctrlKey) finish();
        else press("Enter");
        return;
      case "Escape": {
        e.preventDefault();
        const at = layout().byId.get(owner)?.region.at;
        commitEditing();
        if (layout().byId.has(owner)) setState({ selection: [owner], caret: null });
        else if (at) setState({ caret: [at[0], at[1]] });
        return;
      }
      case "Tab":
        e.preventDefault();
        press("Tab", { shift: e.shiftKey });
        return;
      case "ArrowLeft":
      case "ArrowRight":
        e.preventDefault();
        // ⌘← ⌘→: to the start or the end, as in a line of text; ⌥← ⌥→ (Ctrl on Windows and Linux) by words
        if (e.metaKey) press(k === "ArrowLeft" ? "Home" : "End", { shift: e.shiftKey });
        else if (isMac ? e.altKey : e.ctrlKey)
          press(k === "ArrowLeft" ? "WordLeft" : "WordRight", { shift: e.shiftKey });
        else press(k, { shift: e.shiftKey });
        return;
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        press(k, { pick: true });
        return;
      case "Home":
      case "End":
      case "Backspace":
      case "Delete":
        e.preventDefault();
        press(k, { shift: e.shiftKey });
        return;
    }
    if (e.metaKey || e.ctrlKey) return;
    // characters arrive through the field as text (`input`), composed by the keyboard and the IME
  };

  const takeText = () => {
    const text = sink.value;
    sink.value = "";
    if (text) type(text);
  };

  // ---- pointer ----

  let dragging = false;
  let openedAt = performance.now();
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    sink.focus({ preventScroll: true });
    const p = hit(e.clientX, e.clientY);
    if (!p) return;
    hideCompletions();
    s = setCaret(s, p, e.shiftKey);
    dragging = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    changed({ record: true });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const p = hit(e.clientX, e.clientY);
    if (!p || (p.row === s.caret.row && p.i === s.caret.i)) return;
    s = setCaret(s, p, true);
    changed({ record: true });
  };
  const onPointerUp = () => {
    dragging = false;
  };
  /** A double-click selects the name or number under it, or the structure. */
  const onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // the double-click that opened the formula only puts the caret where it landed
    if (performance.now() - openedAt < 700) return;
    const p = hit(e.clientX, e.clientY);
    if (!p) return;
    const row = tree().get(p.row)!.row;
    const word = (a: Atom | undefined) => !!a && a.k === "g" && (isNameCont(a.s) || a.s === ".");
    let a = p.i;
    let b = p.i;
    while (a > 0 && word(row.atoms[a - 1])) a--;
    while (b < row.atoms.length && word(row.atoms[b])) b++;
    if (a === b) {
      const near = row.atoms[p.i - 1]?.k !== "g" ? p.i - 1 : row.atoms[p.i]?.k !== "g" ? p.i : -1;
      if (near >= 0 && row.atoms[near]) [a, b] = [near, near + 1];
      else {
        // an empty slot: the structure it is in
        const w = whereIs(s, row.id);
        if (!w?.parent) return;
        s = selectRange(s, w.parent.id, w.at, w.at + 1);
        return changed({ record: true });
      }
    }
    s = selectRange(s, row.id, a, b);
    changed({ record: true });
  };

  // ---- on the page ----

  onMount(() => {
    const host = mathEl.parentElement!;
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("dblclick", onDblClick);
    onCleanup(() => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("dblclick", onDblClick);
    });
    draw();
    // where the click that opened it landed, or where the arrow came in, or the first □
    const click = editClickPoint;
    const at = click ? hit(click[0], click[1]) : null;
    const from = entry;
    entry = null;
    if (at) s = setCaret(s, at);
    else if (from === "start") s = key(s, "Home");
    else if (from !== "end") s = toFirstHole(s) ?? s;
    s = settleSlots(s);
    history.record(s);
    draw();
    lastPlace = placeWords(s, { units: [], constants: [] })?.key ?? "";
    sink.focus({ preventScroll: true });
    setInPlace({ type, insert, undo: travel });
    forgetMeanings(viewId);
    traceName();
  });
  onCleanup(() => {
    setInPlace(null);
    setCaretName(null);
    hideCompletions();
  });

  // a new result, or what the names mean, from the engine: drawn as it comes
  createEffect(on(props.said, () => draw(), { defer: true }));

  const insert = (template: string) => {
    sink.focus({ preventScroll: true });
    s = insertTemplate(s, template);
    changed();
  };

  return (
    <>
      <span class="m in-place" ref={mathEl} aria-hidden="true" />
      <div class="mip-sel" ref={selEl} aria-hidden="true" />
      <div class="mip-caret" ref={caretEl} aria-hidden="true" />
      <textarea
        ref={sink}
        class="mip-sink"
        aria-label="Math"
        aria-description={toLinear(s)}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="off"
        rows={1}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing = true;
          sink.classList.add("composing");
          caretEl.style.visibility = "hidden";
        }}
        onCompositionEnd={() => {
          composing = false;
          sink.classList.remove("composing");
          caretEl.style.visibility = "";
          takeText();
        }}
        onInput={(e) => {
          if (composing || e.isComposing) {
            // the composition shown where it is typed, as wide as it is
            sink.style.width = `${Math.max(1, sink.scrollWidth)}px`;
            return;
          }
          takeText();
        }}
        onBeforeInput={(e) => {
          // the edit menu and the context menu undo through here
          if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
          e.preventDefault();
          travel(e.inputType === "historyRedo");
        }}
        onCopy={(e) => {
          e.stopPropagation();
          const text = selectedText(s);
          if (!text) return;
          e.preventDefault();
          e.clipboardData?.setData("text/plain", text);
        }}
        onCut={(e) => {
          e.stopPropagation();
          const cut = cutSelection(s);
          if (!cut.text) return;
          e.preventDefault();
          e.clipboardData?.setData("text/plain", cut.text);
          s = cut.state;
          changed();
        }}
        onPaste={(e) => {
          e.stopPropagation();
          e.preventDefault();
          const raw = e.clipboardData?.getData("text/plain").trim() ?? "";
          // LaTeX from a paper or Overleaf goes in as linear math (`\frac{a}{b}` → `a/b`)
          const linear = latexToLinear(raw) ?? raw;
          const first = linear.split("\n")[0];
          if (!first) return;
          s = paste(s, first);
          changed();
        }}
        onBlur={(e) => {
          hideCompletions();
          setCaretName(null);
          caretEl.style.display = "none";
          // moving to another line of the same block, the palette, or the format bar end nothing
          const stillMath = props.line ? props.line.active() : layout().byId.get(props.r.id)?.region.kind === "math";
          const toBar = (e.relatedTarget as Element | null)?.closest?.(".formatbar");
          if (state.editing === owner && stillMath && !paletteOpen() && !toBar) commitEditing();
        }}
        onFocus={() => place()}
      />
    </>
  );
}
