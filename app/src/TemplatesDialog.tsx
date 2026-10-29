// File ▸ New from Template… and File ▸ Save as Template….
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { useModal } from "./a11y";
import { api, type TemplateInfo } from "./api";
import { flash, localized, state } from "./store";
import type { Doc } from "./types";

export const [templates, setTemplates] = createSignal<"new" | "save" | null>(null);

interface Props {
  /** Load a template's copy; false when the user kept the current document. */
  onOpen: (doc: Doc, origin: string | null) => Promise<boolean>;
  onBlank: () => void;
}

export function TemplatesDialog(props: Props) {
  return (
    <Show when={templates()}>
      {(mode) => <Dialog mode={mode()} {...props} />}
    </Show>
  );
}

function Dialog(props: Props & { mode: "new" | "save" }) {
  const close = () => setTemplates(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  let el!: HTMLDivElement;
  useModal(() => el);
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="settings templates"
        role="dialog"
        aria-modal="true"
        aria-label={props.mode === "new" ? "New from template" : "Save as template"}
        ref={el}
      >
        <header role="none">
          <h2>{props.mode === "new" ? "New from template" : "Save as template"}</h2>
          <button class="settings-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <Show when={props.mode === "new"} fallback={<SaveForm close={close} />}>
          <Chooser {...props} close={close} />
        </Show>
      </div>
    </div>
  );
}

function Chooser(props: Props & { close: () => void }) {
  const [list, { refetch }] = createResource(() => api.listTemplates());
  const [busy, setBusy] = createSignal(false);
  const open = async (t: TemplateInfo) => {
    if (busy()) return;
    setBusy(true);
    try {
      const { doc, origin } = await api.openTemplate(t.id);
      if (await props.onOpen(doc, origin)) props.close();
    } catch (e) {
      flash(`Could not open the template: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t: TemplateInfo) => {
    if (!window.confirm(`Delete the template “${t.name}”?`)) return;
    await api.deleteTemplate(t.id).catch((e) => flash(String(e)));
    void refetch();
  };
  const group = (builtin: boolean) => (list() ?? []).filter((t) => t.builtin === builtin);
  return (
    <div class="settings-body templates-body">
      <div class="template-grid">
        <button
          class="template-card"
          onClick={() => {
            props.close();
            props.onBlank();
          }}
        >
          <span class="template-name">Blank document</span>
          <span class="template-desc">Your default settings</span>
        </button>
        <For each={group(true)}>
          {(t) => (
            <button class="template-card" onClick={() => void open(t)} disabled={busy()}>
              <span class="template-name">{t.name}</span>
              <span class="template-desc">{t.description}</span>
            </button>
          )}
        </For>
      </div>
      <h3 class="templates-heading">Your templates</h3>
      <Show
        when={group(false).length}
        fallback={<p class="templates-empty">Save any document with File ▸ Save as Template…</p>}
      >
        <div class="template-grid">
          <For each={group(false)}>
            {(t) => (
              <div class="template-card mine">
                <button class="template-open" onClick={() => void open(t)} disabled={busy()}>
                  <span class="template-name">{t.name}</span>
                  <span class="template-desc">{t.description || "Your template"}</span>
                </button>
                <button class="template-delete" title="Delete this template" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}>
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function SaveForm(props: { close: () => void }) {
  const [name, setName] = createSignal(localized(state.doc.meta?.title) || "My template");
  const [description, setDescription] = createSignal("");
  const save = async () => {
    try {
      await api.saveTemplate(name(), description(), unwrap(state.doc), state.path ?? state.origin);
      flash(`Saved template “${name().trim()}”`);
      props.close();
    } catch (e) {
      flash(`Could not save the template: ${(e as Error).message}`);
    }
  };
  return (
    <form
      class="settings-body templates-body"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label class="insp-field">
        <span class="insp-label">Name</span>
        <input class="insp-input" value={name()} onInput={(e) => setName(e.currentTarget.value)} autofocus />
      </label>
      <label class="insp-field">
        <span class="insp-label">Description</span>
        <input
          class="insp-input"
          value={description()}
          placeholder="Optional"
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <div class="templates-actions">
        <button type="button" class="btn" onClick={props.close}>
          Cancel
        </button>
        <button type="submit" class="btn primary" disabled={!name().trim()}>
          Save Template
        </button>
      </div>
    </form>
  );
}
