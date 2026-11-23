// End to end: commands reachable without knowing their shortcuts. In a browser there is no menu
// bar, so the toolbar has a menu and a Help button (#153); and the text format bar offers inline
// math and cross-references (#154).
import { expect, type Page, test } from "@playwright/test";

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
}

test("in a browser the toolbar's menu reaches the File commands, Settings and Help", async ({ page }) => {
  await blank(page);
  await page.getByRole("button", { name: "Menu" }).click();
  const menu = page.getByRole("menu");
  for (const item of ["New", "Open…", "Save", "Export as Word…", "Print…", "Command Palette…", "Settings…"])
    await expect(menu.locator(".cm-label").getByText(item, { exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Settings…/ }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("dialog", { name: "Quire Help" })).toBeVisible();
});

/** A text paragraph being typed, with the format bar for text showing. */
async function typing(page: Page, words: string) {
  await blank(page);
  await page.mouse.click(700, 250);
  await page.keyboard.type(words);
  await expect(page.locator(".rich-editor")).toBeFocused();
  return page.locator(".formatbar");
}

test("the text format bar inserts inline math", async ({ page }) => {
  const bar = await typing(page, "The span is ");
  await bar.getByRole("button", { name: /Inline math/ }).click();
  // the math field inside the sentence (its class depends on whether it is being typed in)
  await expect(page.locator(".rich-editor [class*='qmath']").first()).toBeVisible();
});

test("the text format bar opens the cross-reference picker", async ({ page }) => {
  const bar = await typing(page, "As shown in ");
  await bar.getByRole("button", { name: /Cross-reference/ }).click();
  await expect(page.getByRole("dialog", { name: "Insert cross-reference" })).toBeVisible();
});
