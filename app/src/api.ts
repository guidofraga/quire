// Bridge to the Rust backend: Tauri commands in the app, `quire serve` over /api in a browser.
import type { PdfInfo } from "./export";
import type { Doc, Library, Report } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(String(e));
    }
  }
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-quire-dev": "1" },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => {
    throw new Error(`the Quire backend is not reachable (HTTP ${res.status}); is \`quire serve\` running?`);
  });
  if (!res.ok) throw new Error(body?.error ?? res.statusText);
  return body as T;
}

export const api = {
  report: (doc: Doc) => call<Report>("report", { doc }),
  open: (path: string) => call<Doc>("open_document", { path }),
  importSm: (path: string) => call<{ doc: Doc; origin: string; warnings: string[] }>("import_sm", { path }),
  save: (path: string, doc: Doc, from: string | null) => call<null>("save_document", { path, doc, from }),
  djotHtml: (src: string) => call<string>("djot_html", { src }),
  library: () => call<Library>("library"),
  importImage: (path: string) => call<string>("import_image", { path }),
  stageImage: (data: string, ext: string) => call<string>("stage_image", { data, ext }),
  readAsset: (bundle: string, src: string) => call<string>("read_asset", { bundle, src }),
  newDocument: () => call<Doc>("new_document"),
  listTemplates: () => call<TemplateInfo[]>("list_templates"),
  openTemplate: (id: string) => call<{ doc: Doc; origin: string | null }>("open_template", { id }),
  saveTemplate: (name: string, description: string, doc: Doc, from: string | null) =>
    call<string>("save_template", { name, description, doc, from }),
  deleteTemplate: (id: string) => call<null>("delete_template", { id }),
  print: (paper: Paper, title: string) => call<null>("print_document", { paper, title }),
  exportPdf: (path: string, paper: Paper, title: string, compress: boolean, info: PdfInfo) =>
    call<null>("export_pdf", { path, paper, title, compress, info }),
  finishExport: (error: string | null) => call<null>("finish_export", { error }),
  exportCsv: (path: string, contents: string) => call<null>("export_csv", { path, contents }),
  /** Documents the system asked to open before the UI was ready (Finder, Explorer, command line). */
  saveRecovery: (doc: Doc, path: string | null) =>
    isTauri ? call<null>("save_recovery", { doc, path }) : Promise.resolve(null),
  takeRecovery: () =>
    isTauri ? call<{ doc: Doc; path: string | null } | null>("take_recovery") : Promise.resolve(null),
  clearRecovery: () => (isTauri ? call<null>("clear_recovery") : Promise.resolve(null)),
  setRecent: (paths: string[]) => (isTauri ? call<null>("set_recent", { paths }) : Promise.resolve(null)),
  takeOpenRequests: () => (isTauri ? call<string[]>("take_open_requests") : Promise.resolve([] as string[])),
};

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

export interface Paper {
  widthPt: number;
  heightPt: number;
}

/** Set by `quire-app --export-pdf <in> <out>` (headless export). */
export const exportJob = (window as unknown as { __QUIRE_EXPORT__?: { open: string; pdf: string } }).__QUIRE_EXPORT__;

export async function pickPdfPath(suggested: string): Promise<string | null> {
  let p: string | null;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    p = await save({ defaultPath: suggested, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  } else {
    p = suggested;
  }
  if (!p) return null;
  return p.toLowerCase().endsWith(".pdf") ? p : `${p}.pdf`;
}

export const isMac = /Mac/.test(navigator.userAgent);

/**
 * Documents are `.quire` folders (a single file in the Finder, where they are packages)
 * or `.quirez` single files. Windows and Linux save single files: a folder that should
 * open like a file is not something those systems do.
 */
export const DOC_EXT = isMac ? "quire" : "quirez";

/** `…/x.quire/document.json` (picked in a file dialog) means the `x.quire` bundle. */
export function documentPath(p: string): string {
  return p.replace(/[\\/]document\.json$/i, "");
}

export async function pickOpenPath(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const extensions = isMac ? ["quire", "quirez"] : ["quirez", "json"];
    const p = await open({
      title: "Open",
      filters: [
        { name: "Quire document or SMath worksheet", extensions: [...extensions, "sm"] },
        { name: "Quire document", extensions },
        { name: "SMath Studio worksheet", extensions: ["sm"] },
      ],
    });
    return typeof p === "string" ? documentPath(p) : null;
  }
  return window.prompt("Path to a .quire, .quirez or SMath .sm document");
}

export async function pickSavePath(suggested: string): Promise<string | null> {
  let p: string | null;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filters = isMac
      ? [
          { name: "Quire document", extensions: ["quire"] },
          { name: "Quire single file (for email and other systems)", extensions: ["quirez"] },
        ]
      : [{ name: "Quire document", extensions: ["quirez"] }];
    p = await save({ defaultPath: `${suggested}.${DOC_EXT}`, filters });
  } else {
    p = window.prompt("Save as (a path ending in .quire or .quirez)", `${suggested}.${DOC_EXT}`);
  }
  if (!p) return null;
  return /\.quirez?$/i.test(p) ? p : `${p}.${DOC_EXT}`;
}

/** After a crash: put back the unsaved work? */
export async function confirmRestore(name: string): Promise<boolean> {
  const msg = `Quire closed before your changes to “${name}” were saved. Restore them?`;
  if (isTauri) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(msg, { title: "Restore unsaved changes", kind: "info", okLabel: "Restore", cancelLabel: "Discard" });
  }
  return window.confirm(msg);
}

export async function confirmDiscard(): Promise<boolean> {
  const msg = "You have unsaved changes. Discard them?";
  if (isTauri) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(msg, { title: "Quire", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
  }
  return window.confirm(msg);
}

/** Documents opened from the system while the app is running. */
export async function onOpenFile(handler: (path: string) => void) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("open-file", (e) => handler(documentPath(e.payload)));
}

export async function onMenu(handler: (id: string) => void) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("menu", (e) => handler(e.payload));
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  }
}

export async function guardClose(isDirty: () => boolean, onDiscard: () => Promise<unknown>) {
  if (!isTauri) {
    window.addEventListener("beforeunload", (e) => {
      if (isDirty()) e.preventDefault();
    });
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (!isDirty()) return;
    if (await confirmDiscard()) await onDiscard().catch(() => {});
    else e.preventDefault();
  });
}
