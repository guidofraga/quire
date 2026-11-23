// End to end: a formula's note on any side of it, from the right-click menu, the Inspector or a
// drag that snaps to the nearest side, with the formula staying put (#167); and Ctrl+Y as
// Redo on Windows (#168).
import { expect, type Locator, type Page, test } from "@playwright/test";

/** A blank document with one formula, selected, carrying the note "Final check". */
async function formulaWithNote(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(500, 300);
  await page.keyboard.type("D:=2*3=");
  await page.keyboard.press("Escape");
  const region = page.locator(".region").first();
  await region.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Note…" }).click();
  // the Inspector opens with the cursor in the note's field
  const field = page.locator('[data-field="note"]');
  await expect(field).toBeFocused();
  await page.keyboard.type("Final check");
  await page.keyboard.press("Enter");
  await expect(region.locator(".note")).toHaveText("Final check");
  // the Inspector slides open and moves the page with it: measure once that has settled
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await region.locator(".math-line > .m").boundingBox());
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return region;
}

const box = async (l: Locator) => (await l.boundingBox())!;

/** The formula must not move on the page when its note changes side (regions sit on whole units). */
async function expectFormulaAt(region: Locator, at: { x: number; y: number }) {
  const formula = region.locator(".math-line > .m");
  await expect.poll(async () => Math.abs((await box(formula)).x - at.x)).toBeLessThan(1.5);
  await expect.poll(async () => Math.abs((await box(formula)).y - at.y)).toBeLessThan(1.5);
}

test("dragging a note snaps it to the side of the formula it is dropped on", async ({ page }) => {
  const region = await formulaWithNote(page);
  const line = region.locator(".math-line");
  await expect(line).toHaveClass(/\bnote-right\b/);
  const formula = await box(region.locator(".math-line > .m"));
  const note = await box(region.locator(".note"));

  // above the formula
  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  await page.mouse.down();
  await page.mouse.move(formula.x + formula.width / 2, formula.y - 40, { steps: 8 });
  // while dragging, a ghost shows where it will land
  await expect(page.locator(".note-ghost")).toHaveAttribute("data-side", "above");
  await page.mouse.up();
  await expect(page.locator(".note-ghost")).toHaveCount(0);
  await expect(line).toHaveClass(/\bnote-above\b/);
  const noteAbove = await box(region.locator(".note"));
  expect(noteAbove.y + noteAbove.height).toBeLessThanOrEqual(formula.y + 1);
  await expectFormulaAt(region, formula);

  // left of it
  await page.mouse.move(noteAbove.x + noteAbove.width / 2, noteAbove.y + noteAbove.height / 2);
  await page.mouse.down();
  await page.mouse.move(formula.x - 80, formula.y + formula.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(line).toHaveClass(/\bnote-left\b/);
  const noteLeft = await box(region.locator(".note"));
  expect(noteLeft.x + noteLeft.width).toBeLessThanOrEqual(formula.x + 1);
  await expectFormulaAt(region, formula);

  // Esc during a drag leaves it where it was
  await page.mouse.move(noteLeft.x + noteLeft.width / 2, noteLeft.y + noteLeft.height / 2);
  await page.mouse.down();
  await page.mouse.move(formula.x + formula.width / 2, formula.y + formula.height + 40, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(line).toHaveClass(/\bnote-left\b/);

  // each move is one undo step, note and formula together
  await page.keyboard.press("ControlOrMeta+z");
  await expect(line).toHaveClass(/\bnote-above\b/);
  await expectFormulaAt(region, formula);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(line).toHaveClass(/\bnote-right\b/);
  await expectFormulaAt(region, formula);
});

test("the right-click menu and the Inspector put the note on a side", async ({ page }) => {
  const region = await formulaWithNote(page);
  const line = region.locator(".math-line");
  const formula = await box(region.locator(".math-line > .m"));

  await region.locator(".math-line > .m").click({ button: "right" });
  await expect(page.getByRole("menuitemcheckbox", { name: "Note on the Right" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("menuitemcheckbox", { name: "Note Below" }).click();
  await expect(line).toHaveClass(/\bnote-below\b/);
  await expectFormulaAt(region, formula);

  // the Inspector shows the side, and sets it
  const position = page.getByRole("combobox", { name: "Note position" });
  await expect(position).toHaveValue("below");
  await position.selectOption("left");
  await expect(line).toHaveClass(/\bnote-left\b/);
  await expectFormulaAt(region, formula);
});

test.describe("on Windows", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  });

  test("Ctrl+Z undoes and Ctrl+Y redoes on the page", async ({ page }) => {
    const region = await formulaWithNote(page);
    await page.mouse.click(900, 600);
    await page.keyboard.press("Control+z");
    await expect(region.locator(".note")).toHaveCount(0);
    await page.keyboard.press("Control+y");
    await expect(region.locator(".note")).toHaveText("Final check");
  });
});
