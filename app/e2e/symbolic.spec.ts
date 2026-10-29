// End to end: symbolic results (→) typed as a user would, shown on the page.
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

test("works out limits, series, factors and systems symbolically", async ({ page }) => {
  await blank(page);
  await typeLines(
    page,
    "lim(sin(x)/x, x, 0)->",
    "factor(x^2-5*x+6)->",
    "series(exp(x), x, 0, 2)->",
    "solve([A+B==P; B*L==P*a], [A; B])->",
    "int(1/(x^2+1), x, 0, 1)->",
  );
  await expect(regions(page)).toHaveCount(5);
  for (let i = 0; i < 5; i++) await expect(regions(page).nth(i)).not.toHaveClass(/\berror\b/);
  await expect(regions(page).nth(0)).toContainText(/→\s*1$/);
  await expect(regions(page).nth(1)).toContainText(/→\s*\(\s*x\s*[−-]\s*2\s*\)\s*·?\s*\(\s*x\s*[−-]\s*3\s*\)$/);
  await expect(regions(page).nth(2)).toContainText(/→\s*1\s*\+\s*x\s*\+/);
  await expect(regions(page).nth(4)).toContainText(/→\s*π\s*\/?\s*4$/);
});
