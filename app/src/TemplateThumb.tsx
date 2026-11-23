// A template's first page in miniature, for the Welcome screen and the templates dialog.
import { createResource, For } from "solid-js";
import { api, type TemplateInfo } from "./api";
import { type Shape, thumbnail, type Thumbnail } from "./thumbnail";

/** First pages of the templates, drawn once per session (a template rarely changes meanwhile). */
const thumbs = new Map<string, Promise<Thumbnail | null>>();
const thumbOf = (t: TemplateInfo) => {
  const key = `${t.id}\n${t.name}`;
  if (!thumbs.has(key))
    thumbs.set(
      key,
      api.openTemplate(t.id).then(
        ({ doc }) => thumbnail(doc),
        () => null,
      ),
    );
  return thumbs.get(key)!;
};

/** One shape of a miniature page; the page is paper-white in either theme, as on the canvas. */
function ThumbShape(props: { s: Shape }) {
  const s = props.s;
  if (s.kind === "rule") return <line class="t-rule" x1={s.x} y1={s.y} x2={s.x + s.w} y2={s.y} />;
  if (s.kind === "curve") {
    const d = `M${s.x} ${s.y + s.h * 0.8}C${s.x + s.w * 0.3} ${s.y - s.h * 0.2} ${s.x + s.w * 0.55} ${s.y + s.h * 1.1} ${s.x + s.w} ${s.y + s.h * 0.15}`;
    return <path class="t-curve" d={d} />;
  }
  return (
    <rect
      class={`t-${s.kind}`}
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      rx={s.kind === "box" || s.kind === "fill" ? 0 : s.h / 2}
    />
  );
}

/** A template's first page in miniature; a plain sheet until it is drawn. */
export function TemplateThumb(props: { t: TemplateInfo; width?: number }) {
  const [thumb] = createResource(() => props.t, thumbOf);
  // A4 until the document says otherwise, so the row doesn't change height
  const w = () => thumb()?.width ?? 794;
  const h = () => thumb()?.height ?? 1123;
  return (
    <svg
      class="welcome-thumb"
      viewBox={`0 0 ${w()} ${h()}`}
      width={props.width ?? 40}
      height={Math.round(((props.width ?? 40) * h()) / w())}
      aria-hidden="true"
    >
      <rect class="t-paper" x="0" y="0" width={w()} height={h()} />
      <For each={thumb()?.shapes ?? []}>{(s) => <ThumbShape s={s} />}</For>
    </svg>
  );
}
