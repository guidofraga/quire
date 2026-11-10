// Updates: a quiet check after launch, a banner when a new version is out, and
// Quire ▸ Check for Updates…. Updates are signed; the updater refuses anything else.
import { createSignal, Show } from "solid-js";
import { api, isTauri } from "./api";
import { flash } from "./store";

interface Available {
  version: string;
  install: (progress: (done: number, total: number | undefined) => void) => Promise<void>;
}

const [available, setAvailable] = createSignal<Available | null>(null);
const [dismissed, setDismissed] = createSignal(false);

/** Ask GitHub for the latest release; `manual` reports "up to date" and errors too. */
export async function checkForUpdates(manual = false) {
  if (!isTauri) {
    if (manual) flash("Updates come with the desktop app");
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
  const update = async () => {
    const a = available();
    if (!a || busy()) return;
    // busy from the first click, so a second click can't start a second install while the user is asked
    setBusy("Preparing…");
    try {
      // installing restarts Quire: unsaved work is saved or deliberately discarded first
      if (!(await props.beforeRestart())) {
        setBusy(null);
        return;
      }
      setBusy("Downloading…");
      await a.install((done, total) =>
        setBusy(total ? `Downloading… ${Math.round((done / total) * 100)}%` : "Downloading…"),
      );
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
          {/* the release page has the notes; the update feed only carries a generic line */}
          <button
            class="update-link"
            onClick={() =>
              api
                .openReleaseNotes(available()!.version)
                .catch((e) => flash(`Could not open the release notes: ${e.message ?? e}`))
            }
          >
            What's new
          </button>
          <button class="btn primary" disabled={!!busy()} onClick={() => void update()}>
            {busy() ?? "Update and Restart"}
          </button>
          <Show when={!busy()}>
            <button class="btn" onClick={() => setDismissed(true)}>
              Later
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}
