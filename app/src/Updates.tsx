// Updates: a quiet check after launch, a banner when a new version is out, and
// Quire ▸ Check for Updates…. Updates are signed; the updater refuses anything else.
import { createSignal, Show } from "solid-js";
import { isTauri } from "./api";
import { flash } from "./store";

interface Available {
  version: string;
  notes: string;
  install: (progress: (done: number, total: number | undefined) => void) => Promise<void>;
}

const [available, setAvailable] = createSignal<Available | null>(null);
const [dismissed, setDismissed] = createSignal(false);

/** Ask GitHub for the latest release; `manual` reports "up to date" and errors too. */
export async function checkForUpdates(manual = false) {
  if (!isTauri) {
    if (manual) flash("Updates are checked in the desktop app");
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (manual) {
        const { getVersion } = await import("@tauri-apps/api/app");
        flash(`Quire ${await getVersion()} is the latest version`);
      }
      return;
    }
    setDismissed(false);
    setAvailable({
      version: update.version,
      notes: update.body ?? "",
      install: async (progress) => {
        let done = 0;
        let total: number | undefined;
        await update.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength;
          else if (e.event === "Progress") progress((done += e.data.chunkLength), total);
        });
      },
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (!manual) return; // offline, or GitHub unreachable: only worth saying when asked
    // no release has published update information yet: nothing newer to offer
    if (/valid release JSON|404/i.test(message)) {
      const { getVersion } = await import("@tauri-apps/api/app");
      flash(`Quire ${await getVersion()} is the latest version`);
    } else flash(`Could not check for updates: ${message}`);
  }
}

/** The banner: what is new, Update (download, install, restart) or Later. */
export function UpdateBanner(props: { beforeRestart: () => Promise<boolean> }) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [showNotes, setShowNotes] = createSignal(false);
  const update = async () => {
    const a = available();
    if (!a || busy()) return;
    // installing restarts Quire: unsaved work is saved or deliberately discarded first
    if (!(await props.beforeRestart())) return;
    try {
      setBusy("Downloading…");
      await a.install((done, total) => setBusy(total ? `Downloading… ${Math.round((done / total) * 100)}%` : "Downloading…"));
      setBusy("Restarting…");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setBusy(null);
      flash(`Could not update: ${(e as Error).message ?? e}`);
    }
  };
  return (
    <Show when={available() && !dismissed()}>
      <div class="update-banner" role="status">
        <div class="update-row">
          <span class="update-text">
            <strong>Quire {available()!.version}</strong> is available.
          </span>
          <Show when={available()!.notes}>
            <button class="update-link" onClick={() => setShowNotes(!showNotes())}>
              {showNotes() ? "Hide" : "What's new"}
            </button>
          </Show>
          <button class="btn primary" disabled={!!busy()} onClick={() => void update()}>
            {busy() ?? "Update and Restart"}
          </button>
          <Show when={!busy()}>
            <button class="btn" onClick={() => setDismissed(true)}>
              Later
            </button>
          </Show>
        </div>
        <Show when={showNotes()}>
          <div class="update-notes">{available()!.notes}</div>
        </Show>
      </div>
    </Show>
  );
}
