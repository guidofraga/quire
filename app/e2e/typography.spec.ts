// End to end: document typography. New documents are typeset (styles.typography 2: Quire Text,
// math at the text's size, a heading scale); a document saved before keeps the look it had.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const REGIONS = [
  { id: "ttl", kind: "text", at: [0, 0], text: "{.title}\n# Beam design" },
  { id: "par", kind: "text", at: [0, 60], text: "The beam is simply supported." },
  { id: "hda", kind: "text", at: [0, 100], text: "# Data" },
  { id: "mth", kind: "math", at: [0, 150], expr: "L := 7 m" },
];

/** Computed font of a region's text, its heading, and its math, in px. */
async function fonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    // by what they say: a paste gives regions new ids
    const css = (words: string, sel: string) => {
      const region = [...document.querySelectorAll(`.region.${sel === "math" ? "math" : "text"}`)].find((r) =>
        r.textContent?.includes(words),
      );
      const el = region?.querySelector(sel);
      if (!el) throw new Error(`no ${sel} in "${words}"`);
      const s = getComputedStyle(el);
      return { family: s.fontFamily, size: parseFloat(s.fontSize) };
    };
    return {
      text: css("simply supported", ".text-body p"),
      title: css("Beam design", ".text-body h1"),
      heading: css("Data", ".text-body h1"),
      math: css("7", "math"),
      quireText: document.fonts.check('10pt "Quire Text"'),
    };
  });
}

test("a new document is typeset: Quire Text, math at the text's size, a heading scale", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  // the regions as another Quire window puts them on the clipboard
  const b64 = Buffer.from(JSON.stringify({ quire: 1, regions: REGIONS })).toString("base64");
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(e);
  }, `<div data-quire-clip="${b64}"><p>text</p></div>`);
  await expect(page.locator(".region.math math")).toBeVisible();

  const f = await fonts(page);
  expect(f.quireText).toBe(true);
  expect(f.text.family).toMatch(/^"?Quire Text"?,/);
  expect(f.math.family).toMatch(/^"?Quire Math"?,/);
  // 10.5 pt = 14 px; math at the same size, so the x-heights of the two STIX faces match
  expect(f.text.size).toBeCloseTo(14, 1);
  expect(f.math.size).toBeCloseTo(14, 1);
  // title 20 pt, first-level heading 14 pt
  expect(f.title.size).toBeCloseTo((20 * 96) / 72, 0);
  expect(f.heading.size).toBeCloseTo((14 * 96) / 72, 0);
});

test("a document saved before typeset defaults keeps its look", async ({ page }) => {
  const dir = join(mkdtempSync(join(tmpdir(), "quire-typography-")), "Old.quire");
  mkdirSync(dir);
  // no styles.typography: written before it existed
  const doc = { format: "quire/1", meta: { title: "Old" }, page: { view: "pages", paper: "A4" }, regions: REGIONS };
  writeFileSync(join(dir, "document.json"), JSON.stringify(doc));
  await page.goto(`/?open=${encodeURIComponent(dir)}`);
  await expect(page.locator(".region.math math")).toBeVisible();

  const f = await fonts(page);
  // the system's sans-serif at 10 pt, as every document had it
  expect(f.text.family).not.toContain("Quire Text");
  expect(f.text.family).toMatch(/apple-system|system-ui|BlinkMacSystemFont/);
  expect(f.text.size).toBeCloseTo((10 * 96) / 72, 1);
  // math drawn at 1.2 times its 10 pt size, headings at the text's size, the title 1.8 times it
  expect(f.math.size).toBeCloseTo((12 * 96) / 72, 1);
  expect(f.heading.size).toBeCloseTo(f.text.size, 1);
  expect(f.title.size).toBeCloseTo(f.text.size * 1.8, 1);
});
