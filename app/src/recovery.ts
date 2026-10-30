// Crash recovery: while a document has unsaved changes, a copy of it is kept by the backend,
// and offered back the next time Quire starts.
import { createEffect, createRoot, on } from "solid-js";
import { unwrap } from "solid-js/store";
import { api } from "./api";
import { state } from "./store";

/** How long after the last edit the copy is written. */
export const RECOVERY_DELAY = 3000;

/**
 * While there are unsaved changes, keep a copy for crash recovery (a few seconds after
 * the last edit); once the document is saved or replaced, drop it.
 */
export function keepRecovery() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // started after the awaits in onMount, so it needs its own reactive root
  createRoot(() =>
    createEffect(
      // edits change the document in place, so `rev` is what says it changed
      on([() => state.rev, () => state.dirty], ([, dirty]) => {
        clearTimeout(timer);
        if (!dirty) return void api.clearRecovery().catch(() => {});
        timer = setTimeout(() => void api.saveRecovery(unwrap(state.doc), state.path).catch(() => {}), RECOVERY_DELAY);
      }),
    ),
  );
}
