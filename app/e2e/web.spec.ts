// The web version: the engine as WebAssembly in the page, no server. Documents come from
// links and files the visitor picks, and leave as links and downloads.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const regions = (page: Page) => page.locator(".region");

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Welcome to Quire" })).toBeVisible();
});

test("evaluates in the browser, with nothing that needs files on disk offered", async ({ page }) => {
  await expect(page.getByRole("link", { name: "Get the desktop app" })).toBeVisible();
  await expect(page.getByRole("button", { name: /New notebook/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Blank document/ }).click();
  await expect(page.getByRole("button", { name: "Show the sidebar" })).toHaveCount(0);
  await page.mouse.click(700, 250);
  await typeLines(page, "q:=12 kN/m", "L:=6 m", "M:=q*L^2/8=");
  await expect(regions(page).nth(2)).toContainText(/=54\s*kN\W?m$/);
});

test("a shared link opens the document, as it was, in another browser", async ({ page, browser }) => {
  // no animations: axe would measure the dialog's colours half faded in
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: /Simply supported beam/ }).click();
  await expect(page.locator(".region.math .res").first()).toBeVisible();
  await page.getByRole("button", { name: "Share" }).click();
  const field = page.getByRole("textbox", { name: "Link to this document" });
  await expect(field).toHaveValue(/#doc=[A-Za-z0-9_-]+$/);
  const link = await field.inputValue();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await audit(page, `Share, ${colorScheme}`, ".share");
  }

  const other = await browser.newPage();
  await other.goto(link);
  await expect(other.locator(".toolbar .title")).toHaveText("Simply supported beam");
  await expect(other.locator('[data-region="bmdnwh"]')).toContainText(/123\.11\s*kN/);
  await other.close();
});

test("the address keeps the document as it is now, so reloading loses nothing", async ({ page }) => {
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  await typeLines(page, "a:=21", "b:=a*2=");
  await expect(page).toHaveURL(/#doc=/);
  await page.reload();
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=42$/);
});

test("Save downloads a .quirez, and Open reads it back", async ({ page }) => {
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  await typeLines(page, "x:=7 m", "y:=x*3=");
  const download = page.waitForEvent("download");
  await page.keyboard.press("ControlOrMeta+s");
  const file = await download;
  expect(file.suggestedFilename()).toBe("Untitled.quirez");
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  await expect(page.locator(".edited")).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("ControlOrMeta+o");
  await (await chooser).setFiles({ name: "Untitled.quirez", mimeType: "application/zip", buffer: bytes });
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=21\s*m$/);
});

test("Ctrl+Z undoes typing inside a math region, and Ctrl+Shift+Z redoes it", async ({ page }) => {
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  const math = page.getByRole("textbox", { name: "Math", exact: true });
  await page.keyboard.type("a:=5");
  await expect(math).toHaveValue("a:=5");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(math).toHaveValue("a:=");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(math).toHaveValue("a:=5");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("Control+y");
  await expect(math).toHaveValue("a:=5");
  // undoing past the start of the edit does nothing, and the editor keeps working
  for (let i = 0; i < 8; i++) await page.keyboard.press("ControlOrMeta+z");
  const start = await math.inputValue();
  expect("a:=5".startsWith(start)).toBe(true);
  await page.keyboard.type("b");
  await expect(math).toHaveValue(start + "b");
});

test("Ctrl+Z also undoes typing in a table cell and in a text region", async ({ page }) => {
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  await page.keyboard.type('"hello world');
  await page.keyboard.press("ControlOrMeta+z");
  // ProseMirror takes quick typing as one step; the editor is still there to type in
  await page.keyboard.type("again");
  await expect(page.locator(".region.text")).toContainText("again");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await page.keyboard.type("12");
  const cell = page.getByRole("textbox", { name: /^Cell / });
  await expect(cell).toHaveValue("12");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell).toHaveValue("1");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(cell).toHaveValue("12");
});
