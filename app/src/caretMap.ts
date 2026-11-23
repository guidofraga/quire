// Where a position in the math line being typed is in its typeset formula, and back: the first
// step towards typing in the formula itself (#165). The typed line stays what is edited; the
// formula shows a caret where the typing caret is, and a click in it moves the typing caret.
//
// The math is drawn from the parsed tree, which keeps no positions, so the line's tokens are
// matched to the drawn pieces (mi, mn, mo, ms) in reading order, by what each piece shows. A
// token drawn as no piece of its own (`sqrt` as a radical, `/` as a fraction bar, `^`) is skipped.

/** A piece of the typed line and what the formula shows for it. */
export interface Token {
  from: number;
  to: number;
  shows: string;
}

/** Operators as the formula draws them. */
const SHOWN: Record<string, string> = {
  ":=": "≔",
  "::=": "≡",
  "==": "=",
  "!=": "≠",
  "<=": "≤",
  ">=": "≥",
  "*": "·",
  "⋅": "·",
  "×": "·",
  "-": "−",
  "?": "□",
};

const OPERATORS = ["::=", ":=", "==", "!=", "<=", ">=", ".."];

/** The tokens of a typed math line, with where each is and what the formula shows for it. */
export function tokensOf(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (from: number, to: number, shows: string) => out.push({ from, to, shows });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    // numbers, with a decimal part and an exponent
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      while (/[\d.]/.test(src[i] ?? "") && !(src[i] === "." && src[i + 1] === ".")) i++;
      if (/[eE]/.test(src[i] ?? "") && /[\d+-]/.test(src[i + 1] ?? "")) {
        i += 2;
        while (/\d/.test(src[i] ?? "")) i++;
      }
      push(start, i, src.slice(start, i));
      continue;
    }
    // a name, a quoted unit or a constant; a name with a subscript is drawn as two pieces
    if (/[\p{L}_'#]/u.test(c)) {
      const marked = c === "'" || c === "#";
      if (marked) i++;
      const nameStart = i;
      while (/[\p{L}\p{N}_°%]/u.test(src[i] ?? "") || (src[i] === "." && /[\p{L}\p{N}]/u.test(src[i + 1] ?? ""))) i++;
      const name = src.slice(nameStart, i);
      const dot = name.indexOf(".");
      if (dot > 0) {
        push(start, nameStart + dot, name.slice(0, dot));
        push(nameStart + dot + 1, i, name.slice(dot + 1));
      } else if (name) push(start, i, name);
      else i = Math.max(i, start + 1);
      continue;
    }
    // a string, quotes and all
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i = Math.min(src.length, i + 1);
      push(start, i, src.slice(start, i));
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i)) ?? c;
    i += op.length;
    push(start, i, SHOWN[op] ?? op);
  }
  return out;
}

/** What a drawn piece shows, compared without the thin spaces of grouped digits. */
const shown = (el: Element) => (el.textContent ?? "").replace(/[\s ]/g, "");

/** The pieces of a drawn formula that stand for typed text, in reading order (not the result). */
export function piecesOf(math: Element): Element[] {
  return [...math.querySelectorAll("mi, mn, mo, ms")].filter((el) => !el.closest(".res"));
}

/** Each token paired with the piece that draws it, where one does. */
export function pair(tokens: Token[], pieces: readonly { textContent: string | null }[]): [Token, number][] {
  const out: [Token, number][] = [];
  let next = 0;
  for (const t of tokens) {
    // a piece a little further on: tokens drawn as nothing (a fraction's `/`) leave a gap
    for (let k = next; k < Math.min(pieces.length, next + 4); k++) {
      if (shown(pieces[k] as Element) === t.shows.replace(/\s/g, "")) {
        out.push([t, k]);
        next = k + 1;
        break;
      }
    }
  }
  return out;
}

export interface CaretBox {
  x: number;
  y: number;
  height: number;
}

/** Where the caret at `at` in `src` goes in the drawn formula `math`, relative to `frame`. */
export function caretBox(math: Element, frame: Element, src: string, at: number): CaretBox | null {
  const pieces = piecesOf(math);
  const pairs = pair(tokensOf(src), pieces);
  if (!pairs.length) return null;
  const origin = frame.getBoundingClientRect();
  const box = (k: number) => pieces[k].getBoundingClientRect();
  // as tall as the piece's type, centred on it: an operator's box can be a hairline (−), and
  // one in an exponent is smaller
  const size = (k: number) => parseFloat(getComputedStyle(pieces[k]).fontSize) || 16;
  const place = (x: number, r: DOMRect, k: number): CaretBox => {
    const height = size(k) * 1.15;
    return { x: x - origin.left, y: r.top + r.height / 2 - height / 2 - origin.top, height };
  };
  // inside a token: in proportion along its piece
  const inside = pairs.find(([t]) => t.from < at && at < t.to);
  if (inside) {
    const [t, k] = inside;
    const r = box(k);
    return place(r.left + ((at - t.from) / (t.to - t.from)) * r.width, r, k);
  }
  // between tokens: after the last one before the caret, or before the first one
  const before = pairs.filter(([t]) => t.to <= at).at(-1);
  if (before) {
    const r = box(before[1]);
    return place(r.right, r, before[1]);
  }
  const r = box(pairs[0][1]);
  return place(r.left, r, pairs[0][1]);
}

/** The position in `src` for a click at (x, y) on the drawn formula: the nearest token's edge. */
export function offsetAt(math: Element, src: string, x: number, y: number): number | null {
  const pieces = piecesOf(math);
  const pairs = pair(tokensOf(src), pieces);
  let best: { d: number; at: number } | null = null;
  for (const [t, k] of pairs) {
    const r = pieces[k].getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy * 4;
    // the edge nearer the click; inside a name or number, in proportion along it
    const along = r.width ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0;
    const at =
      t.to - t.from > 1 && dx === 0 ? t.from + Math.round(along * (t.to - t.from)) : along < 0.5 ? t.from : t.to;
    if (!best || d < best.d) best = { d, at };
  }
  return best?.at ?? null;
}
