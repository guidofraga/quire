// End to end: the editor's keyboard states, typed as a user would (WebKit, `quire serve`).
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");

/** A blank document with the insertion point on the page. */
async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

/** Type each line as a new region, as on a fresh page. */
async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

test("Escape on a new empty line leaves the keyboard working for the next line", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("a:=2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await page.keyboard.type("b:=3*4=");
  await page.keyboard.press("Escape");
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=12$/);
});

test("Select All hides the insertion point", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=2");
  await page.mouse.click(700, 600);
  await expect(page.locator(".caret")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".caret")).toHaveCount(0);
});

test("Tab leaves an untouched unit list alone and moves on", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("q:=12 kN/m=");
  await expect(page.locator(".completion.units")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".completion.units")).toHaveCount(0);
  // Tab moved on from the line, so nothing was inserted into it
  await regions(page).first().click();
  await expect(page.locator(".math-input")).toHaveValue(/^q:=12 kN\/m ?=$/);
});

test("a typed = after : survives a Tab in between", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("f(?):");
  await page.keyboard.press("Tab");
  await page.keyboard.type("=");
  await expect(page.locator(".math-input")).toHaveValue("f(=):=");
});
