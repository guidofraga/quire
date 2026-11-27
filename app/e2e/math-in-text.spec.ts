// End to end: inline math inside text, typed into the typeset formula itself (#165, phase 3b), with
// Settings ▸ Editing ▸ Edit math in place on. ← → go from the text into a formula and out again,
// a click goes where it lands, Esc and Enter return to the text, one undo history serves both,
// and nothing in the paragraph moves while the caret goes in and out. The keys:
// docs/07-math-editing.md § Inline math in text.
import { expect, type Page, test } from "@playwright/test";

const inPlace = (page: Page) =>
  page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem("quire.prefs") ?? "{}");
    localStorage.setItem("quire.prefs", JSON.stringify({ ...prefs, mathInPlace: true }));
  });

/** A blank document with a text region holding this Djot, pasted as another Quire window would. */
async function withText(page: Page, text: string, width?: number) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(400, 250);
  const clip = { quire: 1, regions: [{ id: "t1", kind: "text", at: [0, 0], text, ...(width ? { width } : {}) }] };
  const b64 = Buffer.from(JSON.stringify(clip)).toString("base64");
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(e);
  }, `<div data-quire-clip="${b64}"><p>text</p></div>`);
  await expect(page.locator(".region.text")).toHaveCount(1);
}

/** Start editing the text region: a click selects it, a second one edits it, on its first word. */
async function edit(page: Page, word: string) {
  const at = page.locator(".region.text").getByText(word).first();
  await at.click({ position: { x: 3, y: 6 } });
  await at.click({ position: { x: 3, y: 6 } });
  await expect(page.locator(".rich-editor")).toBeFocused();
}

/** The text region's Djot, as the document holds it (written while it is typed). */
const stored = (page: Page) =>
  page.evaluate(() => {
    const q = (window as unknown as { __quire: { state: { doc: { regions: { kind: string; text?: unknown }[] } } } })
      .__quire;
    return String(q.state.doc.regions.find((r) => r.kind === "text")?.text ?? "");
  });

const editor = (page: Page) => page.locator(".rich-editor");
/** The inline formula being typed into. */
const open = (page: Page) => editor(page).locator(".qmath .m.in-place");
const sink = (page: Page) => page.locator("textarea.mip-sink");
const caret = (page: Page) => page.locator(".mip-caret");

async function typeKeys(page: Page, text: string) {
  for (const ch of text) await page.keyboard.type(ch);
}

/** The caret to the start of the text, with the platform's key for it (CI is Linux). */
const toStart = (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");

/** Where the text caret is: the text before it in its paragraph, formulas as `$…$`. */
const textCaret = (page: Page) =>
  page.evaluate(() => {
    const s = getSelection()!;
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const p = (
      r.startContainer.nodeType === 1 ? (r.startContainer as Element) : r.startContainer.parentElement
    )!.closest("p");
    if (!p) return null;
    const before = document.createRange();
    before.setStart(p, 0);
    before.setEnd(r.startContainer, r.startOffset);
    const div = document.createElement("div");
    div.appendChild(before.cloneContents());
    for (const m of div.querySelectorAll(".qmath")) m.replaceWith("$");
    return div.textContent;
  });

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test.describe("edited in place", () => {
  test.beforeEach(({ page }) => inPlace(page));

  test("a sentence typed with inline math: q*L^2/8 is a fraction as it is typed, → goes back to the text", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Blank document/ }).click();
    await page.mouse.click(400, 250);
    // a word and a space at the start of a new region: it becomes text
    await typeKeys(page, "The moment is ");
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Shift+m");
    // the formula is open at once, its caret in the empty slot
    await expect(open(page)).toHaveCount(1);
    await expect(sink(page)).toBeFocused();
    await expect(open(page).locator(".ph.on")).toHaveCount(1);
    await typeKeys(page, "q*L^2/");
    // the fraction is drawn the moment `/` is typed, its denominator empty
    await expect(open(page).locator("mfrac")).toHaveCount(1);
    await expect(open(page).locator("mfrac .ph")).toHaveCount(1);
    await typeKeys(page, "8");
    await expect(open(page).locator("mfrac .ph")).toHaveCount(0);
    await expect(open(page).locator("msup")).toHaveCount(1);
    // out of the denominator, then out of the formula: the text caret right after it
    await page.keyboard.press("ArrowRight");
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(editor(page)).toBeFocused();
    await expect(open(page)).toHaveCount(0);
    await typeKeys(page, " at midspan.");
    expect(await stored(page)).toBe("The moment is $`q*L^2/8` at midspan.");
    // the formula stays typeset in the text
    await expect(editor(page).locator(".qmath mfrac")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(editor(page)).toHaveCount(0);
    expect(await stored(page)).toBe("The moment is $`q*L^2/8` at midspan.");
    await expect(page.locator(".region.text .qmath mfrac")).toHaveCount(1);
  });

  test("a click in an inline formula puts the caret there, and what is typed goes in it", async ({ page }) => {
    await withText(page, "A load $`w := a/b` on the beam.");
    await edit(page, "beam");
    const den = await box(page, ".rich-editor .qmath mfrac > :last-child");
    await page.mouse.click(den.x + den.width - 0.5, den.y + den.height / 2);
    await expect(sink(page)).toBeFocused();
    const c = (await caret(page).boundingBox())!;
    expect(Math.abs(c.x + c.width / 2 - (den.x + den.width))).toBeLessThan(2);
    await typeKeys(page, "+1");
    await expect(open(page).locator("mfrac > :last-child")).toContainText("b+1");
    expect(await stored(page)).toBe("A load $`w := a/(b + 1)` on the beam.");
    // a click on the text puts the caret back in the text
    const word = await box(page, ".rich-editor p");
    await page.mouse.click(word.x + 4, word.y + word.height / 2);
    await expect(editor(page)).toBeFocused();
    await expect(open(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("← → go into a formula at its edge and out again, at both edges", async ({ page }) => {
    await withText(page, "x $`a+b` y");
    await edit(page, "y");
    await toStart(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await textCaret(page)).toBe("x ");
    const math = await box(page, ".rich-editor .qmath math");
    // → at the text's edge: into the formula, at its start
    await page.keyboard.press("ArrowRight");
    await expect(sink(page)).toBeFocused();
    let c = (await caret(page).boundingBox())!;
    expect(Math.abs(c.x - math.x)).toBeLessThan(3);
    for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowRight");
    c = (await caret(page).boundingBox())!;
    expect(Math.abs(c.x + c.width - (math.x + math.width))).toBeLessThan(3);
    // → at the formula's end: back to the text, right after it
    await page.keyboard.press("ArrowRight");
    await expect(editor(page)).toBeFocused();
    expect(await textCaret(page)).toBe("x $");
    // ← at the text's edge: into the formula, at its end
    await page.keyboard.press("ArrowLeft");
    await expect(sink(page)).toBeFocused();
    c = (await caret(page).boundingBox())!;
    expect(Math.abs(c.x + c.width - (math.x + math.width))).toBeLessThan(3);
    for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowLeft");
    // ← at the formula's start: back to the text, right before it
    await page.keyboard.press("ArrowLeft");
    await expect(editor(page)).toBeFocused();
    expect(await textCaret(page)).toBe("x ");
    await typeKeys(page, "!");
    expect(await stored(page)).toBe("x !$`a+b` y");
    await page.keyboard.press("Escape");
  });

  test("one undo history for the text and its formulas: each ⌘Z undoes the latest edit, wherever it was", async ({
    page,
  }) => {
    await withText(page, "x $`a` y");
    await edit(page, "y");
    await toStart(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    // into the formula, typed into, out, then text typed
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await typeKeys(page, "+c");
    expect(await stored(page)).toBe("x $`a + c` y");
    await page.keyboard.press("ArrowRight");
    await expect(editor(page)).toBeFocused();
    await typeKeys(page, "z");
    expect(await stored(page)).toBe("x $`a + c`z y");
    // the text first
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => stored(page)).toBe("x $`a + c` y");
    // then the formula, a key at a time, the formula open where it is undone
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => stored(page)).toBe("x $`a + ?` y");
    await expect(open(page)).toHaveCount(1);
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => stored(page)).toBe("x $`a` y");
    // and redo, the same way back
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => stored(page)).toBe("x $`a + c` y");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => stored(page)).toBe("x $`a + c`z y");
    await page.keyboard.press("Escape");
  });

  test("Esc in a formula returns to the text right after it; Esc again ends the edit", async ({ page }) => {
    await withText(page, "x $`a/b` y");
    await edit(page, "y");
    await page.locator(".rich-editor .qmath mfrac > :first-child").click();
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editor(page)).toBeFocused();
    await expect(open(page)).toHaveCount(0);
    expect(await textCaret(page)).toBe("x $");
    // Enter at the formula's end returns to the text too, without a new paragraph
    await page.keyboard.press("ArrowLeft");
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor(page)).toBeFocused();
    await expect(editor(page).locator("p")).toHaveCount(1);
    expect(await textCaret(page)).toBe("x $");
    await page.keyboard.press("Escape");
    await expect(editor(page)).toHaveCount(0);
    expect(await stored(page)).toBe("x $`a/b` y");
  });

  test("nothing in the paragraph moves as the caret goes into a formula and out", async ({ page }) => {
    const words =
      "The load on the beam gives a moment of $`M := q*L^2/8` at midspan, and the deflection follows from it.";
    await withText(page, words, 260);
    await edit(page, "deflection");
    /** Every line box of the paragraph, and the formula's box. */
    const lines = () =>
      page.evaluate(() => {
        const p = document.querySelector(".rich-editor p")!;
        const r = document.createRange();
        r.selectNodeContents(p);
        const boxes = [...r.getClientRects()].map((b) => [b.left, b.top, b.width, b.height].map(Math.round).join(","));
        const m = p.querySelector(".qmath math")!.getBoundingClientRect();
        return { boxes, math: [m.left, m.top, m.width, m.height].map(Math.round).join(",") };
      });
    const before = await lines();
    // more than one line: the formula sits inside a wrapped paragraph
    expect(
      new Set(
        await page.locator(".rich-editor p").evaluate((p) => {
          const r = document.createRange();
          r.selectNodeContents(p);
          return [...r.getClientRects()].map((b) => Math.round(b.top));
        }),
      ).size,
    ).toBeGreaterThan(2);
    await page.locator(".rich-editor .qmath mfrac > :last-child").click();
    await expect(sink(page)).toBeFocused();
    expect(await lines()).toEqual(before);
    for (let k = 0; k < 4; k++) await page.keyboard.press("ArrowLeft");
    expect(await lines()).toEqual(before);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await expect(editor(page)).toBeFocused();
    expect(await lines()).toEqual(before);
    await page.keyboard.press("ArrowLeft");
    await expect(sink(page)).toBeFocused();
    expect(await lines()).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(editor(page)).toBeFocused();
    expect(await lines()).toEqual(before);
    await page.keyboard.press("Escape");
  });
});

test.describe("edited in place, where things are", () => {
  test.beforeEach(({ page }) => inPlace(page));

  test("a formula whose result can't be worked out keeps its = □: starting and ending the text's edit moves nothing", async ({
    page,
  }) => {
    // `w` is defined nowhere: the formula asks for a result it can't have
    await withText(page, "The value is $`w*2 =` and the rest of the sentence.");
    /** The formula's box and the paragraph's, relative to the paragraph. */
    const where = (scope: string) =>
      page.evaluate((scope) => {
        const p = document.querySelector(`${scope} p`)!.getBoundingClientRect();
        const m = document.querySelector(`${scope} .qmath math`)!.getBoundingClientRect();
        return [m.left - p.left, m.top - p.top, m.width, m.height, p.width, p.height].map((v) => Math.round(v * 2) / 2);
      }, scope);
    await expect(page.locator(".region.text .qmath .ph")).toHaveCount(1);
    const shown = await where(".region.text .text-body");
    await edit(page, "The value");
    const editing = await where(".rich-editor");
    expect(editing).toEqual(shown);
    await page.locator(".rich-editor .qmath math").click();
    await expect(sink(page)).toBeFocused();
    expect(await where(".rich-editor")).toEqual(shown);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(editor(page)).toHaveCount(0);
    expect(await where(".region.text .text-body")).toEqual(shown);
  });

  test("↑ ↓ from a formula: the line above or below at the caret's x, or the paragraph's start or end", async ({
    page,
  }) => {
    await withText(
      page,
      "One $`a` two three four five six seven eight nine ten $`c` eleven twelve thirteen fourteen fifteen $`b` end",
      170,
    );
    // on the text, clear of the formulas
    const p = page.locator(".region.text p");
    await p.click({ position: { x: 100, y: 6 } });
    await p.click({ position: { x: 100, y: 6 } });
    await expect(editor(page)).toBeFocused();
    const caretTop = () =>
      page.evaluate(() => {
        const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
        return r.top + r.height / 2;
      });
    const formulas = editor(page).locator(".qmath math");
    // the first formula, on the first line: ↑ goes to the paragraph's start
    await formulas.nth(0).click();
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(editor(page)).toBeFocused();
    expect(await textCaret(page)).toBe("");
    // the last, on the last line: ↓ goes to its end
    await formulas.nth(2).click();
    await expect(sink(page)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(editor(page)).toBeFocused();
    expect(await textCaret(page)).toMatch(/fifteen \$ end$/);
    // one in the middle: ↑ to the line above, ↓ to the line below, near the formula's x
    const mid = (await formulas.nth(1).boundingBox())!;
    await formulas.nth(1).click();
    await page.keyboard.press("ArrowUp");
    await expect(editor(page)).toBeFocused();
    const above = await caretTop();
    expect(above).toBeLessThan(mid.y);
    expect(await textCaret(page)).not.toBe("");
    await formulas.nth(1).click();
    await page.keyboard.press("ArrowDown");
    await expect(editor(page)).toBeFocused();
    expect(await caretTop()).toBeGreaterThan(mid.y + mid.height);
    expect(await textCaret(page)).not.toMatch(/ end$/);
    await page.keyboard.press("Escape");
  });
});

test("with the setting off, inline math is edited as linear text in a box, as before", async ({ page }) => {
  await withText(page, "A load $`a/b` on it.");
  await edit(page, "load");
  const chip = editor(page).locator(".qmath-chip input");
  await expect(chip).toHaveValue("a/b");
  await expect(page.locator(".mip-sink")).toHaveCount(0);
  await chip.click();
  await chip.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
  await typeKeys(page, "+1");
  expect(await stored(page)).toBe("A load $`a/b+1` on it.");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator(".region.text .qmath mfrac")).toHaveCount(1);
});
