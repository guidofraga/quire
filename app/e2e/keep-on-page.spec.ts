// Page view keeps new content on the paper: clicks outside the content area, paste and drags.
// Canvas view places things wherever they are put.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const sheet = (page: Page, k: number) => page.locator(".sheet").nth(k);

/** Open a document written for the test, in the page view or on the canvas. */
async function openDoc(page: Page, view: "pages" | "canvas", regions: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "quire-keep-e2e-"));
  const doc = join(dir, "keep.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1500, height: 2600 });
  writeFileSync(join(doc, "document.json"), JSON.stringify({ format: "quire/1", page: { view }, regions }));
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  return dir;
}

/** The sheet's content area on screen (the default margins are 20 mm on a 210 mm sheet). */
async function content(page: Page, k = 0) {
  // the view settles (centres the pages) just after the document opens
  let b = (await sheet(page, k).boundingBox())!;
  await expect
    .poll(async () => {
      const was = b;
      b = (await sheet(page, k).boundingBox())!;
      return b.x === was.x && b.y === was.y && b.width === was.width;
    })
    .toBe(true);
  const m = (b.width * 20) / 210;
  return { left: b.x + m, right: b.x + b.width - m, sheet: b };
}

async function paste(page: Page, text: string) {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(e);
  }, text);
}

test("a click right of the sheet puts typing inside the content area", async ({ page }) => {
  const dir = await openDoc(page, "pages");
  try {
    const c = await content(page);
    await page.mouse.click(c.sheet.x + c.sheet.width + 40, c.sheet.y + 200);
    await page.keyboard.type("a:=1");
    await page.keyboard.press("Escape");
    const box = (await sheet(page, 0).locator(".region").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(c.left - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(c.right + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a click between pages puts typing on a page, inside the content area", async ({ page }) => {
  const dir = await openDoc(page, "pages", [
    { id: "p", kind: "math", at: [0, 0], expr: "p:=1" },
    { id: "q", kind: "math", at: [0, 1200], expr: "q:=2" },
  ]);
  try {
    await expect(sheet(page, 1).locator('[data-region="q"]')).toBeVisible();
    const s0 = (await sheet(page, 0).boundingBox())!;
    const s1 = (await sheet(page, 1).boundingBox())!;
    await page.mouse.click(s0.x + s0.width / 2, (s0.y + s0.height + s1.y) / 2);
    await page.keyboard.type("c:=3");
    await page.keyboard.press("Escape");
    const added = page
      .locator(".sheet .region", { hasText: "c:=3" })
      .or(page.locator(".sheet .region", { hasText: "c" }));
    await expect(page.locator(".sheet .region")).toHaveCount(3);
    const box = (await added.last().boundingBox())!;
    const inside = [s0, s1].some((s) => box.y >= s.y && box.y + box.height <= s.y + s.height);
    expect(inside).toBe(true);
    // not in the bottom margin either: the content area ends 20 mm above the sheet's edge
    const margin = (s0.width * 20) / 210;
    expect([s0, s1].some((s) => box.y >= s.y + margin - 1 && box.y + box.height <= s.y + s.height - margin + 1)).toBe(
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a paste after a click outside the page lands inside it", async ({ page }) => {
  const dir = await openDoc(page, "pages");
  try {
    const c = await content(page);
    await page.mouse.click(c.sheet.x + c.sheet.width + 200, c.sheet.y + 300);
    await paste(page, "Pasted words");
    const box = (await sheet(page, 0).locator(".region").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(c.left - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(c.right + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dragging a region past the right edge stops at the margin", async ({ page }) => {
  const dir = await openDoc(page, "pages", [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }]);
  try {
    const c = await content(page);
    const region = page.locator('[data-region="a"]');
    const from = (await region.boundingBox())!;
    await page.mouse.move(from.x + 4, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 300, from.y + from.height / 2, { steps: 5 });
    await page.mouse.move(c.sheet.x + c.sheet.width + 300, from.y + from.height / 2, { steps: 5 });
    await page.mouse.up();
    const to = (await region.boundingBox())!;
    expect(to.x).toBeGreaterThan(from.x + 100);
    expect(to.x + to.width).toBeLessThanOrEqual(c.right + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canvas view places things wherever they are put", async ({ page }) => {
  const dir = await openDoc(page, "canvas");
  try {
    await page.mouse.click(1300, 300);
    await page.keyboard.type("a:=1");
    await page.keyboard.press("Escape");
    const box = (await page.locator(".region").boundingBox())!;
    expect(box.x).toBeGreaterThan(1250);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
