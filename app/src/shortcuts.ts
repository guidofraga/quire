// The menu's keyboard shortcuts, as the page sees them. The desktop app's native menu has the
// same ones (app/src-tauri/src/main.rs; shortcuts.test.ts checks they agree), but a browser has
// no menu, and on Windows and Linux the web view can keep a key press from ever reaching the
// menu (#168), so the page runs the command itself.

/** The parts of a key press a shortcut depends on. */
export interface Keys {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * The command a key press is the shortcut for, or "" when it is none. `mac` picks ⌘ over Ctrl.
 * Formatting shortcuts (Bold, Italic, Underline) are left out: the text editor has them.
 */
export function shortcutCommand(e: Keys, mac: boolean): string {
  if (e.key === "F1") return "help";
  if (e.key === "F3") return e.shiftKey ? "find_prev" : "find_next";
  if (!(mac ? e.metaKey : e.ctrlKey)) return "";
  // ⌥ changes e.key on a Mac (⌥⌘F gives ƒ, ⌥⌘, gives ≤), and Shift changes it everywhere
  // (Ctrl+Shift+- gives _), so read letters, digits and punctuation from the key's position
  const key = e.code.startsWith("Key")
    ? e.code.slice(3).toLowerCase()
    : e.code.startsWith("Digit")
      ? e.code.slice(5)
      : (CODES[e.code] ?? e.key.toLowerCase());
  const { shiftKey: shift, altKey: alt } = e;
  switch (key) {
    case "s":
      return alt ? "" : shift ? "save_as" : "save";
    case "o":
      return alt ? "" : shift ? "open_notebook" : "open";
    case "n":
      return alt ? "new_section" : shift ? "new_from_template" : "new";
    case "\\":
      return "toggle_sidebar";
    case "z":
      return alt ? "" : shift ? "redo" : "undo";
    // Ctrl+Y, as on Windows and Linux; on a Mac ⌘Y is not Redo
    case "y":
      return !mac && !shift && !alt ? "redo" : "";
    case "a":
      return !shift && !alt ? "select_all" : "";
    case "p":
      return alt ? "insert_plot" : shift ? "page_view" : "print";
    case "e":
      return shift || alt ? "" : "export_pdf";
    case "d":
      return shift || alt ? "" : "duplicate";
    case "i":
      return alt ? "toggle_inspector" : shift ? "insert_image" : "";
    case "t":
      return alt ? "insert_table" : shift ? "insert_text" : "";
    case "m":
      return shift && !alt ? "insert_math" : "";
    case "r":
      return shift && !alt ? "insert_ref" : "";
    case "f":
      return alt ? "find_replace" : shift ? "search_notebook" : "find";
    case "=":
      return "zoom_in";
    case "-":
      return "zoom_out";
    case "0":
      return "zoom_reset";
    case "'":
      return "next_error";
    case "/":
      return shift ? "help" : "";
    // Ctrl+G is Greek in math, so Find Next is ⌘G on a Mac only
    case "g":
      return mac ? (shift ? "find_prev" : "find_next") : "";
    case ",":
      return alt ? "document_settings" : "settings";
    default:
      return "";
  }
}

/** Punctuation keys by position, so Shift or ⌥ don't change which one was pressed. */
const CODES: Record<string, string> = {
  Backslash: "\\",
  Equal: "=",
  Minus: "-",
  Quote: "'",
  Slash: "/",
  Comma: ",",
};

/** Commands an editor handles itself while typing (math, text, a table cell or a field). */
export const EDITOR_KEYS = new Set(["undo", "redo", "select_all", "duplicate"]);
