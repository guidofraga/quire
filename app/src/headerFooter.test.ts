// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chipTypedFields, fromTokens, readSlot, renderSlot, SlotHistory, toTokens } from "./headerFooter";

describe("fields as tokens", () => {
  it("splits a slot into text and the fields it knows", () => {
    expect(toTokens("Page {page} of {pages}")).toEqual(["Page ", { field: "page" }, " of ", { field: "pages" }]);
    expect(toTokens("{date}")).toEqual([{ field: "date" }]);
    expect(toTokens("")).toEqual([]);
  });

  it("leaves braces that are not a field as text", () => {
    expect(toTokens("{nope} {page} {")).toEqual(["{nope} ", { field: "page" }, " {"]);
  });

  it("gives back exactly the text it was made from", () => {
    for (const t of ["{author} | {company}", "{page} / {pages}", "a{section}b", "{x}{title}{", "plain"])
      expect(fromTokens(toTokens(t))).toBe(t);
  });
});

describe("a slot in the editor", () => {
  const slot = () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    document.body.append(el);
    return el;
  };

  it("shows fields as chips named in words, and reads back as the text in the file", () => {
    const el = slot();
    renderSlot(el, "Page {page} of {pages}");
    const chips = el.querySelectorAll<HTMLElement>(".hf-chip");
    expect([...chips].map((c) => c.textContent)).toEqual(["Page", "Pages"]);
    expect(chips[0].contentEditable).toBe("false");
    expect(readSlot(el)).toBe("Page {page} of {pages}");
  });

  it("reads a slot on one line, with ordinary spaces", () => {
    const el = slot();
    el.innerHTML = "a b<br>c";
    expect(readSlot(el)).toBe("a b c");
  });

  it("turns {page} typed by hand into a chip and keeps the caret after it", () => {
    const el = slot();
    el.textContent = "Page {page}";
    const sel = document.getSelection()!;
    sel.collapse(el.firstChild, "Page {page}".length);
    expect(chipTypedFields(el)).toBe(true);
    expect(el.querySelector(".hf-chip")?.textContent).toBe("Page");
    expect(readSlot(el)).toBe("Page {page}");
    expect(sel.anchorNode).toBe(el);
    expect(el.childNodes[sel.anchorOffset - 1]).toBe(el.querySelector(".hf-chip"));
  });

  it("keeps the caret in the text when a field is closed before it", () => {
    const el = slot();
    el.textContent = "{date} – x";
    const sel = document.getSelection()!;
    sel.collapse(el.firstChild, 8);
    chipTypedFields(el);
    expect(sel.anchorNode?.nodeValue).toBe(" – x");
    expect(sel.anchorOffset).toBe(2);
  });

  it("leaves text without fields alone", () => {
    const el = slot();
    el.textContent = "{nope}";
    expect(chipTypedFields(el)).toBe(false);
    expect(el.querySelector(".hf-chip")).toBeNull();
  });
});

describe("undo inside one session", () => {
  const v = (left: string) => ({ left, center: "", right: "" });

  it("joins typing in one slot into one step, and keeps a field inserted as its own", () => {
    const h = new SlotHistory();
    h.before(v(""), "left", true, 0);
    h.before(v("a"), "left", true, 100);
    h.before(v("ab"), "left", false, 200);
    expect(h.undo(v("ab{page}"))).toEqual(v("ab"));
    expect(h.undo(v("ab"))).toEqual(v(""));
    expect(h.undo(v(""))).toBeNull();
    expect(h.redo(v(""))).toEqual(v("ab"));
  });

  it("starts a new step after a pause or in another slot", () => {
    const h = new SlotHistory();
    h.before(v(""), "left", true, 0);
    h.before(v("a"), "left", true, 5000);
    h.before({ left: "ab", center: "", right: "" }, "right", true, 5100);
    expect(h.undo({ left: "ab", center: "", right: "x" })).toEqual(v("ab"));
    expect(h.undo(v("ab"))).toEqual(v("a"));
    expect(h.undo(v("a"))).toEqual(v(""));
  });

  it("keeps whole bands, an absent one included, apart from later changes", () => {
    type Hf = { left?: string; rule?: { width?: string } } | undefined;
    const h = new SlotHistory<Hf>();
    h.before(undefined, "left", false, 0);
    const band: Hf = { left: "a", rule: {} };
    h.before(band, "left", false, 10);
    band.rule!.width = "1pt"; // the document changes the object in place
    expect(h.undo({ left: "b" })).toEqual({ left: "a", rule: {} });
    // the band did not exist before the first change: undo says so, rather than "nothing left"
    expect(h.undo({ left: "a", rule: {} })).toBeUndefined();
    expect(h.undo(undefined)).toBeNull();
    expect(h.redo(undefined)).toEqual({ left: "a", rule: {} });
  });
});
