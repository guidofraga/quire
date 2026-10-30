// Insert ▸ Cross-Reference…: pick a heading, figure or table and how the reference reads.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useModal } from "./a11y";
import { activeView, commands, run as runText } from "./richtext";
import { type RefStyle, refText, type Target, targets } from "./xref";

export const [refPickerOpen, setRefPickerOpen] = createSignal(false);

const GROUP: Record<Target["kind"], string> = { heading: "Headings", figure: "Figures", table: "Tables" };

const STYLES: [RefStyle, string][] = [
  ["", "Figure 2"],
  ["num", "2"],
  ["page", "page 4"],
  ["title", "Caption text"],
];

export function RefPicker() {
  return (
    <Show when={refPickerOpen()}>
      <Dialog />
    </Show>
  );
}

function Dialog() {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [style, setStyle] = createSignal<RefStyle>("");
  const all = targets();
  const results = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = q ? all.filter((t) => `${refText(t.id) ?? ""} ${t.title}`.toLowerCase().includes(q)) : all;
    // headings first, then figures, then tables, each in reading order
    return (["heading", "figure", "table"] as const).flatMap((k) => list.filter((t) => t.kind === k));
  });
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const close = () => {
    setRefPickerOpen(false);
    activeView()?.focus();
  };
  const choose = (i: number) => {
    const t = results()[i];
    if (!t) return;
    setRefPickerOpen(false);
    runText(commands.insertRef(t.id, style()));
  };
  const move = (by: number) => {
    const n = results().length;
    if (!n) return;
    setActive((active() + by + n) % n);
    list.querySelector(`[data-i="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") choose(active());
    else return;
    e.preventDefault();
  };
  onMount(() => input.focus());
  let el!: HTMLDivElement;
  useModal(() => el);
  return (
    <div class="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Insert cross-reference" ref={el}>
        <input
          ref={input}
          class="palette-input"
          role="combobox"
          aria-label="Heading, figure or table"
          aria-expanded="true"
          aria-controls="ref-list"
          aria-autocomplete="list"
          aria-activedescendant={results().length ? `ref-item-${active()}` : undefined}
          placeholder="Reference a heading, figure or table"
          value={query()}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <div class="ref-styles" role="radiogroup" aria-label="The reference reads">
          <span class="ref-styles-label">Reads as</span>
          <For each={STYLES}>
            {([value, label]) => (
              <button
                class="ref-style"
                classList={{ on: style() === value }}
                role="radio"
                aria-checked={style() === value}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setStyle(value);
                  input.focus();
                }}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <div class="palette-list" ref={list} role="listbox" id="ref-list" aria-label="Targets">
          <For
            each={results()}
            fallback={
              <div class="palette-empty">
                {all.length
                  ? "Nothing matches"
                  : "Nothing to refer to yet: add a heading, or a caption to a figure or table."}
              </div>
            }
          >
            {(t, i) => (
              <>
                <Show when={i() === 0 || results()[i() - 1].kind !== t.kind}>
                  <div class="palette-group" aria-hidden="true">
                    {GROUP[t.kind]}
                  </div>
                </Show>
                <div
                  class="palette-item"
                  classList={{ active: i() === active() }}
                  id={`ref-item-${i()}`}
                  data-i={i()}
                  role="option"
                  aria-selected={i() === active()}
                  onPointerMove={() => setActive(i())}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(i())}
                >
                  <span class="palette-label">
                    {t.kind === "heading" ? `${t.number}  ${t.title}` : `${refText(t.id)}  ${t.title}`}
                  </span>
                  <span class="palette-hint">{refText(t.id, style())}</span>
                </div>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
