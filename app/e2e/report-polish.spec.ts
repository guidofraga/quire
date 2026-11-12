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
  // its markers are all red, so the legend's dot is red too (not the series' palette colour)
  await expect(legend.locator("circle")).toHaveAttribute("fill", "#ff0000");
  // the x axis title sits whole inside the small plot
  const svg = (await plot.locator("svg").boundingBox())!;
  const title = (await plot.locator(".plot-titles text").first().boundingBox())!;
  expect(title.y + title.height).toBeLessThanOrEqual(svg.y + svg.height + 0.5);
});

for (const [width, height] of [
  [310, 210],
  [620, 440],
] as const) {
  test(`a 3D plot draws its own axis titles, whole and clear of the numbers (${width}×${height})`, async ({ page }) => {
    await openDoc(page, { size3: [width, height] });
    const canvas = region(page, "plot3").locator("canvas");
    await expect.poll(() => canvas.getAttribute("data-labels")).toContain("title|load|");
    const labs = ((await canvas.getAttribute("data-labels")) ?? "").split(";").map((l) => {
      const [kind, text, x0, y0, x1, y1] = l.split("|");
      return { kind, text, x0: +x0, y0: +y0, x1: +x1, y1: +y1 };
    });
    const titles = labs.filter((l) => l.kind === "title");
    const ticks = labs.filter((l) => l.kind === "tick");
    expect(titles.map((t) => t.text).sort()).toEqual(["load", "span", "width"]);
    expect(ticks.length).toBeGreaterThan(4);
    for (const l of labs) {
      expect([l.x0 >= 0, l.y0 >= 0, l.x1 <= width, l.y1 <= height], `${l.text} inside`).toEqual([
        true,
        true,
        true,
        true,
      ]);
    }
    const hit = (a: (typeof labs)[0], b: (typeof labs)[0]) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    for (const t of titles) {
      expect(
        ticks.filter((k) => hit(t, k)).map((k) => k.text),
        `${t.text} on a number`,
      ).toEqual([]);
      expect(
        titles.filter((o) => o !== t && hit(t, o)).map((o) => o.text),
        `${t.text} on a title`,
      ).toEqual([]);
    }
  });
}

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
