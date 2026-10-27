import { createEffect, createRoot, on, onMount, Show } from "solid-js";
import { reconcile, unwrap } from "solid-js/store";
import {
  api,
  confirmDiscard,
  confirmRestore,
  documentPath,
  exportJob,
  guardClose,
  isTauri,
  onMenu,
  onOpenFile,
  pickOpenPath,
  pickPdfPath,
  pickSavePath,
  setWindowTitle,
} from "./api";
import {
  addBackground,
  duplicateSelection,
  insertImage,
  insertImageBlob,
  insertImagePath,
  installContextMenus,
  isImagePath,
  onCopy,
  onPaste,
} from "./actions";
import { Canvas, clientToDoc, reveal, zoomCenter } from "./Canvas";
import { CompletionPopup } from "./Completion";
import { ContextMenu } from "./ContextMenu";
import { FormatBar } from "./FormatBar";
import { Inspector, setInspectorTab } from "./Inspector";
import { type Background, paperPoints } from "./pages";
import { NameTooltip } from "./Tooltip";
import { SettingsDialog } from "./SettingsDialog";
import { directPdf, shrinkImages } from "./export";
import { addRecent, clearRecent, forgetRecent, recentList, syncRecent } from "./recent";
import { applyTheme, prefs, setSettingsOpen, withDefaults } from "./settings";
import { type Align, activeView, commands, run as runText } from "./richtext";
import {
  type AlignMode,
  alignRegions,
  commitEditing,
  deleteRegions,
  distributeRegions,
  insertArea,
  insertAtCaret,
  insertContents,
  layout,
  loadDoc,
  localized,
  redo,
  selectAll,
  setState,
  state,
  togglePageView,
  undo,
} from "./store";

function fileName(path: string | null): string {
  if (!path) return localized(state.doc.meta?.title) || "Untitled";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.quirez?$/i, "");
}

function flash(message: string) {
  setState({ message });
  setTimeout(() => state.message === message && setState({ message: null }), 4000);
}

// ---------------------------------------------------------------------------
// Live evaluation: every document change re-runs the worksheet (≈0.3 ms in Rust).
// ---------------------------------------------------------------------------

let requestSeq = 0;
let reportPending = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleReport() {
  clearTimeout(timer);
  reportPending = true;
  timer = setTimeout(async () => {
    const seq = ++requestSeq;
    try {
      const report = await api.report(unwrap(state.doc));
      if (seq !== requestSeq) return;
      setState("report", report);
      setState("views", reconcile(Object.fromEntries(report.regions.map((v) => [v.id, v]))));
    } catch (e) {
      flash(String(e));
    } finally {
      if (seq === requestSeq) reportPending = false;
    }
  }, 30);
}

const loadingAssets = new Set<string>();

function loadAssets() {
  // images inserted into an unsaved document are served from the staging area
  const bundle = state.path ?? "";
  const backgrounds = (state.doc.page?.backgrounds as Background[] | undefined) ?? [];
  const sources = [...layout().list.map((p) => p.region.src), ...backgrounds.map((b) => b.src)];
  for (const src of sources) {
    if (!src || state.assets[src] || loadingAssets.has(src)) continue;
    loadingAssets.add(src);
    api
      .readAsset(bundle, src)
      .then((url) => setState("assets", src, url))
      .catch((e) => flash(`Image ${src}: ${e.message ?? e}`))
      .finally(() => loadingAssets.delete(src));
  }
}

// ---------------------------------------------------------------------------
// File commands
// ---------------------------------------------------------------------------

/**
 * While there are unsaved changes, keep a copy for crash recovery (a few seconds after
 * the last edit); once the document is saved or replaced, drop it.
 */
function keepRecovery() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // started after the awaits in onMount, so it needs its own reactive root
  createRoot(() =>
    createEffect(
      on([() => state.doc, () => state.dirty], ([doc, dirty]) => {
        clearTimeout(timer);
        if (!dirty) return void api.clearRecovery().catch(() => {});
        timer = setTimeout(() => void api.saveRecovery(unwrap(doc), state.path).catch(() => {}), 3000);
      }),
    ),
  );
}

async function guardUnsaved(): Promise<boolean> {
  return !state.dirty || (await confirmDiscard());
}

export async function newDocument() {
  if (!(await guardUnsaved())) return;
  loadDoc(withDefaults(await api.newDocument()), null);
}

export async function openPath(path: string) {
  try {
    const doc = await api.open(path);
    loadDoc(doc, path);
    addRecent(path);
  } catch (e) {
    flash(`Could not open ${fileName(path)}: ${(e as Error).message}`);
    // a moved or deleted file shouldn't stay in Open Recent
    forgetRecent(path);
  }
}

async function openDocument() {
  if (!(await guardUnsaved())) return;
  const path = await pickOpenPath();
  if (path) await openPath(path);
}

async function save(as = false) {
  commitEditing();
  let path = state.path;
  if (!path || as) {
    path = await pickSavePath(fileName(state.path));
    if (!path) return;
  }
  try {
    await api.save(path, unwrap(state.doc), state.path);
    setState({ path, dirty: false });
    addRecent(path);
    flash(`Saved ${fileName(path)}`);
  } catch (e) {
    flash(`Could not save: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Print / PDF: the page view *is* the print layout.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until evaluation, images, fonts and pagination have settled. */
async function settle() {
  await document.fonts.ready;
  for (let i = 0; i < 100 && (reportPending || loadingAssets.size > 0); i++) await sleep(50);
  // pagination reacts to measured heights; give it a few rounds to converge
  let last = "";
  for (let i = 0; i < 20; i++) {
    await sleep(80);
    const sig = layout().list.map((p) => `${p.page}:${Math.round(p.top)}`).join(",");
    if (sig === last) break;
    last = sig;
  }
}

async function withPrintLayout(run: () => Promise<unknown>) {
  commitEditing();
  const g = layout().geom;
  const pageRule = document.createElement("style");
  pageRule.textContent = `@page { size: ${g.paperW}px ${g.paperH}px; margin: 0; }`;
  document.head.appendChild(pageRule);
  setState({ printing: true, selection: [], caret: null });
  let restoreImages = () => {};
  try {
    await settle();
    restoreImages = await shrinkImages(prefs.exportDpi);
    await run();
  } finally {
    restoreImages();
    setState({ printing: false });
    pageRule.remove();
  }
}

const docTitle = () => fileName(state.path);

async function exportPdf(target?: string) {
  // Windows and Linux save PDFs from the system print dialog
  if (isTauri && !directPdf && !target) return printDocument();
  const path = target ?? (await pickPdfPath(`${docTitle()}.pdf`));
  if (!path) return;
  await withPrintLayout(async () => {
    if (isTauri) await api.exportPdf(path, paperPoints(layout().geom), docTitle(), prefs.compressPhotos);
    else window.print();
  });
  if (isTauri) flash(`Exported ${path.split("/").pop()}`);
}

async function printDocument() {
  await withPrintLayout(async () => {
    if (isTauri && directPdf) await api.print(paperPoints(layout().geom), docTitle());
    // blocks until the dialog closes, so the print layout stays up while it previews
    else window.print();
  });
}

async function runExportJob(job: { open: string; pdf: string }) {
  try {
    const doc = await api.open(job.open);
    loadDoc(doc, job.open);
    await settle();
    await exportPdf(job.pdf);
    await api.finishExport(null);
  } catch (e) {
    await api.finishExport(String((e as Error).message ?? e));
  }
}

function nextError() {
  const errors = (state.report?.regions ?? []).filter((v) => v.error);
  if (!errors.length) return;
  const current = errors.findIndex((v) => v.id === state.selection[0]);
  reveal(errors[(current + 1) % errors.length].id);
}

const TEXT_FORMAT: Record<string, () => void> = {
  fmt_bold: () => runText(commands.bold),
  fmt_italic: () => runText(commands.italic),
  fmt_underline: () => runText(commands.underline),
  fmt_strike: () => runText(commands.strike),
  fmt_bullets: () => runText(commands.bulletList),
  fmt_numbers: () => runText(commands.orderedList),
};

function showInspector(tab: "region" | "document" | "page") {
  setInspectorTab(tab);
  setState({ inspector: true });
}

function runCommand(id: string) {
  const editingField = !!state.editing;
  if (TEXT_FORMAT[id]) return activeView() ? TEXT_FORMAT[id]() : undefined;
  if (id.startsWith("fmt_align_")) return activeView() && runText(commands.align(id.slice(10) as Align));
  if (id.startsWith("arrange_")) return alignRegions(state.selection, id.slice(8) as AlignMode);
  if (id.startsWith("recent:")) {
    const path = recentList()[Number(id.slice(7))];
    if (path) void guardUnsaved().then((ok) => (ok ? openPath(path) : undefined));
    return;
  }
  switch (id) {
    case "recent_clear":
      return clearRecent();
    case "distribute_x":
      return distributeRegions(state.selection, "x");
    case "distribute_y":
      return distributeRegions(state.selection, "y");
    case "duplicate":
      return duplicateSelection();
    case "insert_image":
      return insertImage().catch((e) => flash(`Could not insert the image: ${e.message ?? e}`));
    case "insert_toc":
      return insertContents("headings");
    case "insert_figures":
      return insertContents("figures");
    case "insert_tables":
      return insertContents("tables");
    case "toggle_inspector":
      return setState({ inspector: !state.inspector });
    case "region_properties":
      return showInspector("region");
    case "document_settings":
      return showInspector("document");
    case "page_setup":
      return showInspector("page");
    case "new":
      return newDocument();
    case "open":
      return openDocument();
    case "save":
      return save();
    case "save_as":
      return save(true);
    case "undo":
      if (activeView()) return runText(commands.undo);
      return editingField ? document.execCommand("undo") : undo();
    case "redo":
      if (activeView()) return runText(commands.redo);
      return editingField ? document.execCommand("redo") : redo();
    case "select_all":
      return editingField ? document.execCommand("selectAll") : selectAll();
    case "delete":
      return editingField ? document.execCommand("delete") : deleteRegions(state.selection);
    case "settings":
      commitEditing();
      return setSettingsOpen(true);
    case "insert_math":
      return insertAtCaret("math");
    case "insert_text":
      return insertAtCaret("text");
    case "insert_area":
      return insertArea();
    case "zoom_in":
      return zoomCenter(1.2);
    case "zoom_out":
      return zoomCenter(1 / 1.2);
    case "zoom_reset":
      return zoomCenter("reset");
    case "next_error":
      return nextError();
    case "page_view":
      return togglePageView();
    case "export_pdf":
      return exportPdf().catch((e) => flash(`Could not export: ${e.message ?? e}`));
    case "print":
      return printDocument().catch((e) => flash(`Could not print: ${e.message ?? e}`));
  }
}

/** In a plain browser there is no native menu; map the same shortcuts. */
function browserShortcuts(e: KeyboardEvent) {
  if (isTauri || !(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  const map: Record<string, string> = {
    s: e.shiftKey ? "save_as" : "save",
    o: "open",
    z: e.shiftKey ? "redo" : "undo",
    p: e.shiftKey ? "page_view" : "print",
    e: "export_pdf",
    d: "duplicate",
    i: e.altKey ? "toggle_inspector" : "",
    "=": "zoom_in",
    "-": "zoom_out",
    "0": "zoom_reset",
    "'": "next_error",
    ",": e.altKey ? "" : "settings",
  };
  if (key === "a" && state.editing) return;
  const cmd = key === "a" ? "select_all" : map[key];
  if (cmd && !(state.editing && (cmd === "undo" || cmd === "redo" || cmd === "duplicate"))) {
    e.preventDefault();
    runCommand(cmd);
  }
}

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__quire = { state, layout };

export function App() {
  createEffect(on(() => state.rev, scheduleReport));
  createEffect(on(() => [state.path, layout()] as const, loadAssets));
  createEffect(() => {
    void setWindowTitle(`${fileName(state.path)}${state.dirty ? " — Edited" : ""}`);
  });

  onMount(async () => {
    installContextMenus(runCommand);
    // the window itself never scrolls (focus can try to)
    window.addEventListener("scroll", () => window.scrollTo(0, 0));
    document.getElementById("root")?.addEventListener("scroll", (e) => {
      const el = e.currentTarget as HTMLElement;
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
    document.addEventListener("copy", (e) => onCopy(e, false));
    document.addEventListener("cut", (e) => onCopy(e, true));
    document.addEventListener("paste", (e) => void onPaste(e));
    // images dropped on the canvas
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const at = clientToDoc(e.clientX, e.clientY);
      files.forEach((f, i) => insertImageBlob(f, [at[0] + i * 18, at[1] + i * 18]).catch((err) => flash(String(err))));
    });
    if (isTauri) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().onDragDropEvent((ev) => {
        if (ev.payload.type !== "drop") return;
        const ratio = window.devicePixelRatio || 1;
        const at = clientToDoc(ev.payload.position.x / ratio, ev.payload.position.y / ratio);
        ev.payload.paths
          .filter(isImagePath)
          .forEach((path, i) => insertImagePath(path, [at[0] + i * 18, at[1] + i * 18]).catch((err) => flash(String(err))));
      });
    }
    void applyTheme();
    syncRecent();
    await onMenu(runCommand);
    await guardClose(() => state.dirty, api.clearRecovery);
    window.addEventListener("keydown", browserShortcuts);
    if (exportJob) return runExportJob(exportJob);
    await onOpenFile(async (path) => {
      if (await guardUnsaved()) await openPath(path);
    });
    const requested = await api.takeOpenRequests().catch(() => [] as string[]);
    const recovered = await api.takeRecovery().catch(() => null);
    if (recovered?.doc && (await confirmRestore(fileName(recovered.path)))) {
      loadDoc(recovered.doc, recovered.path);
      setState({ dirty: true });
    } else {
      const open = requested.map(documentPath)[0] ?? new URLSearchParams(location.search).get("open");
      if (open) await openPath(open);
      else loadDoc(await api.newDocument().then(withDefaults).catch(() => state.doc), null);
    }
    keepRecovery();
  });

  const regionCount = () => state.report?.regions.length ?? 0;

  return (
    <div class="app" classList={{ tauri: isTauri, printing: state.printing }}>
      <header class="toolbar" data-tauri-drag-region>
        <div class="title" data-tauri-drag-region>
          {fileName(state.path)}
          <Show when={state.dirty}>
            <span class="edited"> — Edited</span>
          </Show>
        </div>
        <div class="tools">
          <button onClick={() => insertAtCaret("math")} title="Insert math (⇧⌘M)">
            <span class="glyph math-glyph">
              x<sup>2</sup>
            </span>
            Math
          </button>
          <button onClick={() => insertAtCaret("text")} title="Insert text (⇧⌘T)">
            <span class="glyph">¶</span> Text
          </button>
          <button onClick={() => runCommand("insert_image")} title="Insert image">
            <span class="glyph">▣</span> Image
          </button>
          <button onClick={insertArea} title="Insert area">
            <span class="glyph">▤</span> Area
          </button>
          <button onClick={() => runCommand("insert_toc")} title="Insert table of contents">
            <span class="glyph">☰</span> Contents
          </button>
        </div>
        <div class="status" data-tauri-drag-region>
          <Show when={(state.report?.errorCount ?? 0) > 0}>
            <button class="errors" onClick={nextError} title="Go to next error (⌘')">
              {state.report!.errorCount} {state.report!.errorCount === 1 ? "error" : "errors"}
            </button>
          </Show>
          <span class="muted" data-tauri-drag-region>
            {regionCount()} math · {(state.report?.elapsedMs ?? 0).toFixed(2)} ms
          </span>
          <div class="segmented" role="group" aria-label="View">
            <button classList={{ on: !layout().pageView }} onClick={() => layout().pageView && togglePageView()} title="Free canvas">
              Canvas
            </button>
            <button classList={{ on: layout().pageView }} onClick={() => !layout().pageView && togglePageView()} title="Page view (⇧⌘P)">
              Pages
            </button>
          </div>
          <button
            class="icon-btn"
            classList={{ on: state.inspector }}
            onClick={() => runCommand("toggle_inspector")}
            title="Inspector (⌥⌘I)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M10 2.5v11" />
            </svg>
          </button>
          <button class="zoom" onClick={() => zoomCenter("reset")} title="Actual size (⌘0)">
            {Math.round(state.view.zoom * 100)}%
          </button>
        </div>
      </header>
      <FormatBar />
      <div class="workspace">
        <Canvas />
        <Show when={state.inspector}>
          <Inspector onAddBackground={() => addBackground().catch((e) => flash(String(e)))} />
        </Show>
      </div>
      <ContextMenu />
      <CompletionPopup />
      <NameTooltip />
      <SettingsDialog />
      <Show when={state.message}>
        <div class="toast" onClick={() => setState({ message: null })}>
          {state.message}
        </div>
      </Show>
    </div>
  );
}
