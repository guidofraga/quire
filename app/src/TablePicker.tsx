// Insert ▸ Table: Word's grid of squares. Point (or arrow) to the size, click (or Enter) to
// insert. Typing straight away inserts the default size and the text goes into its first cell.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

const MAX_COLS = 10;
const MAX_ROWS = 8;
export const DEFAULT_TABLE: [number, number] = [4, 3];

interface Open {
  x: number;
  y: number;
  pick: (rows: number, cols: number, typed?: string) => void;
}

const [picker, setPicker] = createSignal<Open | null>(null);
export const tablePickerOpen = () => picker() !== null;
export const closeTablePicker = () => setPicker(null);

/** Open the picker under an element (the toolbar button), at a point, or in the middle of the window. */
export function openTablePicker(anchor: Element | { x: number; y: number } | null, pick: Open["pick"]) {
  let x = window.innerWidth / 2 - 110;
  let y = window.innerHeight / 3;
  if (anchor instanceof Element) {
    const b = anchor.getBoundingClientRect();
    [x, y] = [b.left, b.bottom + 4];
  } else if (anchor) [x, y] = [anchor.x, anchor.y];
  setPicker({ x, y, pick });
}

export function TablePicker() {
  return (
    <Show when={picker()} keyed>
      {(p) => <Grid {...p} />}
    </Show>
  );
}

function Grid(props: Open) {
  let el!: HTMLDivElement;
  const [size, setSize] = createSignal<[number, number]>([...DEFAULT_TABLE]);
  const done = (rows: number, cols: number, typed?: string) => {
    closeTablePicker();
    props.pick(rows, cols, typed);
  };
  const onKey = (e: KeyboardEvent) => {
    const [r, c] = size();
    const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (step[e.key]) {
      const [dr, dc] = step[e.key];
      setSize([Math.max(1, Math.min(MAX_ROWS, r + dr)), Math.max(1, Math.min(MAX_COLS, c + dc))]);
    } else if (e.key === "Enter" || e.key === " ") done(r, c);
    else if (e.key === "Escape") closeTablePicker();
    else if (e.key === "Tab") closeTablePicker();
    // typing right away: a table of the size shown, the text in its first cell
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) done(r, c, e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) closeTablePicker();
  };
  onMount(() => {
    const b = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - b.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(props.y, window.innerHeight - b.height - 8))}px`;
    // at once: typing can follow the click that opened it immediately
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
  });
  const rows = Array.from({ length: MAX_ROWS }, (_, i) => i + 1);
  const cols = Array.from({ length: MAX_COLS }, (_, j) => j + 1);
  return (
    <Portal>
      <div
        ref={el}
        class="table-picker"
        role="dialog"
        aria-label="Insert table"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
        onPointerDown={(e) => e.preventDefault()}
      >
        <div class="table-picker-title" aria-live="polite">
          {size()[1]} × {size()[0]} Table
        </div>
        <div class="table-picker-grid" role="grid" aria-label="Columns × rows">
          <For each={rows}>
            {(i) => (
              <div class="table-picker-row" role="row">
                <For each={cols}>
                  {(j) => (
                    <button
                      class="table-picker-cell"
                      classList={{ on: i <= size()[0] && j <= size()[1] }}
                      role="gridcell"
                      tabIndex={-1}
                      aria-label={`${j} × ${i}`}
                      data-size={`${i}x${j}`}
                      onPointerEnter={() => setSize([i, j])}
                      onClick={() => done(i, j)}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <div class="table-picker-hint">Arrows choose · Enter inserts · or just start typing</div>
      </div>
    </Portal>
  );
}
