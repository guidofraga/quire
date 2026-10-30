// File ▸ Share Link…: a link that opens the document in anyone's browser, with nothing to
// install. The document travels inside the link (share.ts), so nothing is uploaded.
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { useModal } from "./a11y";
import { isTauri } from "./api";
import { hasImages, linkFor, WEB_URL } from "./share";
import { commitEditing, state } from "./store";

export const [shareOpen, setShareOpen] = createSignal(false);

/** Over this many characters some apps cut links short when they are pasted into a message. */
const LONG_LINK = 8000;

export function ShareDialog() {
  return (
    <Show when={shareOpen()}>
      <Dialog />
    </Show>
  );
}

function Dialog() {
  commitEditing();
  const doc = unwrap(state.doc);
  // links made in the desktop app open the web version; in a browser, this page
  const [made] = createResource(() =>
    linkFor(doc, isTauri ? WEB_URL : location.href).then(
      (url) => ({ url, error: null }),
      (e: Error) => ({ url: "", error: String(e.message ?? e) }),
    ),
  );
  const link = () => made()?.url;
  const [copied, setCopied] = createSignal(false);
  const close = () => setShareOpen(false);
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
  let field!: HTMLInputElement;
  useModal(() => el);

  const copy = () => {
    // the field's own text, selected: execCommand works in every browser and in the app,
    // where the asynchronous clipboard API may refuse
    field.focus();
    field.select();
    if (!document.execCommand("copy")) void navigator.clipboard?.writeText(field.value);
    setCopied(true);
  };

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="settings share" role="dialog" aria-modal="true" aria-label="Share link" ref={el}>
        <header role="none">
          <h2>Share link</h2>
          <button class="settings-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <div class="settings-body share-body">
          <p>Anyone with the link can open and edit a copy in their browser. Nothing is uploaded.</p>
          <div class="share-row">
            <input
              ref={field}
              class="share-link"
              readOnly
              value={made() ? link() : "Making the link…"}
              aria-label="Link to this document"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button class="btn primary" disabled={!link()} onClick={copy} autofocus>
              {copied() ? "Copied" : "Copy link"}
            </button>
          </div>
          <Show when={made()?.error}>
            <p class="share-note">Could not make a link: {made()?.error}</p>
          </Show>
          <Show when={hasImages(doc)}>
            <p class="share-note">Links leave out images. Send the .quirez file to include them.</p>
          </Show>
          <Show when={(link()?.length ?? 0) > LONG_LINK}>
            <p class="share-note">
              Long link ({Math.round((link()?.length ?? 0) / 1000)}k characters): some chat apps cut it short.
            </p>
          </Show>
        </div>
      </div>
    </div>
  );
}
