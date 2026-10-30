import { For, Show } from "solid-js";
import { type Background, fillFields, type HeaderFooter, pageMatches } from "./pages";
import { RegionBox } from "./Region";
import { layout, localized, type Placed, state } from "./store";

const px = (n: number) => `${n}px`;

function fileLabel(): string {
  return state.path?.replace(/\/+$/, "").split("/").pop() ?? "Untitled.quire";
}

function Slots(props: { hf: HeaderFooter; page: number; pages: number; style: Record<string, string> }) {
  const meta = () => state.doc.meta ?? {};
  const ctx = () => ({
    page: (state.doc.page?.pageNumber as { start?: number } | undefined)?.start ?? 1,
    pages: props.pages,
    file: fileLabel(),
    title: localized(meta().title, meta().lang),
    author: ((meta().authors as string[] | undefined) ?? []).join(", "),
    company: String(meta().company ?? ""),
    lang: meta().lang,
    now: new Date(),
  });
  const fill = (t: string | undefined) => (t ? fillFields(t, { ...ctx(), page: ctx().page + props.page }) : "");
  return (
    <div class="page-hf" style={{ ...props.style, color: props.hf.color ?? "#8a8f98" }}>
      <span class="hf-left">{fill(props.hf.left)}</span>
      <span class="hf-center">{fill(props.hf.center)}</span>
      <span class="hf-right">{fill(props.hf.right)}</span>
    </div>
  );
}

export function Sheet(props: { k: number; regions: Placed[]; onDragStart: (id: string, e: PointerEvent) => void }) {
  const g = () => layout().geom;
  const page = () => state.doc.page ?? {};
  const first = () =>
    props.k === 0 ? ((page().firstPage as { header?: boolean; footer?: boolean } | undefined) ?? {}) : {};
  const header = () => (first().header === false ? undefined : (page().header as HeaderFooter | undefined));
  const footer = () => (first().footer === false ? undefined : (page().footer as HeaderFooter | undefined));
  const backgrounds = () =>
    ((page().backgrounds as Background[] | undefined) ?? []).filter((b) => pageMatches(b.pages, props.k + 1));
  const m = () => g().margins;
  // what's on screen while editing; on paper, only pages with something on them
  const total = () => (state.printing ? layout().contentPages : layout().pages);

  return (
    <div
      class="sheet"
      style={{ width: px(g().paperW), height: px(g().paperH), "--sheet-h": px(g().paperH) }}
      data-page={props.k + 1}
    >
      <For each={backgrounds()}>
        {(b) => (
          <Show when={state.assets[b.src]}>
            <img
              class="page-bg"
              src={state.assets[b.src]}
              alt=""
              draggable={false}
              style={
                b.fit === "page"
                  ? { left: "0", top: "0", width: px(g().paperW), height: px(g().paperH) }
                  : { left: px(m().left), top: px(m().top), width: px(g().contentW), height: px(g().contentH) }
              }
            />
          </Show>
        )}
      </For>
      <Show when={header()}>
        <Slots
          hf={header()!}
          page={props.k}
          pages={total()}
          style={{ left: px(m().left), right: px(m().right), top: "0", height: px(m().top) }}
        />
      </Show>
      <Show when={footer()}>
        <Slots
          hf={footer()!}
          page={props.k}
          pages={total()}
          style={{ left: px(m().left), right: px(m().right), bottom: "0", height: px(m().bottom) }}
        />
      </Show>
      <Show when={!state.printing}>
        <div
          class="content-box"
          style={{ left: px(m().left), top: px(m().top), width: px(g().contentW), height: px(g().contentH) }}
        />
      </Show>
      <For each={props.regions.map((p) => p.region)}>
        {(region) => <RegionBox region={region} onDragStart={props.onDragStart} />}
      </For>
    </div>
  );
}
