// The notebook sidebar's two dialogs: the confirmation before items go to the Trash, and
// Move to…, a picker of sections for when dragging is awkward (long trees, the keyboard).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useModal } from "./a11y";
import { find, moveItems, nb, type NbNode, parentOf, topmost, trashItems, walk, within } from "./notebook";

/** The items waiting for a yes before they go to the Trash. */
export const [trashAsk, setTrashAsk] = createSignal<string[] | null>(null);
/** The items Move to… is choosing a section for. */
export const [moveAsk, setMoveAsk] = createSignal<string[] | null>(null);

/** Ask before moving the items to the Trash (one question for any number of them). */
export const askTrash = (rels: string[]) => {
  const items = topmost(rels);
  if (items.length) setTrashAsk(items);
};

export const askMove = (rels: string[]) => {
  const items = topmost(rels);
  if (items.length) setMoveAsk(items);
};

const countNotes = (n: NbNode): number =>
  (n.children ?? []).reduce((s, c) => s + (c.kind === "note" ? 1 : countNotes(c)), 0);

/** "Mechanics and the 4 notes in it", "Newton". */
function whatGoes(rel: string): { name: string; more: string } {
  const n = find(rel);
  if (!n) return { name: rel, more: "" };
  if (n.kind === "note") return { name: n.name, more: "" };
  const c = countNotes(n);
  return {
    name: n.name,
    more: c === 0 ? "empty section" : c === 1 ? "section with 1 note" : `section with ${c} notes`,
  };
}

/** Esc closes, as everywhere; captured first so the page and the tree don't see it. */
function useEscape(close: () => void) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
}

/** Focus goes back to the tree's row for the item once a dialog closes. */
function refocus(rel: string | undefined) {
  if (!rel) return;
  setTimeout(() => document.querySelector<HTMLElement>(`.nb-tree [data-rel="${CSS.escape(rel)}"]`)?.focus());
}

export function SidebarDialogs() {
  return (
    <>
      <Show when={trashAsk()}>{(items) => <ConfirmTrash items={items()} />}</Show>
      <Show when={moveAsk()}>{(items) => <MovePicker items={items()} />}</Show>
    </>
  );
}

function ConfirmTrash(props: { items: string[] }) {
  const items = props.items;
  const one = items.length === 1 ? whatGoes(items[0]) : null;
  const shown = items.slice(0, 6);
  const notesIn = one && find(items[0])?.kind === "section" ? countNotes(find(items[0])!) : 0;
  const explain = !one
    ? "You can put them back from the Trash."
    : notesIn
      ? `The ${notesIn === 1 ? "note" : `${notesIn} notes`} in it ${notesIn === 1 ? "goes" : "go"} too. You can put everything back from the Trash.`
      : "You can put it back from the Trash.";
  const close = () => {
    setTrashAsk(null);
    refocus(nb.current ?? undefined);
  };
  const go = () => {
    setTrashAsk(null);
    void trashItems(items).then(() => refocus(nb.current ?? undefined));
  };
  useEscape(close);
  let el!: HTMLDivElement;
  useModal(() => el);
  return (
    <Portal>
      <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div
          class="settings nb-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="nb-trash-title"
          aria-describedby="nb-trash-text"
          ref={el}
        >
          <div class="nb-dialog-body">
            <div class="nb-dialog-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M4 6h14M9 6V4.2h4V6M5.6 6l.9 12h9l.9-12" stroke-linejoin="round" stroke-linecap="round" />
                <path d="M9.2 9.5v5.5M12.8 9.5v5.5" stroke-linecap="round" />
              </svg>
            </div>
            <div>
              <h2 id="nb-trash-title">
                {one ? `Move “${one.name}” to the Trash?` : `Move ${items.length} items to the Trash?`}
              </h2>
              <p id="nb-trash-text">{explain}</p>
              <Show when={!one}>
                <ul class="nb-dialog-list">
                  <For each={shown}>
                    {(rel) => {
                      const w = whatGoes(rel);
                      return (
                        <li>
                          <span class="nb-dialog-name">{w.name}</span>
                          <Show when={w.more}>
                            <span class="nb-dialog-more">{w.more}</span>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                  <Show when={items.length > shown.length}>
                    <li class="nb-dialog-more">and {items.length - shown.length} more</li>
                  </Show>
                </ul>
              </Show>
            </div>
          </div>
          <footer class="nb-dialog-foot">
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button class="btn danger" onClick={go} autofocus>
              Move to Trash
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

interface Choice {
  rel: string;
  name: string;
  depth: number;
  /** Where the items already are. */
  here: boolean;
  /** Inside an item being moved. */
  blocked: boolean;
  color?: string;
}

function MovePicker(props: { items: string[] }) {
  const items = props.items;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const all = (): Choice[] => {
    const here = (to: string) => items.every((r) => parentOf(r) === to);
    const blocked = (to: string) => items.some((r) => within(to, r));
    const top: Choice = { rel: "", name: nb.book?.name ?? "Notebook", depth: 0, here: here(""), blocked: false };
    return [
      top,
      ...walk()
        .filter((n) => n.kind === "section")
        .map((n) => ({
          rel: n.rel,
          name: n.name,
          depth: n.rel.split("/").length,
          here: here(n.rel),
          blocked: blocked(n.rel),
          color: n.color,
        })),
    ];
  };
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const choices = createMemo(() => {
    const q = fold(query().trim());
    return all().filter((c) => !c.blocked && (!q || fold(c.name).includes(q) || fold(c.rel).includes(q)));
  });
  const close = () => {
    setMoveAsk(null);
    refocus(items[0]);
  };
  const pick = (c: Choice | undefined) => {
    if (!c) return;
    setMoveAsk(null);
    if (c.here) return refocus(items[0]);
    void moveItems(items, c.rel).then((now) => refocus(now?.[0] ?? items[0]));
  };
  useEscape(close);
  let el!: HTMLDivElement;
  let list!: HTMLUListElement;
  useModal(() => el);
  const show = (i: number) => {
    const n = choices().length;
    if (!n) return;
    setActive((i + n) % n);
    list.querySelector(`#nb-move-${active()}`)?.scrollIntoView({ block: "nearest" });
  };
  const title =
    items.length === 1 ? `Move “${find(items[0])?.name ?? items[0]}” to…` : `Move ${items.length} items to…`;
  return (
    <Portal>
      <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div class="settings nb-dialog nb-move" role="dialog" aria-modal="true" aria-label={title} ref={el}>
          <header role="none">
            <h2>{title}</h2>
            <button class="settings-close" onClick={close} aria-label="Close">
              ✕
            </button>
          </header>
          <div class="nb-move-search">
            <svg
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              aria-hidden="true"
            >
              <circle cx="5.6" cy="5.6" r="3.9" />
              <path d="M8.6 8.6l2.9 2.9" stroke-linecap="round" />
            </svg>
            <input
              type="text"
              placeholder="Find a section"
              aria-label="Find a section"
              role="combobox"
              aria-expanded="true"
              aria-controls="nb-move-list"
              aria-activedescendant={choices().length ? `nb-move-${active()}` : undefined}
              autofocus
              spellcheck={false}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") show(active() + 1);
                else if (e.key === "ArrowUp") show(active() - 1);
                else if (e.key === "Enter") pick(choices()[active()]);
                else return;
                e.preventDefault();
              }}
            />
          </div>
          <ul class="nb-move-list" id="nb-move-list" role="listbox" aria-label="Sections" ref={list}>
            <For each={choices()} fallback={<li class="nb-move-none">No section is called “{query().trim()}”.</li>}>
              {(c, i) => (
                <li
                  id={`nb-move-${i()}`}
                  role="option"
                  aria-selected={active() === i()}
                  aria-disabled={c.here || undefined}
                  classList={{ active: active() === i(), here: c.here }}
                  style={{ "padding-left": `${12 + (query().trim() ? 0 : c.depth) * 16}px` }}
                  onPointerMove={() => setActive(i())}
                  onClick={() => pick(c)}
                >
                  <Show
                    when={c.rel}
                    fallback={
                      <svg
                        class="nb-move-book"
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.2"
                        aria-hidden="true"
                      >
                        <path
                          d="M2.5 2.2h7.2a1.3 1.3 0 0 1 1.3 1.3v8.3H3.8a1.3 1.3 0 0 1-1.3-1.3z"
                          stroke-linejoin="round"
                        />
                        <path d="M2.5 10.5a1.3 1.3 0 0 1 1.3-1.3H11" />
                      </svg>
                    }
                  >
                    <span class="nb-dot" style={{ background: c.color ?? "var(--nb-section)" }} aria-hidden="true" />
                  </Show>
                  <span class="nb-move-name">{c.name}</span>
                  <Show when={query().trim() && c.rel.includes("/")}>
                    <span class="nb-move-path">{c.rel.split("/").slice(0, -1).join(" › ")}</span>
                  </Show>
                  <Show when={c.here}>
                    <span class="nb-move-here">{items.length === 1 ? "Here now" : "They're here"}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </Portal>
  );
}
