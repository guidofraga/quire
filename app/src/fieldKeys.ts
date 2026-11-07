// Keys that belong to a text field when one has focus: Select All and Backspace.

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);

function textControl(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type);
}

/**
 * The text field with focus (the sidebar's search, an inspector field, a table cell), or null.
 * The page's own hidden field takes keys for the canvas and is not one.
 */
export function focusedTextField(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  return textControl(el) && !el.classList.contains("key-sink") ? el : null;
}

/** Select All inside the focused field, when there is one; true when it did. */
export function selectInField(): boolean {
  const field = focusedTextField();
  if (!field) return false;
  field.select();
  return true;
}

function editable(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return textControl(el) && !el.readOnly;
}

/**
 * Backspace on a button, a link or anything else that isn't typed into makes some browsers
 * go back a page. The canvas no longer claims keys aimed elsewhere, so stop it here; in a
 * field Backspace still deletes.
 */
export function keepBackspaceFromHistory(e: KeyboardEvent) {
  if (e.key === "Backspace" && !e.defaultPrevented && !editable(e.target)) e.preventDefault();
}
