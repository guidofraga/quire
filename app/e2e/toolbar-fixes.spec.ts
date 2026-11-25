// End to end: the toolbar's Text button while typing math (#152), the errors menu listing every
// error it counts and no error on an empty line (#151), and Settings ▸ Theme in a browser (#150).
import { expect, type Page, test } from "@playwright/test";

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(500, 300);
}

test("Text in the toolbar turns the math being typed into text", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("q*L");
  await expect(page.locator(".region.math.editing")).toHaveCount(1);
  await page.getByRole("toolbar", { name: "Insert" }).getByRole("button", { name: "Text" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".region")).toHaveCount(1);
  await expect(page.locator(".region.math")).toHaveCount(0);
  await expect(page.locator(".region.text")).toContainText("q*L");
});

test("the errors menu lists an error in a solve block's line", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Solve Block" }).click();
  const block = page.getByRole("group", { name: "Solve block for x, y" });
  await expect(block.locator("input.math-input")).toBeFocused();
  // the first constraint names something that doesn't exist
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x^2 + qq^2 = 4");
  await page.keyboard.press("Escape");
  const pill = page.getByRole("toolbar", { name: "Document" }).locator("button.errors");
  await expect(pill).toBeVisible();
  const count = Number((await pill.textContent())?.match(/\d+/)?.[0]);
  await pill.click();
  // one row for every error counted, the constraint among them
  const rows = page.getByRole("menu").getByRole("menuitem");
  await expect(rows).toHaveCount(count);
  await expect(rows.filter({ hasText: "qq" }).first()).toBeVisible();
});

test("an empty math line shows no error, however long you wait", async ({ page }) => {
  await blank(page);
  await page.getByRole("toolbar", { name: "Insert" }).getByRole("button", { name: "Math" }).click();
  await expect(page.locator(".region.math.editing")).toHaveCount(1);
  // longer than the pause after which errors show (1.5 s)
  await page.waitForTimeout(2200);
  await expect(page.locator(".region.math .err")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Document" }).locator("button.errors")).toHaveCount(0);
});

/** The page's chrome colour, a token the dark theme changes. */
const chrome = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chrome").trim());

async function chooseTheme(page: Page, theme: "Light" | "Dark" | "Match system") {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Theme" }).selectOption({ label: theme });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("Settings ▸ Theme turns the window dark or light, whatever the system says", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await blank(page);
  await page.keyboard.press("Escape");
  const light = await chrome(page);
  await chooseTheme(page, "Dark");
  await expect.poll(() => chrome(page)).not.toBe(light);
  const dark = await chrome(page);
  // the choice is kept: a reload opens dark
  await page.reload();
  await expect.poll(() => chrome(page)).toBe(dark);

  // Light wins over a dark system
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: /Blank document/ }).click();
  await chooseTheme(page, "Light");
  await expect.poll(() => chrome(page)).toBe(light);
  // and Match system follows it again
  await chooseTheme(page, "Match system");
  await expect.poll(() => chrome(page)).toBe(dark);
});

// the shortcuts Windows lost (#168); the page runs them from the same table as the desktop app
test("Ctrl+Shift+M, T, I and P insert math, text and an image, and switch the view", async ({ page }) => {
  await blank(page);
  await page.keyboard.press("ControlOrMeta+Shift+m");
  await expect(page.locator(".region.math.editing")).toHaveCount(1);
  await page.keyboard.type("a:=1");
  await page.keyboard.press("Escape");
  await page.mouse.click(500, 420);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await page.keyboard.type("words");
  await page.keyboard.press("Escape");
  await expect(page.locator(".region.text")).toContainText("words");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("ControlOrMeta+Shift+i");
  await chooser;
  const pages = page.getByRole("button", { name: "Pages", exact: true });
  const before = await pages.getAttribute("aria-pressed");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(pages).not.toHaveAttribute("aria-pressed", before ?? "");
});
