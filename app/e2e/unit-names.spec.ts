// End to end: a name no variable defines, read as a unit where a variable is usual (M/W),
// is said so under the line while it is edited and by a mark on the finished line.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const regions = (page: Page) => page.locator(".region");

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

const NOTE = "W is the unit watt; if you meant a variable, define it above";

test("an undefined name read as a unit is flagged, and a unit after a number is not", async ({ page }) => {
  await blank(page);
  await typeLines(page, "M := 40 N", "z := M/W", "P := 5 W", "q := 2 kN*m");
  await expect(regions(page)).toHaveCount(4);
  const mark = (i: number) => regions(page).nth(i).locator(".unit-mark");
  await expect(mark(1)).toHaveCount(1);
  await expect(mark(1)).toHaveAttribute("aria-label", NOTE);
  await expect(mark(1)).toHaveAttribute("title", NOTE);
  await expect(mark(0)).toHaveCount(0);
  await expect(mark(2)).toHaveCount(0);
  await expect(mark(3)).toHaveCount(0);
  await audit(page, "a line with the unit mark");
  // while the line is edited the note is under it, in the usual style
  await regions(page).nth(1).dblclick();
  await expect(page.locator(".name-note", { hasText: NOTE })).toBeVisible();
});

test("defining the name above removes the note", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 450);
  await typeLines(page, "M := 40 N", "z := M/W");
  await expect(regions(page).nth(1).locator(".unit-mark")).toHaveCount(1);
  // a definition above the lines, in reading order
  await page.mouse.click(700, 250);
  await typeLines(page, "W := 3 N");
  await expect(regions(page).locator(".unit-mark")).toHaveCount(0);
});

test("dismissing the note hides it for that name and survives save and reopen", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "quire-unitnote-e2e-"));
  try {
    await blank(page);
    await typeLines(page, "M := 40 N", "z := M/W");
    await expect(regions(page).locator(".unit-mark")).toHaveCount(1);
    await regions(page).nth(1).dblclick();
    await page.locator(".name-note", { hasText: NOTE }).getByRole("button", { name: "Dismiss for W" }).click();
    await page.keyboard.press("Escape");
    await expect(regions(page).locator(".unit-mark")).toHaveCount(0);

    const file = join(dir, "Quiet.quire");
    page.once("dialog", (d) => void d.accept(file));
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, ctrlKey: true })),
    );
    await expect(page.locator(".toast")).toHaveText("Saved Quiet");

    await page.goto(`/?open=${encodeURIComponent(file)}`);
    await expect(regions(page)).toHaveCount(2);
    await expect(regions(page).nth(1)).toContainText("z");
    await expect(regions(page).locator(".unit-mark")).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
