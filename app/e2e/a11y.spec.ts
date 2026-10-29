// Accessibility: axe on the main states of the app, in light and dark, and the keyboard
// flows a person without a mouse depends on.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/** Fail on serious and critical problems; list them all so one run shows everything. */
async function audit(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = bad.map((v) => `${state}: ${v.id} (${v.impact}) ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")}  ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n")}`);
  expect(report, report.join("\n")).toEqual([]);
}

const blankButton = (page: Page) => page.getByRole("button", { name: /Blank document/ });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.beforeEach(async ({ page }) => {
      // no animations: axe would measure colours half faded in
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto("/");
      await expect(blankButton(page)).toBeVisible();
    });

    test("welcome screen and an empty document", async ({ page }) => {
      await audit(page, "welcome");
      await blankButton(page).click();
      await audit(page, "empty document");
    });

    test("format bar galleries and menus", async ({ page }) => {
      await blankButton(page).click();
      await page.getByRole("button", { name: "Symbols" }).click();
      await expect(page.getByRole("dialog", { name: "Symbols" })).toBeVisible();
      await audit(page, "symbols gallery");
      await page.getByRole("tab", { name: "Units" }).click();
      await audit(page, "symbols gallery, units");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Structures" }).click();
      await expect(page.locator(".gallery-tile math").first()).toBeVisible();
      await audit(page, "structures gallery");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Zoom/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await audit(page, "zoom menu");
    });

    test("a document with math, text, a table and a plot, on the canvas and in pages", async ({ page }) => {
      await page.getByRole("button", { name: /Simply supported beam/ }).click();
      await expect(page.locator(".region.plot2d")).toBeVisible();
      await expect(page.locator(".region.math .res").first()).toBeVisible();
      await audit(page, "beam, pages");
      await page.getByRole("button", { name: "Canvas" }).click();
      await audit(page, "beam, canvas");
      await page.locator(".region.math").first().click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await audit(page, "region menu");
      await page.keyboard.press("Escape");
      await page.locator(".region.table").first().dblclick();
      await expect(page.getByRole("grid")).toBeVisible();
      await audit(page, "table being edited");
    });

    test("dialogs", async ({ page }) => {
      await blankButton(page).click();
      for (const [keys, name] of [
        ["ControlOrMeta+,", "Settings"],
        ["ControlOrMeta+Shift+n", "New from template"],
        ["ControlOrMeta+Shift+?", "Quire Help"],
        // the test browser says it is a Mac, so ⌘K, wherever the tests run (CI is Linux)
        ["Meta+k", "Command palette"],
      ] as const) {
        await page.keyboard.press(keys);
        await expect(page.getByRole("dialog", { name })).toBeVisible();
        await audit(page, name);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name })).toBeHidden();
      }
      await page.getByRole("button", { name: "Inspector" }).click();
      await audit(page, "inspector");
    });
  });
}

test.describe("keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(blankButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
  });

  test("insert a symbol from the Symbols gallery, and Esc returns to the button", async ({ page }) => {
    // F6 from the page: the toolbar, then the format bar
    await page.keyboard.press("F6");
    await expect(page.getByRole("toolbar", { name: "Insert" }).getByRole("button").first()).toBeFocused();
    await page.keyboard.press("F6");
    const symbols = page.getByRole("button", { name: "Symbols" });
    await symbols.focus();
    await page.keyboard.press("Enter");
    await expect(symbols).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: "Greek", exact: true })).toBeFocused();
    // Esc closes it and focus is back on the button
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Symbols" })).toBeHidden();
    await expect(symbols).toBeFocused();
    // open again, arrow down into the letters and insert one
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Greek", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".gallery-tile.symbol").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Symbols" })).toBeHidden();
    await expect(page.locator(".math-input")).toBeFocused();
    await expect(page.locator(".math-input")).toHaveValue("β");
  });

  test("Tab stays inside a dialog and Esc gives focus back", async ({ page }) => {
    await page.getByRole("button", { name: /^Zoom/ }).focus();
    const zoom = page.getByRole("button", { name: /^Zoom/ });
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(zoom).toBeFocused();
  });

  test("menus open from the keyboard, move with the arrows and close with Esc", async ({ page }) => {
    const zoom = page.getByRole("button", { name: /^Zoom/ });
    await zoom.focus();
    await page.keyboard.press("Enter");
    const items = page.getByRole("menu").getByRole("menuitemcheckbox");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(zoom).toBeFocused();
  });

  test("regions are read as words, and selecting one says what it is", async ({ page }) => {
    await page.mouse.click(700, 250);
    for (const [i, line] of ["q:=12 kN/m", "L:=6 m", "M:=q*L^2/8="].entries()) {
      await page.keyboard.type(line);
      await page.keyboard.press(i < 2 ? "Enter" : "Escape");
    }
    const last = page.locator(".region.math").nth(2);
    await expect(last).toContainText(/=54\s*kN\W?m/);
    await expect(last.locator(".sr-only")).toHaveText("M is defined as q times L squared over 8, equals 54 kilonewton metres");
    await expect(last.locator(".m")).toHaveAttribute("aria-hidden", "true");
    // Tab on the page selects regions in reading order, and the live region describes it
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("status").filter({ hasText: "Math:" })).toHaveText("Math: q is defined as 12 kilonewtons per metre");
  });

  test("a table being edited is a grid with named cells", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+Alt+t");
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    const active = await page.locator(".sheet-wrap").getAttribute("aria-activedescendant");
    expect(active).toMatch(/-cell-1-1$/);
    await expect(page.locator(`[id="${active}"]`)).toHaveAccessibleName(/^B2/);
  });
});
