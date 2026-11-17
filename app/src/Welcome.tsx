// The welcome screen at launch: a blank document, recent documents and templates, each
// template with a miniature of its first page.
import { guardUnsaved, newNotebookDialog, openNotebookDialog } from "./Sidebar";
import { createResource, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { arrowFocus, useModal } from "./a11y";
import { api, isMac, isWeb, type TemplateInfo } from "./api";
import { Icon, type IconName } from "./icons";
import logoUrl from "./assets/logo-mark.png";
import { type Shape, thumbnail, type Thumbnail } from "./thumbnail";
import { recentList } from "./recent";
import { setTemplates as setTemplatesDialog } from "./TemplatesDialog";
import { prefs, setPref, type Prefs } from "./settings";
import { flash } from "./store";
import type { Doc } from "./types";

export const [welcomeOpen, setWelcomeOpen] = createSignal(false);

/** How many templates the Welcome screen lists before "All templates…". */
const WELCOME_TEMPLATES = 5;

interface Props {
  openPath: (path: string) => Promise<void>;
  openDialog: () => void;
  openTemplate: (doc: Doc, origin: string | null) => Promise<boolean>;
}

const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.quirez?$/i, "");
const folderOf = (path: string) => {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const folder = parts.join("/");
  return folder.replace(/^\/Users\/[^/]+/, "~");
};

const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";

/** First pages of the templates, drawn once per session (a template rarely changes meanwhile). */
const thumbs = new Map<string, Promise<Thumbnail | null>>();
const thumbOf = (t: TemplateInfo) => {
  const key = `${t.id}\n${t.name}`;
  if (!thumbs.has(key))
    thumbs.set(
      key,
      api.openTemplate(t.id).then(
        ({ doc }) => thumbnail(doc),
        () => null,
      ),
    );
  return thumbs.get(key)!;
};

/** One shape of a miniature page; the page is paper-white in either theme, as on the canvas. */
function ThumbShape(props: { s: Shape }) {
  const s = props.s;
  if (s.kind === "rule") return <line class="t-rule" x1={s.x} y1={s.y} x2={s.x + s.w} y2={s.y} />;
  if (s.kind === "curve") {
    const d = `M${s.x} ${s.y + s.h * 0.8}C${s.x + s.w * 0.3} ${s.y - s.h * 0.2} ${s.x + s.w * 0.55} ${s.y + s.h * 1.1} ${s.x + s.w} ${s.y + s.h * 0.15}`;
    return <path class="t-curve" d={d} />;
  }
  return (
    <rect
      class={`t-${s.kind}`}
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      rx={s.kind === "box" || s.kind === "fill" ? 0 : s.h / 2}
    />
  );
}

/** A template's first page in miniature; a plain sheet until it is drawn. */
function TemplateThumb(props: { t: TemplateInfo }) {
  const [thumb] = createResource(() => props.t, thumbOf);
  // A4 until the document says otherwise, so the row doesn't change height
  const w = () => thumb()?.width ?? 794;
  const h = () => thumb()?.height ?? 1123;
  return (
    <svg
      class="welcome-thumb"
      viewBox={`0 0 ${w()} ${h()}`}
      width="40"
      height={Math.round((40 * h()) / w())}
      aria-hidden="true"
    >
      <rect class="t-paper" x="0" y="0" width={w()} height={h()} />
      <For each={thumb()?.shapes ?? []}>{(s) => <ThumbShape s={s} />}</For>
    </svg>
  );
}

/** A row's square icon. */
const tile = (name: IconName) => (
  <span class="welcome-icon" aria-hidden="true">
    <Icon name={name} />
  </span>
);

/** A shortcut on the right of a row, as a menu shows it; the button's name leaves it out. */
const key = (keys: string): JSX.Element => (
  <kbd class="welcome-key" aria-hidden="true">
    {keys}
  </kbd>
);

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
  // a few, yours first: the rest are one click away in the Templates dialog
  const shown = () => {
    const all = templates() ?? [];
    return [...all.filter((t) => !t.builtin), ...all.filter((t) => t.builtin)].slice(0, WELCOME_TEMPLATES);
  };
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
  let el!: HTMLDivElement;
  useModal(() => el);
  const run = async (fn: () => Promise<unknown> | unknown) => {
    close();
    await fn();
  };
  // asks before a recent document replaces unsaved work; the screen stays up if the user says no
  const openRecent = async (path: string) => {
    if (!(await guardUnsaved())) return;
    await run(() => props.openPath(path));
  };
  const openTemplate = async (t: TemplateInfo) => {
    try {
      const { doc, origin } = await api.openTemplate(t.id);
      if (await props.openTemplate(doc, origin)) close();
    } catch (e) {
      flash(`Could not open the template: ${(e as Error).message}`);
    }
  };
  // ↑/↓ within a column, ←/→ to the row beside it in the other one
  const onArrows = (e: KeyboardEvent) => {
    const cols = [...(e.currentTarget as HTMLElement).querySelectorAll("section")].map((sec) => [
      ...sec.querySelectorAll<HTMLElement>(".welcome-item"),
    ]);
    const at = cols.findIndex((c) => c.includes(document.activeElement as HTMLElement));
    if (at < 0) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return void arrowFocus(e, cols[at], "vertical");
    const other = cols[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (!other?.length || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const y = mid(document.activeElement!);
    other.reduce((a, b) => (Math.abs(mid(b) - y) < Math.abs(mid(a) - y) ? b : a)).focus();
  };
  return (
    <div class="welcome-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="welcome" role="dialog" aria-modal="true" aria-label="Welcome to Quire" ref={el}>
        <div class="welcome-head">
          <img class="welcome-mark" src={logoUrl} alt="" width="40" height="40" draggable={false} />
          <h2 class="welcome-title">Quire</h2>
        </div>
        <div class="welcome-cols" onKeyDown={onArrows}>
          <section>
            <h3>Start</h3>
            <button class="welcome-item primary" onClick={close} autofocus>
              {tile("newDoc")}
              <span>
                <b>Blank document</b>
              </span>
              {key(`${mod}N`)}
            </button>
            <Show when={!isWeb}>
              <button class="welcome-item" onClick={() => void run(newNotebookDialog)}>
                {tile("newFolder")}
                <span>
                  <b>New notebook…</b>
                </span>
              </button>
            </Show>
            <button class="welcome-item" onClick={() => void run(props.openDialog)}>
              {tile("folder")}
              <span>
                <b>Open…</b>
              </span>
              {key(`${mod}O`)}
            </button>
            <Show when={!isWeb}>
              <button class="welcome-item" onClick={() => void run(openNotebookDialog)}>
                {tile("notebook")}
                <span>
                  <b>Open notebook…</b>
                </span>
                {key(`${shift}${mod}O`)}
              </button>
              <h3>Recent</h3>
              <Show when={recent.length} fallback={<p class="welcome-empty">No recent documents</p>}>
                <For each={recent}>
                  {(path) => (
                    <button class="welcome-item" title={path} onClick={() => void openRecent(path)}>
                      {tile("doc")}
                      <span>
                        <b>{nameOf(path)}</b>
                        <small>{folderOf(path)}</small>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </section>
          <section>
            <h3>Templates</h3>
            <For each={shown()} fallback={<p class="welcome-empty">Loading…</p>}>
              {(t) => (
                <button class="welcome-item template" onClick={() => void openTemplate(t)}>
                  <TemplateThumb t={t} />
                  <span>
                    <b>{t.name}</b>
                    <small>{t.description || "Your template"}</small>
                  </span>
                </button>
              )}
            </For>
            <Show when={(templates() ?? []).length > shown().length}>
              <button
                class="welcome-item"
                onClick={() => {
                  close();
                  setTemplatesDialog("new");
                }}
              >
                {tile("template")}
                <span>
                  <b>All templates…</b>
                  <small>{(templates() ?? []).length} to choose from</small>
                </span>
              </button>
            </Show>
          </section>
        </div>
        <div class="welcome-foot">
          <Show
            when={!isWeb}
            fallback={
              <span class="welcome-hint">
                <a href="https://github.com/guidofraga/quire/releases/latest" target="_blank" rel="noopener">
                  Get the desktop app
                </a>
              </span>
            }
          >
            <label>
              At launch
              <select
                value={prefs.onLaunch}
                onChange={(e) => setPref("onLaunch", e.currentTarget.value as Prefs["onLaunch"])}
              >
                <option value="welcome">Welcome screen</option>
                <option value="last">Last document</option>
                <option value="blank">Blank document</option>
              </select>
            </label>
          </Show>
          <span class="welcome-hint">
            {mod}K Commands · {isMac ? "⌘?" : "F1"} Help
          </span>
        </div>
      </div>
    </div>
  );
}
