import { describe, expect, it } from "vitest";
import { type Keys, shortcutCommand } from "./shortcuts";
import menu from "../src-tauri/src/main.rs?raw";

// The native menu's shortcuts, read from the desktop app's source so the two can't drift
const accelerators = [...menu.matchAll(/item\(app, "([a-z_]+)", "[^"]*", Some\("([^"]+)"\)\)/g)].map(
  ([, id, accel]) => ({ id, accel }),
);

// The editors have these; the page doesn't run them (shortcuts.ts), nor the palette's own key
const LEFT_TO_OTHERS = new Set(["fmt_bold", "fmt_italic", "fmt_underline", "command_palette"]);

/** The key press an accelerator like "CmdOrCtrl+Shift+M" makes on a Mac or elsewhere. */
function press(accel: string, mac: boolean): Keys {
  const parts = accel.split("+");
  const last = parts[parts.length - 1];
  const shift = parts.includes("Shift");
  const punctuation: Record<string, [string, string]> = {
    Backslash: ["Backslash", "\\"],
    "=": ["Equal", "="],
    "-": ["Minus", "-"],
    "'": ["Quote", "'"],
    ",": ["Comma", ","],
  };
  const [code, key] = /^[A-Z]$/.test(last)
    ? [`Key${last}`, shift ? last : last.toLowerCase()]
    : /^\d$/.test(last)
      ? [`Digit${last}`, last]
      : punctuation[last];
  return {
    key,
    code,
    ctrlKey: !mac,
    metaKey: mac,
    shiftKey: shift,
    altKey: parts.includes("Alt"),
  };
}

describe("shortcutCommand", () => {
  it("finds the menu's shortcuts in main.rs", () => {
    expect(accelerators.length).toBeGreaterThan(30);
  });

  for (const mac of [false, true]) {
    it(`runs every menu shortcut from the page (${mac ? "Mac" : "Windows and Linux"})`, () => {
      const wrong = accelerators
        .filter(({ id }) => !LEFT_TO_OTHERS.has(id))
        .map(({ id, accel }) => ({ id, accel, got: shortcutCommand(press(accel, mac), mac) }))
        .filter(({ id, got }) => id !== got);
      expect(wrong).toEqual([]);
    });
  }

  it("has the four Windows reported missing (#168)", () => {
    const win = (code: string): Keys => ({
      key: code.slice(3),
      code,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    });
    expect(shortcutCommand(win("KeyM"), false)).toBe("insert_math");
    expect(shortcutCommand(win("KeyT"), false)).toBe("insert_text");
    expect(shortcutCommand(win("KeyI"), false)).toBe("insert_image");
    expect(shortcutCommand(win("KeyP"), false)).toBe("page_view");
  });

  it("leaves Ctrl+G to math on Windows, and Ctrl+Y isn't Redo on a Mac", () => {
    const g: Keys = { key: "g", code: "KeyG", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(shortcutCommand(g, false)).toBe("");
    const y: Keys = { key: "y", code: "KeyY", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false };
    expect(shortcutCommand(y, true)).toBe("");
  });

  it("ignores plain typing and the other modifier", () => {
    const m: Keys = { key: "M", code: "KeyM", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false };
    expect(shortcutCommand(m, false)).toBe("");
    // Ctrl on a Mac is not ⌘
    expect(shortcutCommand({ ...m, ctrlKey: true }, true)).toBe("");
  });

  it("follows the keyboard's layout for letters", () => {
    // on AZERTY the key in QWERTY's Q position types A: Ctrl+A is Select All, not nothing
    const azertyA: Keys = { key: "a", code: "KeyQ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(shortcutCommand(azertyA, false)).toBe("select_all");
    // ⌥⌘F types ƒ on a Mac: the key's position says F
    const optF: Keys = { key: "ƒ", code: "KeyF", ctrlKey: false, metaKey: true, shiftKey: false, altKey: true };
    expect(shortcutCommand(optF, true)).toBe("find_replace");
  });

  it("takes Ctrl or ⌘ in a browser, but only ⌘ for the Mac desktop app", () => {
    const save: Keys = { key: "s", code: "KeyS", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(shortcutCommand(save, true, true)).toBe("save");
    expect(shortcutCommand(save, true)).toBe("");
    // Ctrl+G stays Greek in math even in a browser on a Mac
    expect(shortcutCommand({ ...save, key: "g", code: "KeyG" }, true, true)).toBe("");
  });
});
