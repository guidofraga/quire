// Inspector: properties of the selected region, the document and its pages.
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { type Background, PX_PER_MM, toPx } from "./pages";
import { commitEditing, layout, localized, state, updateDoc, updateRegion } from "./store";
import type { Doc, Region } from "./types";

type Tab = "region" | "document" | "page";
const [tab, setTab] = createSignal<Tab>("region");
export { setTab as setInspectorTab };

export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="insp-field">
      <span class="insp-label">{props.label}</span>
      {props.children}
    </label>
  );
}

/** Text field that commits on Enter or when it loses focus. */
export function Text(props: { value: string | undefined; placeholder?: string; mono?: boolean; onCommit: (v: string) => void }) {
  return (
    <input
      class="insp-input"
      classList={{ mono: !!props.mono }}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      spellcheck={false}
      onFocus={() => commitEditing()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        e.stopPropagation();
      }}
      onChange={(e) => props.onCommit(e.currentTarget.value.trim())}
    />
  );
}

export function Num(props: { value: number | undefined; placeholder?: string; step?: number; onCommit: (v: number | undefined) => void }) {
  return (
    <input
      class="insp-input num"
      type="number"
      step={props.step ?? 1}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        e.stopPropagation();
      }}
      onChange={(e) => {
        const v = e.currentTarget.value.trim();
        props.onCommit(v === "" ? undefined : Number(v));
      }}
    />
  );
}

export function Check(props: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label class="insp-check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  );
}

export function Select<T extends string>(props: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select class="insp-input" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
      <For each={props.options}>{([v, label]) => <option value={v}>{label}</option>}</For>
    </select>
  );
}

export function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="insp-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

function CaptionFields(props: { r: Region }) {
  return (
    <Section title="Caption">
      <Check
        checked={!!props.r.caption}
        label="Show a numbered caption"
        onChange={(on) => updateRegion(props.r.id, { caption: on ? { text: "Caption", position: "below" } : undefined })}
      />
      <Show when={props.r.caption}>
        <Field label="Text">
          <Text
            value={localized(props.r.caption!.text)}
            onCommit={(v) => updateRegion(props.r.id, { caption: { ...props.r.caption!, text: v } })}
          />
        </Field>
        <Field label="Position">
          <Select
            value={props.r.caption!.position ?? "below"}
            options={[
              ["above", "Above"],
              ["below", "Below"],
            ]}
            onChange={(v) => updateRegion(props.r.id, { caption: { ...props.r.caption!, position: v } })}
          />
        </Field>
      </Show>
    </Section>
  );
}

function RegionTab() {
  const selected = () => (state.selection.length === 1 ? layout().byId.get(state.selection[0])?.region : undefined);
  return (
    <Show
      when={selected()}
      fallback={
        <p class="insp-empty">
          {state.selection.length > 1
            ? `${state.selection.length} regions selected. Use the format bar to align or distribute them.`
            : "Select a region to see its properties."}
        </p>
      }
    >
      {(r) => (
        <>
          <Section title={{ math: "Math", text: "Text", image: "Image", table: "Table", area: "Area", toc: "Contents" }[r().kind] ?? r().kind}>
            <div class="insp-row">
              <Field label="X">
                <Num value={r().at[0]} onCommit={(v) => updateRegion(r().id, { at: [v ?? 0, r().at[1]] })} />
              </Field>
              <Field label="Y">
                <Num value={r().at[1]} onCommit={(v) => updateRegion(r().id, { at: [r().at[0], v ?? 0] })} />
              </Field>
            </div>
            <Switch>
              <Match when={r().kind === "math"}>
                <Field label="Expression">
                  <Text value={r().expr} mono onCommit={(v) => updateRegion(r().id, { expr: v })} />
                </Field>
                <Check
                  checked={!!r().show}
                  label="Show the result"
                  onChange={(on) => updateRegion(r().id, { show: on ? "value" : undefined })}
                />
                <div class="insp-row">
                  <Field label="Result unit" hint="e.g. kN, kgf/m^2, mm">
                    <Text
                      value={r().display?.unit}
                      mono
                      placeholder="automatic"
                      onCommit={(v) => updateRegion(r().id, (d) => {
                        d.display = { ...d.display, unit: v || undefined };
                        if (!d.display.unit) delete d.display.unit;
                        if (!Object.keys(d.display).length) delete d.display;
                      })}
                    />
                  </Field>
                  <Field label="Decimals">
                    <Num
                      value={r().display?.decimals}
                      placeholder="doc"
                      onCommit={(v) => updateRegion(r().id, (d) => {
                        d.display = { ...d.display, decimals: v };
                        if (d.display.decimals === undefined) delete d.display.decimals;
                        if (!Object.keys(d.display).length) delete d.display;
                      })}
                    />
                  </Field>
                </div>
                <Field label="Note" hint="Shown beside the result">
                  <Text value={r().note} onCommit={(v) => updateRegion(r().id, { note: v || undefined })} />
                </Field>
                <Check
                  checked={!!r().disabled}
                  label="Exclude from calculation"
                  onChange={(on) => updateRegion(r().id, { disabled: on || undefined })}
                />
              </Match>
              <Match when={r().kind === "text"}>
                <Field label="Width" hint="Empty = grow to the page edge">
                  <Num value={r().width} placeholder="auto" onCommit={(v) => updateRegion(r().id, { width: v })} />
                </Field>
                <Field label="Font size (pt)">
                  <Num
                    value={r().style?.size}
                    placeholder={String(state.doc.styles?.body?.size ?? 10)}
                    step={0.5}
                    onCommit={(v) => updateRegion(r().id, (d) => {
                      d.style = { ...d.style, size: v };
                      if (d.style.size === undefined) delete d.style.size;
                      if (!Object.keys(d.style).length) delete d.style;
                    })}
                  />
                </Field>
              </Match>
              <Match when={r().kind === "image"}>
                <div class="insp-row">
                  <Field label="Width">
                    <Num
                      value={r().size?.[0]}
                      onCommit={(v) => v && updateRegion(r().id, { size: [v, Math.round((v * (r().size?.[1] ?? 1)) / (r().size?.[0] ?? 1))] })}
                    />
                  </Field>
                  <Field label="Height">
                    <Num value={r().size?.[1]} onCommit={(v) => v && updateRegion(r().id, { size: [r().size?.[0] ?? v, v] })} />
                  </Field>
                </div>
              </Match>
              <Match when={r().kind === "table"}>
                <Field label="Matrix shown" hint="Any expression giving a matrix">
                  <Text value={r().source ?? ""} mono onCommit={(v) => updateRegion(r().id, { source: v })} />
                </Field>
                <Check
                  checked={!!r().header?.row}
                  label="First row is a header"
                  onChange={(on) => updateRegion(r().id, { header: { ...r().header, row: on } })}
                />
                <Check
                  checked={!!r().header?.column}
                  label="First column is a header"
                  onChange={(on) => updateRegion(r().id, { header: { ...r().header, column: on } })}
                />
              </Match>
              <Match when={r().kind === "area"}>
                <Field label="Title">
                  <Text value={localized(r().title)} onCommit={(v) => updateRegion(r().id, { title: v })} />
                </Field>
                <Field label="Height">
                  <Num value={r().height} onCommit={(v) => updateRegion(r().id, { height: v })} />
                </Field>
                <Check checked={!!r().collapsed} label="Collapsed" onChange={(on) => updateRegion(r().id, { collapsed: on || undefined })} />
              </Match>
              <Match when={r().kind === "toc"}>
                <Field label="Lists">
                  <Select
                    value={(r().of as "headings" | "figures" | "tables") ?? "headings"}
                    options={[
                      ["headings", "Headings (table of contents)"],
                      ["figures", "Figures"],
                      ["tables", "Tables"],
                    ]}
                    onChange={(v) => updateRegion(r().id, { of: v })}
                  />
                </Field>
                <Field label="Title">
                  <Text value={String(r().title ?? "")} onCommit={(v) => updateRegion(r().id, { title: v })} />
                </Field>
              </Match>
            </Switch>
          </Section>
          <Show when={["image", "table", "plot2d", "plot3d"].includes(r().kind)}>
            <CaptionFields r={r()} />
          </Show>
        </>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export const LANGS: [string, string][] = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["pt-BR", "Português (Brasil)"],
  ["pt-PT", "Português (Portugal)"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
];

function setPath(d: Doc, path: string[], value: unknown) {
  let obj = d as Record<string, unknown>;
  for (const k of path.slice(0, -1)) {
    if (typeof obj[k] !== "object" || obj[k] === null) obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined || value === "") delete obj[last];
  else obj[last] = value;
}

const set = (path: string[]) => (value: unknown) => updateDoc((d) => setPath(d, path, value));

function DocumentTab() {
  const meta = () => state.doc.meta ?? {};
  const display = () => (state.doc.settings as { display?: Record<string, unknown> } | undefined)?.display ?? {};
  const numbering = () => state.doc.styles?.numbering ?? {};
  return (
    <>
      <Section title="Properties">
        <Field label="Title">
          <Text value={localized(meta().title)} onCommit={set(["meta", "title"])} />
        </Field>
        <Field label="Authors" hint="Comma-separated">
          <Text
            value={((meta().authors as string[] | undefined) ?? []).join(", ")}
            onCommit={(v) => set(["meta", "authors"])(v ? v.split(",").map((a) => a.trim()).filter(Boolean) : undefined)}
          />
        </Field>
        <Field label="Company">
          <Text value={meta().company as string | undefined} onCommit={set(["meta", "company"])} />
        </Field>
        <Field label="Language" hint="Dates, decimal separators, numbering words">
          <Select value={(meta().lang as string) ?? "en-US"} options={LANGS} onChange={set(["meta", "lang"])} />
        </Field>
      </Section>
      <Section title="Results">
        <div class="insp-row">
          <Field label="Decimals">
            <Num value={display().decimals as number | undefined} placeholder="4" onCommit={set(["settings", "display", "decimals"])} />
          </Field>
          <Field label="Scientific from 10^">
            <Num
              value={display().exponentialThreshold as number | undefined}
              placeholder="5"
              onCommit={set(["settings", "display", "exponentialThreshold"])}
            />
          </Field>
        </div>
        <Check
          checked={!!display().trailingZeros}
          label="Keep trailing zeros (2.50)"
          onChange={(on) => set(["settings", "display", "trailingZeros"])(on || undefined)}
        />
      </Section>
      <Section title="Numbering">
        <Check
          checked={numbering().headings !== ""}
          label="Number headings (1, 1.1, 1.1.1)"
          onChange={(on) => set(["styles", "numbering", "headings"])(on ? "1.1" : "")}
        />
        <Field label="Figure label" hint="{n} is the number">
          <Text value={numbering().figures ?? "Figure {n} –"} onCommit={set(["styles", "numbering", "figures"])} />
        </Field>
        <Field label="Table label">
          <Text value={numbering().tables ?? "Table {n} –"} onCommit={set(["styles", "numbering", "tables"])} />
        </Field>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const FIELDS = "{page}, {pages}, {date}, {title}…";

function mm(v: string | number | undefined, fallback: number): number {
  return Math.round((toPx(v, fallback * PX_PER_MM) / PX_PER_MM) * 10) / 10;
}

function HeaderFooter(props: { which: "header" | "footer" }) {
  const hf = () => (state.doc.page?.[props.which] as Record<string, string> | undefined) ?? {};
  return (
    <>
      <For each={["left", "center", "right"]}>
        {(slot) => (
          <Field label={`${props.which === "header" ? "Header" : "Footer"} ${slot}`}>
            <Text value={hf()[slot]} placeholder={FIELDS} onCommit={set(["page", props.which, slot])} />
          </Field>
        )}
      </For>
    </>
  );
}

function PageTab(props: { onAddBackground: () => void }) {
  const page = () => state.doc.page ?? {};
  const margins = () => (page().margins ?? {}) as Record<string, string | number>;
  const backgrounds = () => (page().backgrounds as Background[] | undefined) ?? [];
  const first = () => (page().firstPage as { header?: boolean; footer?: boolean } | undefined) ?? {};
  return (
    <>
      <Section title="Paper">
        <div class="insp-row">
          <Field label="Size">
            <Select
              value={typeof page().paper === "string" ? (page().paper as string) : "A4"}
              options={["A4", "A3", "A5", "Letter", "Legal"].map((p) => [p, p] as [string, string])}
              onChange={set(["page", "paper"])}
            />
          </Field>
          <Field label="Orientation">
            <Select
              value={(page().orientation as string) ?? "portrait"}
              options={[
                ["portrait", "Portrait"],
                ["landscape", "Landscape"],
              ]}
              onChange={(v) => set(["page", "orientation"])(v === "portrait" ? undefined : v)}
            />
          </Field>
        </div>
        <div class="insp-row four">
          <For each={["top", "bottom", "left", "right"]}>
            {(side) => (
              <Field label={`${side[0].toUpperCase()}${side.slice(1)} mm`}>
                <Num value={mm(margins()[side], 20)} step={0.5} onCommit={(v) => set(["page", "margins", side])(v === undefined ? undefined : `${v}mm`)} />
              </Field>
            )}
          </For>
        </div>
      </Section>
      <Section title="Header & footer">
        <HeaderFooter which="header" />
        <HeaderFooter which="footer" />
        <Check
          checked={first().header === false}
          label="No header on the first page"
          onChange={(on) => set(["page", "firstPage", "header"])(on ? false : undefined)}
        />
        <Check
          checked={first().footer === false}
          label="No footer on the first page"
          onChange={(on) => set(["page", "firstPage", "footer"])(on ? false : undefined)}
        />
        <Field label="First page number">
          <Num
            value={(page().pageNumber as { start?: number } | undefined)?.start}
            placeholder="1"
            onCommit={set(["page", "pageNumber", "start"])}
          />
        </Field>
      </Section>
      <Section title="Backgrounds">
        <For each={backgrounds()}>
          {(b, i) => (
            <div class="insp-bg">
              <Show when={state.assets[b.src]}>
                <img src={state.assets[b.src]} alt="" />
              </Show>
              <div class="insp-bg-fields">
                <Field label="Pages" hint="all, 1, 2-4, odd, even">
                  <Text value={b.pages ?? "all"} onCommit={(v) => updateDoc((d) => ((d.page!.backgrounds as Background[])[i()].pages = v || "all"))} />
                </Field>
                <Select
                  value={b.fit ?? "margins"}
                  options={[
                    ["margins", "Fit inside margins"],
                    ["page", "Fill the page"],
                  ]}
                  onChange={(v) => updateDoc((d) => ((d.page!.backgrounds as Background[])[i()].fit = v))}
                />
                <button class="insp-link" onClick={() => updateDoc((d) => (d.page!.backgrounds as Background[]).splice(i(), 1))}>
                  Remove
                </button>
              </div>
            </div>
          )}
        </For>
        <button class="insp-button" onClick={props.onAddBackground}>
          Add background image…
        </button>
      </Section>
    </>
  );
}

export function Inspector(props: { onAddBackground: () => void }) {
  return (
    <aside class="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <div class="insp-tabs">
        <For
          each={
            [
              ["region", "Region"],
              ["document", "Document"],
              ["page", "Page"],
            ] as [Tab, string][]
          }
        >
          {([t, label]) => (
            <button classList={{ on: tab() === t }} onClick={() => setTab(t)}>
              {label}
            </button>
          )}
        </For>
      </div>
      <div class="insp-body">
        <Switch>
          <Match when={tab() === "region"}>
            <RegionTab />
          </Match>
          <Match when={tab() === "document"}>
            <DocumentTab />
          </Match>
          <Match when={tab() === "page"}>
            <PageTab onAddBackground={props.onAddBackground} />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
