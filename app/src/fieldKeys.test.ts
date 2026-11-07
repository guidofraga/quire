import { afterEach, describe, expect, it } from "vitest";
import { focusedTextField, keepBackspaceFromHistory, selectInField } from "./fieldKeys";

afterEach(() => {
  document.body.innerHTML = "";
});

function add<K extends keyof HTMLElementTagNameMap>(tag: K, init?: (el: HTMLElementTagNameMap[K]) => void) {
  const el = document.createElement(tag);
  init?.(el);
  document.body.append(el);
  return el;
}

/** Press Backspace on `target`; true when the browser's default (going back) was prevented. */
function backspaceOn(target: Element): boolean {
  const e = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
  target.addEventListener("keydown", (ev) => keepBackspaceFromHistory(ev as KeyboardEvent));
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("Backspace outside a field", () => {
  it("is kept from the browser on a toolbar button, a link and the body", () => {
    expect(backspaceOn(add("button"))).toBe(true);
    expect(backspaceOn(add("a", (a) => (a.href = "#x")))).toBe(true);
    expect(backspaceOn(document.body)).toBe(true);
    expect(backspaceOn(add("input", (i) => (i.type = "checkbox")))).toBe(true);
  });

  it("still deletes in a text field, a text area and editable text", () => {
    expect(backspaceOn(add("input"))).toBe(false);
    expect(backspaceOn(add("input", (i) => (i.type = "search")))).toBe(false);
    expect(backspaceOn(add("textarea"))).toBe(false);
    // jsdom has no isContentEditable: the property is what a browser sets for contenteditable
    const div = add("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(backspaceOn(div)).toBe(false);
  });

  it("leaves other keys alone", () => {
    const button = add("button");
    const e = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    button.addEventListener("keydown", (ev) => keepBackspaceFromHistory(ev as KeyboardEvent));
    button.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("Select All in a field", () => {
  it("selects the text of the focused search field", () => {
    const input = add("input", (i) => ((i.type = "search"), (i.value = "beam loads")));
    input.focus();
    expect(focusedTextField()).toBe(input);
    expect(selectInField()).toBe(true);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 10]);
  });

  it("is not taken when a button, or the page's own hidden field, has focus", () => {
    add("button").focus();
    expect(selectInField()).toBe(false);
    const sink = add("textarea", (t) => t.classList.add("key-sink"));
    sink.focus();
    expect(focusedTextField()).toBe(null);
    expect(selectInField()).toBe(false);
  });
});
