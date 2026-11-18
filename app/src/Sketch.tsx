// Parametric engineering sketches (docs/02-file-format.md §4.11): vector SVG drawings driven
// by the worksheet's variables in reading order. Paper-white in every theme so ISO 128 stroke
// weights and ink match the printed page.
import { createMemo, Index, onCleanup, Show } from "solid-js";
import { announce } from "./a11y";
import { announceFirst, completionKey, hideCompletions, type Item, openList, showCompletions } from "./Completion";
import { Field, Num, Select, setInspectorTab } from "./Inspector";
import { nameHtml, prettyValue } from "./math";
import { setMenu } from "./menu";
import {
  KIND_WORD,
  knownMeanings,
  knownUnitMeanings,
  meanings,
  type NameSpan,
  nameSpan,
  unitMeanings,
  unitPosition,
} from "./names";
import { buildSketchScene, DEFAULT_SKETCH_SIZE, describeSketch } from "./sketchGeometry";
import {
  commitEditing,
  contentBottom,
  flash,
  heights,
  insertRegion,
  layout,
  LINE,
  setState,
  snap,
  state,
  updateRegion,
} from "./store";
import type { Completion, Region, SketchElement, SketchView } from "./types";
import { typeset } from "./typography";

export { DEFAULT_SKETCH_SIZE };

export const elementsOf = (r: Region): SketchElement[] =>
  Array.isArray(r.elements) ? (r.elements as SketchElement[]) : [];

export const shownSketchSize = (r: Region): [number, number] =>
  r.size ?? (r.width ? [r.width, DEFAULT_SKETCH_SIZE[1]] : DEFAULT_SKETCH_SIZE);

const INK = "#1b1d22";
const PAPER = "#ffffff";

function fillColor(fill: "paper" | "ink" | "none" | undefined): string {
  if (fill === "paper") return PAPER;
  if (fill === "ink") return INK;
  return "none";
}

export function SketchBody(props: { r: Region }) {
  const r = () => props.r;
  const view = () => state.views[r().id]?.sketch as SketchView | undefined;
  const size = () => shownSketchSize(r());
  const elements = () => elementsOf(r());
  const scene = createMemo(() => buildSketchScene(elements(), view(), size()[0], size()[1]));
  const fontFamily = () =>
    state.doc.styles?.body?.font ||
    (typeset(state.doc) ? '"Quire Text", Georgia, serif' : 'system-ui, -apple-system, "Segoe UI", sans-serif');

  return (
    <div class="sketch-box" style={{ width: `${size()[0]}px`, height: `${size()[1]}px` }}>
      <svg
        role="img"
        aria-label={describeSketch(elements(), view())}
        width={size()[0]}
        height={size()[1]}
        viewBox={`0 0 ${size()[0]} ${size()[1]}`}
        style={{ "font-family": fontFamily() }}
        onDblClick={(e) => {
          e.stopPropagation();
          editSketch(r().id);
        }}
      >
        <g class="sketch-geometry">
          <Index each={scene().items}>
            {(item) => (
              <g
                class="sketch-item"
                data-el={item().index}
                onDblClick={(e) => {
                  e.stopPropagation();
                  editSketch(r().id, item().index);
                }}
              >
                <Index each={item().strokes}>
                  {(st) => <path class={`sketch-stroke ${st().weight}`} d={st().d} fill={fillColor(st().fill)} />}
                </Index>
                <Index each={item().circles}>
                  {(c) => (
                    <circle
                      class={`sketch-circle ${c().weight}`}
                      cx={c().cx}
                      cy={c().cy}
                      r={c().r}
                      fill={fillColor(c().fill)}
                    />
                  )}
                </Index>
              </g>
            )}
          </Index>
        </g>
        <g class="sketch-labels">
          <Index each={scene().items}>
            {(item) => (
              <Index each={item().texts}>
                {(t) => (
                  <g
                    transform={t().rotate ? `rotate(${t().rotate} ${t().x} ${t().y})` : undefined}
                    onDblClick={(e) => {
                      e.stopPropagation();
                      editSketch(r().id, item().index);
                    }}
                  >
                    <Show when={t().backdrop}>
                      {(bd) => (
                        <rect
                          x={t().x - bd().w / 2}
                          y={t().y - bd().h + 3}
                          width={bd().w}
                          height={bd().h}
                          rx={2}
                          fill={PAPER}
                        />
                      )}
                    </Show>
                    <text class="sketch-text" x={t().x} y={t().y} text-anchor={t().anchor}>
                      {t().text}
                    </text>
                  </g>
                )}
              </Index>
            )}
          </Index>
        </g>
      </svg>
      <Show when={elements().length === 0}>
        <div class="sketch-empty">Empty sketch: add elements in the Inspector</div>
      </Show>
    </div>
  );
}

/** Whether a variable `name` is defined above `y` (or globally anywhere in the worksheet). */
function variableDefinedAbove(name: string, y: number): boolean {
  const defRe = new RegExp(`^\\s*${name}\\s*(?::=|≔|~|≡)`);
  const globalRe = new RegExp(`^\\s*${name}\\s*(?:~|≡)`);
  for (const p of layout().list) {
    if (p.region.disabled) continue;
    const expr = p.region.kind === "math" ? (p.region.expr ?? "") : "";
    if (globalRe.test(expr)) return true;
    if (p.y <= y + 1) {
      if (state.views[p.region.id]?.defines === name || defRe.test(expr)) return true;
    }
  }
  return false;
}

/** Insert ▸ Sketch: starter simply supported beam bound to `L` and `q` when defined above, else concrete literals. */
export function insertSketch() {
  const selected = state.selection.length === 1 ? layout().byId.get(state.selection[0]) : undefined;
  const at: [number, number] = selected
    ? [selected.x, snap(selected.y + (heights[selected.region.id] ?? 20) + LINE)]
    : (state.caret ?? [36, snap(contentBottom() + LINE)]);
  const hasL = variableDefinedAbove("L", at[1]);
  const hasQ = variableDefinedAbove("q", at[1]);
  const span = hasL ? "L" : "6 m";
  const udlLabel = hasQ ? "q = {q}" : "q = 10 kN/m";
  const elements: SketchElement[] = [
    { type: "member", from: ["0 m", "0 m"], to: [span, "0 m"] },
    { type: "support", at: ["0 m", "0 m"], kind: "pin" },
    { type: "support", at: [span, "0 m"], kind: "roller" },
    { type: "udl", from: ["0 m", "0 m"], to: [span, "0 m"], label: udlLabel },
    { type: "dimension", from: ["0 m", "0 m"], to: [span, "0 m"], offset: -40 },
  ];
  insertRegion({ kind: "sketch", at, size: [...DEFAULT_SKETCH_SIZE], elements });
}

// ---------------------------------------------------------------------------
// Inspector ▸ Sketch (expression autocomplete + add / reorder / remove)
// ---------------------------------------------------------------------------

function tidy<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

function toCompletionItem(c: Completion): Item {
  const about =
    c.kind === "unit" && c.title
      ? [c.title, c.quantity].filter(Boolean).join(" · ")
      : c.kind === "constant" && c.title
        ? c.title
        : prettyValue(c.preview);
  return {
    name: c.name,
    insert: c.insert,
    note: about,
    kind: c.kind,
    html: `${c.quotedOnly ? "'" : ""}${nameHtml(c.name, c.kind)}`,
    speak: `${c.name}, ${KIND_WORD[c.kind]}, ${about}`,
  };
}

/** Find the `{...}` slice surrounding `caret`, if `caret` sits inside an unclosed `{...}` interpolation. */
function braceContext(value: string, caret: number): { start: number; end: number } | null {
  let open = -1;
  let inStr = false;
  for (let i = 0; i < caret; i++) {
    const ch = value[i];
    if (inStr) {
      if (ch === "\\" && i + 1 < value.length) i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") open = i + 1;
    else if (ch === "}") open = -1;
  }
  if (open < 0) return null;
  let end = value.length;
  for (let j = caret; j < value.length; j++) {
    if (value[j] === "}") {
      end = j;
      break;
    }
  }
  return { start: open, end };
}

/**
 * Inspector expression / `{expr}` label input wired to the worksheet's scoped completion popup.
 * When `braceOnly` is true, completions activate only when the caret is inside `{...}`.
 */
function SketchExprInput(props: {
  regionId: string;
  value: string | undefined;
  placeholder?: string;
  mono?: boolean;
  braceOnly?: boolean;
  onCommit: (v: string) => void;
}) {
  let input!: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  onCleanup(() => clearTimeout(timer));

  const suggest = (typing: boolean, ask = false) => {
    const myGen = ++gen;
    clearTimeout(timer);
    const open = openList();
    const namesOpen = open?.list === "names";
    const asked = ask || (namesOpen && !open.soft);
    const full = input.value;
    const caret = input.selectionStart ?? 0;
    if (input.selectionStart !== input.selectionEnd) {
      if (open) hideCompletions();
      return;
    }

    let offset = 0;
    let slice = full;
    let relCaret = caret;
    if (props.braceOnly) {
      const ctx = braceContext(full, caret);
      if (!ctx) {
        if (open) hideCompletions();
        return;
      }
      offset = ctx.start;
      slice = full.slice(ctx.start, ctx.end);
      relCaret = caret - ctx.start;
    }

    const span = nameSpan(slice, relCaret);
    const here: NameSpan | null =
      span ?? (ask ? { from: relCaret, to: relCaret, name: "", marker: "", typed: "" } : null);
    const prefix = here ? (asked ? here.typed || here.name : here.typed) : "";
    const unitHere = !!here && here.marker !== "#" && unitPosition(slice, here.from);
    const starts = typing && here?.to === relCaret && /^[\p{L}°]/u.test(prefix);
    if (!here || !(asked || (prefix && (namesOpen || starts)))) {
      if (open) hideCompletions();
      return;
    }
    if (open && !namesOpen) hideCompletions();

    const regionId = props.regionId;
    const search = unitHere && !!prefix;
    let toSay = ask;

    const replaceSpan = (insert: string) => {
      const a = offset + here.from;
      const b = offset + here.to;
      const next = full.slice(0, a) + insert + full.slice(b);
      input.value = next;
      const nextCaret = a + insert.length;
      input.setSelectionRange(nextCaret, nextCaret);
    };

    const show = (all: Completion[]) => {
      if (myGen !== gen || input.value !== full || document.activeElement !== input) return;
      const fits = (c: Completion) =>
        (search || c.name.startsWith(prefix)) &&
        (here.marker === "'" ? c.kind === "unit" : here.marker === "#" ? c.kind === "constant" : true);
      const items = all.filter(fits).slice(0, 80).map(toCompletionItem);
      const same = items.length === 1 && items[0].insert === slice.slice(here.from, here.to);
      if (!items.length || (!asked && same)) {
        if (openList()?.list === "names") hideCompletions();
        if (toSay) announce(`Nothing named ${prefix || "here"}`);
        toSay = false;
        return;
      }
      const box = input.getBoundingClientRect();
      showCompletions(
        box.left,
        box.bottom + 4,
        items,
        (item) => replaceSpan(item.insert),
        !asked,
        "names",
        box.top - 4,
      );
      if (toSay) announceFirst();
      toSay = false;
    };

    const query = here.marker === "'" ? `'${prefix}` : prefix;
    const known = search ? knownUnitMeanings(regionId, query) : knownMeanings(regionId, prefix);
    if (known) show(known.list);
    if (known?.exact) return;
    const lookUp = () => (search ? unitMeanings(regionId, query) : meanings(regionId, prefix));
    timer = setTimeout(() => void lookUp().then(show), asked ? 0 : 100);
  };

  return (
    <input
      ref={input}
      class="insp-input"
      classList={{ mono: !!props.mono }}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      spellcheck={false}
      onFocus={() => commitEditing()}
      onInput={() => suggest(true, false)}
      onBlur={(e) => {
        hideCompletions();
        props.onCommit(e.currentTarget.value.trim());
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          suggest(false, true);
          return;
        }
        if (completionKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === "Enter") {
          hideCompletions();
          (e.currentTarget as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

const ELEMENT_TITLE: Record<SketchElement["type"], string> = {
  member: "Member",
  support: "Support",
  udl: "Uniform load",
  point: "Point load",
  moment: "Moment",
  dimension: "Dimension",
  label: "Label",
};

const regionOf = (id: string) => layout().byId.get(id)?.region;
const viewOf = (id: string) => state.views[id]?.sketch as SketchView | undefined;

function setElement(id: string, i: number, next: SketchElement) {
  updateRegion(id, (d) => {
    const list = elementsOf(d).map((e) => ({ ...e }));
    list[i] = tidy(next);
    d.elements = list;
  });
}

function moveElement(id: string, i: number, delta: -1 | 1) {
  updateRegion(id, (d) => {
    const list = [...elementsOf(d)];
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    d.elements = list;
  });
}

function removeElement(id: string, i: number) {
  updateRegion(id, (d) => {
    d.elements = elementsOf(d).filter((_, k) => k !== i);
  });
}

function defaultElement(type: SketchElement["type"], r: Region): SketchElement {
  const existingMember = elementsOf(r).find(
    (e): e is Extract<SketchElement, { type: "member" }> => e.type === "member",
  );
  const end = existingMember?.to ?? ["6 m", "0 m"];
  switch (type) {
    case "member":
      return { type: "member", from: ["0 m", "0 m"], to: [end[0], end[1]] };
    case "support":
      return { type: "support", at: ["0 m", "0 m"], kind: "pin" };
    case "udl":
      return { type: "udl", from: ["0 m", "0 m"], to: [end[0], end[1]], label: "q = 10 kN/m" };
    case "point":
      return { type: "point", at: [end[0], end[1]], angle: -90, label: "P = 10 kN" };
    case "moment":
      return { type: "moment", at: [end[0], end[1]], sense: "ccw", label: "M = 10 kN·m" };
    case "dimension":
      return { type: "dimension", from: ["0 m", "0 m"], to: [end[0], end[1]], offset: -40 };
    case "label":
      return { type: "label", at: ["0 m", "0 m"], text: "A", anchor: "above" };
  }
}

function addElement(id: string, type: SketchElement["type"]) {
  let nextIdx = 0;
  updateRegion(id, (d) => {
    const list = elementsOf(d);
    nextIdx = list.length;
    d.elements = [...list, defaultElement(type, d)];
  });
  setTimeout(() => {
    document.querySelector<HTMLInputElement>(`[data-sketch-el="${nextIdx}"] input`)?.focus();
  }, 30);
}

function ElementEditor(props: { id: string; i: number }) {
  const list = () => elementsOf(regionOf(props.id) ?? ({} as Region));
  const el = () => list()[props.i];
  const err = () => viewOf(props.id)?.errors[String(props.i)];

  const patch = (p: Record<string, unknown>) => {
    const cur = el();
    if (!cur) return;
    setElement(props.id, props.i, { ...cur, ...p } as SketchElement);
  };

  return (
    <Show when={el()}>
      {(e) => (
        <div class="insp-sub sketch-el" data-sketch-el={props.i}>
          <div class="insp-subtitle">
            <span>
              {props.i + 1}. {ELEMENT_TITLE[e().type]}
              {e().type === "support" ? ` (${(e() as Extract<SketchElement, { type: "support" }>).kind})` : ""}
            </span>
            <span class="sketch-el-actions">
              <button
                type="button"
                class="insp-mini"
                title="Move element up"
                aria-label={`Move element ${props.i + 1} up`}
                disabled={props.i === 0}
                onClick={() => moveElement(props.id, props.i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="insp-mini"
                title="Move element down"
                aria-label={`Move element ${props.i + 1} down`}
                disabled={props.i >= list().length - 1}
                onClick={() => moveElement(props.id, props.i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                class="insp-mini"
                title="Remove element"
                aria-label={`Remove element ${props.i + 1}`}
                onClick={() => removeElement(props.id, props.i)}
              >
                ✕
              </button>
            </span>
          </div>

          <Show when={e().type === "member" || e().type === "udl" || e().type === "dimension"}>
            {(() => {
              const span = () => e() as Extract<SketchElement, { from: [string, string]; to: [string, string] }>;
              return (
                <>
                  <div class="insp-row">
                    <Field label="From X">
                      <SketchExprInput
                        regionId={props.id}
                        value={span().from[0]}
                        mono
                        placeholder="0 m"
                        onCommit={(v) => patch({ from: [v, span().from[1]] })}
                      />
                    </Field>
                    <Field label="From Y">
                      <SketchExprInput
                        regionId={props.id}
                        value={span().from[1]}
                        mono
                        placeholder="0 m"
                        onCommit={(v) => patch({ from: [span().from[0], v] })}
                      />
                    </Field>
                  </div>
                  <div class="insp-row">
                    <Field label="To X">
                      <SketchExprInput
                        regionId={props.id}
                        value={span().to[0]}
                        mono
                        placeholder="L"
                        onCommit={(v) => patch({ to: [v, span().to[1]] })}
                      />
                    </Field>
                    <Field label="To Y">
                      <SketchExprInput
                        regionId={props.id}
                        value={span().to[1]}
                        mono
                        placeholder="0 m"
                        onCommit={(v) => patch({ to: [span().to[0], v] })}
                      />
                    </Field>
                  </div>
                </>
              );
            })()}
          </Show>

          <Show when={e().type === "support" || e().type === "point" || e().type === "moment" || e().type === "label"}>
            {(() => {
              const ptEl = () => e() as Extract<SketchElement, { at: [string, string] }>;
              return (
                <div class="insp-row">
                  <Field label="At X">
                    <SketchExprInput
                      regionId={props.id}
                      value={ptEl().at[0]}
                      mono
                      placeholder="0 m"
                      onCommit={(v) => patch({ at: [v, ptEl().at[1]] })}
                    />
                  </Field>
                  <Field label="At Y">
                    <SketchExprInput
                      regionId={props.id}
                      value={ptEl().at[1]}
                      mono
                      placeholder="0 m"
                      onCommit={(v) => patch({ at: [ptEl().at[0], v] })}
                    />
                  </Field>
                </div>
              );
            })()}
          </Show>

          <Show when={e().type === "support"}>
            {(() => {
              const sup = () => e() as Extract<SketchElement, { type: "support" }>;
              return (
                <div class="insp-row">
                  <Field label="Support">
                    <Select<"pin" | "roller" | "fixed">
                      value={sup().kind}
                      options={[
                        ["pin", "Pin"],
                        ["roller", "Roller"],
                        ["fixed", "Fixed"],
                      ]}
                      onChange={(v) => patch({ kind: v })}
                    />
                  </Field>
                  <Field label="Angle (°)">
                    <Num
                      value={sup().angle}
                      placeholder={sup().kind === "fixed" ? "auto" : "0"}
                      onCommit={(v) => patch({ angle: v })}
                    />
                  </Field>
                </div>
              );
            })()}
          </Show>

          <Show when={e().type === "point"}>
            {(() => {
              const ptEl = () => e() as Extract<SketchElement, { type: "point" }>;
              return (
                <Field label="Angle (°)">
                  <Num value={ptEl().angle} placeholder="-90" onCommit={(v) => patch({ angle: v })} />
                </Field>
              );
            })()}
          </Show>

          <Show when={e().type === "moment"}>
            {(() => {
              const mom = () => e() as Extract<SketchElement, { type: "moment" }>;
              return (
                <Field label="Sense">
                  <Select<"ccw" | "cw">
                    value={mom().sense ?? "ccw"}
                    options={[
                      ["ccw", "Counter-clockwise"],
                      ["cw", "Clockwise"],
                    ]}
                    onChange={(v) => patch({ sense: v === "ccw" ? undefined : v })}
                  />
                </Field>
              );
            })()}
          </Show>

          <Show when={e().type === "dimension"}>
            {(() => {
              const dim = () => e() as Extract<SketchElement, { type: "dimension" }>;
              return (
                <Field label="Offset (px)">
                  <Num value={dim().offset} placeholder="-40" onCommit={(v) => patch({ offset: v })} />
                </Field>
              );
            })()}
          </Show>

          <Show when={e().type === "label"}>
            {(() => {
              const lbl = () => e() as Extract<SketchElement, { type: "label" }>;
              return (
                <>
                  <Field label="Text">
                    <SketchExprInput
                      regionId={props.id}
                      value={lbl().text}
                      braceOnly
                      placeholder="{L}"
                      onCommit={(v) => patch({ text: v })}
                    />
                  </Field>
                  <Field label="Anchor">
                    <Select<NonNullable<Extract<SketchElement, { type: "label" }>["anchor"]>>
                      value={lbl().anchor ?? "above"}
                      options={[
                        ["above", "Above"],
                        ["below", "Below"],
                        ["left", "Left"],
                        ["right", "Right"],
                        ["center", "Centre"],
                      ]}
                      onChange={(v) => patch({ anchor: v === "above" ? undefined : v })}
                    />
                  </Field>
                </>
              );
            })()}
          </Show>

          <Show when={e().type !== "label"}>
            {(() => {
              const withLabel = () => e() as Exclude<SketchElement, { type: "label" }>;
              const ph = () =>
                e().type === "dimension"
                  ? "measured"
                  : e().type === "udl"
                    ? "q = {q}"
                    : e().type === "point"
                      ? "P = {P}"
                      : e().type === "moment"
                        ? "M = {M}"
                        : "optional";
              return (
                <Field label="Label">
                  <SketchExprInput
                    regionId={props.id}
                    value={withLabel().label}
                    braceOnly
                    placeholder={ph()}
                    onCommit={(v) => patch({ label: v || undefined })}
                  />
                </Field>
              );
            })()}
          </Show>

          <Show when={err()}>
            <div class="err">{err()}</div>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function SketchFields(props: { r: Region }) {
  const openAddMenu = (e: MouseEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const types: [SketchElement["type"], string][] = [
      ["member", "Member"],
      ["support", "Support"],
      ["udl", "Uniform Load"],
      ["point", "Point Load"],
      ["moment", "Moment"],
      ["dimension", "Dimension"],
      ["label", "Label"],
    ];
    setMenu({
      x: box.left,
      y: box.bottom + 4,
      items: types.map(([t, label]) => ({
        label,
        run: () => addElement(props.r.id, t),
      })),
    });
  };

  return (
    <>
      <Index each={elementsOf(props.r)}>{(_, i) => <ElementEditor id={props.r.id} i={i} />}</Index>
      <button type="button" class="btn insp-add" onClick={openAddMenu}>
        Add Element ▾
      </button>
    </>
  );
}

/** Double-click or Enter on a sketch: open the Inspector Region tab and focus its element input. */
export function editSketch(id: string, elementIndex = 0) {
  setInspectorTab("region");
  setState({ selection: [id], caret: null, inspector: true });
  setTimeout(() => {
    const target =
      document.querySelector<HTMLInputElement>(`[data-sketch-el="${elementIndex}"] input`) ??
      document.querySelector<HTMLInputElement>(".sketch-el input");
    target?.focus();
  }, 30);
}

const INLINED = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linejoin",
  "stroke-linecap",
  "paint-order",
  "font-size",
  "font-family",
  "font-weight",
  "opacity",
];

/** Right-click ▸ Copy as Image: rasterize the sketch SVG at 2× onto white paper PNG. */
export async function copySketchImage(id: string) {
  const svg = document.querySelector<SVGSVGElement>(`[data-region="${CSS.escape(id)}"] .sketch-box svg`);
  if (!svg) return;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, k) => {
    const cs = getComputedStyle(el);
    const style = INLINED.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    to[k]?.setAttribute("style", style);
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const [w, h] = [svg.width.baseVal.value, svg.height.baseVal.value];
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  const png = (async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png"),
    );
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flash("Copied the sketch as an image");
  } catch (e) {
    flash(`Could not copy the sketch: ${(e as Error).message}`);
  }
}
