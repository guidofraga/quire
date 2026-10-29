// A small panel at the pointer for editing something on the page in place: a plot's
// axis or series, a caption's label. Closes on Escape, a click outside, or Done.
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useModal } from "./a11y";

interface Open {
  x: number;
  y: number;
  title: string;
  body: () => JSX.Element;
}

const [popover, setPopover] = createSignal<Open | null>(null);

export function openPopover(e: MouseEvent, title: string, body: () => JSX.Element) {
  e.preventDefault();
  e.stopPropagation();
  setPopover({ x: e.clientX, y: e.clientY, title, body });
}

export const closePopover = () => setPopover(null);

export function PagePopover() {
  return (
    <Show when={popover()} keyed>
      {(p) => <Panel {...p} />}
    </Show>
  );
}

function Panel(props: Open) {
  let el!: HTMLDivElement;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
    }
  };
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) closePopover();
  };
  onMount(() => {
    // keep it in the window
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(props.y + 8, window.innerHeight - r.height - 8))}px`;
    el.querySelector<HTMLInputElement>("input, select")?.focus();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
  });
  useModal(() => el);
  return (
    <Portal>
      <div ref={el} class="page-popover insp-body" role="dialog" aria-modal="true" aria-label={props.title} style={{ left: `${props.x}px`, top: `${props.y + 8}px` }}>
        <div class="page-popover-head">
          <span>{props.title}</span>
          <button class="insp-mini" onClick={closePopover} aria-label="Close">
            ✕
          </button>
        </div>
        {props.body()}
        <div class="page-popover-foot">
          <button class="btn" onClick={closePopover}>
            Done
          </button>
        </div>
      </div>
    </Portal>
  );
}
