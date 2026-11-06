// Unsaved work is asked about before a recent document or a notebook replaces it. Each test
// works in a fresh folder; the browser setup answers its confirm and prompt boxes as the test says.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quire-unsaved-e2e-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A saved document in the test folder, and the one `quire.recent` lists first on the Welcome screen. */
async function savedDocument(page: Page, name: string): Promise<string> {
  const bundle = join(dir, `${name}.quire`);
  cpSync(fileURLToPath(new URL("../../crates/quire-cli/tests/fixtures/numeric-tools.quire", import.meta.url)), bundle, {
    recursive: true,
  });
  await page.addInitScript((path) => {
    try {
      if (!localStorage.getItem("quire.recent")) localStorage.setItem("quire.recent", JSON.stringify([path]));
    } catch {
      // blocked storage: the list is simply empty
    }
  }, bundle);
  return bundle;
}

/** A blank document with one line typed in: unsaved work. */
async function dirtyBlank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  await page.keyboard.type("a≔2");
  await page.keyboard.press("Escape");
  await expect(page.locator(".region")).toContainText("a≔2");
}

/** The Welcome screen again, from the command palette. */
async function openWelcome(page: Page) {
  // ⌘K: the test browser reports itself as a Mac, so Ctrl+K (what ControlOrMeta is on Linux) does nothing
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Welcome Screen");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Welcome to Quire" })).toBeVisible();
}

test("a recent document from the Welcome screen asks before it replaces unsaved work", async ({ page }) => {
  await savedDocument(page, "Physics");
  await dirtyBlank(page);
  await openWelcome(page);

  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  await page.locator(".welcome-item", { hasText: "Physics" }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked).toEqual(["confirm"]);

  // Cancel keeps the document and the Welcome screen stays up for another choice
  await expect(page.getByRole("dialog", { name: "Welcome to Quire" })).toBeVisible();
  await expect(page.locator(".region")).toContainText("a≔2");
});

test("discarding the unsaved work opens the recent document", async ({ page }) => {
  await savedDocument(page, "Physics");
  await dirtyBlank(page);
  await openWelcome(page);

  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.accept();
  });
  await page.locator(".welcome-item", { hasText: "Physics" }).click();
  await expect.poll(() => asked).toEqual(["confirm"]);
  await expect(page.getByRole("dialog", { name: "Welcome to Quire" })).toBeHidden();
  await expect(page.locator(".region", { hasText: "a≔2" })).toHaveCount(0);
});

test("opening a notebook asks before it replaces unsaved work, and the folder is not asked for", async ({ page }) => {
  await dirtyBlank(page);

  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  await page.keyboard.press("ControlOrMeta+Shift+o");
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  // only the discard question: a cancelled answer never reaches the folder prompt
  expect(asked).toEqual(["confirm"]);
  await expect(page.getByRole("navigation", { name: "Notebook" })).toBeHidden();
  await expect(page.locator(".region")).toContainText("a≔2");
});

test("discarding the unsaved work then picking a folder opens the notebook", async ({ page }) => {
  await dirtyBlank(page);

  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void (d.type() === "confirm" ? d.accept() : d.accept(dir));
  });
  await page.keyboard.press("ControlOrMeta+Shift+o");
  await expect(page.getByRole("navigation", { name: "Notebook" })).toBeVisible();
  expect(asked).toEqual(["confirm", "prompt"]);
});
