// End to end: what a name means, shown in the math and chosen from the keyboard (#129).
// Ctrl+Space lists the meanings of the name at the caret, ⌥Enter cycles them in place, a soft
// list opens after two letters, and a definition that hides a unit or constant is marked.
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const regions = (page: Page) => page.locator(".region");
const input = (page: Page) => page.locator(".math-input");
const names = (page: Page) => page.getByRole("listbox", { name: "Names" });

/** A blank document with the insertion point on the page. */
async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

/** Type each line as a new region; the last one stays open when `keepLast`. */
async function typeLines(page: Page, lines: string[], keepLast = false) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    if (i < lines.length - 1) await page.keyboard.press("Enter");
    else if (!keepLast) await page.keyboard.press("Escape");
  }
}

test("G is the constant; after G := 5, Ctrl+Space on G offers the constant back as #G", async ({ page }) => {
  await blank(page);
  await typeLines(page, ["G="]);
  await expect(regions(page).nth(0).locator(".k")).toHaveText("G");
  await page.mouse.click(700, 320);
  await typeLines(page, ["G:=5", "y:=G"], true);
  await page.keyboard.press("Control+Space");
  const list = names(page);
  await expect(list).toBeVisible();
  await expect(list.locator('[data-kind="variable"]', { hasText: "G" })).toHaveCount(1);
  const constant = list.locator('[data-kind="constant"]').filter({ hasText: /^G/ });
  await expect(constant).toHaveCount(1);
  // the variable comes first; walk down to the constant and take it
  const options = list.getByRole("option");
  const target = await constant.getAttribute("id");
  for (let i = 0; i < 20; i++) {
    if ((await options.nth(i).getAttribute("id")) === target) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(constant).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(input(page)).toHaveValue("y:=#G");
  await page.keyboard.press("Escape");
  await expect(regions(page).nth(2).locator(".k")).toHaveText("G");
});

test("⌥Enter on a name cycles your variable to the unit, and undo puts it back", async ({ page }) => {
  await blank(page);
  await typeLines(page, ["T:=300", "x:=2T="], true);
  await expect(regions(page).nth(1).locator(".res")).toHaveText("600");
  // the caret right after T, before the `=`
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+Enter");
  await expect(input(page)).toHaveValue("x:=2'T=");
  await expect(regions(page).nth(1).locator(".res")).toHaveText(/^2\s*T$/);
  // still editing: ⌥Enter does not finish the line
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input(page)).toHaveValue("x:=2T=");
  await expect(regions(page).nth(1).locator(".res")).toHaveText("600");
});

test("the soft list opens after two letters, narrows as you type, and Enter still finishes the line", async ({
  page,
}) => {
  await blank(page);
  await typeLines(page, ["width:=3", "wi"], true);
  const list = names(page);
  await expect(list).toBeVisible();
  await expect(list.locator('[data-kind="variable"]', { hasText: "width" })).toHaveCount(1);
  await page.keyboard.type("dt");
  await expect(list.getByRole("option")).toHaveCount(1);
  // nothing chosen: Enter ends the line as typed
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText("widt");
  // moving into the list and pressing Enter takes the name and keeps editing
  await page.keyboard.type("wi");
  await expect(list).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveValue("width");
  await expect(input(page)).toBeFocused();
});

test("a definition that hides a unit is underlined, with a title, and its uses are not", async ({ page }) => {
  await blank(page);
  await typeLines(page, ["T:=300", "x:=2T="]);
  const mark = regions(page).nth(0).locator(".redef");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText("T");
  await expect(mark).toHaveAttribute("title", "Redefines tesla (unit)");
  await expect(regions(page).nth(1).locator(".redef")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const)
  test(`axe passes with a redefinition and the Ctrl+Space list open, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await blank(page);
    await typeLines(page, ["G:=5", "T:=300", "y:=G*T"], true);
    await expect(regions(page).nth(0).locator(".redef")).toHaveCount(1);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+Space");
    await expect(names(page)).toBeVisible();
    await audit(page, `names, ${scheme}`);
  });
