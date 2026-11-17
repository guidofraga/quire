// End to end: typing a unit (#146). Right after a number the list opens after one letter with
// the units that match best, by symbol, name or quantity (`C` offers coulomb and °C); ↓ and
// Enter put one in and keep editing, Enter alone still finishes the line; `°C` typed directly
// is a unit; and the units after `=` are searched the same way.
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const regions = (page: Page) => page.locator(".region");
const input = (page: Page) => page.locator(".math-input");
const names = (page: Page) => page.getByRole("listbox", { name: "Names" });

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

/** Walk down the open list to the row whose text starts with `start`, and check it is selected. */
async function arrowTo(page: Page, list: ReturnType<typeof names>, start: RegExp) {
  const row = list.getByRole("option").filter({ hasText: start }).first();
  await expect(row).toBeVisible();
  const target = await row.getAttribute("id");
  const options = list.getByRole("option");
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("ArrowDown");
    if ((await options.nth(i).getAttribute("id")) === target) break;
  }
  await expect(row).toHaveAttribute("aria-selected", "true");
}

test("after a number, C offers °C; ↓ and Enter put it in, and T is 20 °C", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("T:=20 C");
  const list = names(page);
  await expect(list).toBeVisible();
  // coulomb first, as typed, then degree Celsius with its name and quantity
  await expect(list.getByRole("option").first()).toContainText("coulomb");
  const celsius = list.getByRole("option").filter({ hasText: "degree Celsius · temperature" });
  await expect(celsius).toHaveCount(1);
  await audit(page, "the unit list after 20 C");
  await arrowTo(page, list, /°C/);
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  // still editing the line, with the unit in place
  await expect(input(page)).toHaveValue("T:=20 °C");
  await page.keyboard.press("Enter");
  await page.keyboard.type("T=");
  await page.keyboard.press("Escape");
  await expect(regions(page)).toHaveCount(2);
  await expect(page.locator(".region .err")).toHaveCount(0);
  await expect(regions(page).nth(1).locator(".res")).toContainText("293.15");
});

test("°C typed directly is the unit", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("T:=20 °C");
  await page.keyboard.press("Enter");
  await page.keyboard.type("T=");
  await page.keyboard.press("Escape");
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1).locator(".res")).toContainText("293.15");
  await expect(page.locator(".region .err")).toHaveCount(0);
});

test("Enter without moving into the list finishes the line as typed", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("q:=20 C");
  await expect(names(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(names(page)).toHaveCount(0);
  await expect(input(page)).toHaveCount(0);
  await expect(regions(page)).toHaveCount(1);
  // the coulomb, as typed: nothing from the list went in
  await expect(regions(page).nth(0)).not.toContainText("°");
  await page.keyboard.type("q=");
  await page.keyboard.press("Escape");
  await expect(regions(page).nth(1).locator(".res")).toContainText("20");
  await expect(regions(page).nth(1).locator(".res")).toContainText("C");
  await expect(regions(page).nth(1).locator(".res")).not.toContainText("°");
});

test("after =, the units to show a result in are searched by name too", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("F:=12 kN");
  await page.keyboard.press("Enter");
  await page.keyboard.type("F=");
  const showIn = page.getByRole("listbox", { name: "Show in" });
  await expect(showIn).toBeVisible();
  // the dyne is not among the usual force units, but it is a force, found by its name
  await page.keyboard.type("dyne");
  const dyne = showIn.getByRole("option").filter({ hasText: "dyne" });
  await expect(dyne).toHaveCount(1);
  await expect(showIn.getByRole("option").first()).toContainText("dyne");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(showIn).toHaveCount(0);
  await expect(regions(page).nth(1).locator(".res")).toContainText("dyn");
});
