// End to end: keys typed the instant a region is inserted, with no wait for its editor to take
// focus (issue #85).
//
// A person (or dictation, or a driver of a real browser) can get keys to the page before the
// new region's editor has focus; they then land in the page's hidden field (`.key-sink`).
// Playwright's own typing is slower than that handoff in WebKit, so `atOnce` does what the
// browser does: it inserts and then puts the keys into the hidden field in the same task,
// before anything can have moved focus. Two tests also use real key presses.
import { expect, type Page, test } from "@playwright/test";

/** A blank document with the insertion point on the page. */
async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

type Step = { text: string } | { key: string };
type Insert = { shortcut: { key: string; shift?: boolean; alt?: boolean } } | { menu: string } | { button: string };

/** Insert a region and type into the page's hidden field in the same task. */
async function atOnce(page: Page, insert: Insert, steps: Step[]) {
  await page.evaluate(
    ([insert, steps]) => {
      const sink = document.querySelector<HTMLTextAreaElement>(".key-sink")!;
      const keydown = (key: string, init: KeyboardEventInit = {}) =>
        sink.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
      if ("shortcut" in insert) {
        const { key, shift, alt } = insert.shortcut;
        keydown(key, {
          code: `Key${key.toUpperCase()}`,
          metaKey: true,
          ctrlKey: true,
          shiftKey: !!shift,
          altKey: !!alt,
        });
      } else if ("button" in insert) {
        [...document.querySelectorAll("button")]
          .find((b) => b.querySelector(".tool-label")?.textContent === insert.button)!
          .click();
      } else {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.querySelector(".tool-label")?.textContent === "Insert",
        )!;
        button.click();
        [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
          .find((m) => new RegExp(insert.menu).test(m.textContent ?? ""))!
          .click();
      }
      for (const step of steps) {
        if ("key" in step) keydown(step.key);
        else {
          sink.value = step.text;
          sink.dispatchEvent(new InputEvent("input", { data: step.text, inputType: "insertText", bubbles: true }));
        }
      }
    },
    [insert, steps] as const,
  );
}

/** The page's hidden field must never keep the keyboard while a region is being edited. */
async function focusIsOffTheSink(page: Page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("key-sink"))).toBe(false);
}

const cellA1 = (page: Page) => page.getByRole("textbox", { name: "Cell A1" });
const cell = (page: Page, r: number, c: number) => page.locator(`td[data-r="${r}"][data-c="${c}"]`);
const TABLE: Insert = { shortcut: { key: "t", alt: true } };
const TABLE_MENU: Insert = { menu: "^Table(?! from)" };

test("typing right after ⌥⌘T reaches the table's first cell", async ({ page }) => {
  await blank(page);
  await atOnce(page, TABLE, [{ text: "Load" }]);
  await expect(cellA1(page)).toHaveValue("Load");
  await focusIsOffTheSink(page);
});

test("typing right after Insert ▸ Table reaches the table's first cell", async ({ page }) => {
  await blank(page);
  await atOnce(page, TABLE_MENU, [{ text: "Load" }]);
  await expect(cellA1(page)).toHaveValue("Load");
  await focusIsOffTheSink(page);
});

test("typing right after Insert ▸ Table from CSV reaches the new table", async ({ page }) => {
  await blank(page);
  await page.getByRole("button", { name: "Insert" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /Table from CSV/ }).click();
  await (await chooser).setFiles({ name: "loads.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
  // the file is read after the menu closes, so the table appears later than the click
  await page.keyboard.type("Load");
  await expect(cellA1(page)).toHaveValue("Load");
  await focusIsOffTheSink(page);
});

test("keys typed at once into a new table land in order, and Tab and Escape work", async ({ page }) => {
  await blank(page);
  await atOnce(page, TABLE, [{ text: "Load" }, { key: "Tab" }, { text: "kN" }, { key: "Tab" }]);
  await expect(cell(page, 0, 0)).toContainText("Load");
  await expect(cell(page, 0, 1)).toContainText("kN");
  await expect(cell(page, 0, 2)).toHaveClass(/\bactive\b/);
  await focusIsOffTheSink(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".region.editing")).toHaveCount(0);
});

test("Tab and Escape work in a table inserted from the menu and used at once", async ({ page }) => {
  await blank(page);
  await atOnce(page, TABLE_MENU, [{ key: "Tab" }, { text: "kN" }, { key: "Tab" }]);
  await expect(cell(page, 0, 1)).toContainText("kN");
  await expect(cell(page, 0, 2)).toHaveClass(/\bactive\b/);
  await focusIsOffTheSink(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".region.editing")).toHaveCount(0);
});

test("Escape typed at once into a new table ends the edit", async ({ page }) => {
  await blank(page);
  await atOnce(page, TABLE, [{ key: "Escape" }]);
  await expect(page.locator(".region.editing")).toHaveCount(0);
});

test("typing with real key presses right after ⌥⌘T reaches the table, in order", async ({ page }) => {
  await blank(page);
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await page.keyboard.type("Load");
  await page.keyboard.press("Tab");
  await page.keyboard.type("kN");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(cell(page, 0, 0)).toContainText("Load");
  await expect(cell(page, 0, 1)).toContainText("kN");
  await expect(page.locator(".region.editing")).toHaveCount(0);
});

test("typing right after ⇧⌘M reaches the new math region", async ({ page }) => {
  await blank(page);
  await atOnce(page, { shortcut: { key: "m", shift: true } }, [{ text: "q := 12 kN/m" }]);
  await expect(page.locator(".region.editing input")).toHaveValue("q := 12 kN/m");
  await focusIsOffTheSink(page);
});

test("typing right after the Text button reaches the new text region", async ({ page }) => {
  await blank(page);
  await atOnce(page, { button: "Text" }, [{ text: "Loads on the beam" }]);
  await expect(page.locator("[contenteditable=true]")).toContainText("Loads on the beam");
  await focusIsOffTheSink(page);
});
