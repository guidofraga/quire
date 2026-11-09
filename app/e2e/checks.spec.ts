// End to end: a comparison is a check by itself, no `=` needed.
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

test("a comparison without = shows pass or fail, counts, and is listed in the summary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  await typeLines(page, "M := 50 kN*m", "M <= 60 kN*m", "M >= 60 kN*m", "ok := M <= 60 kN*m");
  await expect(regions(page)).toHaveCount(4);
  await expect(regions(page).nth(1).locator(".check-badge")).toHaveText("✓");
  await expect(regions(page).nth(2).locator(".check-badge")).toHaveText("✗ fails");
  // a definition holding a comparison is not a check, nor is a plain definition
  await expect(regions(page).nth(3).locator(".check-badge")).toHaveCount(0);
  await expect(regions(page).nth(0).locator(".check-badge")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "✗ 1 of 2 failing" })).toBeVisible();

  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Summary of Checks" }).click();
  const summary = page.locator(".checks-summary");
  await expect(summary.locator(".contents-row")).toHaveCount(2);
  await expect(summary.locator(".checks-total")).toHaveText("1 of 2 failing");
});
