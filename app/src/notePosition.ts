// Where a math region's note sits: right of the formula (the default), left, above or below.
// Set from the Inspector or the right-click menu, or by dragging the note, which snaps to the
// side nearest the pointer. The formula stays where it is on the page either way (#167).
import { announce } from "./a11y";
import { commitEditing, findDraft, layout, mutate, setState, state, updateRegion } from "./store";

export type NoteSide = "right" | "left" | "above" | "below";

export const NOTE_SIDES: [NoteSide, string][] = [
  ["right", "Right"],
  ["left", "Left"],
  ["above", "Above"],
  ["below", "Below"],
];

/** The side a region's note is on; anything unknown reads as the default. */
export function noteSide(position: string | undefined): NoteSide {
  return position === "left" || position === "above" || position === "below" ? position : "right";
}

const regionEl = (id: string) => document.querySelector<HTMLElement>(`[data-region="${CSS.escape(id)}"]`);
const formulaEl = (el: HTMLElement) => el.querySelector<HTMLElement>(".math-line > .m, .math-line > .raw");

/** Screen pixels per document unit: the canvas is zoomed, and the page view scaled. */
function scaleOf(el: HTMLElement): number {
  return el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
}

/** Put the note on `side`, in one undo step, moving the region so its formula doesn't move. */
export function setNotePosition(id: string, side: NoteSide) {
  const region = layout().byId.get(id)?.region;
  if (!region || noteSide(region.notePosition) === side) return;
  const el = regionEl(id);
  const before = el && formulaEl(el)?.getBoundingClientRect();
  updateRegion(id, { notePosition: side === "right" ? undefined : side });
  // the store renders as it changes: measure where the formula went, and shift it back
  const after = el && formulaEl(el)?.getBoundingClientRect();
  if (el && before && after) {
    const s = scaleOf(el);
    const dx = (before.left - after.left) / s;
    const dy = (before.top - after.top) / s;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
      // part of the same step: undo puts the note and the region back together
      mutate((d) => {
        const r = findDraft(d, id);
        if (r?.at) r.at = [Math.round(r.at[0] + dx), Math.round(r.at[1] + dy)];
      }, false);
  }
  announce(`Note ${side === "right" || side === "left" ? `on the ${side}` : side}`);
}

/** The side of the formula a point is nearest to, measured in half-sizes so wide formulas work too. */
function sideAt(f: DOMRect, x: number, y: number): NoteSide {
  const dx = (x - (f.left + f.width / 2)) / Math.max(f.width / 2, 1);
  const dy = (y - (f.top + f.height / 2)) / Math.max(f.height / 2, 1);
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "above" : "below";
}

/**
 * Press on a note: a click selects its region as usual; a drag shows the note where it would
 * land, on the side of the formula nearest the pointer, and puts it there on release. Esc cancels.
 */
export function startNoteDrag(e: PointerEvent, id: string) {
  if (e.button !== 0 || e.shiftKey || state.editing === id) return;
  const note = e.currentTarget as HTMLElement;
  const el = regionEl(id);
  const formula = el && formulaEl(el);
  if (!el || !formula) return;
  // the region's own press would start moving the region: the note takes this one
  e.stopPropagation();
  e.preventDefault();
  commitEditing();
  if (!state.selection.includes(id) || state.selection.length > 1) setState({ selection: [id], caret: null });
  const start = { x: e.clientX, y: e.clientY };
  const current = noteSide(layout().byId.get(id)?.region.notePosition);
  let side = current;
  let ghost: HTMLElement | null = null;

  const place = () => {
    if (!ghost) return;
    const f = formula.getBoundingClientRect();
    const n = note.getBoundingClientRect();
    const s = scaleOf(el);
    const gap = (side === "left" || side === "right" ? 14 : 2) * s;
    const [left, top] =
      side === "right"
        ? [f.right + gap, f.top + (f.height - n.height) / 2]
        : side === "left"
          ? [f.left - gap - n.width, f.top + (f.height - n.height) / 2]
          : side === "above"
            ? [f.left, f.top - gap - n.height]
            : [f.left, f.bottom + gap];
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.dataset.side = side;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      // the note as it will look, at the side it would go to; the note itself stays faint
      ghost = note.cloneNode(true) as HTMLElement;
      ghost.classList.add("note-ghost");
      ghost.setAttribute("aria-hidden", "true");
      const s = scaleOf(el);
      ghost.style.width = `${note.getBoundingClientRect().width / s}px`;
      ghost.style.transform = `scale(${s})`;
      // the note's type and colour, which the clone leaves behind with the page's styles
      const look = getComputedStyle(note);
      ghost.style.font = look.font;
      ghost.style.color = look.color;
      document.body.append(ghost);
      el.classList.add("note-dragging");
    }
    side = sideAt(formula.getBoundingClientRect(), ev.clientX, ev.clientY);
    place();
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    el.classList.remove("note-dragging");
    const dragged = !!ghost;
    ghost?.remove();
    ghost = null;
    if (drop && dragged && side !== current) setNotePosition(id, side);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
