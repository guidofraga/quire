// Edits are never lost on the way to disk: a table cell half typed, a save that is slow,
// Save As from a note. Each test works in a fresh folder and checks what lands there.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quire-save-e2e-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saved = (bundle: string) => readFileSync(join(bundle, "document.json"), "utf8");

/**
 * A menu shortcut as the native menu sends it: to the window, whatever has focus. (A cell
 * being typed into keeps keys to itself; in the app the menu's accelerator acts anyway.)
 */
async function menuShortcut(page: Page, key: string, shift = false) {
  await page.evaluate(
    ([key, shift]) => window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, shiftKey: shift })),
    [key, shift] as const,
  );
}

/** Answer the browser setup's "Save as" prompt with `path`. */
function saveTo(page: Page, path: string) {
  page.once("dialog", (d) => void d.accept(path));
}

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
}

/** A new table, with `text` typed into its first cell and still being typed. */
async function typeInNewTable(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(page.getByRole("grid")).toBeVisible();
  await page.keyboard.type(text);
  await expect(page.getByRole("textbox", { name: "Cell A1" })).toHaveValue(text);
}

test("a cell being typed is kept when you click elsewhere on the page", async ({ page }) => {
  await blank(page);
  await typeInNewTable(page, "42");
  await page.mouse.click(700, 600);
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.locator(".region.table")).toContainText("42");
});

test("Save writes the cell being typed", async ({ page }) => {
  await blank(page);
  await typeInNewTable(page, "42");
  const file = join(dir, "Cells.quire");
  saveTo(page, file);
  await menuShortcut(page, "s");
  await expect(page.locator(".toast")).toHaveText("Saved Cells");
  expect(JSON.parse(saved(file)).regions[0].rows[0][0]).toBe("42");
  await expect(page.locator(".region.table")).toContainText("42");
  await expect(page.locator(".edited")).toHaveCount(0);
});

test("typing during a slow save keeps the document Edited", async ({ page }) => {
  await blank(page);
  await page.mouse.click(700, 250);
  await page.keyboard.type("a:=1");
  await page.keyboard.press("Escape");
  // hold the save on its way to disk until more has been typed
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/save_document", async (route) => {
    await held;
    await route.continue();
  });
  const file = join(dir, "Slow.quire");
  saveTo(page, file);
  const started = page.waitForRequest("**/api/save_document");
  await menuShortcut(page, "s");
  await started;
  await page.mouse.click(700, 400);
  await page.keyboard.type("b:=2");
  await page.keyboard.press("Escape");
  release();
  await expect(page.locator(".toast")).toHaveText("Saved Slow");
  await expect(page.locator(".edited")).toBeVisible();
  expect(saved(file)).toMatch(/a ?:= ?1/);
  expect(saved(file)).not.toMatch(/b ?:=/);
});

test("after Save As from a note, edits go to the copy, not the note", async ({ page }) => {
  const book = join(dir, "Notebook");
  mkdirSync(book);
  await page.goto(`/?notebook=${encodeURIComponent(book)}`);
  const field = page.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await field.fill("Forces");
  await field.press("Enter");
  const note = page.getByRole("treeitem", { name: "Forces" });
  await expect(note).toHaveAttribute("aria-selected", "true");
  await page.mouse.click(900, 300);
  await page.keyboard.type("F:=12 kN");
  await page.keyboard.press("Escape");

  const copy = join(dir, "Copy.quire");
  saveTo(page, copy);
  await menuShortcut(page, "s", true);
  await expect(page.locator(".toast")).toHaveText("Saved Copy");
  // the note has what was typed before Save As, and is no longer the open document
  expect(saved(join(book, "Forces.quire"))).toMatch(/F ?:= ?12/);
  await expect(note).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".toolbar .title")).toHaveText("Copy");

  await page.mouse.click(900, 450);
  await page.keyboard.type("G:=3 kN");
  await page.keyboard.press("Escape");
  await expect(page.locator(".edited")).toBeVisible();
  await menuShortcut(page, "s");
  await expect(page.locator(".edited")).toHaveCount(0);
  expect(saved(copy)).toMatch(/G ?:= ?3/);
  expect(saved(join(book, "Forces.quire"))).not.toMatch(/G ?:=/);
});
