import { For, Show } from "solid-js";
import { HeaderFooterBand } from "./HeaderFooterBand";
import { type Background, pageMatches } from "./pages";
import { RegionBox } from "./Region";
import { layout, type Placed, state } from "./store";

const px = (n: number) => `${n}px`;

export function Sheet(props: { k: number; regions: Placed[]; onDragStart: (id: string, e: PointerEvent) => void }) {
  const g = () => layout().geom;
  const page = () => state.doc.page ?? {};
  const backgrounds = () =>
    ((page().backgrounds as Background[] | undefined) ?? []).filter((b) => pageMatches(b.pages, props.k + 1));
  const m = () => g().margins;
  // what's on screen while editing; on paper, only pages with something on them
  const total = () => (state.printing ? layout().contentPages : layout().pages);

  return (
    <div
      class="sheet"
      classList={{ "hf-active": !!state.hfEditing }}
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
      <HeaderFooterBand
        band="header"
        k={props.k}
        pages={total()}
        style={{ left: px(m().left), right: px(m().right), top: "0", height: px(m().top) }}
      />
      <HeaderFooterBand
        band="footer"
        k={props.k}
        pages={total()}
        style={{ left: px(m().left), right: px(m().right), bottom: "0", height: px(m().bottom) }}
      />
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
