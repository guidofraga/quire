// End to end: the small gaps of a finished report (#113): a note below its formula, the labels of
// a 3D plot, a marker in a 2D plot and its legend, even ticks, whole numbers at 0 decimals, and
// the header fields in text and table cells.
import { expect, type Page, test } from "@playwright/test";
import { closeDoc, openDoc } from "./polish-doc";

test.afterEach(closeDoc);

const region = (page: Page, id: string) => page.locator(`[data-region="${id}"]`);

test("auto notation at 0 decimals keeps a large whole number whole", async ({ page }) => {
  await openDoc(page);
  const text = (await region(page, "re").locator(".math-line").textContent()) ?? "";
  expect(text).toContain("152180");
  expect(text).not.toContain("10");
});

test("notePosition below puts a long note under its formula, within the paper", async ({ page }) => {
  await openDoc(page);
  const formula = (await region(page, "wide").locator(".m").boundingBox())!;
  const note = (await region(page, "wide").locator(".note").boundingBox())!;
  const paper = (await page.locator(".sheet .content-box").first().boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(formula.y + formula.height - 1);
  expect(note.x + note.width).toBeLessThanOrEqual(paper.x + paper.width + 1);
  expect(note.height).toBeGreaterThan(24); // it wrapped onto two lines
  // a note with no position stays beside its formula
  const m = (await region(page, "beside").locator(".m").boundingBox())!;
  const side = (await region(page, "beside").locator(".note").boundingBox())!;
  expect(side.x).toBeGreaterThan(m.x + m.width - 1);
});

test("a 2D plot has even ticks, takes a one-row marker matrix, and its legend shows a dot for it", async ({ page }) => {
  await openDoc(page);
  const plot = region(page, "plot");
  await expect(plot.locator(".plot-ticks text[text-anchor=middle]").first()).toBeVisible();
  const ticks = await plot.locator(".plot-ticks text[text-anchor=middle]").allTextContents();
  expect(ticks).toEqual(["0", "2", "4", "6"]);
  await expect(plot.locator(".err")).toHaveCount(0);
  const legend = plot.locator(".plot-legend");
  await expect(legend.locator("line")).toHaveCount(1);
  await expect(legend.locator("circle")).toHaveCount(1);
  // the x axis title sits whole inside the small plot
  const svg = (await plot.locator("svg").boundingBox())!;
  const title = (await plot.locator(".plot-titles text").first().boundingBox())!;
  expect(title.y + title.height).toBeLessThanOrEqual(svg.y + svg.height + 0.5);
});

test("a 3D plot draws its own axis labels, whole inside a small plot", async ({ page }) => {
  await openDoc(page);
  const canvas = region(page, "plot3").locator("canvas");
  await expect.poll(() => canvas.getAttribute("data-labels")).toContain("load|");
  const labels = ((await canvas.getAttribute("data-labels")) ?? "").split(";");
  const names = labels.map((l) => l.split("|")[0]);
  expect(names).toEqual(expect.arrayContaining(["span", "width", "load"]));
  expect(names).not.toContain("z");
  expect(labels.filter((l) => l.endsWith("|out"))).toEqual([]);
});

test("the header fields work in text and table cells, and the engine reports each cell's pass or fail", async ({
  page,
}) => {
  await openDoc(page);
  const date = await page.evaluate(() => new Date().toLocaleDateString());
  await expect(region(page, "text").locator(".text-body")).toHaveText(`Issued ${date}, page 1 of 1: Beam report`);
  const cells = region(page, "table").locator("td");
  await expect(cells.filter({ hasText: date })).toHaveCount(1);
  await expect(cells.filter({ hasText: "Beam report" })).toHaveCount(1);
  // the engine says which cells pass: the page marks them from that, and the status bar counts them
  await expect(region(page, "table").locator("td.check-pass")).toHaveCount(1);
  await expect(region(page, "table").locator("td.check-fail")).toHaveCount(1);
  const views = await page.evaluate(() =>
    (
      window as unknown as { __quire: { state: { views: Record<string, { cells?: { verdict?: boolean }[][] }> } } }
    ).__quire.state.views.table.cells!.map((row) => row.map((c) => c.verdict ?? null)),
  );
  expect(views.map((row) => row[1])).toEqual([null, true, false]);
});
