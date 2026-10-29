// End to end: the UI in WebKit against `quire serve`, typing as a user would.
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

test("evaluates math with units as you type", async ({ page }) => {
  await blank(page);
  await typeLines(page, "q:=12 kN/m", "L:=6 m", "M:=q*L^2/8=");
  await expect(regions(page)).toHaveCount(3);
  // the result keeps the units of the inputs: 54 kN·m, not 54000 J
  await expect(regions(page).nth(2)).toContainText(/=54\s*kN\W?m$/);
  await expect(page.locator(".status .muted").first()).toContainText("3 math");
});

test("explains a unit mismatch", async ({ page }) => {
  await blank(page);
  await typeLines(page, "x:=1 m + 2 kN=");
  await expect(regions(page).first()).toContainText(/cannot add a length \(m\) and a force/);
});

test("a word followed by a space becomes text", async ({ page }) => {
  await blank(page);
  await typeLines(page, "The span is simply supported.");
  await expect(regions(page)).toHaveCount(1);
  await expect(regions(page).first()).toHaveClass(/\btext\b/);
  await expect(regions(page).first()).toContainText("The span is simply supported.");
});

test("undo and redo a new region", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=2", "b:=a*3=");
  await expect(regions(page)).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(regions(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=6$/);
});

test("a change upstream updates results below", async ({ page }) => {
  await blank(page);
  await typeLines(page, "L:=2 m", "A:=L*3=");
  await expect(regions(page).nth(1)).toContainText(/=6\s*m$/);
  await regions(page).first().dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("L:=5 m");
  await page.keyboard.press("Escape");
  await expect(regions(page).nth(1)).toContainText(/=15\s*m$/);
});
