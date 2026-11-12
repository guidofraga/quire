// Solve blocks (docs/02-file-format.md §4.10): guess values, Given, the constraints, and a
// closing `find(x, y)` or `minerr(x, y)`, as one framed region. Each line is edited like a
// math region; the engine reports each as `<id>:g<n>`, `<id>:c<n>` and `<id>:f`.
import { createEffect, createSignal, Index, on, Show } from "solid-js";
import { type MathLine, MathEditor } from "./MathEditor";
import { mathml } from "./math";
import { nameMarks, solveWords } from "./describe";
import { spokenMath } from "./speech";
import {
  commitBelow,
  commitEditing,
  contentBottom,
  editClickPoint,
  findDraft,
  insertRegion,
  LINE,
  layout,
  mutate,
  noteTyping,
  onCommitEditing,
  setState,
  snap,
  splitShow,
  startEditing,
  state,
} from "./store";
import type { Region } from "./types";

export type LineKey = "guesses" | "given" | "find";

export interface LineRef {
  key: LineKey;
  index: number;
}

/** The report's id for a line of block `id`. */
export const lineId = (id: string, l: LineRef) =>
  l.key === "find" ? `${id}:f` : `${id}:${l.key === "guesses" ? "g" : "c"}${l.index}`;

const lines = (r: Region | undefined, key: "guesses" | "given"): string[] =>
  Array.isArray(r?.[key]) ? (r![key] as unknown[]).map((s) => (typeof s === "string" ? s : "")) : [];

/** What a block's find line reads while it is edited: `= ` for a shown result, as math lines do. */
const findText = (r: Region) =>
  String(r.find ?? "") + (r.show === "value" ? ` =${r.display?.unit ? ` ${r.display.unit}` : ""}` : "");

/** The line of a block being edited (while the block is `state.editing`). */
const [active, setActive] = createSignal<({ id: string } & LineRef) | null>(null);

const isActive = (id: string, l: LineRef) => {
  const a = active();
  return !!a && a.id === id && a.key === l.key && a.index === l.index;
};

/** The block's lines in order: guesses, constraints, find. */
function order(r: Region): LineRef[] {
  return [
    ...lines(r, "guesses").map((_, index) => ({ key: "guesses" as const, index })),
    ...lines(r, "given").map((_, index) => ({ key: "given" as const, index })),
    { key: "find", index: 0 },
  ];
}

const blockOf = (id: string) => {
  const r = layout().byId.get(id)?.region;
  return r?.kind === "solve" ? r : undefined;
};

/** Edit line `l` of block `id` (starting to edit the block if it isn't already). */
export function editLine(id: string, l: LineRef) {
  setActive({ id, ...l });
  if (state.editing !== id) startEditing(id);
}

/** Typing in a line: the block changes as typing goes (one undo step for the whole edit). */
function setLine(id: string, l: LineRef, text: string) {
  noteTyping();
  mutate((d) => {
    const r = findDraft(d, id);
    if (!r) return;
    if (l.key === "find") {
      const { expr, show, unit } = splitShow(text);
      r.find = expr;
      if (show === "value") r.show = "value";
      else delete r.show;
      if (unit) r.display = { ...r.display, unit };
      else if (r.display?.unit) {
        delete r.display.unit;
        if (!Object.keys(r.display).length) delete r.display;
      }
      return;
    }
    const list = lines(r, l.key);
    list[l.index] = text;
    r[l.key] = list;
  }, false);
}

/** A new empty line after `l` (in its own list), edited at once. */
function addLine(id: string, key: "guesses" | "given", at: number) {
  mutate((d) => {
    const r = findDraft(d, id);
    if (!r) return;
    const list = lines(r, key);
    list.splice(at, 0, "");
    r[key] = list;
  }, false);
  setActive({ id, key, index: at });
}

/** Empty guess and constraint lines go when the edit ends (or the line is left with Enter). */
function dropEmpty(id: string, keep?: LineRef) {
  const r = blockOf(id);
  if (!r) return;
  const empty = (key: "guesses" | "given") =>
    lines(r, key).some((s, i) => !s.trim() && !(keep?.key === key && keep.index === i));
  if (!empty("guesses") && !empty("given")) return;
  mutate((d) => {
    const draft = findDraft(d, id);
    if (!draft) return;
    for (const key of ["guesses", "given"] as const) {
      const list = lines(draft, key).filter((s, i) => s.trim() || (keep?.key === key && keep.index === i));
      if (list.length) draft[key] = list;
      else delete draft[key];
    }
  }, false);
}

// the edit of a block ends: its empty lines go, as an empty math line does
onCommitEditing(() => {
  const id = state.editing;
  if (!id || !blockOf(id)) return;
  dropEmpty(id);
  if (active()?.id === id) setActive(null);
});

/** Enter: a new line after a guess or constraint; on an empty one, on to the next part; on find, below. */
function enter(id: string, l: LineRef) {
  const r = blockOf(id);
  if (!r) return;
  if (l.key === "find") return commitBelow(id);
  const text = lines(r, l.key)[l.index] ?? "";
  if (text.trim()) return addLine(id, l.key, l.index + 1);
  // an empty line: it goes, and the next part of the block takes over
  const next: LineRef = l.key === "guesses" ? { key: "given", index: 0 } : { key: "find", index: 0 };
  const nextKey = next.key;
  dropEmpty(id);
  const after = blockOf(id);
  if (nextKey === "given" && after && !lines(after, "given").length) return addLine(id, "given", 0);
  setActive({ id, ...next });
}

/** Tab: the next line of the block (⇧Tab the one before); false past its ends. */
function tab(id: string, l: LineRef, by: 1 | -1): boolean {
  const r = blockOf(id);
  if (!r) return false;
  const all = order(r);
  const at = all.findIndex((x) => x.key === l.key && x.index === l.index);
  const next = all[at + by];
  if (!next) return false;
  setActive({ id, ...next });
  return true;
}

/** Insert ▸ Solve Block: a small worked example at the insertion point, ready to change. */
export function insertSolveBlock() {
  commitEditing();
  const at = state.caret ?? [36, snap(contentBottom() + LINE)];
  const id = insertRegion({
    kind: "solve",
    at,
    guesses: ["x := 1", "y := 1"],
    given: ["x^2 + y^2 == 4", "y == 2*x"],
    find: "[x; y] := find(x, y)",
    show: "value",
  });
  setState({ caret: null });
  editLine(id, { key: "given", index: 0 });
  return id;
}

function Line(props: { r: Region; at: LineRef; text: string }) {
  const id = () => props.r.id;
  const view = () => state.views[lineId(id(), props.at)];
  const editing = () => state.editing === id() && isActive(id(), props.at);
  const shows = () => props.at.key === "find" && props.r.show === "value";
  const rendered = () => {
    const v = view();
    return v?.input ? mathml(v.input, shows() ? v.result : null, v.units, v.constants, false, nameMarks(v)) : null;
  };
  // at the values found, whether a constraint holds
  const holds = () => (props.at.key === "given" && !view()?.error ? view()?.check : undefined);
  const words = () => {
    const v = view();
    if (!v?.input) return props.text;
    const verdict = holds() === undefined ? "" : holds() ? ", holds" : ", does not hold";
    return `${spokenMath(v.input, shows() ? v.result : null, v.units, v.constants)}${verdict}`;
  };
  const line: MathLine = {
    view: lineId(id(), props.at),
    owner: id(),
    text: props.at.key === "find" ? findText(props.r) : props.text,
    equation: props.at.key === "given",
    active: () => isActive(id(), props.at),
    onInput: (text) => setLine(id(), props.at, text),
    onEnter: () => enter(id(), props.at),
    onTab: (by) => tab(id(), props.at, by),
  };
  return (
    <div
      class="solve-line"
      classList={{ find: props.at.key === "find", editing: editing() }}
      data-line={lineId(id(), props.at)}
      onPointerDown={(e) => {
        // while the block is edited, a click moves between its lines without leaving the edit
        if (state.editing === id() && !editing()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={(e) => {
        if (state.editing !== id() || editing()) return;
        e.stopPropagation();
        setActive({ id: id(), ...props.at });
      }}
      onDblClick={(e) => {
        if (editing()) return;
        e.stopPropagation();
        editLine(id(), props.at);
      }}
    >
      <Show when={editing()}>
        <MathEditor r={{ id: line.view, kind: "math", at: [0, 0], expr: line.text }} line={line} />
      </Show>
      <div
        class="math-line"
        classList={{ preview: editing(), "check-pass": holds() === true, "check-fail": holds() === false }}
        aria-hidden={editing() || undefined}
      >
        <Show when={rendered()} fallback={<code class="raw">{props.text || " "}</code>}>
          <span class="sr-only">{words()}</span>
          <span class="m" innerHTML={rendered()!} aria-hidden="true" />
        </Show>
        <Show when={holds() !== undefined}>
          <span
            class="check-badge solve-check"
            aria-hidden="true"
            classList={{ pass: holds() === true, fail: holds() === false }}
            title={holds() ? "Holds at the values found" : "Does not hold at the values found"}
          >
            {holds() ? "✓" : "✗"}
          </span>
        </Show>
      </div>
      <Show when={view()?.error}>
        <div class="err">
          <span class="err-text">{view()!.error}</span>
        </div>
      </Show>
    </div>
  );
}

/** A small button that adds a line while the block is edited (not printed). */
function AddLine(props: { r: Region; key: "guesses" | "given"; label: string }) {
  return (
    <Show when={state.editing === props.r.id && !state.printing}>
      <button
        class="solve-add"
        onPointerDown={(e) => (e.preventDefault(), e.stopPropagation())}
        onClick={(e) => (e.stopPropagation(), addLine(props.r.id, props.key, lines(props.r, props.key).length))}
      >
        {props.label}
      </button>
    </Show>
  );
}

export function SolveBody(props: { r: Region }) {
  const r = () => props.r;
  const editing = () => state.editing === r().id;
  // editing started from outside (a double-click on the frame, Enter on the selected block):
  // the line under the click, else the first constraint
  createEffect(
    on(editing, (now) => {
      if (!now || active()?.id === r().id) return;
      const hit = editClickPoint && document.elementFromPoint(...editClickPoint)?.closest<HTMLElement>("[data-line]");
      const all = order(r());
      const picked = hit ? all.find((l) => lineId(r().id, l) === hit.dataset.line) : undefined;
      setActive({ id: r().id, ...(picked ?? all.find((l) => l.key === "given") ?? all[0]) });
    }),
  );
  const unknowns = () => /\(([^)]*)\)\s*$/.exec(String(r().find ?? ""))?.[1]?.trim() ?? "";
  // said once the block is evaluated: the solution, or why there is none
  const status = () => (editing() ? "" : solveWords(r().id));
  return (
    <div class="solve-block" role="group" aria-label={unknowns() ? `Solve block for ${unknowns()}` : "Solve block"}>
      <Index each={lines(r(), "guesses")}>
        {(text, index) => <Line r={r()} at={{ key: "guesses", index }} text={text()} />}
      </Index>
      <AddLine r={r()} key="guesses" label="+ Guess value" />
      <div class="solve-given" aria-hidden="true">
        Given
      </div>
      <Index each={lines(r(), "given")}>
        {(text, index) => <Line r={r()} at={{ key: "given", index }} text={text()} />}
      </Index>
      <AddLine r={r()} key="given" label="+ Constraint" />
      <Line r={r()} at={{ key: "find", index: 0 }} text={String(r().find ?? "")} />
      <div class="sr-only" aria-live="polite">
        {status()}
      </div>
    </div>
  );
}
