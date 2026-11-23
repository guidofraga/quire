// App-wide preferences (Quire ▸ Settings…), kept on this machine, not in documents.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Doc } from "./types";

export type Theme = "system" | "light" | "dark";
export type CanvasPattern = "dots" | "grid" | "lines" | "plain";

export interface Prefs {
  theme: Theme;
  /** `\Delta` → Δ while typing, with the completion list. */
  latex: boolean;
  /** The faint mark on a name that may not mean what was meant (a redefinition, a name read as a unit). */
  nameNotes: boolean;
  /** Unit fractions on one line (`80 km/h`), in math and results. */
  flatUnits: boolean;
  /** The free canvas's background. */
  canvasPattern: CanvasPattern;
  /** On the free canvas, show the printable column and where pages break. */
  pageBreaks: boolean;
  /** What Quire shows when it starts. */
  onLaunch: "welcome" | "last" | "blank";
  /** Hover explanations for units and constants. */
  tooltips: boolean;
  /** Enter / Backspace on empty space open or close a line, moving what is below. */
  shiftContent: boolean;
  /** Resolution of images in exported PDFs; 0 keeps them as they are. */
  exportDpi: number;
  /** Store photos in exported PDFs as JPEG (macOS and Linux export; drawings stay lossless). */
  compressPhotos: boolean;
  // Defaults for new documents: empty font and size 0 leave the document's own (typography.ts)
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
  flatUnits: true,
  canvasPattern: "dots",
  pageBreaks: true,
  onLaunch: "welcome",
  tooltips: true,
  shiftContent: true,
  exportDpi: 300,
  compressPhotos: true,
  font: "",
  size: 0,
  decimals: 4,
  paper: "A4",
  view: "pages",
  lang: "",
};

const KEY = "quire.prefs";

function load(): Prefs {
  try {
    const stored = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    // 10 pt was the default before documents were typeset, stored with every other preference:
    // it meant "the default", not a choice
    if (stored.size === 10) stored.size = 0;
    return stored;
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

/** The stylesheet's dark rules, found once: `@media (prefers-color-scheme: dark)` blocks. */
const darkRules = new Set<CSSMediaRule>();

/**
 * Light or Dark from Settings, in a browser and on the web too (#150). A page can't change what
 * `prefers-color-scheme` reports, so the stylesheet's dark blocks are switched on (`all`) or
 * off (`not all`) here, and back to following the system for "Match system". The CSS itself
 * keeps one place for each dark rule.
 */
function applyThemeToStyles() {
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a stylesheet from another origin: not ours
    }
    for (const rule of rules)
      if (rule instanceof CSSMediaRule && rule.media.mediaText.includes("prefers-color-scheme: dark"))
        darkRules.add(rule);
  }
  const media = { system: "(prefers-color-scheme: dark)", dark: "all", light: "not all" }[prefs.theme];
  for (const rule of darkRules) rule.media.mediaText = media;
  // native controls and scrollbars follow too
  document.documentElement.style.colorScheme = prefs.theme === "system" ? "" : prefs.theme;
}

/** The window's appearance: the page's styles, and in the desktop app the native window too. */
export async function applyTheme() {
  applyThemeToStyles();
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .setTheme(prefs.theme === "system" ? null : prefs.theme)
    .catch(() => {});
}

/** Apply the new-document defaults to a fresh document from the engine. */
export function withDefaults(doc: Doc): Doc {
  const d = structuredClone(doc);
  d.settings = {
    ...(d.settings as object),
    display: {
      ...((d.settings as { display?: object })?.display ?? {}),
      decimals: prefs.decimals,
      resultUnits: "working",
    },
  };
  d.page = { ...(d.page ?? {}), paper: prefs.paper, view: prefs.view };
  if (prefs.lang) d.meta = { ...(d.meta ?? {}), lang: prefs.lang };
  const body = { ...(prefs.font ? { font: prefs.font } : {}), ...(prefs.size > 0 ? { size: prefs.size } : {}) };
  if (Object.keys(body).length) d.styles = { ...(d.styles ?? {}), body: { ...(d.styles?.body ?? {}), ...body } };
  return d;
}

export const [settingsOpen, setSettingsOpen] = createSignal(false);
