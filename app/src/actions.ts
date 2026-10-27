// Document actions that span the UI: clipboard, images, duplicate, context menus.
import { unwrap } from "solid-js/store";
import { api, isTauri } from "./api";
import { latex } from "./latex";
import { prettyValue } from "./math";
import { closeMenu, type MenuItems, setRegionMenuBuilder } from "./menu";
import type { Background } from "./pages";
import {
  availableWidth,
  commitEditing,
  deleteRegions,
  flash,
  GRID,
  layout,
  mutate,
  newId,
  type Placed,
  setState,
  snap,
  startEditing,
  state,
  updateRegion,
} from "./store";
import type { Region } from "./types";

const MIME = "application/x-quire-regions";
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** Regions copied in this session (the context menu can't read the system clipboard). */
let internalClipboard: Region[] = [];

function cloneWithNewIds(r: Region): Region {
  const copy = structuredClone(unwrap(r)) as Region;
  const renew = (x: Region) => {
    x.id = newId();
    x.regions?.forEach(renew);
  };
  renew(copy);
  return copy;
}

/** The selected regions with absolute positions (children of areas lifted out). */
function selectedRegions(): Region[] {
  const ids = new Set(state.selection);
  return layout()
    .list.filter((p) => ids.has(p.region.id) && !(p.parent && ids.has(p.parent.id)))
    .map((p: Placed) => ({ ...structuredClone(unwrap(p.region)), at: [p.x, p.y] as [number, number] }));
}

function plainTextOf(regions: Region[]): string {
  return regions
    .map((r) => (r.kind === "math" ? (r.expr ?? "") + (r.show ? " =" : "") : typeof r.text === "string" ? r.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Text for the next copy event (Copy Result, Copy as LaTeX). */
let pendingText: string | null = null;

function copyText(text: string, what: string) {
  pendingText = text;
  const ok = document.execCommand("copy");
  pendingText = null;
  flash(ok ? `Copied ${what}` : "Could not copy");
}

export function onCopy(e: ClipboardEvent, cut: boolean) {
  if (pendingText !== null) {
    e.clipboardData?.setData("text/plain", pendingText);
    e.preventDefault();
    return;
  }
  if (state.editing || isTextField(e.target) || !state.selection.length) return;
  const regions = selectedRegions();
  internalClipboard = regions;
  e.clipboardData?.setData(MIME, JSON.stringify(regions));
  e.clipboardData?.setData("text/plain", plainTextOf(regions));
  e.preventDefault();
  if (cut) deleteRegions(state.selection);
}

function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("input:not(.key-sink), textarea:not(.key-sink), [contenteditable=true], .inspector");
}

export function pasteRegions(regions: Region[]) {
  if (!regions.length) return;
  commitEditing();
  const minX = Math.min(...regions.map((r) => r.at[0]));
  const minY = Math.min(...regions.map((r) => r.at[1]));
  const [tx, ty] = state.caret ?? [minX + GRID * 2, minY + GRID * 2];
  const pasted = regions.map((r) => {
    const c = cloneWithNewIds(r);
    c.at = [Math.max(0, snap(c.at[0] - minX + tx)), Math.max(0, snap(c.at[1] - minY + ty))];
    return c;
  });
  mutate((d) => {
    d.regions.push(...pasted);
  });
  setState({ selection: pasted.map((r) => r.id), caret: null });
}

const looksLikeMath = (t: string) => !t.includes("\n") && /(:=|=|[+\-*/^]|\d)/.test(t) && t.trim().split(/\s+/).length <= 6;

function escapeDjot(t: string) {
  return t.replace(/[\\*_[\]{}`~^$<>#|]/g, "\\$&");
}

export async function onPaste(e: ClipboardEvent) {
  if (state.editing || isTextField(e.target)) return;
  const data = e.clipboardData;
  if (!data) return;
  const json = data.getData(MIME);
  if (json) {
    e.preventDefault();
    pasteRegions(JSON.parse(json) as Region[]);
    return;
  }
  const image = [...data.files].find((f) => f.type.startsWith("image/"));
  if (image) {
    e.preventDefault();
    await insertImageBlob(image);
    return;
  }
  const text = data.getData("text/plain").trim();
  if (!text) return;
  e.preventDefault();
  commitEditing();
  const [x, y] = state.caret ?? [GRID * 4, GRID * 4];
  const id = newId();
  mutate((d) => {
    d.regions.push(
      looksLikeMath(text)
        ? { id, kind: "math", at: [x, y], expr: text.replace(/\s*=\s*$/, ""), ...(/=\s*$/.test(text) && !/:=\s*$/.test(text) ? { show: "value" } : {}) }
        : { id, kind: "text", at: [x, y], text: text.split(/\n{2,}/).map((p) => escapeDjot(p).replace(/\n/g, "\\\n")).join("\n\n") },
    );
  });
  setState({ selection: [id], caret: null });
}

export function copyToInternal() {
  internalClipboard = selectedRegions();
}

export function duplicateSelection() {
  if (!state.selection.length) return;
  const regions = selectedRegions();
  setState({ caret: null });
  pasteRegions(regions);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function naturalSize(url: string): Promise<[number, number]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth || 300, img.naturalHeight || 200]);
    img.onerror = () => resolve([300, 200]);
    img.src = url;
  });
}

async function placeImage(src: string, at?: [number, number]) {
  const url = await api.readAsset(state.path ?? "", src);
  setState("assets", src, url);
  const [nw, nh] = await naturalSize(url);
  const [x, y] = at ?? state.caret ?? [GRID * 4, GRID * 4];
  const maxW = Math.min(availableWidth(x), 480);
  const w = Math.round(Math.min(nw, maxW));
  const id = newId();
  mutate((d) => {
    d.regions.push({ id, kind: "image", at: [snap(x), snap(y)], size: [w, Math.round((w * nh) / nw)], src });
  });
  setState({ selection: [id], caret: null });
}

export async function insertImagePath(path: string, at?: [number, number]) {
  await placeImage(await api.importImage(path), at);
}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function insertImageBlob(file: Blob, at?: [number, number]) {
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
  await placeImage(await api.stageImage(await readAsBase64(file), ext), at);
}

/** Ask for an image file (Tauri dialog, or a file input in a browser). */
export async function pickImage(): Promise<{ path?: string; file?: File } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ title: "Insert image", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }] });
    return typeof p === "string" ? { path: p } : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => resolve(input.files?.[0] ? { file: input.files[0] } : null);
    input.click();
  });
}

export async function insertImage(at?: [number, number]) {
  commitEditing();
  const pick = await pickImage();
  if (pick?.path) await insertImagePath(pick.path, at);
  else if (pick?.file) await insertImageBlob(pick.file, at);
}

export async function addBackground() {
  const pick = await pickImage();
  if (!pick) return;
  const src = pick.path
    ? await api.importImage(pick.path)
    : await api.stageImage(await readAsBase64(pick.file!), (pick.file!.type.split("/")[1] ?? "png").replace("jpeg", "jpg"));
  setState("assets", src, await api.readAsset(state.path ?? "", src));
  mutate((d) => {
    const page = (d.page ??= {});
    const list = ((page.backgrounds as Background[] | undefined) ?? []).concat([{ pages: "1", src, fit: "margins" }]);
    page.backgrounds = list;
  });
}

export const isImagePath = (p: string) => IMAGE_EXT.test(p);

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

export function installContextMenus(run: (command: string) => void) {
  setRegionMenuBuilder((id): MenuItems => {
    const go = (cmd: string) => () => {
      closeMenu();
      run(cmd);
    };
    if (!id) {
      return [
        { label: "Paste", shortcut: "⌘V", disabled: !internalClipboard.length, run: () => (closeMenu(), pasteRegions(internalClipboard)) },
        null,
        { label: "Insert Math", run: go("insert_math") },
        { label: "Insert Text", run: go("insert_text") },
        { label: "Insert Image…", run: go("insert_image") },
        { label: "Insert Area", run: go("insert_area") },
        null,
        { label: "Table of Contents", run: go("insert_toc") },
        { label: "List of Figures", run: go("insert_figures") },
        { label: "List of Tables", run: go("insert_tables") },
        null,
        { label: "Page View", checked: layout().pageView, run: go("page_view") },
        { label: "Document Settings…", run: go("document_settings") },
      ];
    }
    const r = layout().byId.get(id)?.region;
    const many = state.selection.length > 1;
    const items: MenuItems = [];
    if (!many && r && (r.kind === "math" || r.kind === "text")) items.push({ label: "Edit", shortcut: "↩", run: () => (closeMenu(), startEditing(id)) });
    items.push(
      { label: "Cut", shortcut: "⌘X", run: () => (closeMenu(), copyToInternal(), document.execCommand("cut") || deleteRegions(state.selection)) },
      { label: "Copy", shortcut: "⌘C", run: () => (closeMenu(), copyToInternal(), document.execCommand("copy")) },
      { label: "Paste", shortcut: "⌘V", disabled: !internalClipboard.length, run: () => (closeMenu(), pasteRegions(internalClipboard)) },
      { label: "Duplicate", shortcut: "⌘D", run: go("duplicate") },
      { label: "Delete", shortcut: "⌫", run: () => (closeMenu(), deleteRegions(state.selection)) },
      null,
    );
    if (many) {
      items.push(
        { label: "Align Left Edges", run: go("arrange_left") },
        { label: "Align Centres", run: go("arrange_hcenter") },
        { label: "Align Tops", run: go("arrange_top") },
        { label: "Distribute Horizontally", disabled: state.selection.length < 3, run: go("distribute_x") },
        { label: "Distribute Vertically", disabled: state.selection.length < 3, run: go("distribute_y") },
        null,
      );
    } else if (r?.kind === "math") {
      const view = state.views[id];
      items.push(
        {
          label: "Copy Result",
          disabled: !view?.resultText || !!view.error,
          run: () => (closeMenu(), copyText(prettyValue(view!.resultText!), "the result")),
        },
        {
          label: "Copy as LaTeX",
          disabled: !view?.input,
          run: () => (closeMenu(), copyText(latex(view!.input!, view!.error ? null : view!.result, view!.units), "as LaTeX")),
        },
        null,
        { label: "Show Result", checked: !!r.show, run: () => (closeMenu(), updateRegion(id, { show: r.show ? undefined : "value" })) },
        { label: "Exclude from Calculation", checked: !!r.disabled, run: () => (closeMenu(), updateRegion(id, { disabled: r.disabled ? undefined : true })) },
        null,
      );
    } else if (r && ["image", "table"].includes(r.kind)) {
      items.push(
        {
          label: r.caption ? "Remove Caption" : "Add Caption",
          run: () => (closeMenu(), updateRegion(id, { caption: r.caption ? undefined : { text: "Caption", position: r.kind === "table" ? "above" : "below" } })),
        },
        null,
      );
    }
    items.push({ label: "Properties…", run: go("region_properties") });
    return items;
  });
}
