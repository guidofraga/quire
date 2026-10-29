// Spreadsheets linked to the document (`dataLinks`: name → file). Their tables live in the
// document's `data`, which importData reads, so a document keeps working without the file;
// with automatic updates on, a file that changed is read again and the worksheet
// recalculates. Insert ▸ Excel Data… links one; the toolbar turns updates on and off.
import { api, isTauri } from "./api";
import { flash, mutate, state } from "./store";

export interface DataLink {
  /** The file, as an absolute path. */
  path: string;
  /** Read it again when it changes (on unless turned off). */
  auto?: boolean;
  /** When the file had changed last time it was read (ms since 1970). */
  stamp?: number;
}

/** How often linked files are checked while automatic updates are on. */
export const CHECK_MS = 3000;

const links = () => (state.doc.dataLinks ?? {}) as Record<string, DataLink>;

export const hasLinks = () => Object.keys(links()).length > 0;

/** Automatic updates: on unless every link was turned off. */
export const autoOn = () => Object.values(links()).some((l) => l.auto !== false);

export function setAuto(on: boolean) {
  mutate((d) => {
    for (const l of Object.values((d.dataLinks ?? {}) as Record<string, DataLink>)) l.auto = on;
  });
  flash(on ? "Excel data updates automatically" : "Excel data no longer updates by itself; ⟳ updates it now");
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

let busy = false;

/**
 * Read again the linked files that changed since they were last read (all of them with
 * `force`). Quiet when nothing changed; a file that can't be read is left as it was.
 */
export async function refreshData(force = false): Promise<string[]> {
  if (busy) return [];
  const names = Object.keys(links());
  if (!names.length) return [];
  busy = true;
  try {
    const stamps = await api.dataStamps(names.map((n) => links()[n].path));
    const changed: string[] = [];
    for (const [i, name] of names.entries()) {
      const stamp = stamps[i];
      if (stamp == null || (!force && stamp === links()[name].stamp)) continue;
      const sheets = await api.readData(links()[name].path).catch((e: Error) => {
        flash(`Could not read ${name}: ${e.message}`);
        return null;
      });
      if (!sheets) continue;
      mutate((d) => {
        d.data = { ...((d.data ?? {}) as object), [name]: sheets };
        (d.dataLinks as Record<string, DataLink>)[name].stamp = stamp;
      }, false);
      changed.push(name);
    }
    if (changed.length) flash(`Updated from ${changed.join(", ")}`);
    else if (force) flash("The Excel data is up to date");
    return changed;
  } finally {
    busy = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Check the linked files every few seconds while automatic updates are on. */
export function watchData() {
  if (timer) return;
  timer = setInterval(() => {
    if (autoOn() && hasLinks() && !state.printing) void refreshData().catch(() => undefined);
  }, CHECK_MS);
}

/** Insert ▸ Excel Data…: link a spreadsheet (.xlsx or .csv) and read its tables now. */
export async function linkSpreadsheet() {
  let path: string | null;
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ title: "Link Excel data", filters: [{ name: "Spreadsheet", extensions: ["xlsx", "csv", "txt"] }] });
    path = typeof p === "string" ? p : null;
  } else {
    path = window.prompt("Path to an .xlsx or .csv file");
  }
  if (!path) return;
  try {
    const [stamp] = await api.dataStamps([path]);
    const sheets = (await api.readData(path)) as Record<string, unknown>;
    const name = fileName(path);
    mutate((d) => {
      d.data = { ...((d.data ?? {}) as object), [name]: sheets };
      d.dataLinks = { ...((d.dataLinks ?? {}) as object), [name]: { path, auto: true, stamp: stamp ?? undefined } };
    });
    const first = Object.keys(sheets)[0] ?? "Sheet1";
    flash(`Linked ${name}: use importData("${name}", "${first}", "A1:C10") in math; it updates when the file changes`);
  } catch (e) {
    flash(`Could not link ${fileName(path)}: ${(e as Error).message}`);
  }
}
