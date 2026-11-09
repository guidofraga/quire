// End to end: the built-in templates, from the Welcome screen and the Templates dialog.
import { expect, type Page, test } from "@playwright/test";

/** Each built-in template, and what its status bar says about its checks. */
const BUILTIN: [string, string][] = [
  ["Calculation report", "✓ 1 check"],
  ["Simply supported beam", "✗ 1 of 8 failing"],
  ["Load combinations", "✓ 1 check"],
  ["RC section in bending", "✓ 6 checks"],
  ["Bolted connection", "✗ 1 of 9 failing"],
  ["Pad footing", "✓ 4 checks"],
  ["Pipe flow head loss", "✓ 3 checks"],
];

async function allTemplates(page: Page) {
  await page.goto("/");
  const welcome = page.getByRole("dialog", { name: "Welcome to Quire" });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: /All templates/ }).click();
  const dialog = page.getByRole("dialog", { name: "New from template" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the Welcome screen lists a few templates and reaches the rest", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByRole("dialog", { name: "Welcome to Quire" });
  await expect(welcome.getByRole("button", { name: /Calculation report/ })).toBeVisible();
  await expect(welcome.getByRole("button", { name: /Pipe flow head loss/ })).toHaveCount(0);
  const dialog = await allTemplates(page);
  for (const [name] of BUILTIN) await expect(dialog.getByRole("button", { name: new RegExp(name) })).toBeVisible();
});

for (const [name, checks] of BUILTIN) {
  test(`the ${name} template opens with no errors and its checks as expected`, async ({ page }) => {
    const dialog = await allTemplates(page);
    await dialog.getByRole("button", { name: new RegExp(name) }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: checks, exact: true })).toBeVisible();
    await expect(page.locator(".region.math").first()).toBeVisible();
    await expect(page.locator(".toolbar .errors")).toHaveCount(0);
    await expect(page.locator(".region.error, .inline-error")).toHaveCount(0);
  });
}
