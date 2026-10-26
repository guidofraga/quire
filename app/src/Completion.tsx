// The `\name` autocomplete list shared by the math and text editors.
import { createSignal, For, Show } from "solid-js";
import { isTemplate, type Sym } from "./symbols";

interface Popup {
  x: number;
  y: number;
  items: Sym[];
  index: number;
  pick: (s: Sym) => void;
}

const [popup, setPopup] = createSignal<Popup | null>(null);

export function showCompletions(x: number, y: number, items: Sym[], pick: (s: Sym) => void) {
  if (!items.length) return hideCompletions();
  const prev = popup();
  setPopup({ x, y, items, index: prev ? Math.min(prev.index, items.length - 1) : 0, pick });
}

export function hideCompletions() {
  setPopup(null);
}

export const completionOpen = () => popup() !== null;

/** Arrow keys, Enter/Tab and Escape while the list is open. Returns true when handled. */
export function completionKey(e: KeyboardEvent): boolean {
  const p = popup();
  if (!p) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = p.items.length;
    setPopup({ ...p, index: (p.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
    return true;
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
        <div class="completion" style={{ left: `${p().x}px`, top: `${p().y}px` }} onMouseDown={(e) => e.preventDefault()}>
          <For each={p().items}>
            {(item, i) => (
              <button
                class="completion-item"
                classList={{ on: i() === p().index }}
                onMouseEnter={() => setPopup({ ...p(), index: i() })}
                onClick={() => {
                  p().pick(item);
                  hideCompletions();
                }}
              >
                <span class="completion-glyph">{isTemplate(item) ? (item.label ?? item.insert) : item.insert}</span>
                <span class="completion-name">\{item.name}</span>
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
