// Keyboard and screen-reader plumbing shared by dialogs, menus, galleries and toolbars:
// focus traps that hand focus back, arrow keys between buttons, F6 between the parts of
// the window, and a live region for messages a screen reader should speak.
import { createSignal, onCleanup, onMount } from "solid-js";

// ---------------------------------------------------------------------------
// Live region
// ---------------------------------------------------------------------------

const [spoken, setSpoken] = createSignal("");
const [spokenNow, setSpokenNow] = createSignal("");
/** What the polite and assertive live regions (rendered by App) say. */
export { spoken, spokenNow };

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** Have a screen reader say `text`; `urgent` interrupts (errors). */
export function announce(text: string, urgent = false) {
  const set = urgent ? setSpokenNow : setSpoken;
  // the same words twice in a row are only spoken if the region changes in between
  set("");
  clearTimeout(clearTimer);
  setTimeout(() => set(text), 30);
  // cleared afterwards, so browsing the page doesn't land on stale text
  clearTimer = setTimeout(() => (setSpoken(""), setSpokenNow("")), 6000);
}

// ---------------------------------------------------------------------------
// Keyboard or pointer: menus opened from the keyboard take focus, ones opened with the
// mouse leave it where it is (in the text being edited, say).
// ---------------------------------------------------------------------------

let keyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboard = true), true);
  window.addEventListener("pointerdown", () => (keyboard = false), true);
}
export const fromKeyboard = () => keyboard;

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The elements Tab reaches inside `root`, in order. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

/**
 * A modal dialog: focus moves into it, Tab and ⇧Tab stay inside, and when it closes
 * focus goes back to where it was. Call while the dialog's component is set up.
 */
export function useModal(root: () => HTMLElement | undefined) {
  const previous = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    const el = root();
    if (e.key !== "Tab" || !el) return;
    // a menu or popover on top of the dialog handles its own keys
    if (!el.contains(e.target as Node) && (e.target as Element).closest?.("[role=menu], [role=dialog]")) return;
    const list = focusables(el);
    const active = document.activeElement;
    if (!list.length) return e.preventDefault();
    // moved by hand: the engine's own order can skip controls (WebKit leaves some out
    // depending on system settings) and so walk out of the dialog
    const at = list.indexOf(active as HTMLElement);
    e.preventDefault();
    if (at < 0) return list[e.shiftKey ? list.length - 1 : 0].focus();
    list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
  };
  // everything around the dialog is out of reach while it is open (aria-modal alone isn't
  // honoured everywhere); live regions stay, so messages are still spoken
  const hidden: HTMLElement[] = [];
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    const el = root();
    for (let node = el; node && node !== document.body; node = node.parentElement ?? undefined) {
      for (const sib of node.parentElement?.children ?? []) {
        if (
          sib === node ||
          !(sib instanceof HTMLElement) ||
          sib.inert ||
          sib.hasAttribute("aria-live") ||
          sib.matches("script, style")
        )
          continue;
        sib.inert = true;
        sib.setAttribute("aria-hidden", "true");
        hidden.push(sib);
      }
    }
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>("[autofocus]") ?? focusables(el)[0] ?? el).focus({ preventScroll: true });
    }
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    for (const sib of hidden) {
      sib.inert = false;
      sib.removeAttribute("aria-hidden");
    }
    // only if focus is now nowhere in particular (a command run from the dialog may have moved it on)
    queueMicrotask(() => {
      const now = document.activeElement;
      if (previous?.isConnected && (!now || now === document.body)) previous.focus({ preventScroll: true });
    });
  });
}

/**
 * Arrow keys between `items`: ←/→ step through them in order, ↑/↓ go to the nearest one
 * above or below (rows of a list, or a grid of tiles), Home/End to the ends.
 * Returns true when the key was handled.
 */
export function arrowFocus(
  e: KeyboardEvent,
  items: HTMLElement[],
  axis: "both" | "horizontal" | "vertical" = "both",
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || !items.length) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  const horizontal = axis !== "vertical";
  const vertical = axis !== "horizontal";
  if (e.key === "Home") next = items[0];
  else if (e.key === "End") next = items[items.length - 1];
  else if (at < 0 && ["ArrowDown", "ArrowRight"].includes(e.key)) next = items[0];
  else if (at < 0 && ["ArrowUp", "ArrowLeft"].includes(e.key)) next = items[items.length - 1];
  else if (horizontal && e.key === "ArrowRight") next = items[(at + 1) % items.length];
  else if (horizontal && e.key === "ArrowLeft") next = items[(at - 1 + items.length) % items.length];
  else if (vertical && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    next =
      axis === "vertical"
        ? items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]
        : below(items, at, e.key === "ArrowDown" ? 1 : -1);
  } else return false;
  e.preventDefault();
  e.stopPropagation();
  next?.focus();
  next?.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** The item nearest straight below (or above) item `at`; on the last row, stays put. */
function below(items: HTMLElement[], at: number, dir: 1 | -1): HTMLElement | undefined {
  const a = items[at].getBoundingClientRect();
  const cx = a.left + a.width / 2;
  let best: [number, HTMLElement] | null = null;
  for (const el of items) {
    const b = el.getBoundingClientRect();
    const gap = dir > 0 ? b.top - (a.bottom - 2) : a.top + 2 - b.bottom;
    if (gap < 0) continue;
    const cost = gap * 4 + Math.abs(b.left + b.width / 2 - cx);
    if (!best || cost < best[0]) best = [cost, el];
  }
  return best?.[1] ?? items[at];
}

/** A toolbar's keys: arrows between its buttons (not into open popovers); Esc runs `escape`. */
export function toolbarKeys(e: KeyboardEvent, escape: () => void) {
  const bar = e.currentTarget as HTMLElement;
  if ((e.target as Element).closest("input, select, textarea, .fb-pop")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    return escape();
  }
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
    arrowFocus(
      e,
      focusables(bar).filter((el) => !el.closest(".fb-pop")),
      "horizontal",
    );
}

// ---------------------------------------------------------------------------
// F6: between the sidebar, the toolbar, the format bar, the page and the inspector
// ---------------------------------------------------------------------------

const PANES = [".sidebar:not(.collapsed)", ".toolbar", ".formatbar", ".viewport", ".findbar", ".inspector"];

/** Focus the next (or previous) part of the window; the page is reached through `focusPage`. */
export function cyclePanes(by: 1 | -1, focusPage: () => void) {
  const panes = PANES.map((s) => document.querySelector<HTMLElement>(s)).filter((el): el is HTMLElement => !!el);
  const active = document.activeElement;
  let at = panes.findIndex((p) => p.contains(active));
  if (at < 0) at = panes.findIndex((p) => p.matches(".viewport"));
  for (let k = 1; k <= panes.length; k++) {
    const pane = panes[(at + by * k + panes.length * k) % panes.length];
    if (pane.matches(".viewport")) return focusPage();
    const first = focusables(pane).find((el) => !el.closest(".fb-pop"));
    if (first) return first.focus();
  }
}
