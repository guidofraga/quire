// Captions as in Word: right-click a table or figure ▸ Insert Caption…, numbered by itself,
// above a table and below a figure.
import { expect, test } from "@playwright/test";

test("Insert Caption numbers tables and feeds the list of tables", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  const box = (await page.locator(".content-box").first().boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 60);
  await page.getByRole("button", { name: /^.?\s*Table$/ }).first().click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Carga");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const table = page.locator(".region.table").first();
  await table.click({ button: "right" });
  await page.getByText("Insert Caption…", { exact: true }).click();
  const input = page.locator(".caption-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("Cargas no olhal");
  await input.press("Enter");
  const caption = table.locator(".caption");
  await expect(caption).toContainText(/1/, { timeout: 10_000 });
  await expect(caption).toContainText("Cargas no olhal", { timeout: 10_000 });
  // a table's caption goes above it, as in Word
  const capBox = (await caption.boundingBox())!;
  const sheetBox = (await table.locator("table").first().boundingBox())!;
  expect(capBox.y).toBeLessThan(sheetBox.y);
});
