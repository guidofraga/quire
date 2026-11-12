import { MathEditor } from "./MathEditor";
import type { EditorView } from "prosemirror-view";
import { hitIds } from "./find";
import { trace } from "./trace";
import { fillRefs } from "./xref";
import { type Check, checks, failing, isComparison, mathCheck, regionOf, tableName } from "./checks";
import { captionLabel, defaultLabel, labelKey, labelPattern } from "./labels";
import { openPopover } from "./Popover";
import { Field, Text as InspText } from "./Inspector";
import { DEFAULT_SIZE, editPlot, insertPlot, PlotBody } from "./Plot";
import { DEFAULT_SIZE_3D, editPlot3d, Plot3DBody } from "./Plot3D";
import { editTableAt, isSheet, SheetGrid } from "./TableEditor";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { produce } from "solid-js/store";
import { api, isMac } from "./api";
import { SHEET_GAP } from "./pages";
import { cellHtml, esc, mathml, prettyValue } from "./math";
import { mathWords, nameMarks } from "./describe";
import { spokenMath } from "./speech";
import { closeMenu, type MenuItems, openRegionMenu, setMenu } from "./menu";
import { createEditor, isLiteral, placeCaret, plainText, releaseEditor } from "./richtext";
import {
  AREA_COLLAPSED_HEIGHT,
  availableWidth,
  checkpoint,
  commitBelow,
  commitEditing,
  type Cuts,
  cuts,
  convertEditing,
  editClickPoint,
  editText,
  findDraft,
  GRID,
  heights,
  isPageView,
  layout,
  localized,
  noteRoom,
  type Part,
  type Placed,
  renameIn,
  revealRegion,
  scheduleGrowth,
  setCuts,
  setHeights,
  setLive,
  setState,
  setWidths,
  SPLIT_SHARE,
  startEditing,
  state,
  toggleArea,
  updateDoc,
  updateRegion,
  widths,
  withLocalized,
} from "./store";
import type { Expr, Fix, Region } from "./types";

export interface RegionProps {
  region: Region;
  onDragStart: (id: string, e: PointerEvent) => void;
}

const pt = (n: number | undefined, fallback: number) => `${n ?? fallback}pt`;

/** Apply Djot attributes the HTML renderer leaves as plain attributes ({size=12 font="Arial"}). */
function applyDjotAttributes(el: HTMLElement) {
  for (const node of el.querySelectorAll<HTMLElement>("[size],[font],[color]")) {
    const size = node.getAttribute("size");
    if (size && /^[\d.]+$/.test(size)) node.style.fontSize = `${size}pt`;
    const font = node.getAttribute("font");
    if (font) node.style.fontFamily = `"${font.replace(/"/g, "")}"`;
    const color = node.getAttribute("color");
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) node.style.color = color;
  }
}

/** Typeset the live inline math placeholders (`$`expr``) inside rendered text. */
function fillInlineMath(el: HTMLElement) {
  for (const span of el.querySelectorAll<HTMLElement>("[data-math]")) {
    const v = state.views[span.dataset.math!];
    span.classList.toggle("inline-error", !!v?.error);
    span.title = v?.error ?? "";
    span.innerHTML = v?.input
      ? mathml(v.input, v.result, v.units, v.constants, v.symbolic)
      : `<code class="raw">?</code>`;
    // read as words, not as the MathML
    if (v?.input) span.setAttribute("aria-label", spokenMath(v.input, v.result, v.units, v.constants, v.symbolic));
    span.setAttribute("role", "img");
  }
}

function Html(props: { html: string | undefined; class?: string }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    el.innerHTML = props.html ?? "";
    applyDjotAttributes(el);
    fillInlineMath(el);
    // this effect also reruns when results arrive, and rewriting the HTML empties the
    // references: fill them again here, without making the text depend on the numbering
    untrack(() => fillRefs(el));
  });
  // references follow the numbering without re-rendering the text
  createEffect(() => {
    void props.html;
    fillRefs(el);
  });
  return <div ref={el} class={props.class} />;
}

function captionPrefix(r: Region, number: string | undefined): string {
  return number ? `${captionLabel(r.kind === "table" ? "table" : "figure", number)} ` : "";
}

/** Double-click a caption's "Figure 3 –": what every figure (or table) caption says. */
function editCaptionLabel(e: MouseEvent, kind: "figure" | "table") {
  const key = labelKey(kind);
  const set = (v: string) =>
    updateDoc((d) => {
      d.styles = { ...d.styles, numbering: { ...d.styles?.numbering, [key]: v || undefined } };
    });
  openPopover(e, kind === "table" ? "Table captions" : "Figure captions", () => (
    <>
      <Field label="Every caption reads" hint="{n} is the number, e.g. Figura {n} –">
        <InspText value={labelPattern(kind)} placeholder={defaultLabel(kind)} onCommit={set} />
      </Field>
      <div class="insp-hint">Empty follows the document's language. Also in Document ▸ Numbering.</div>
    </>
  ));
}

/** A caption to start editing as soon as it appears (right after Add Caption). */
export const [captionToEdit, setCaptionToEdit] = createSignal<string | null>(null);

/** `hidden`: kept for the region's size but not shown (a split table's first part), not printed. */
function Caption(props: { p: Placed; hidden?: boolean }) {
  const r = () => props.p.region;
  const [editing, setEditing] = createSignal(false);
  createEffect(() => {
    if (captionToEdit() === r().id && r().caption) {
      setCaptionToEdit(null);
      setEditing(true);
    }
  });
  const lang = () => state.doc.meta?.lang;
  const commit = (text: string) => {
    setEditing(false);
    const caption = r().caption;
    if (!caption || text === localized(caption.text, lang())) return;
    // a caption in several languages keeps the others
    updateRegion(r().id, { caption: { ...caption, text: withLocalized(caption.text, text, lang()) } });
  };
  return (
    <Show when={r().caption}>
      <div
        class="caption"
        style={props.hidden ? (state.printing ? { display: "none" } : { visibility: "hidden" }) : undefined}
      >
        <span
          class="caption-num"
          title="Double-click to rename all"
          onDblClick={(e) => editCaptionLabel(e, r().kind === "table" ? "table" : "figure")}
        >
          {captionPrefix(r(), props.p.number)}
        </span>
        <Show
          when={editing()}
          fallback={
            <span
              class="caption-edit-target"
              title="Double-click to edit"
              onDblClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              <Html html={state.report?.html[`${r().id}:caption`]} class="caption-text" />
            </span>
          }
        >
          <input
            class="caption-input"
            value={localized(r().caption!.text, lang())}
            size={Math.max(12, localized(r().caption!.text, lang()).length + 2)}
            spellcheck={true}
            aria-label="Caption"
            // after the menu that opened it has closed and handed focus back to the page
            ref={(el) => setTimeout(() => (el.focus(), el.select()), 60)}
            onPointerDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onInput={(e) => (e.currentTarget.size = Math.max(12, e.currentTarget.value.length + 2))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit(e.currentTarget.value.trim());
              else if (e.key === "Escape") setEditing(false);
            }}
            onBlur={(e) => editing() && commit(e.currentTarget.value.trim())}
          />
        </Show>
      </div>
    </Show>
  );
}

function RichTextEditor(props: { p: Placed; style: Record<string, string | undefined> }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const id = untrack(() => props.p.region.id);
  onCleanup(() => view && releaseEditor(view));
  onMount(async () => {
    const src = untrack(() => editText(props.p.region));
    // plain text (e.g. just switched from math) opens instantly; markup goes through the parser
    const plain = !/[\\*_[\]{}`~^$<>#|-]|^\s*\d+\./.test(src) && isLiteral(src);
    const html = plain ? null : await api.djotHtml(src).catch(() => "");
    if (state.editing !== id) return;
    view = createEditor(host, html ?? { text: src }, {
      onChange: (djot) => setLive(id, djot),
      onExit: (below) => (below ? commitBelow(id) : commitEditing()),
      onKey: (v, e) => {
        // "Area" + space became text, then ":" — it was a definition after all
        if (state.editingFresh && (e.key === ":" || e.key === "=") && !e.metaKey) {
          const word = plainText(v).trim();
          if (/^[\p{L}][\p{L}\p{N}_.]*$/u.test(word)) {
            e.preventDefault();
            convertEditing("math", `${word} ${e.key === ":" ? ":=" : "="}`);
            return true;
          }
        }
        return false;
      },
    });
    if (editClickPoint) placeCaret(view, ...editClickPoint);
  });
  return <div ref={host} class="text-body rich-host" style={props.style} />;
}

/** The engine's repair for an error, one click away. */
function FixButton(props: { id: string; fix: Fix }) {
  const label = () => (props.fix.kind === "rename" ? `Use ${props.fix.to}` : "Show definition");
  return (
    <button
      class="err-fix"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const f = props.fix;
        if (f.kind === "rename") renameIn(props.id, f.from, f.to);
        else revealRegion(f.id);
      }}
    >
      {label()}
    </button>
  );
}

/** `noteWidth`: the room for the error note (see noteRoom). */
function MathBody(props: { r: Region; noteWidth: () => number }) {
  const view = () => state.views[props.r.id];
  const editing = () => state.editing === props.r.id;
  // a check: a comparison reads ✓ / ✗ instead of = 1 / = 0; an OK / FAIL result is coloured
  const check = () => mathCheck(props.r, view());
  const comparison = () => check() !== null && isComparison(view()?.input);
  const rendered = () => {
    const v = view();
    const result = props.r.show && !comparison() ? v?.result : null;
    return v?.input ? mathml(v.input, result, v.units, v.constants, props.r.show === "symbolic", nameMarks(v)) : null;
  };
  return (
    <>
      <Show when={editing()}>
        <MathEditor r={props.r} />
      </Show>
      <div
        class="math-line"
        classList={{ preview: editing(), "check-pass": check() === true, "check-fail": check() === false }}
        aria-hidden={editing() || undefined}
      >
        <Show when={rendered()} fallback={<code class="raw">{props.r.expr || " "}</code>}>
          {/* screen readers get the formula in words; the MathML would be read symbol by symbol */}
          <span class="sr-only">{mathWords(props.r.id, false)}</span>
          <span class="m" innerHTML={rendered()!} aria-hidden="true" />
        </Show>
        <Show when={comparison()}>
          <span
            class="check-badge"
            aria-hidden="true"
            classList={{ pass: check() === true, fail: check() === false }}
            title={check() ? "This check passes" : "This check fails"}
          >
            {check() ? "✓" : "✗ fails"}
          </span>
        </Show>
        <Show when={props.r.note && !editing()}>
          <Html html={state.report?.html[`${props.r.id}:note`]} class="note" />
        </Show>
      </div>
      <Show when={view()?.error}>
        <div class="err" style={{ "max-width": `${props.noteWidth()}px` }}>
          <span class="err-text">{view()!.error}</span>
          <Show when={!editing() && view()?.fix}>{(fix) => <FixButton id={props.r.id} fix={fix()} />}</Show>
        </div>
      </Show>
    </>
  );
}

/** A text region; `static`: as it reads, also while it is being edited (a later part of it). */
function TextBody(props: { p: Placed; static?: boolean }) {
  const r = () => props.p.region;
  const style = () => ({
    "font-family": r().style?.font ?? state.doc.styles?.body?.font,
    "font-size": pt(r().style?.size, state.doc.styles?.body?.size ?? 10),
    // aligned text needs the full width to align within; plain text hugs its content
    width: r().width
      ? `${r().width}px`
      : /\{[^}\n]*\.(center|right|justify)\b/.test(localized(r().text, state.doc.meta?.lang))
        ? `${availableWidth(props.p.x)}px`
        : undefined,
    // unsized text wraps at the page edge
    "max-width": r().width ? undefined : `${availableWidth(props.p.x)}px`,
    "--num": props.p.number && state.doc.styles?.numbering?.headings !== "" ? `"${props.p.number}. "` : undefined,
  });
  return (
    <Show
      when={state.editing !== r().id || props.static}
      fallback={<RichTextEditor p={props.p} style={{ ...style(), "min-width": "160px", "white-space": "normal" }} />}
    >
      <div style={style()} class="text-wrap" classList={{ fixed: !!r().width }}>
        <Show
          when={state.report?.html[r().id] !== undefined}
          fallback={<div class="text-body">{localized(r().text, state.doc.meta?.lang)}</div>}
        >
          <Html html={state.report?.html[r().id]} class="text-body" />
        </Show>
      </div>
    </Show>
  );
}

function ImageBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const size = () => r().size ?? [200, 150];
  const url = () => (r().src ? state.assets[r().src!] : undefined);
  return (
    <figure class="figure" style={{ width: `${size()[0]}px` }}>
      <Show when={r().caption?.position === "above"}>
        <Caption p={props.p} />
      </Show>
      <Show
        when={url()}
        fallback={<div class="img-missing" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }} />}
      >
        <img src={url()} width={size()[0]} height={size()[1]} draggable={false} alt={r().caption ? "" : "Image"} />
      </Show>
      <Show when={r().caption?.position !== "above"}>
        <Caption p={props.p} />
      </Show>
    </figure>
  );
}

/** A plot as a figure: captioned like an image, with its error below. */
function PlotFigure(props: { p: Placed; selected: boolean }) {
  const r = () => props.p.region;
  const error = () => state.views[r().id]?.error;
  const three = () => r().kind === "plot3d";
  return (
    <figure
      class="figure plot-figure"
      style={{ width: `${(r().size ?? (three() ? DEFAULT_SIZE_3D : DEFAULT_SIZE))[0]}px` }}
    >
      <Show when={r().caption?.position === "above"}>
        <Caption p={props.p} />
      </Show>
      <Show when={three()} fallback={<PlotBody r={r()} />}>
        <Plot3DBody r={r()} selected={props.selected} />
      </Show>
      <Show when={error()}>
        <div class="err" title={error()!}>
          <span class="err-text">{error()}</span>
        </div>
      </Show>
      <Show when={r().caption?.position !== "above"}>
        <Caption p={props.p} />
      </Show>
    </figure>
  );
}

/**
 * An area's band: the printable column in page view. On the free canvas it starts as wide as
 * the column and reaches on to hold what is placed inside it further right.
 */
function areaWidth(p: Placed): number {
  const l = layout();
  if (l.pageView) return l.geom.contentW;
  let right = l.geom.contentW;
  for (const q of l.list) {
    let inside = false;
    for (let a = q.parent; a && !inside; a = l.byId.get(a.id)?.parent ?? null) inside = a.id === p.region.id;
    if (inside && !q.hidden) right = Math.max(right, q.x - p.x + (widths[q.region.id] ?? 0) + GRID);
  }
  return right;
}

function AreaBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const height = () => (r().collapsed ? AREA_COLLAPSED_HEIGHT : (r().height ?? 90));
  return (
    <div
      class="area"
      classList={{ collapsed: !!r().collapsed }}
      style={{ width: `${areaWidth(props.p)}px`, height: `${height()}px` }}
    >
      <div class="area-header">
        <button
          class="disclosure"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleArea(r().id)}
          title={r().collapsed ? "Expand" : "Collapse"}
          aria-label={r().collapsed ? "Expand area" : "Collapse area"}
          aria-expanded={!r().collapsed}
        >
          {r().collapsed ? "▸" : "▾"}
        </button>
        <Html html={state.report?.html[`${r().id}:title`]} class="area-title" />
      </div>
    </div>
  );
}

/** The first row a cut at `off` px starts (`Cuts.rows`); `n` (past the last) for the region's end. */
const rowAt = (c: Cuts | undefined, off: number, n: number) => {
  const k = c?.at.indexOf(off) ?? -1;
  return k >= 0 && c?.rows ? c.rows[k] : n;
};

/**
 * A table, whole or, split across pages, as one of its parts (`part`, from 0): the first part is
 * the whole table with the rows of the later parts kept hidden, a later one draws only its own
 * rows under the header row (`SheetGrid`).
 */
function TableBody(props: { p: Placed; part?: number }) {
  const r = () => props.p.region;
  const view = () => state.views[r().id];
  const rows = (): Expr[][] | null => {
    const res = view()?.result;
    return res?.t === "Matrix" ? res.c : null;
  };
  const n = () => (isSheet(r()) ? ((r().rows as unknown[] | undefined)?.length ?? 0) : (rows()?.length ?? 0));
  const parts = () => props.p.parts;
  const later = props.part !== undefined && props.part > 0;
  /** A later part's rows: first, past last. */
  const span = (): [number, number] | undefined => {
    const q = parts()?.[props.part ?? 0];
    if (!later || !q) return undefined;
    const c = cuts[r().id];
    return [rowAt(c, q.from, n()), rowAt(c, q.to, n())];
  };
  /** The first part: the first row the later parts draw (hidden here). */
  const ghostFrom = () => {
    const q = parts()?.[1];
    return !later && q ? rowAt(cuts[r().id], q.from, n()) : undefined;
  };
  const isLast = () => !parts() || props.part === parts()!.length - 1;
  const boundRows = () => {
    const all = rows()!.map((row, i) => ({ row, i }));
    const sp = span();
    // printed, the first part draws only its own rows: nothing runs on past its page
    const g = ghostFrom();
    if (!sp) return g !== undefined && state.printing ? all.slice(0, g) : all;
    const shown = all.slice(sp[0], sp[1]);
    return r().header?.row && sp[0] > 0 ? [{ ...all[0], repeat: true }, ...shown] : shown;
  };
  const BoundTable = () => (
    <Show
      when={rows()}
      fallback={
        <div class="placeholder-box" style={{ width: `${r().size?.[0] ?? 300}px` }}>
          Table of <code>{r().source ?? "—"}</code>
          <Show when={view()?.error}>
            <div class="err">{view()!.error}</div>
          </Show>
        </div>
      }
    >
      <table
        class="table"
        classList={{ "head-row": !!r().header?.row, "head-col": !!r().header?.column }}
        style={
          later && cuts[r().id]?.cols?.length
            ? { "table-layout": "fixed", width: `${cuts[r().id]!.cols!.reduce((a, b) => a + b, 0)}px` }
            : undefined
        }
      >
        <Show when={later && cuts[r().id]?.cols?.length}>
          <colgroup>
            <For each={cuts[r().id]!.cols!}>{(w) => <col style={{ width: `${w}px` }} />}</For>
          </colgroup>
        </Show>
        <tbody>
          <For each={boundRows()}>
            {(row) => (
              <tr
                classList={{ ghost: (ghostFrom() ?? Infinity) <= row.i, repeat: "repeat" in row }}
                aria-hidden={(ghostFrom() ?? Infinity) <= row.i || "repeat" in row || undefined}
              >
                <For each={row.row}>{(cell) => <td innerHTML={cellHtml(cell)} />}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
  return (
    <figure class="figure">
      <Show when={r().caption?.position === "above" && !later}>
        <Caption p={props.p} />
      </Show>
      <Show when={isSheet(r())} fallback={BoundTable()}>
        <SheetGrid p={props.p} ghostFrom={ghostFrom()} rows={later ? (span() ?? [0, 0]) : undefined} />
      </Show>
      {/* below a split table, on its last page; the first part keeps it (hidden) for its size */}
      <Show when={r().caption?.position !== "above" && (later ? isLast() : true)}>
        <Caption p={props.p} hidden={!later && !!parts()} />
      </Show>
    </figure>
  );
}

const textOf = (html: string | undefined) =>
  new DOMParser().parseFromString(html ?? "", "text/html").body.textContent?.trim() ?? "";

/** The text of the first heading in rendered text (a region may hold more after it). */
const headingOf = (html: string | undefined) => {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html");
  return (doc.querySelector("h1, h2, h3, h4, h5, h6") ?? doc.body).textContent?.trim() ?? "";
};

/** Insert ▸ Summary of Checks: every check, ✓ or ✗, kept current. */
function ChecksBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const start = () => (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
  const summary = () => {
    const f = failing().length;
    const n = checks().length;
    return f ? `${f} of ${n} failing` : n === 1 ? "1 check, passing" : `All ${n} checks pass`;
  };
  // rows stay in place as the layout changes; each one updates only what changed in it
  return (
    <div class="contents checks-summary" style={{ width: `${Math.min(availableWidth(props.p.x), 640)}px` }}>
      <div class="contents-title">{String(r().title ?? "Summary of Checks")}</div>
      <Show
        when={checks().length}
        fallback={<div class="contents-empty">No checks yet: write a comparison, like σ ≤ f.y.</div>}
      >
        <div class="checks-total" classList={{ failing: failing().length > 0 }}>
          {summary()}
        </div>
        <Index each={checks()}>{(c) => <CheckRow c={c()} start={start()} />}</Index>
      </Show>
    </div>
  );
}

function CheckRow(props: { c: Check; start: number }) {
  // regions keep their identity across layouts, so this changes only when the row shows another region
  const region = createMemo(() => regionOf(props.c.id));
  const label = createMemo(() => {
    const c = props.c;
    const v = state.views[c.id];
    const r = region();
    if (c.cell && r) return esc(`${tableName(r)} · ${c.row || `row ${c.cell[0] + 1}`}`);
    // the comparison itself, typeset, and its note if it has one
    const input = v?.input?.t === "Define" ? v.input.c.rhs : v?.input;
    const math = input ? mathml(input, null, v!.units, v!.constants) : esc(r?.expr ?? "");
    const note = r?.note ? ` <span class="checks-note">${esc(String(r.note))}</span>` : "";
    return math + note;
  });
  return (
    <div
      class="contents-row"
      data-ref={props.c.id}
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={() => revealRegion(props.c.id)}
      title="Go to"
    >
      <span class="checks-mark" classList={{ pass: props.c.pass, fail: !props.c.pass }}>
        {props.c.pass ? "✓" : "✗"}
      </span>
      <span class="contents-label" innerHTML={label()} />
      <span class="contents-dots" />
      <Show when={layout().pageView}>
        <span class="contents-page">{props.c.page + props.start}</span>
      </Show>
    </div>
  );
}

interface ContentsEntry {
  id: string;
  number: string;
  label: string;
  level: number;
  page: number;
}

const sameEntries = (a: ContentsEntry[], b: ContentsEntry[]) =>
  a.length === b.length &&
  a.every(
    (e, i) =>
      e.id === b[i].id &&
      e.number === b[i].number &&
      e.label === b[i].label &&
      e.level === b[i].level &&
      e.page === b[i].page,
  );

/** Table of contents / list of figures / list of tables — always current. */
function ContentsBody(props: { p: Placed }) {
  const r = () => props.p.region;
  const of = () => (r().of as string | undefined) ?? "headings";
  const start = () => (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1;
  // the layout changes with every height measured: parse a heading's HTML only when it changes
  let parsed = new Map<string, string>();
  const entries = createMemo(
    (): ContentsEntry[] => {
      const headings = of() === "headings";
      const seen = new Map<string, string>();
      const text = (html: string | undefined) => {
        const key = `${headings ? "h" : "c"}:${html ?? ""}`;
        const t = parsed.get(key) ?? (headings ? headingOf(html) : textOf(html));
        seen.set(key, t);
        return t;
      };
      const out = layout()
        .list.filter((q) => !q.hidden && q.number)
        .filter((q) =>
          headings
            ? q.region.kind === "text"
            : of() === "tables"
              ? q.region.kind === "table" && !!q.region.caption
              : q.region.kind !== "table" && q.region.kind !== "text" && !!q.region.caption,
        )
        .map((q) => {
          const html = state.report?.html[headings ? q.region.id : `${q.region.id}:caption`];
          return {
            id: q.region.id,
            number: headings ? q.number! : "",
            label: headings ? text(html) : `${captionPrefix(q.region, q.number)}${text(html)}`,
            level: headings ? q.number!.split(".").length : 1,
            page: q.page,
          };
        });
      parsed = seen;
      return out;
    },
    [],
    { equals: sameEntries },
  );
  // rows stay in place as the layout changes; each one updates only what changed in it
  return (
    <div class="contents" style={{ width: `${Math.min(availableWidth(props.p.x), 640)}px` }}>
      <div class="contents-title">{String(r().title ?? "Contents")}</div>
      <Show when={entries().length} fallback={<div class="contents-empty">Nothing to list yet.</div>}>
        <Index each={entries()}>
          {(e) => (
            <div
              class={`contents-row lvl-${e().level}`}
              data-ref={e().id}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => revealRegion(e().id)}
              title="Go to"
            >
              <Show when={e().number}>
                <span class="contents-num">{e().number}</span>
              </Show>
              <span class="contents-label">{e().label}</span>
              <span class="contents-dots" />
              <Show when={layout().pageView}>
                <span class="contents-page">{e().page + start()}</span>
              </Show>
            </div>
          )}
        </Index>
      </Show>
    </div>
  );
}

/** The size an image or plot is shown at, `size` or the default its body falls back to. */
function shownSize(r: Region): [number, number] {
  if (r.size) return r.size;
  return r.kind === "plot2d" ? DEFAULT_SIZE : r.kind === "plot3d" ? DEFAULT_SIZE_3D : [200, 150];
}

/** Whether a region is resized as a box (image, 2D or 3D plot) rather than by its width (text). */
export const resizable = (r: Region | undefined) => r?.kind === "image" || isPlot(r?.kind ?? "");

/**
 * Resize an image or plot from the keyboard by `dw` and `dh`, one undo step. An image
 * keeps its proportions, as it does when dragged. Returns the new size.
 */
export function resizeBy(id: string, dw: number, dh: number): [number, number] | null {
  const r = layout().byId.get(id)?.region;
  if (!r || !resizable(r)) return null;
  const [w0, h0] = shownSize(r);
  let size: [number, number];
  if (r.kind === "image") {
    const w = Math.max(24, w0 + (dw || dh));
    size = [w, Math.max(16, Math.round((w * h0) / w0))];
  } else size = [Math.max(160, w0 + dw), Math.max(120, h0 + dh)];
  if (size[0] !== w0 || size[1] !== h0) updateRegion(id, { size });
  return size;
}

/** Drag handle that sets a text region's width or an image's size (Shift: free aspect). */
function ResizeHandle(props: { p: Placed }) {
  const r = () => props.p.region;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const id = r().id;
    const startX = e.clientX;
    const startY = e.clientY;
    const sized = resizable(r());
    const [w0, h0] = sized ? shownSize(r()) : [r().width ?? widths[id] ?? 200, 0];
    const ratio = h0 / w0;
    // the undo step is taken on the first move, as when dragging a region: a click that
    // doesn't drag changes nothing, so it mustn't mark the document edited or clear Redo
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      if (!moved) {
        moved = true;
        checkpoint();
      }
      const w = Math.max(24, Math.round((w0 + (ev.clientX - startX) / state.view.zoom) / GRID) * GRID);
      const free = Math.max(16, Math.round(h0 + (ev.clientY - startY) / state.view.zoom));
      setState(
        "doc",
        produce((d) => {
          const reg = findDraft(d, id);
          if (!reg) return;
          if (reg.kind === "image") reg.size = [w, ev.shiftKey ? free : Math.round(w * ratio)];
          else if (isPlot(reg.kind)) reg.size = [Math.max(160, w), Math.max(120, free)];
          else reg.width = w;
        }),
      );
    };
    // a cancelled pointer (the system took it over) keeps the size reached so far, like a release
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (moved) setState({ dirty: true, rev: state.rev + 1 });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return (
    <div
      class="resize-handle"
      classList={{ corner: resizable(r()) }}
      onPointerDown={onDown}
      title={resizable(r()) ? `Drag to resize (${isMac ? "⌘" : "Ctrl+"}Arrows)` : "Drag to resize"}
    />
  );
}

const isPlot = (kind: string) => kind === "plot2d" || kind === "plot3d";

/** The units a result can be shown in, as a menu at the clicked unit. */
function openUnitMenu(e: MouseEvent, r: Region) {
  const choices = state.views[r.id]?.unitChoices ?? [];
  const current = r.display?.unit;
  const setUnit = (unit: string | undefined) => {
    closeMenu();
    updateRegion(r.id, (d) => {
      d.display = { ...d.display, unit };
      if (!unit) delete d.display.unit;
      if (!Object.keys(d.display).length) delete d.display;
    });
  };
  const items: MenuItems = choices.map((c) => ({
    label: prettyValue(c.text),
    checked: c.unit === current,
    run: () => setUnit(c.unit),
  }));
  items.push(null, { label: "Automatic", checked: !current, run: () => setUnit(undefined) });
  items.push({
    label: "Other Unit…",
    run: () => {
      closeMenu();
      startEditing(r.id);
    },
  });
  const box = (e.target as Element).closest(".res")!.getBoundingClientRect();
  setMenu({ x: box.left, y: box.bottom + 4, items });
}

const KIND_LABEL: Record<string, string> = {
  data: "Data import (not supported in this version yet)",
  legacy: "Unconverted SMath region",
  // held by the engine when it can't read a region (a newer Quire's); saved back as it was
  unreadable: "A region this version of Quire can't read, kept as it is",
};

/** Regions that can be split across pages; the others move to the next page whole. */
const splittable = (r: Region) => (r.kind === "table" || r.kind === "text") && r.keep !== true;

/**
 * Where a region may be cut between pages, in px below its top at zoom 1 (store.ts `Cuts`):
 * between table rows (never right under the header row), between lines of text.
 */
function measureCuts(el: HTMLElement, r: Region): Cuts | undefined {
  const box = el.getBoundingClientRect();
  const z = state.view.zoom || 1;
  const y = (v: number) => (v - box.top) / z;
  if (r.kind === "table") {
    const table = el.querySelector<HTMLTableElement>("table");
    const body = table?.tBodies[0];
    if (!table || !body || body.rows.length < 2) return undefined;
    const rows = [...body.rows];
    const header = !!r.header?.row;
    const at: number[] = [];
    const starts: number[] = [];
    // below the last row on each page, its border included
    for (let i = header ? 2 : 1; i < rows.length; i++) {
      at.push(Math.ceil(y(rows[i - 1].getBoundingClientRect().bottom)));
      starts.push(i);
    }
    const top = table.getBoundingClientRect().top;
    const headEnd = header
      ? rows[0].getBoundingClientRect().bottom
      : (table.tHead?.getBoundingClientRect().bottom ?? top);
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    return {
      at,
      rows: starts,
      head: Math.ceil(pad + (headEnd - top) / z),
      cols: [...rows[0].cells].map((td) => td.getBoundingClientRect().width / z),
    };
  }
  const root = el.querySelector(".ProseMirror") ?? el.querySelector(".text-body");
  if (!root) return undefined;
  // every line's extent: text, inline math and pictures are never cut through
  const spans: [number, number][] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    for (const rc of range.getClientRects()) if (rc.height > 0) spans.push([y(rc.top), y(rc.bottom)]);
  }
  for (const e of root.querySelectorAll("img, math, svg, hr, table, [data-math]")) {
    const rc = e.getBoundingClientRect();
    if (rc.height > 0) spans.push([y(rc.top), y(rc.bottom)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const at: number[] = [];
  let bottom = -Infinity;
  for (const [t, b] of spans) {
    // a new line starts below everything before it (line boxes tighter than the font overlap
    // by a pixel or two): cut half-way between them
    if (t >= bottom - 2.5 && bottom > -Infinity) at.push(Math.round((bottom + t) / 2));
    bottom = Math.max(bottom, b);
  }
  return { at: at.filter((a, i) => a > 0 && a !== at[i - 1]), head: 0 };
}

function sameCuts(a: Cuts | undefined, b: Cuts | undefined): boolean {
  if (!a || !b) return a === b;
  const near = (x: number[] = [], y: number[] = []) =>
    x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 0.5);
  return near(a.at, b.at) && near(a.rows, b.rows) && near(a.cols, b.cols) && Math.abs(a.head - b.head) < 0.5;
}

/**
 * A later part of a region split across pages (`Placed.parts`), on its own page: a table's rows
 * under its header row, or a window onto the lines of text that fall on this page. The first
 * part is the region's own element (`RegionBox`), clipped.
 */
export function RegionPart(props: { id: string; part: number; onDragStart: (id: string, e: PointerEvent) => void }) {
  const placed = () => layout().byId.get(props.id);
  const part = () => placed()?.parts?.[props.part];
  return (
    <Show when={placed() && part() ? placed() : undefined}>
      {(p) => {
        const r = () => p().region;
        const editing = () => state.editing === r().id;
        const height = () => part()!.to - part()!.from;
        return (
          <div
            class={`region part ${r().kind}`}
            classList={{ selected: state.selection.includes(r().id), editing: editing() }}
            data-part-of={r().id}
            style={{
              left: `${p().left}px`,
              top: `${part()!.top}px`,
              // text being edited shows whole on its first page
              display: r().kind === "text" && editing() ? "none" : undefined,
            }}
            onPointerDown={(e) => (editing() ? e.stopPropagation() : props.onDragStart(r().id, e))}
            onDblClick={(e) =>
              r().kind === "table"
                ? editTableAt(r().id, [e.clientX, e.clientY])
                : startEditing(r().id, partPoint(e, p(), part()!))
            }
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!state.selection.includes(r().id)) setState({ selection: [r().id], caret: null });
              openRegionMenu(e, r().id);
            }}
          >
            <Show
              when={r().kind === "table"}
              fallback={
                // the lines that fall on this page: the whole text, shifted up, seen through a window;
                // its width is the text's own (sized as on the first part), so lines wrap at the same words
                <div class="part-window" style={{ height: `${height()}px` }}>
                  <div class="part-shift" style={{ "margin-top": `${-part()!.from}px` }}>
                    <TextBody p={p()} static />
                  </div>
                </div>
              }
            >
              <TableBody p={p()} part={props.part} />
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

/**
 * Where a double-click on a later part of split text lands in the text being edited, which shows
 * whole on its first page: the same spot of the text there.
 */
function partPoint(e: MouseEvent, p: Placed, q: Part): [number, number] {
  const first = p.parts?.[0];
  if (!first) return [e.clientX, e.clientY];
  const z = state.view.zoom;
  const stride = layout().geom.paperH + SHEET_GAP;
  return [e.clientX, e.clientY + (first.top - q.top + q.from - (q.page - first.page) * stride) * z];
}

export function RegionBox(props: RegionProps) {
  // keyed by the region (a stable store object); its placement is looked up reactively,
  // so layout changes move the element instead of rebuilding it (and losing focus)
  const placed = (): Placed =>
    layout().byId.get(props.region.id) ?? {
      region: props.region,
      x: 0,
      y: 0,
      shift: 0,
      hidden: true,
      parent: null,
      page: 0,
      left: 0,
      top: 0,
      pulled: 0,
    };
  const r = () => props.region;
  const selected = () => state.selection.includes(r().id);
  const editing = () => state.editing === r().id;
  let el!: HTMLDivElement;
  // a tall table or text region may be split across pages: where it may be cut
  const remeasureCuts = () => {
    if (!splittable(r()) || state.printing) return;
    const next =
      isPageView() && el.offsetHeight > layout().geom.contentH * SPLIT_SHARE ? measureCuts(el, r()) : undefined;
    if (
      !sameCuts(
        untrack(() => cuts[r().id]),
        next,
      )
    )
      setCuts(r().id, next);
  };
  // pagination and spacing need real heights; report them whenever the rendering changes size
  onMount(() => {
    const ro = new ResizeObserver(() => {
      // a split region is drawn shorter while printing (`printedHeight`): its pagination stays
      if (untrack(() => state.printing && !!placed().parts)) return;
      const h = el.offsetHeight;
      const before = untrack(() => heights[r().id]) ?? 0;
      if (h && Math.abs(before - h) > 0.5) {
        setHeights(r().id, h);
        scheduleGrowth();
      }
      const w = el.offsetWidth;
      if (w && Math.abs((untrack(() => widths[r().id]) ?? 0) - w) > 0.5) setWidths(r().id, w);
      untrack(remeasureCuts);
    });
    ro.observe(el);
    onCleanup(() => {
      ro.disconnect();
      if (untrack(() => cuts[r().id])) setCuts(r().id, undefined);
    });
  });
  // the same size can wrap differently: measure again when the view or the content changes
  createEffect(
    on(
      () => [
        isPageView(),
        state.editing === r().id,
        r().rows,
        r().text,
        state.views[r().id],
        state.report?.html[r().id],
      ],
      () => queueMicrotask(remeasureCuts),
      { defer: true },
    ),
  );
  // printed, split text is cut to its first part's lines (a table drops the later rows itself):
  // nothing runs on past its page for the print engine to paginate
  const printedHeight = () => {
    const first = placed().parts?.[0];
    return state.printing && first && r().kind === "text"
      ? { height: `${first.to}px`, overflow: "hidden", "box-sizing": "border-box" as const }
      : {};
  };
  // split across pages: this element shows the first part; text being edited shows whole
  const clip = () => {
    const parts = placed().parts;
    // printed, the first part is drawn only as tall as it is (`printedHeight`, a table's rows)
    if (!parts || state.printing || (r().kind === "text" && editing())) return undefined;
    const below = (heights[r().id] ?? 0) - parts[0].to;
    return `inset(-48px -4000px ${Math.max(0, below)}px -4000px)`;
  };
  return (
    <div
      ref={el}
      class={`region ${r().kind}`}
      classList={{
        selected: selected(),
        editing: editing(),
        error: !!state.views[r().id]?.error,
        found: hitIds().has(r().id),
        "trace-def": !!trace()?.defs.has(r().id),
        "trace-use": !!trace()?.uses.has(r().id) && !trace()?.defs.has(r().id),
      }}
      data-region={r().id}
      style={{
        left: `${placed().left}px`,
        top: `${placed().top}px`,
        display: placed().hidden ? "none" : undefined,
        "font-size": r().kind === "math" ? pt(r().style?.size, state.doc.styles?.math?.size ?? 10) : undefined,
        "clip-path": clip(),
        ...printedHeight(),
      }}
      onPointerDown={(e) => {
        // inside the region being edited, clicks belong to the editor, not the canvas
        if (editing()) return e.stopPropagation();
        // a result's unit: pick another one
        if (
          e.button === 0 &&
          !e.shiftKey &&
          (e.target as Element).closest?.(".res .u") &&
          state.views[r().id]?.unitChoices?.length
        ) {
          e.stopPropagation();
          e.preventDefault();
          setState({ selection: [r().id], caret: null });
          return openUnitMenu(e, r());
        }
        props.onDragStart(r().id, e);
      }}
      onDblClick={(e) =>
        r().kind === "table"
          ? editTableAt(r().id, [e.clientX, e.clientY])
          : r().kind === "plot2d"
            ? editPlot(r().id)
            : r().kind === "plot3d"
              ? editPlot3d(r().id)
              : startEditing(r().id, [e.clientX, e.clientY])
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // the canvas has its own menu
        if (!selected()) setState({ selection: [r().id], caret: null });
        openRegionMenu(e, r().id);
      }}
    >
      <Switch
        fallback={
          <div
            class="placeholder-box"
            style={{ width: `${r().size?.[0] ?? 240}px`, height: `${r().size?.[1] ?? 60}px` }}
          >
            {KIND_LABEL[r().kind] ?? r().kind}
          </div>
        }
      >
        <Match when={r().kind === "math"}>
          <MathBody r={r()} noteWidth={() => noteRoom(placed(), layout().list, heights, availableWidth(placed().x))} />
        </Match>
        <Match when={r().kind === "text"}>
          <TextBody p={placed()} />
        </Match>
        <Match when={r().kind === "image"}>
          <ImageBody p={placed()} />
        </Match>
        <Match when={r().kind === "area"}>
          <AreaBody p={placed()} />
        </Match>
        <Match when={r().kind === "table"}>
          <TableBody p={placed()} />
        </Match>
        <Match when={r().kind === "toc" && r().of === "checks"}>
          <ChecksBody p={placed()} />
        </Match>
        <Match when={r().kind === "toc"}>
          <ContentsBody p={placed()} />
        </Match>
        <Match when={isPlot(r().kind)}>
          <PlotFigure p={placed()} selected={selected()} />
        </Match>
        <Match when={r().kind === "pagebreak"}>
          {/* a mark on screen only: what follows starts on the next page (store.ts computeLayout) */}
          <div class="pagebreak-mark" style={{ width: `${availableWidth(placed().x)}px` }}>
            <span>Page break</span>
          </div>
        </Match>
      </Switch>
      <Show
        when={
          selected() &&
          state.selection.length === 1 &&
          !editing() &&
          !state.printing &&
          ["text", "image", "plot2d", "plot3d"].includes(r().kind)
        }
      >
        <ResizeHandle p={placed()} />
      </Show>
      {/* a function definition can be plotted in one click (shown on hover or when selected) */}
      <Show
        when={r().kind === "math" && !editing() && !state.printing && /\(/.test(state.views[r().id]?.defines ?? "")}
      >
        <button
          class="plot-this"
          title="Plot this function below it"
          aria-label="Plot this function"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setState({ selection: [r().id], caret: null });
            insertPlot();
          }}
        >
          <span>∿ Plot</span>
        </button>
      </Show>
    </div>
  );
}
