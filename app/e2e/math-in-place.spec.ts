// End to end: math typed into the typeset formula itself (#165, phase 2), with Settings ▸ Editing
// ▸ Edit math in place on. The formula on the page is the editor: it is drawn as it will be
// stored at every key, the caret goes where a click lands, arrows walk the structure, and the
// formula never moves when the edit starts, goes on, or ends. The keys: docs/07-math-editing.md.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { audit } from "./axe";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem("quire.prefs") ?? "{}");
    localStorage.setItem("quire.prefs", JSON.stringify({ ...prefs, mathInPlace: true }));
  });
});

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(600, 260);
}

const editing = (page: Page) => page.locator(".region.math.editing");
const formula = (page: Page) => editing(page).locator(".math-line > .m");
const sink = (page: Page) => page.locator("textarea.mip-sink");
const caret = (page: Page) => page.locator(".mip-caret");

/** What the document stores for each math region, in order. */
const stored = (page: Page) =>
  page.evaluate(() => {
    const q = (window as unknown as { __quire: { state: { doc: { regions: { kind: string; expr?: string }[] } } } })
      .__quire;
    return q.state.doc.regions.filter((r) => r.kind === "math").map((r) => r.expr ?? "");
  });

/** Type text one key at a time, as a person does. */
async function typeKeys(page: Page, text: string) {
  for (const ch of text) await page.keyboard.type(ch);
}

/** A line of math, finished with Enter (the insertion point goes under it). */
async function line(page: Page, text: string) {
  await typeKeys(page, text);
  await page.keyboard.press("Enter");
}

/** The caret's box, on screen. */
const caretBox = async (page: Page) => (await caret(page).boundingBox())!;
const box = async (l: Locator) => (await l.boundingBox())!;

test("M:=q*L^2/8= typed key by key: the fraction is there while typing, the result comes, the text is stored", async ({
  page,
}) => {
  await blank(page);
  await line(page, "q:=10");
  await line(page, "L:=2");
  await typeKeys(page, "M:=q*L^2/");
  // the fraction is drawn the moment `/` is typed, with an empty denominator
  await expect(formula(page).locator("mfrac")).toHaveCount(1);
  await expect(formula(page).locator("mfrac .ph")).toHaveCount(1);
  // no line of text anywhere: the formula is the editor
  await expect(page.locator(".math-input")).toHaveCount(0);
  await expect(sink(page)).toBeFocused();
  await typeKeys(page, "8");
  await expect(formula(page).locator("mfrac .ph")).toHaveCount(0);
  await expect(formula(page).locator("msup")).toHaveCount(1);
  await typeKeys(page, "=");
  await expect(formula(page).locator(".res")).toContainText("5");
  expect((await stored(page))[2]).toBe("M := q*L^2/8");
  await page.keyboard.press("Escape");
  await expect(editing(page)).toHaveCount(0);
  expect((await stored(page))[2]).toBe("M := q*L^2/8");
  await expect(page.locator(".region.math").nth(2).locator(".res")).toContainText("5");
});

test("a click in a denominator puts the caret there, and what is typed goes in it", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "x:=a/b+c");
  await page.keyboard.press("Escape");
  const region = page.locator(".region.math").first();
  await region.locator(".math-line > .m").dblclick();
  await expect(editing(page)).toHaveCount(1);
  // right of the b, in the denominator
  const b = await box(formula(page).locator("mfrac > :last-child"));
  await page.mouse.click(b.x + b.width - 0.5, b.y + b.height / 2);
  const c = await caretBox(page);
  expect(Math.abs(c.x + c.width / 2 - (b.x + b.width))).toBeLessThan(2);
  // the caret is on the denominator's line, below the fraction bar
  const bar = await box(formula(page).locator("mfrac > :first-child"));
  expect(c.y + c.height / 2).toBeGreaterThan(bar.y + bar.height);
  expect(c.y + c.height / 2).toBeLessThan(b.y + b.height + 4);
  await typeKeys(page, "+1");
  await expect(formula(page).locator("mfrac > :last-child")).toContainText("b+1");
  expect((await stored(page))[0]).toBe("x := a/(b + 1) + c");
  await page.keyboard.press("Escape");
});

test("arrows and Backspace walk and take apart a fraction, an exponent and a subscript", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "y:=A.n^2/d");
  await expect(formula(page).locator("mfrac msubsup")).toHaveCount(1);
  const den = await box(formula(page).locator("mfrac > :last-child"));
  const num = await box(formula(page).locator("mfrac > :first-child"));
  // ← walks every position, each one to the left of the last or up into the line above
  const seen: { x: number; y: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const c = await caretBox(page);
    seen.push({ x: c.x, y: c.y + c.height / 2 });
    await page.keyboard.press("ArrowLeft");
  }
  // in the denominator after d, before d; then the numerator from its end
  expect(seen[0].y).toBeGreaterThan(den.y);
  expect(seen[1].x).toBeLessThan(seen[0].x);
  expect(seen[2].y).toBeLessThan(num.y + num.height);
  // the exponent: its end (a smaller caret, higher), its start; then the subscript under it
  expect(seen[3].y).toBeLessThan(seen[2].y);
  expect(seen[4].x).toBeLessThan(seen[3].x);
  expect(seen[5].y).toBeGreaterThan(seen[4].y);
  // ↓ from the numerator lands in the denominator
  await page.keyboard.press("ArrowDown");
  expect((await caretBox(page)).y).toBeGreaterThan(den.y - 2);
  // Backspace at the start of the denominator takes the fraction apart, nothing lost
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(formula(page).locator("mfrac")).toHaveCount(0);
  expect((await stored(page))[0]).toBe("y := A.n^2 d");
  // ← into the exponent, Backspace takes the 2, a second one the empty exponent
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(formula(page).locator("msubsup .ph")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(formula(page).locator("msup, msubsup")).toHaveCount(0);
  await expect(formula(page).locator("msub")).toHaveCount(1);
  // into the subscript: its n, then the subscript itself
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(formula(page).locator("msub")).toHaveCount(0);
  expect((await stored(page))[0]).toMatch(/^y := A ?\*?d$/);
  await page.keyboard.press("Escape");
});

test("a composed character (IME, dead key) arrives as one character", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "x:=");
  // what the keyboard sends for ´ then e: a composition of ´, ended with é
  await sink(page).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    el.value = "´";
    el.dispatchEvent(new InputEvent("input", { data: "´", inputType: "insertCompositionText", isComposing: true }));
    el.value = "é";
    el.dispatchEvent(new CompositionEvent("compositionend", { data: "é" }));
  });
  // and text put in by dictation or the character viewer
  await page.keyboard.insertText("α");
  await expect(formula(page)).toContainText("éα");
  expect((await stored(page))[0]).toBe("x := éα");
  await page.keyboard.press("Escape");
});

test("undo and redo step through what was typed", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "a:=1/2");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(formula(page).locator("mfrac .ph")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(formula(page).locator("mfrac")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(formula(page).locator("mfrac")).toHaveCount(1);
  expect((await stored(page))[0]).toBe("a := 1/2");
  await page.keyboard.press("Escape");
});

test("after 20 C the unit list opens, and the unit picked goes in at the caret", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "T:=20 C");
  const list = page.getByRole("listbox", { name: "Names" });
  await expect(list).toBeVisible();
  const celsius = list.getByRole("option").filter({ hasText: "degree Celsius · temperature" });
  await expect(celsius).toHaveCount(1);
  // under the caret
  const c = await caretBox(page);
  const l = await box(list);
  expect(l.y).toBeGreaterThan(c.y + c.height - 1);
  expect(Math.abs(l.x - c.x)).toBeLessThan(40);
  await audit(page, "the unit list in a formula edited in place");
  await celsius.click();
  await expect(list).toHaveCount(0);
  expect((await stored(page))[0]).toBe("T := 20 °C");
  await expect(sink(page)).toBeFocused();
  await page.keyboard.press("Escape");
});

test("Ctrl+Space lists what the name at the caret can mean", async ({ page }) => {
  await blank(page);
  await line(page, "len:=3");
  await typeKeys(page, "y:=le");
  await page.keyboard.press("Control+Space");
  const list = page.getByRole("listbox", { name: "Names" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option").filter({ hasText: "len" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  expect((await stored(page))[1]).toBe("y := len");
  await page.keyboard.press("Escape");
});

test("Esc ends the edit without the formula moving: before, during and after", async ({ page }) => {
  await blank(page);
  await line(page, "q:=10");
  await line(page, "L:=2");
  await typeKeys(page, "M:=q*L^2/8 + sqrt(L)=");
  await page.keyboard.press("Escape");
  const region = page.locator(".region.math").nth(2);
  const math = region.locator(".math-line > .m math");
  await expect(region.locator(".res")).toContainText("6.41");
  const before = await box(math);
  await region.locator(".math-line > .m").dblclick();
  await expect(editing(page)).toHaveCount(1);
  await expect(sink(page)).toBeFocused();
  const during = await box(formula(page).locator("math"));
  expect(during).toEqual(before);
  // moving through it changes nothing either
  for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowLeft");
  expect(await box(formula(page).locator("math"))).toEqual(before);
  await audit(page, "a formula edited in place");
  await page.keyboard.press("Escape");
  await expect(editing(page)).toHaveCount(0);
  expect(await box(math)).toEqual(before);
  expect((await stored(page))[2]).toBe("M := q*L^2/8 + sqrt(L)");
});
