// How content flows between pages in the page view: page breaks, and pulling content back.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const sheet = (page: Page, k: number) => page.locator(".sheet").nth(k);

/** Open a document written for the test, in the page view. */
async function openDoc(page: Page, regions: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "quire-pages-e2e-"));
  const doc = join(dir, "pages.quire");
  mkdirSync(doc);
  // tall enough to show two pages at once, so both can be clicked
  await page.setViewportSize({ width: 1280, height: 2600 });
  writeFileSync(join(doc, "document.json"), JSON.stringify({ format: "quire/1", page: { view: "pages" }, regions }));
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  return dir;
}

test("Backspace at the top of a page brings its content back onto the previous one, in one undo step", async ({
  page,
}) => {
  // a gap left by something deleted: b starts the second page though the first has room
  const dir = await openDoc(page, [
    { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
    { id: "b", kind: "math", at: [0, 1200], expr: "b:=a+1", show: "value" },
  ]);
  try {
    const b = page.locator('[data-region="b"]');
    await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
    await expect(b).toContainText(/=2$/);
    // the insertion point on the second page, above b
    const box = (await b.boundingBox())!;
    await page.mouse.click(box.x + 10, box.y - 60);
    await page.keyboard.press("Backspace");
    await expect(sheet(page, 0).locator('[data-region="b"]')).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Insert ▸ Page Break starts the next page at the insertion point", async ({ page }) => {
  const dir = await openDoc(page, [
    { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
    { id: "b", kind: "math", at: [0, 54], expr: "b:=2" },
  ]);
  try {
    const b = page.locator('[data-region="b"]');
    await expect(sheet(page, 0).locator('[data-region="b"]')).toBeVisible();
    const box = (await b.boundingBox())!;
    await page.mouse.click(box.x + 10, box.y - 12);
    await page.getByRole("button", { name: "Insert" }).click();
    await page.getByRole("menuitem", { name: "Page Break" }).click();
    const mark = sheet(page, 0).locator(".region.pagebreak");
    await expect(mark).toContainText("Page break");
    await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
    // one undo step takes it back
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".region.pagebreak")).toHaveCount(0);
    await expect(sheet(page, 0).locator('[data-region="b"]')).toBeVisible();
    // ⌘↩ on the page does the same
    await page.mouse.click(box.x + 10, box.y - 12);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scheme of ["light", "dark"] as const)
  test(`a page break's mark passes axe, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const dir = await openDoc(page, [
      { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
      { id: "br", kind: "pagebreak", at: [0, 36] },
      { id: "b", kind: "math", at: [0, 72], expr: "b:=2" },
    ]);
    try {
      await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
      await audit(page, "page break, pages");
      await page.getByRole("button", { name: "Canvas", exact: true }).click();
      await expect(page.locator(".region.pagebreak")).toContainText("Page break");
      await audit(page, "page break, canvas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test.describe("a blank page added with + New page", () => {
  const newPage = (page: Page) => page.getByRole("button", { name: "+ New page" });

  test("goes with Backspace", async ({ page }) => {
    const dir = await openDoc(page, [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }]);
    try {
      await expect(page.locator(".sheet")).toHaveCount(1);
      await newPage(page).click();
      await expect(page.locator(".sheet")).toHaveCount(2);
      await page.keyboard.press("Backspace");
      await expect(page.locator(".sheet")).toHaveCount(1);
      // the insertion point is back on the first page, so typing goes there
      await page.keyboard.type("b:=2");
      await page.keyboard.press("Escape");
      await expect(sheet(page, 0).locator(".region")).toHaveCount(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("goes when left with nothing on it", async ({ page }) => {
    const dir = await openDoc(page, [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }]);
    try {
      await newPage(page).click();
      await expect(page.locator(".sheet")).toHaveCount(2);
      const box = (await sheet(page, 0).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + 300);
      await expect(page.locator(".sheet")).toHaveCount(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays once something is typed on it", async ({ page }) => {
    const dir = await openDoc(page, [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }]);
    try {
      await newPage(page).click();
      await page.keyboard.type("b:=a+1=");
      await page.keyboard.press("Escape");
      await expect(sheet(page, 1).locator(".region")).toContainText(/=2$/);
      const box = (await sheet(page, 0).boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + 300);
      await expect(page.locator(".sheet")).toHaveCount(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
