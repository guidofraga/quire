// Bridge to the Rust backend: Tauri commands in the app, `quire serve` over /api in a browser.
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
  save: (path: string, doc: Doc, from: string | null) => call<null>("save_document", { path, doc, from }),
  djotHtml: (src: string) => call<string>("djot_html", { src }),
  library: () => call<Library>("library"),
  importImage: (path: string) => call<string>("import_image", { path }),
  stageImage: (data: string, ext: string) => call<string>("stage_image", { data, ext }),
  readAsset: (bundle: string, src: string) => call<string>("read_asset", { bundle, src }),
  newDocument: () => call<Doc>("new_document"),
  print: (paper: Paper, title: string) => call<null>("print_document", { paper, title }),
  exportPdf: (path: string, paper: Paper, title: string) => call<null>("export_pdf", { path, paper, title }),
  finishExport: (error: string | null) => call<null>("finish_export", { error }),
};

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

export async function pickOpenPath(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ directory: true, title: "Open a Quire document (.quire)" });
    return typeof p === "string" ? p : null;
  }
  return window.prompt("Path to a .quire document");
}

export async function pickSavePath(suggested: string): Promise<string | null> {
  let p: string | null;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    p = await save({ defaultPath: suggested, filters: [{ name: "Quire document", extensions: ["quire"] }] });
  } else {
    p = window.prompt("Save as (a path ending in .quire)", suggested);
  }
  if (!p) return null;
  return p.endsWith(".quire") ? p : `${p}.quire`;
}

export async function confirmDiscard(): Promise<boolean> {
  const msg = "You have unsaved changes. Discard them?";
  if (isTauri) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(msg, { title: "Quire", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
  }
  return window.confirm(msg);
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

export async function guardClose(isDirty: () => boolean) {
  if (!isTauri) {
    window.addEventListener("beforeunload", (e) => {
      if (isDirty()) e.preventDefault();
    });
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (isDirty() && !(await confirmDiscard())) e.preventDefault();
  });
}
