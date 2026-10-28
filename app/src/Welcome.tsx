// The welcome screen at launch: a blank document, recent documents and templates.
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type TemplateInfo } from "./api";
import { recentList } from "./recent";
import { prefs, setPref, type Prefs } from "./settings";
import { flash } from "./store";
import type { Doc } from "./types";

export const [welcomeOpen, setWelcomeOpen] = createSignal(false);

interface Props {
  openPath: (path: string) => Promise<void>;
  openDialog: () => void;
  openTemplate: (doc: Doc, origin: string | null) => Promise<boolean>;
}

const nameOf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.quirez?$/i, "");
const folderOf = (path: string) => {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const folder = parts.join("/");
  return folder.replace(/^\/Users\/[^/]+/, "~");
};

export function Welcome(props: Props) {
  return (
    <Show when={welcomeOpen()}>
      <Screen {...props} />
    </Show>
  );
}

function Screen(props: Props) {
  const recent = recentList().slice(0, 6);
  const [templates] = createResource(() => api.listTemplates().catch(() => [] as TemplateInfo[]));
  const close = () => setWelcomeOpen(false);
  // Esc closes it wherever focus is (at launch nothing in it has focus yet)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  const run = async (fn: () => Promise<unknown> | unknown) => {
    close();
    await fn();
  };
  const openTemplate = async (t: TemplateInfo) => {
    try {
      const { doc, origin } = await api.openTemplate(t.id);
      if (await props.openTemplate(doc, origin)) close();
    } catch (e) {
      flash(`Could not open the template: ${(e as Error).message}`);
    }
  };
  return (
    <div
      class="welcome-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div class="welcome" role="dialog" aria-label="Welcome to Quire">
        <div class="welcome-head">
          <div class="welcome-title">Quire</div>
          <div class="welcome-sub">Engineering calculations with live math, units, plots and reports</div>
        </div>
        <div class="welcome-cols">
          <section>
            <h3>Start</h3>
            <button class="welcome-item primary" onClick={close} autofocus>
              <span class="welcome-icon">＋</span>
              <span>
                <b>Blank document</b>
                <small>Click anywhere on the page and type</small>
              </span>
            </button>
            <button class="welcome-item" onClick={() => void run(props.openDialog)}>
              <span class="welcome-icon">⌘O</span>
              <span>
                <b>Open…</b>
                <small>A Quire document from your computer</small>
              </span>
            </button>
            <h3>Recent</h3>
            <Show when={recent.length} fallback={<p class="welcome-empty">Documents you open or save show up here.</p>}>
              <For each={recent}>
                {(path) => (
                  <button class="welcome-item" title={path} onClick={() => void run(() => props.openPath(path))}>
                    <span class="welcome-icon doc">▤</span>
                    <span>
                      <b>{nameOf(path)}</b>
                      <small>{folderOf(path)}</small>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </section>
          <section>
            <h3>Templates</h3>
            <For each={templates() ?? []} fallback={<p class="welcome-empty">Loading…</p>}>
              {(t) => (
                <button class="welcome-item" onClick={() => void openTemplate(t)}>
                  <span class="welcome-icon doc">{t.builtin ? "◧" : "★"}</span>
                  <span>
                    <b>{t.name}</b>
                    <small>{t.description || "Your template"}</small>
                  </span>
                </button>
              )}
            </For>
          </section>
        </div>
        <div class="welcome-foot">
          <label>
            When Quire starts
            <select
              value={prefs.onLaunch}
              onChange={(e) => setPref("onLaunch", e.currentTarget.value as Prefs["onLaunch"])}
            >
              <option value="welcome">Show this screen</option>
              <option value="last">Reopen the last document</option>
              <option value="blank">Start a blank document</option>
            </select>
          </label>
          <span class="welcome-hint">⌘K finds any command · F1 for help</span>
        </div>
      </div>
    </div>
  );
}
