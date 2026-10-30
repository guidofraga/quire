// Hover explanations for names in typeset math: what `g` or `kN` means here.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { valueText } from "./insert";
import { prefs } from "./settings";
import { state } from "./store";

export function NameTooltip() {
  const [tip, setTip] = createSignal<{ x: number; y: number; name: string; title: string; value: string } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = (e: MouseEvent) => {
    const el = (e.target as Element).closest?.("[data-k]");
    clearTimeout(timer);
    if (!el || state.editing || !prefs.tooltips) return setTip(null);
    const key = el.getAttribute("data-k")!;
    const g = state.report?.glossary[key];
    if (!g) return setTip(null);
    const rect = el.getBoundingClientRect();
    const name = key.split(":").slice(1).join(":");
    timer = setTimeout(
      () => setTip({ x: rect.left, y: rect.bottom + 6, name, title: g.title, value: valueText(g.value) }),
      350,
    );
  };
  const hide = () => {
    clearTimeout(timer);
    setTip(null);
  };
  onMount(() => {
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide);
  });
  onCleanup(() => {
    document.removeEventListener("mouseover", over);
    document.removeEventListener("mousedown", hide);
  });
  return (
    <Show when={tip()}>
      {(t) => (
        <div class="name-tooltip" role="tooltip" style={{ left: `${t().x}px`, top: `${t().y}px` }}>
          <b>{t().name.replace(".", "")}</b> {t().title}
          <Show when={t().value}>
            <span class="tip-value">= {t().value}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}
