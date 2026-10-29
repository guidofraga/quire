import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { arrowFocus, fromKeyboard } from "./a11y";
import { closeMenu, menu } from "./menu";

export function ContextMenu() {
  let el: HTMLDivElement | undefined;
  // focus returns where it was when the menu closes (the toolbar button that opened it, say)
  let previous: HTMLElement | null = null;
  const items = () => (el ? [...el.querySelectorAll<HTMLElement>(".cm-item:not(:disabled)")] : []);
  createEffect(
    on(menu, (m, before) => {
      if (m && !before) {
        previous = document.activeElement as HTMLElement | null;
        // opened from the keyboard: the first item takes focus; with the mouse, focus stays put
        if (fromKeyboard()) queueMicrotask(() => items()[0]?.focus());
      } else if (!m && before) {
        const back = previous;
        previous = null;
        queueMicrotask(() => {
          const now = document.activeElement;
          if (back?.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
        });
      }
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if (!menu()) return;
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    }
    arrowFocus(e, items(), "vertical");
  };
  const onDown = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest(".context-menu")) closeMenu();
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", closeMenu);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("blur", closeMenu);
  });
  return (
    <Show when={menu()}>
      {(m) => (
        <div
          ref={el}
          class="context-menu"
          role="menu"
          style={{
            left: `${Math.min(m().x, window.innerWidth - 240)}px`,
            top: `${Math.min(m().y, window.innerHeight - 24 * m().items.length - 16)}px`,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={m().items}>
            {(item) =>
              item === null ? (
                <div class="cm-sep" role="separator" />
              ) : (
                <button
                  class="cm-item"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  tabIndex={-1}
                  disabled={item.disabled}
                  onClick={() => item.run?.()}
                >
                  <span class="cm-check" aria-hidden="true">
                    {item.checked ? "✓" : ""}
                  </span>
                  <span class="cm-label">{item.label}</span>
                  <span class="cm-shortcut">{item.shortcut ?? ""}</span>
                </button>
              )
            }
          </For>
        </div>
      )}
    </Show>
  );
}
