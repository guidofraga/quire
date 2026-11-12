// Tall tables and text split across pages in the page view, on screen and in print (#10).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// page sheets only: a spreadsheet table is a <table class="sheet"> too
const sheet = (page: Page, k: number) => page.locator("div.sheet").nth(k);

let dir = "";
test.afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Open a document written for the test, in the page view. */
async function openDoc(page: Page, regions: unknown[]) {
  dir = mkdtempSync(join(tmpdir(), "quire-split-e2e-"));
  const doc = join(dir, "split.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1280, height: 1400 });
  writeFileSync(join(doc, "document.json"), JSON.stringify({ format: "quire/1", page: { view: "pages" }, regions }));
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
}

const ROWS = 120;
const table = {
  id: "t",
  kind: "table",
  at: [0, 54],
  header: { row: true },
  rows: [["Item", "Load", "Note"], ...Array.from({ length: ROWS }, (_, i) => [`r${i + 1}`, `${(i + 1) * 3}`, "ok"])],
};

/** Every row label drawn on a sheet, by sheet, and whatever is drawn outside a sheet's content area. */
function placement() {
  const out: { pages: string[][]; outside: string[]; header: boolean[] } = { pages: [], outside: [], header: [] };
  for (const s of document.querySelectorAll<HTMLElement>("div.sheet")) {
    const box = s.querySelector(".content-box")?.getBoundingClientRect() ?? s.getBoundingClientRect();
    const labels: string[] = [];
    for (const td of s.querySelectorAll<HTMLElement>("td")) {
      const text = td.textContent?.trim() ?? "";
      if (!/^r\d+$/.test(text) || getComputedStyle(td).visibility === "hidden") continue;
      // drawn: not clipped away by its region's first part
      const region = td.closest<HTMLElement>(".region")!;
      const rc = td.getBoundingClientRect();
      const clip = /inset\([^ ]+ [^ ]+ ([\d.]+)px/.exec(getComputedStyle(region).clipPath);
      const shown =
        region.getBoundingClientRect().bottom - (clip ? Number(clip[1]) : 0) * (rc.height / td.offsetHeight);
      if (rc.top >= shown - 0.5) continue;
      labels.push(text);
      if (rc.top < box.top - 1 || rc.bottom > box.bottom + 1) out.outside.push(text);
    }
    out.pages.push(labels);
    out.header.push(
      [...s.querySelectorAll<HTMLElement>("tr")].some(
        (tr) => tr.textContent?.startsWith("Item") && getComputedStyle(tr).visibility !== "hidden",
      ),
    );
  }
  return out;
}

test("a tall table splits across pages, its header row repeated on each, on screen and in print", async ({ page }) => {
  await openDoc(page, [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }, table]);
  await expect(sheet(page, 1).locator('[data-part-of="t"]')).toBeVisible();
  const header = sheet(page, 1).locator('[data-part-of="t"] tr.repeat');
  await expect(header).toContainText("Item");
  await expect(header).toBeVisible();

  const check = (p: ReturnType<typeof placement>) => {
    // every row once, in order, on the paper
    expect(p.pages.flat()).toEqual(Array.from({ length: ROWS }, (_, i) => `r${i + 1}`));
    expect(p.outside).toEqual([]);
    expect(p.pages.filter((labels) => labels.length).length).toBeGreaterThan(1);
    // the header row on the first page and every page the table goes on to
    p.pages.forEach((labels, k) => labels.length && expect(p.header[k], `header on page ${k + 1}`).toBe(true));
  };
  check(await page.evaluate(placement));

  // print and PDF export draw the page view: the same split, measured when the print dialog opens
  await page.evaluate((fn) => {
    const w = window as unknown as Record<string, unknown>;
    w.print = () => (w.__printed = new Function(`return (${fn})()`)());
  }, placement.toString());
  await page.evaluate(() =>
    (window as unknown as { __quire: { runCommand: (id: string) => void } }).__quire.runCommand("export_pdf"),
  );
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Record<string, unknown>).__printed)).toBe(true);
  const printed = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__printed)) as ReturnType<
    typeof placement
  >;
  check(printed);
  expect(printed.header[1]).toBe(true);
});

test("a cell of a split table edits in place on its later page", async ({ page }) => {
  await openDoc(page, [table]);
  // a row on the second page
  const row = sheet(page, 1)
    .locator('[data-part-of="t"] tr')
    // while the table is edited, a cell also reads its name to screen readers ("A60 r60")
    .filter({ has: page.locator("td").filter({ hasText: /(^| )r60$/ }) });
  await expect(row).toBeVisible();
  // the cell beside it, "180"
  const value = row.locator("td").nth(1);
  await expect(value).toHaveText("180");
  await value.dblclick();
  await page.keyboard.type("999");
  await page.keyboard.press("Enter");
  // typed into that cell, on that page: once, with the table still split
  await expect(value).toHaveText(/(^| )999$/);
  await expect(
    page
      .locator("td")
      .filter({ hasText: /(^| )999$/ })
      .filter({ visible: true }),
  ).toHaveCount(1);
  // the next row's cell is the active one now, on the same page
  await expect(sheet(page, 1).locator('[data-part-of="t"] td.active')).toHaveText(/(^| )183$/);
});

const sentences = Array.from(
  { length: 240 },
  (_, i) => `Sentence ${i + 1} of one long paragraph, written to wrap over many lines.`,
).join(" ");

/** Lines of the text region `id`: those drawn on each part, and those a part's edge cuts through. */
function lines(id: string) {
  const rects = (root: Element) => {
    const range = document.createRange();
    const out: DOMRect[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      range.selectNodeContents(n);
      for (const rc of range.getClientRects()) if (rc.height) out.push(rc);
    }
    return out;
  };
  const primary = document.querySelector(`[data-region="${id}"]`)!;
  const box = primary.getBoundingClientRect();
  const z = box.height / (primary as HTMLElement).offsetHeight;
  const clip = /inset\([^ ]+ [^ ]+ ([\d.]+)px/.exec(getComputedStyle(primary).clipPath);
  const windows: [Element, number, number][] = [[primary, box.top, box.bottom - (clip ? Number(clip[1]) : 0) * z]];
  for (const w of document.querySelectorAll(`[data-part-of="${id}"] .part-window`)) {
    const rc = w.getBoundingClientRect();
    windows.push([w, rc.top, rc.bottom]);
  }
  const all = new Set(rects(primary).map((r) => Math.round(r.top - box.top)));
  // how the text breaks into lines: where each line ends, from the left of its text
  const shape = (root: Element) => {
    const left = root.getBoundingClientRect().left;
    const all = rects(root);
    return all.map((r) => `${Math.round(r.top - all[0].top)}:${Math.round(r.right - left)}`);
  };
  const ownShape = shape(primary.querySelector(".text-body")!);
  const sameLines = [...document.querySelectorAll(`[data-part-of="${id}"] .text-body`)].every(
    (t) => shape(t).join() === ownShape.join(),
  );
  let drawn = 0;
  const cut: string[] = [];
  for (const [root, top, bottom] of windows) {
    const tops = new Set<number>();
    for (const r of rects(root)) {
      if (r.bottom <= top + 0.5 || r.top >= bottom - 0.5) continue;
      if (r.top < top - 0.5 || r.bottom > bottom + 0.5) cut.push(`${Math.round(r.top)}..${Math.round(r.bottom)}`);
      tops.add(Math.round(r.top));
    }
    drawn += tops.size;
  }
  return { lines: all.size, drawn, cut, parts: windows.length, sameLines };
}

test("a tall text region splits between two lines", async ({ page }) => {
  await openDoc(page, [{ id: "x", kind: "text", at: [0, 0], text: sentences }]);
  await expect(sheet(page, 1).locator('[data-part-of="x"]')).toBeVisible();
  await expect(sheet(page, 1).locator('[data-part-of="x"]')).toContainText("Sentence 240");
  const seen = await page.evaluate(lines, "x");
  expect(seen.parts).toBeGreaterThan(1);
  // no line cut through, and every line drawn once
  expect(seen.cut).toEqual([]);
  expect(seen.drawn).toBe(seen.lines);
  // and each later part breaks the text into the same lines as the first
  expect(seen.sameLines).toBe(true);
});
