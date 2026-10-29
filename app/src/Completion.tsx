// The `\name` autocomplete list shared by the math and text editors.
import { createSignal, For, Show } from "solid-js";
import { announce } from "./a11y";
import { isTemplate, type Sym } from "./symbols";

interface Popup {
  x: number;
  y: number;
  items: Sym[];
  index: number;
  pick: (s: Sym) => void;
  /** A suggestion the user didn't ask for: Enter keeps finishing the line unless they moved through the list. */
  soft?: boolean;
  touched?: boolean;
}

const [popup, setPopup] = createSignal<Popup | null>(null);

export function showCompletions(x: number, y: number, items: Sym[], pick: (s: Sym) => void, soft = false) {
  if (!items.length) return hideCompletions();
  const prev = popup();
  const same = prev && prev.soft === soft;
  setPopup({ x, y, items, index: same ? Math.min(prev.index, items.length - 1) : 0, pick, soft, touched: same ? prev.touched : false });
}

export function hideCompletions() {
  setPopup(null);
}


/** Arrow keys, Enter/Tab and Escape while the list is open. Returns true when handled. */
export function completionKey(e: KeyboardEvent): boolean {
  const p = popup();
  if (!p) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = p.items.length;
    // the first arrow on a suggestion list selects its first entry
    const index = p.soft && !p.touched ? (e.key === "ArrowDown" ? 0 : n - 1) : (p.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    setPopup({ ...p, index, touched: true });
    // the list isn't focused (the editor keeps the caret), so say what the arrows landed on
    const item = p.items[index];
    announce(`${item.label ?? item.insert}, ${item.note ?? item.name}`);
    return true;
  }
  if (e.key === "Enter" && p.soft) {
    // Enter still finishes the line; if a suggestion was chosen with the arrows, it goes in first
    if (p.touched) p.pick(p.items[p.index]);
    hideCompletions();
    return false;
  }
  if (e.key === "Enter" || e.key === "Tab") {
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

export function CompletionPopup() {
  return (
    <Show when={popup()}>
      {(p) => (
        <div
          class="completion"
          classList={{ units: !!p().soft }}
          role="listbox"
          aria-label={p().soft ? "Show in" : "Completions"}
          style={{ left: `${p().x}px`, top: `${p().y}px` }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Show when={p().soft}>
            <div class="completion-head" aria-hidden="true">
              Show in
            </div>
          </Show>
          <For each={p().items}>
            {(item, i) => (
              <button
                class="completion-item"
                classList={{ on: i() === p().index && (!p().soft || !!p().touched) }}
                role="option"
                tabIndex={-1}
                aria-selected={i() === p().index && (!p().soft || !!p().touched)}
                onMouseEnter={() => setPopup({ ...p(), index: i(), touched: true })}
                onClick={() => {
                  p().pick(item);
                  hideCompletions();
                }}
              >
                <span class="completion-glyph">{isTemplate(item) || item.note ? (item.label ?? item.insert) : item.insert}</span>
                <span class="completion-name">{item.note ?? `\\${item.name}`}</span>
                <Show when={item.textOnly}>
                  <span class="completion-note">text</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
