// App-wide preferences (Quire ▸ Settings…), kept on this machine, not in documents.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Doc } from "./types";

export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  /** `\Delta` → Δ while typing, with the completion list. */
  latex: boolean;
  /** Notes under the math being edited when a name could mean something else. */
  nameNotes: boolean;
  /** Hover explanations for units and constants. */
  tooltips: boolean;
  /** Enter / Backspace on empty space open or close a line, moving what is below. */
  shiftContent: boolean;
  // Defaults for new documents
  font: string;
  size: number;
  decimals: number;
  paper: string;
  view: "pages" | "canvas";
  lang: string;
}

const DEFAULTS: Prefs = {
  theme: "system",
  latex: true,
  nameNotes: true,
  tooltips: true,
  shiftContent: true,
  font: "",
  size: 10,
  decimals: 4,
  paper: "A4",
  view: "pages",
  lang: "",
};

const KEY = "quire.prefs";

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

const [prefs, setPrefs] = createStore<Prefs>(load());
export { prefs };

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefs(key, value);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // private window or blocked storage: the setting lasts for this session
  }
  if (key === "theme") void applyTheme();
}

export function resetPrefs() {
  setPrefs({ ...DEFAULTS });
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  void applyTheme();
}

/** The window's appearance; the web view's `prefers-color-scheme` follows it. */
export async function applyTheme() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .setTheme(prefs.theme === "system" ? null : prefs.theme)
    .catch(() => {});
}

/** Apply the new-document defaults to a fresh document from the engine. */
export function withDefaults(doc: Doc): Doc {
  const d = structuredClone(doc);
  d.settings = { ...(d.settings as object), display: { ...((d.settings as { display?: object })?.display ?? {}), decimals: prefs.decimals } };
  d.page = { ...(d.page ?? {}), paper: prefs.paper, view: prefs.view };
  if (prefs.lang) d.meta = { ...(d.meta ?? {}), lang: prefs.lang };
  const body = { ...(prefs.font ? { font: prefs.font } : {}), ...(prefs.size !== 10 ? { size: prefs.size } : {}) };
  if (Object.keys(body).length) d.styles = { ...(d.styles ?? {}), body: { ...(d.styles?.body ?? {}), ...body } };
  return d;
}

export const [settingsOpen, setSettingsOpen] = createSignal(false);
