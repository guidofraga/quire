// The find bar over the top-right of the canvas.
import { Show } from "solid-js";
import {
  currentHit,
  findOpen,
  findStep,
  hits,
  matchCase,
  occurrences,
  query,
  replaceHits,
  replaceOpen,
  replacement,
  setFindOpen,
  setMatchCase,
  setQuery,
  setReplaceOpen,
  setReplacement,
  setWholeWord,
  wholeWord,
} from "./find";
import { revealRegion, setState } from "./store";

export function FindBar() {
  const close = () => setFindOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && e.target === findInput) {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      replaceOne();
    }
  };
  let findInput!: HTMLInputElement;
  const status = () => {
    if (!query()) return "";
    const n = hits().length;
    if (!n) return "Not found";
    const i = currentHit();
    return i < 0 ? `${n} ${n === 1 ? "region" : "regions"}` : `${i + 1} of ${n}`;
  };
  const say = (n: number) => setState({ message: n ? `Replaced ${n} ${n === 1 ? "occurrence" : "occurrences"}` : "Nothing to replace" });
  // the selected match first, then on to the next one
  const replaceOne = () => {
    const list = hits();
    const i = currentHit();
    if (i < 0) return findStep(1);
    const next = list.length > 1 ? list[(i + 1) % list.length].id : null;
    replaceHits([list[i].id]);
    if (next) revealRegion(next);
  };
  return (
    <Show when={findOpen()}>
      <div class="findbar" role="search" onKeyDown={onKey}>
        <div class="find-row">
          <button
            class="find-toggle"
            classList={{ on: replaceOpen() }}
            onClick={() => setReplaceOpen(!replaceOpen())}
            title="Show replace"
            aria-label="Show replace"
          >
            {replaceOpen() ? "▾" : "▸"}
          </button>
          <input
            ref={findInput}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Find in math and text"
            spellcheck={false}
          />
          <span class="find-status" title={query() ? `${occurrences()} occurrences` : ""}>
            {status()}
          </span>
          <button class="find-opt" classList={{ on: matchCase() }} onClick={() => setMatchCase(!matchCase())} title="Match case">
            Aa
          </button>
          <button class="find-opt" classList={{ on: wholeWord() }} onClick={() => setWholeWord(!wholeWord())} title="Whole names only">
            <u>ab</u>
          </button>
          <button class="find-nav" onClick={() => findStep(-1)} disabled={!hits().length} title="Previous (⇧↩)">
            ‹
          </button>
          <button class="find-nav" onClick={() => findStep(1)} disabled={!hits().length} title="Next (↩)">
            ›
          </button>
          <button class="find-nav" onClick={close} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>
        <Show when={replaceOpen()}>
          <div class="find-row">
            <span class="find-toggle" />
            <input
              value={replacement()}
              onInput={(e) => setReplacement(e.currentTarget.value)}
              placeholder="Replace with"
              spellcheck={false}
            />
            <button class="find-act" onClick={replaceOne} disabled={!hits().length} title="Replace in the selected region (↩)">
              Replace
            </button>
            <button
              class="find-act"
              onClick={() => say(replaceHits(hits().map((h) => h.id)))}
              disabled={!hits().length}
              title="Replace everywhere (one undo step)"
            >
              All
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
