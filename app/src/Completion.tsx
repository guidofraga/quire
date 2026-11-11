// The list under the caret shared by the math and text editors: `\name` completion, the units
// after `=`, and the meanings of a name in math (Ctrl+Space, or by itself after two letters).
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { announce } from "./a11y";
import { KIND_WORD } from "./names";
import { isTemplate, type Sym } from "./symbols";
import type { Completion } from "./types";

/** A row: a symbol or unit, or one meaning of a name (`kind`, the name drawn as math in `html`). */
export type Item = Sym & {
  kind?: Completion["kind"];
  html?: string;
  /** What a screen reader says for the row (`G, constant, 6.674·10⁻¹¹ m³/(kg·s²)`). */
  speak?: string;
};

/** `symbols`: `\name`; `units`: the units after `=`; `names`: what a name can mean. */
export type ListKind = "symbols" | "units" | "names";

interface Popup {
  x: number;
  y: number;
  items: Item[];
  index: number;
  pick: (s: Item) => void;
  list: ListKind;
  /** A suggestion the user didn't ask for: Enter keeps finishing the line unless they moved through the list. */
  soft?: boolean;
  touched?: boolean;
}

const [popup, setPopup] = createSignal<Popup | null>(null);

/** The list open now, if any: which one, and whether it opened by itself. */
export const openList = () => {
  const p = popup();
  return p ? { list: p.list, soft: !!p.soft } : null;
};

export function showCompletions(
  x: number,
  y: number,
  items: Item[],
  pick: (s: Item) => void,
  soft = false,
  list: ListKind = soft ? "units" : "symbols",
) {
  if (!items.length) return hideCompletions();
  const prev = popup();
  const same = prev && prev.soft === soft && prev.list === list;
  setPopup({
    x,
    y,
    items,
    index: same ? Math.min(prev.index, items.length - 1) : 0,
    pick,
    list,
    soft,
    touched: same ? prev.touched : false,
  });
}

export function hideCompletions() {
  setPopup(null);
}

const spoken = (item: Item) => item.speak ?? `${item.label ?? item.insert}, ${item.note ?? item.name}`;

/** Say the row a list starts on, when it was asked for (the list itself never takes focus). */
export function announceFirst() {
  const p = popup();
  if (p) announce(`${spoken(p.items[0])}, 1 of ${p.items.length}`);
}

/** Arrow keys, Enter/Tab and Escape while the list is open. Returns true when handled. */
export function completionKey(e: KeyboardEvent): boolean {
  const p = popup();
  if (!p) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = p.items.length;
    // the first arrow on a suggestion list selects its first entry
    const index =
      p.soft && !p.touched ? (e.key === "ArrowDown" ? 0 : n - 1) : (p.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    setPopup({ ...p, index, touched: true });
    // the list isn't focused (the editor keeps the caret), so say what the arrows landed on
    announce(spoken(p.items[index]));
    return true;
  }
  if (e.key === "Tab" && p.soft && !p.touched) {
    // a suggestion the user never looked at: Tab keeps its usual job, nothing is inserted
    hideCompletions();
    return false;
  }
  if (e.key === "Enter" && p.soft && (!p.touched || p.list !== "names")) {
    // Enter still finishes the line; if a unit was chosen with the arrows, it goes in first
    if (p.touched) p.pick(p.items[p.index]);
    hideCompletions();
    return false;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    // (a name chosen from a list that opened by itself goes in, and the line goes on)
    p.pick(p.items[p.index]);
    hideCompletions();
    return true;
  }
  if (e.key === "Escape") {
    hideCompletions();
    return true;
  }
  return false;
}

/** The kind of a name, as a small glyph: ≔ yours, ƒ a function, a ruler a unit, ◆ a constant. */
const KIND_GLYPH: Record<Completion["kind"], () => JSX.Element> = {
  variable: () => (
    <svg viewBox="0 0 12 12" fill="currentColor">
      <circle cx="2.2" cy="4" r="0.9" />
      <circle cx="2.2" cy="8" r="0.9" />
      <path d="M5 4h6M5 8h6" fill="none" stroke="currentColor" stroke-width="1.2" />
    </svg>
  ),
  function: () => (
    <svg viewBox="0 0 12 12" fill="currentColor">
      <path
        d="M9 2.2C7.4 1.6 6.2 2.2 5.9 3.8L4.6 9.6C4.3 10.9 3.3 11.2 2.2 10.7M3.6 5.2h5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </svg>
  ),
  unit: () => (
    <svg viewBox="0 0 12 12" fill="currentColor">
      <rect x="0.8" y="3.6" width="10.4" height="4.8" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.1" />
      <path d="M3.4 3.6v2M6 3.6v2.6M8.6 3.6v2" fill="none" stroke="currentColor" stroke-width="1.1" />
    </svg>
  ),
  constant: () => (
    <svg viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" />
    </svg>
  ),
};

function Row(props: { item: Item; i: number; p: Popup }) {
  const on = () => props.i === props.p.index && (!props.p.soft || !!props.p.touched);
  let el!: HTMLButtonElement;
  // a long list scrolls with the arrows
  createEffect(() => on() && el.scrollIntoView?.({ block: "nearest" }));
  return (
    <button
      ref={el}
      id={`completion-${props.i}`}
      class="completion-item"
      classList={{ on: on() }}
      role="option"
      tabIndex={-1}
      aria-selected={on()}
      data-kind={props.item.kind}
      onMouseEnter={() => setPopup({ ...props.p, index: props.i, touched: true })}
      onClick={() => {
        props.p.pick(props.item);
        hideCompletions();
      }}
    >
      <Show
        when={props.item.kind}
        fallback={
          <>
            <span class="completion-glyph">
              {isTemplate(props.item) || props.item.note ? (props.item.label ?? props.item.insert) : props.item.insert}
            </span>
            <span class="completion-name">{props.item.note ?? `\\${props.item.name}`}</span>
            <Show when={props.item.textOnly}>
              <span class="completion-note">text</span>
            </Show>
          </>
        }
      >
        {(kind) => (
          <>
            <span class={`kind-glyph ${kind()}`} aria-hidden="true">
              {KIND_GLYPH[kind()]()}
            </span>
            <span class="completion-glyph name-glyph" innerHTML={props.item.html} />
            <span class="completion-preview">{props.item.note}</span>
            {/* the glyph's meaning, for screen readers browsing the list */}
            <span class="sr-only">, {KIND_WORD[kind()]}</span>
          </>
        )}
      </Show>
    </button>
  );
}

export function CompletionPopup() {
  return (
    <Show when={popup()}>
      {(p) => (
        <div
          class="completion"
          classList={{ units: p().list === "units", names: p().list === "names" }}
          role="listbox"
          aria-label={{ symbols: "Completions", units: "Show in", names: "Names" }[p().list]}
          style={{ left: `${p().x}px`, top: `${p().y}px` }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Show when={p().list === "units"}>
            <div class="completion-head" aria-hidden="true">
              Show in
            </div>
          </Show>
          <For each={p().items}>{(item, i) => <Row item={item} i={i()} p={p()} />}</For>
        </div>
      )}
    </Show>
  );
}
