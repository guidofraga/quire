import { For, onCleanup, onMount, Show } from "solid-js";
import { closeMenu, menu } from "./menu";

export function ContextMenu() {
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
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
          class="context-menu"
          style={{
            left: `${Math.min(m().x, window.innerWidth - 240)}px`,
            top: `${Math.min(m().y, window.innerHeight - 24 * m().items.length - 16)}px`,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={m().items}>
            {(item) =>
              item === null ? (
                <div class="cm-sep" />
              ) : (
                <button class="cm-item" disabled={item.disabled} onClick={() => item.run?.()}>
                  <span class="cm-check">{item.checked ? "✓" : ""}</span>
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
