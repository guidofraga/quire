// End to end: a name no variable defines, read as a unit where a variable is usual (M/W),
// carries the same faint mark as a redefinition, with the explanation on hover.
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const regions = (page: Page) => page.locator(".region");

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

const NOTE = "W is the unit watt; if you meant a variable, define it above";

test("an undefined name read as a unit is marked, and a unit after a number is not", async ({ page }) => {
  await blank(page);
  await typeLines(page, "M := 40 N", "z := M/W", "P := 5 W", "q := 2 kN*m");
  await expect(regions(page)).toHaveCount(4);
  const mark = (i: number) => regions(page).nth(i).locator(".asunit");
  await expect(mark(1)).toHaveCount(1);
  await expect(mark(1)).toHaveText("W");
  await expect(mark(1)).toHaveAttribute("title", NOTE);
  // screen readers hear it with the line
  await expect(regions(page).nth(1).locator(".sr-only")).toContainText(NOTE);
  await expect(mark(0)).toHaveCount(0);
  await expect(mark(2)).toHaveCount(0);
  await expect(mark(3)).toHaveCount(0);
  // no badge, and no sentences under the line while it is edited
  await expect(page.locator(".unit-mark")).toHaveCount(0);
  await audit(page, "a line with a name read as a unit");
  await regions(page).nth(1).dblclick();
  await expect(page.locator(".math-input")).toBeFocused();
  await expect(page.locator(".name-note")).toHaveCount(0);
});

test("defining the name above removes the mark", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 450);
  await typeLines(page, "M := 40 N", "z := M/W");
  await expect(regions(page).nth(1).locator(".asunit")).toHaveCount(1);
  // a definition above the lines, in reading order
  await page.mouse.click(700, 250);
  await typeLines(page, "W := 3 N");
  await expect(regions(page).locator(".asunit")).toHaveCount(0);
});
