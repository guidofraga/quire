// End to end: the formula being typed stays typeset at every keystroke, with □ for what is still
// missing, units keep their colour, and opening a formula doesn't move it on the page (#164).
import { expect, type Page, test } from "@playwright/test";

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(600, 300);
}

const editing = (page: Page) => page.locator(".region.math.editing");

test("an unfinished line is drawn typeset, with empty slots, never as plain text", async ({ page }) => {
  await blank(page);
  // a bracket left open and a division waiting for its denominator
  await page.keyboard.type("M:=q*(L-x)/");
  const line = editing(page).locator(".math-line");
  await expect(line.locator("mfrac")).toHaveCount(1);
  await expect(line.locator(".ph")).toHaveCount(1);
  await expect(line.locator("code.raw")).toHaveCount(0);
  // the denominator comes: the slot goes
  await page.keyboard.type("2");
  await expect(line.locator(".ph")).toHaveCount(0);
  await expect(line.locator("mfrac")).toHaveCount(1);
});

test("a unit keeps its colour while the line after it is unfinished", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("q:=12 kN");
  const line = editing(page).locator(".math-line");
  await expect(line.locator(".u", { hasText: "kN" })).toHaveCount(1);
  await page.keyboard.type("/");
  await expect(line.locator(".ph")).toHaveCount(1);
  await expect(line.locator(".u", { hasText: "kN" })).toHaveCount(1);
});

test("opening a formula to edit it doesn't move it on the page", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("M:=q*L^2/8");
  await page.keyboard.press("Escape");
  const region = page.locator(".region.math").first();
  const formula = region.locator(".math-line > .m");
  await expect(formula).toBeVisible();
  const before = (await formula.boundingBox())!;
  // on the formula itself: its error note under it is a target of its own
  await formula.dblclick();
  await expect(editing(page)).toHaveCount(1);
  await expect(editing(page).locator(".math-input")).toBeFocused();
  const during = (await editing(page).locator(".math-line > .m").boundingBox())!;
  expect(Math.abs(during.x - before.x)).toBeLessThan(1);
  expect(Math.abs(during.y - before.y)).toBeLessThan(1);
  // what is typed floats under the formula
  const input = (await editing(page).locator(".math-input").boundingBox())!;
  expect(input.y).toBeGreaterThanOrEqual(during.y + during.height - 1);
});

test("brackets and quotes close themselves, and the closer typed anyway steps past", async ({ page }) => {
  await blank(page);
  const input = page.locator(".math-input");
  await page.keyboard.type("M:=q*(L-x");
  await expect(input).toHaveValue("M:=q*(L-x)");
  // the `)` already there is stepped over, not doubled
  await page.keyboard.type(")/2");
  await expect(input).toHaveValue("M:=q*(L-x)/2");
  await page.keyboard.type(" + f(");
  await expect(input).toHaveValue("M:=q*(L-x)/2 + f()");
  // Backspace between an empty pair takes both
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("M:=q*(L-x)/2 + f");
});

test("the bracket pair at the caret is highlighted, and one not closed yet is faint", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("a:=2*(b+c");
  const line = editing(page).locator(".math-line");
  // the caret sits before the `)` that closed itself: that pair lights up
  await expect(line.locator("mo.bmatch")).toHaveCount(2);
  // past the `)`: no pair at the caret any more
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("+d");
  await expect(line.locator("mo.bmatch")).toHaveCount(0);

  // a `(` typed before text doesn't close itself: its `)` is drawn faint until typed
  await page.keyboard.press("Escape");
  await page.mouse.click(600, 450);
  await page.keyboard.type("x:=a+b");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("(");
  await expect(page.locator(".math-input")).toHaveValue("x:=(a+b");
  await expect(editing(page).locator(".math-line mo.ghost")).toHaveCount(1);
});

/** The middle of the drawn piece showing `text` in the formula being edited. */
async function pieceAt(page: Page, text: string) {
  const piece = editing(page)
    .locator(".math-line > .m")
    .locator("mi, mn, mo")
    .filter({ hasText: new RegExp(`^${text}$`) });
  return (await piece.first().boundingBox())!;
}

test("the typing caret shows in the formula, and follows the arrow keys", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("M:=q*(L-x)/2");
  const caret = editing(page).locator(".formula-caret");
  await expect(caret).toBeVisible();
  // at the end, after the 2 under the fraction bar
  const two = await pieceAt(page, "2");
  await expect.poll(async () => Math.abs((await caret.boundingBox())!.x - (two.x + two.width))).toBeLessThan(3);
  // back four: after `L−`, before `x`, up in the numerator
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  const x = await pieceAt(page, "x");
  await expect.poll(async () => Math.abs((await caret.boundingBox())!.x - x.x)).toBeLessThan(3);
  expect((await caret.boundingBox())!.y).toBeLessThan(two.y);
});

test("a click in the formula being edited moves the typing caret there", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("M:=q*(L-x)/2");
  const input = page.locator(".math-input");
  const q = await pieceAt(page, "q");
  // on the right half of q: just after it, in `M:=q|*(L-x)/2`
  await page.mouse.click(q.x + q.width * 0.8, q.y + q.height / 2);
  await expect(editing(page)).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(4);
  await page.keyboard.type("^2");
  await expect(input).toHaveValue("M:=q^2*(L-x)/2");
});

test("the click that opens a formula puts the caret where it landed", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("a:=bb+c");
  await page.keyboard.press("Escape");
  const region = page.locator(".region.math").first();
  const b = region.locator(".math-line > .m mi").filter({ hasText: /^bb$/ });
  const box = (await b.boundingBox())!;
  // the region is selected: a click on it opens it, there, on the left edge of bb
  await page.mouse.click(box.x + 1, box.y + box.height / 2);
  await expect(editing(page)).toHaveCount(1);
  await expect.poll(() => page.locator(".math-input").evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);
});
