// End to end: Insert ▸ Solve Block, edit a constraint, the values it finds used below it, an
// error in plain words, and undo.
import { expect, type Page, test } from "@playwright/test";

async function insertBlock(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Solve Block" }).click();
  const block = page.getByRole("group", { name: "Solve block for x, y" });
  await expect(block).toBeVisible();
  return block;
}

test("a solve block finds values the math below it uses, and undo puts it back", async ({ page }) => {
  const block = await insertBlock(page);
  const find = block.locator('[data-line$=":f"]');
  // the example is solved at once: x² + y² = 4 with y = 2x gives x = 2/√5, y = 4/√5
  await expect(find.locator(".res")).toContainText("0.8944");
  await expect(block.locator(".solve-check.pass")).toHaveCount(2);

  // it opens on its first constraint, where `=` is the equation sign
  const input = block.locator("input.math-input");
  await expect(input).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x^2 + y^2 = 5");
  await expect(input).toHaveValue("x^2 + y^2 == 5");
  // Tab goes on to the next line of the block
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("y == 2*x");
  await page.keyboard.press("Escape");
  await expect(block.locator("input.math-input")).toHaveCount(0);
  // x² + 4x² = 5: x = 1, y = 2
  await expect(find.locator(".res")).toContainText("1");
  await expect(find.locator(".res")).toContainText("2");
  await expect(block.locator(".solve-check.pass")).toHaveCount(2);

  // the variables it defines are there below it
  const box = await block.boundingBox();
  if (!box) throw new Error("no block");
  await page.mouse.click(box.x + 20, box.y + box.height + 40);
  await page.keyboard.type("x*y + x =");
  await page.keyboard.press("Escape");
  const below = page.locator(".region.math");
  await expect(below).toHaveCount(1);
  await expect(below.locator(".res")).toHaveText("3");

  // undo: the line below goes, then the constraint is as it was
  await page.keyboard.press("ControlOrMeta+z");
  await expect(below).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(find.locator(".res")).toContainText("0.8944");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block).toHaveCount(0);
});

test("a block with no solution says so in plain words and marks what fails", async ({ page }) => {
  const block = await insertBlock(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x^2 + y^2 = -1");
  await page.keyboard.press("Escape");
  const error = block.locator('[data-line$=":f"] .err');
  await expect(error).toContainText("No solution near the guess values");
  await expect(error).toContainText("minerr");
  await expect(block.locator(".solve-check.fail")).not.toHaveCount(0);
  // a screen reader hears the block and its error when it is selected from the keyboard
  await expect(block.locator("[aria-live]")).toContainText("Error: No solution");
});
