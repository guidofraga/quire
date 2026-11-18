// The chrome's small icons: one 16 px line set, drawn inline (no icon font to download),
// in the stroke of the format bar's icons so they sit together.
import type { JSX } from "solid-js";

const DOC = "M4 1.8h5.2L12 4.6v9.6H4zM9 1.8v3h3";
const LENS = "M10.2 10.2L14 14M11.2 6.8a4.4 4.4 0 1 1-8.8 0a4.4 4.4 0 1 1 8.8 0";

const PATHS = {
  doc: DOC,
  newDoc: `${DOC}M8 7.4v4.2M5.9 9.5h4.2`,
  note: "M4 1.8h8v12.4H4zM6.2 5h3.6M6.2 7.6h3.6M6.2 10.2h2.2",
  folder: "M1.8 4.2a1 1 0 0 1 1-1h3.4l1.5 1.6h5.5a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z",
  newFolder:
    "M1.8 4.2a1 1 0 0 1 1-1h3.4l1.5 1.6h5.5a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1zM8 7.4v4M6 9.4h4",
  notebook: "M3 2.2h8.4a1.3 1.3 0 0 1 1.3 1.3v10.3H4.3A1.3 1.3 0 0 1 3 12.5zM3 12.5a1.3 1.3 0 0 1 1.3-1.3h8.4",
  template: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  save: "M8 2v8M4.8 6.8L8 10l3.2-3.2M2.5 11v2.5h11V11",
  export: "M8 10V2M4.8 5.2L8 2l3.2 3.2M2.5 11v2.5h11V11",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.7-3.7L5.3 7.8",
  print: "M4.5 6V2h7v4M4.5 11.5h-2V6h11v5.5h-2M4.5 9.5h7V14h-7z",
  settings:
    "M2 4.5h6.9M12.1 4.5H14M2 11.5h1.9M7.1 11.5H14M12.1 4.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 1 1 3.2 0M7.1 11.5a1.6 1.6 0 1 1-3.2 0a1.6 1.6 0 1 1 3.2 0",
  page: "M3.5 1.8h9v12.4h-9zM5.8 4.8h4.4M5.8 7.4h4.4M5.8 10h2.6",
  header: "M3 2h10v12H3zM3 5h10",
  footer: "M3 2h10v12H3zM3 11h10",
  undo: "M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7",
  redo: "M10.5 3.5l3 3-3 3M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9",
  duplicate: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  selectAll: "M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11M6 6h4v4H6z",
  find: LENS,
  math: "M12 3H4l4.5 5L4 13h8",
  text: "M7 13.5v-11M10 13.5v-11M12.5 2.5h-6a3 3 0 0 0 0 6H7",
  image: "M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.6 6h.01",
  table: "M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 3v10",
  plot: "M2.5 2.5v11h11M4.5 11c2-6 4-6 5-3s2 2 3.5-3",
  plot3d: "M8 2l5.5 3v6L8 14l-5.5-3V5zM2.5 5L8 8l5.5-3M8 8v6",
  sketch: "M2 8.5h12M3.5 8.5L2 11.5h3zM12.5 8.5L11 11.5h3zM8 2.5v4.5M6.3 5.2L8 7l1.7-1.8",
  area: "M2.5 3h11v3h-11zM4.5 9h9M4.5 12h9M2.5 8v5",
  solve: "M3 4.5h10M3 8h10M3 11.5h5.5M10 11.2l1.4 1.4 2.6-3",
  pageBreak: "M3.5 2v4h9V2M3.5 14v-4h9v4M1.5 8h2M6.5 8h3M12.5 8h2",
  ref: "M6.2 2.5l-1.4 11M11.2 2.5l-1.4 11M3 6h10.5M2.5 10H13",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  check: "M3 8.5l3 3 7-7",
  guides: "M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12",
  sidebar: "M2.5 3h11v10h-11zM6 3v10",
  inspector: "M2.5 3h11v10h-11zM10 3v10",
  zoomIn: `${LENS}M6.8 4.8v4M4.8 6.8h4`,
  zoomOut: `${LENS}M4.8 6.8h4`,
  fitWidth: "M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5",
  fitPage: "M3.5 1.8h9v12.4h-9zM8 4.5v7M6 6.5l2-2 2 2M6 9.5l2 2 2-2",
  error: "M8 2l6.5 11.5h-13zM8 6.5V10M8 12h.01",
  help: "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.4M8 11.6h.01M14.5 8a6.5 6.5 0 1 1-13 0a6.5 6.5 0 1 1 13 0",
  update: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  home: "M2.5 7.5L8 2.5l5.5 5M4 6.5v7h8v-7",
  format: "M3 13.5h10M5 10.5L8 2.5l3 8M6 8.3h4",
  align: "M2 3h12M2 6.5h8M2 10h12M2 13.5h8",
  arrange: "M2 2v12M4 4h8M4 8h5M4 12h9",
  variable: "M3 6h.01M3 10h.01M6 6h7M6 10h7",
  command: "M6 4l4 4-4 4",
} as const;

export type IconName = keyof typeof PATHS;

/** A 16 px line icon; decorative, so hidden from screen readers. */
export function Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
  return (
    <svg
      class={props.class}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
