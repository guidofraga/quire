// Tables as in Word: choose rows × columns, type straight away, format cells, merge, resize,
// and blocks (tables, lists, plots) placed in the text column in Pages view.
import { expect, type Page, test } from "@playwright/test";

const SHOT = process.env.SHOT_DIR;

type R = { id: string; kind: string; at: [number, number]; rows?: string[][]; [k: string]: unknown };
const regionsOf = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __quire: { state: { doc: { regions: R[] } } } }).__quire.state.doc.regions.map((r) => JSON.parse(JSON.stringify(r)) as R),
  );
const tableOf = async (page: Page) => (await regionsOf(page)).find((r) => r.kind === "table")!;

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
}

/** The text column of the first page, in the window. */
async function column(page: Page) {
  const box = await page.locator(".content-box").first().boundingBox();
  if (!box) throw new Error("no page");
  return box;
}

const tableButton = (page: Page) => page.getByRole("button", { name: /^.?\s*Table$/ }).first();
const tools = (page: Page) => page.getByRole("toolbar", { name: "Table tools" });
const tool = (page: Page, name: string) => tools(page).getByRole("button", { name, exact: true });

async function shot(page: Page, name: string) {
  if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` });
}

test("typing right after inserting a table fills A1; Tab and Enter move on", async ({ page }) => {
  await blank(page);
  const col = await column(page);
  await page.mouse.click(col.x + 40, col.y + 120);
  await tableButton(page).click();
  await page.keyboard.type("Item");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Valor");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Peso");
  await page.keyboard.press("Tab");
  await page.keyboard.type("12 kN");
  await page.keyboard.press("Tab");
  await shot(page, "t1-typing");
  const t = await tableOf(page);
  expect(t.rows![0].slice(0, 2)).toEqual(["Item", "Valor"]);
  // Enter went to the cell below the one typed (B2), as in a spreadsheet; Tab on from there
  expect(t.rows![1][1]).toBe("Peso");
  expect(t.rows![1][2]).toBe("12 kN");
});

test("slow typing after inserting also lands in the cells", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.type("Item", { delay: 120 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("Valor", { delay: 120 });
  await page.keyboard.press("Tab");
  const t = await tableOf(page);
  expect(t.rows![0].slice(0, 2)).toEqual(["Item", "Valor"]);
});

test("the size picker inserts rows × columns with a header row, as wide as the text column", async ({ page }) => {
  await blank(page);
  const col = await column(page);
  await page.mouse.click(col.x + 40, col.y + 100);
  await tableButton(page).click();
  const picker = page.getByRole("dialog", { name: "Insert table" });
  await expect(picker).toBeVisible();
  await picker.locator('[data-size="3x5"]').hover();
  await expect(picker).toContainText("5 × 3 Table");
  await shot(page, "t2-picker");
  await picker.locator('[data-size="3x5"]').click();
  await expect(picker).toHaveCount(0);
  const t = await tableOf(page);
  expect(t.rows!.length).toBe(3);
  expect(t.rows![0].length).toBe(5);
  expect(t.header).toEqual({ row: true });
  expect(t.fit).toBe(true);
  // fits the column: left at the margin, right edge at the right margin
  await page.keyboard.press("Escape");
  const box = (await page.locator(".region.table table.sheet").boundingBox())!;
  // (inside the region's 3 px padding, lined up with text)
  expect(Math.abs(box.x - col.x)).toBeLessThan(5);
  expect(Math.abs(box.x + box.width - (col.x + col.width))).toBeLessThan(5);
  await shot(page, "t3-fitted");
});

test("the picker answers the keyboard: arrows, then Enter", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const t = await tableOf(page);
  expect([t.rows!.length, t.rows![0].length]).toEqual([5, 4]);
});

test("in Pages view a table, contents and plot go to the left margin, not where the click was", async ({ page }) => {
  await blank(page);
  const col = await column(page);
  const farRight = col.x + col.width - 30;
  await page.mouse.click(farRight, col.y + 60);
  await page.getByRole("button", { name: /Contents/ }).click();
  await page.mouse.click(farRight, col.y + 300);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.mouse.click(farRight, col.y + 520);
  await page.getByRole("button", { name: /^.?\s*Plot$/ }).first().click();
  await page.mouse.click(col.x + col.width / 2, col.y + col.height - 40);
  await shot(page, "t4-pages-placement");
  const regions = await regionsOf(page);
  for (const kind of ["toc", "table", "plot2d"]) {
    const r = regions.find((x) => x.kind === kind);
    expect(r, kind).toBeTruthy();
    expect(r!.at[0], kind).toBe(0);
  }
  for (const el of await page.locator(".region.toc, .region.table, .region.plot2d").all()) {
    const b = (await el.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(col.x - 2);
    expect(b.x + b.width).toBeLessThanOrEqual(col.x + col.width + 4);
  }
});

test("on the canvas a table still goes where the click was", async ({ page }) => {
  await blank(page);
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.mouse.click(700, 300);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  const t = await tableOf(page);
  expect(t.at[0]).toBeGreaterThan(100);
});

test("rows and columns: insert above/below/left/right and delete, formulas follow", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.press("Enter"); // 4 × 3
  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("=B1*3");
  await page.keyboard.press("Enter");
  // from A1: the new row goes above it and the new column to its left
  await page.locator(".region.table td[data-r='0'][data-c='0']").click();
  await tool(page, "Insert row above").click();
  await tool(page, "Insert column left").click();
  let t = await tableOf(page);
  expect(t.rows!.length).toBe(5);
  expect(t.rows![0].length).toBe(4);
  // C1 = 2 moved to C2; the formula moved with it and still points at it
  expect(t.rows![1]).toEqual(["", "a", "2", "=C2*3"]);
  await tool(page, "Insert row below").click();
  await tool(page, "Insert column right").click();
  t = await tableOf(page);
  expect([t.rows!.length, t.rows![0].length]).toEqual([6, 5]);
  await tool(page, "Delete rows").click();
  await tool(page, "Delete columns").click();
  t = await tableOf(page);
  expect([t.rows!.length, t.rows![0].length]).toEqual([5, 4]);
  await shot(page, "t5-rows-cols");
});

test("merge and split cells", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Cargas");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await tool(page, "Merge cells").click();
  let t = await tableOf(page);
  expect(t.cellFormat).toEqual({ A1: { colSpan: 3 } });
  const merged = page.locator(".region.table td[data-r='0'][data-c='0']");
  await expect(merged).toHaveAttribute("colspan", "3");
  await expect(page.locator(".region.table tbody tr").first().locator("td")).toHaveCount(1);
  // Tab steps over the merged cell to the next row
  await page.keyboard.press("Tab");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  t = await tableOf(page);
  expect(t.rows![1][0]).toBe("x");
  await shot(page, "t6-merged");
  await page.locator(".region.table td[data-r='0'][data-c='0']").click();
  await tool(page, "Split cells").click();
  t = await tableOf(page);
  expect(t.cellFormat).toBeUndefined();
  await expect(page.locator(".region.table tbody tr").first().locator("td")).toHaveCount(3);
});

test("cell formatting: bold, italic, alignment, shading, borders", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("1,5");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.press("ControlOrMeta+i");
  await tool(page, "Align centre").click();
  await tool(page, "Align bottom").click();
  await tools(page).getByLabel("Shading", { exact: true }).selectOption("#fff2cc");
  let t = await tableOf(page);
  expect(t.cellFormat).toEqual({ A2: { bold: true, italic: true, align: "center", valign: "bottom", fill: "#fff2cc" } });
  const cell = page.locator(".region.table td[data-r='1'][data-c='0']");
  await expect(cell).toHaveCSS("font-weight", "700");
  await expect(cell).toHaveCSS("font-style", "italic");
  await expect(cell).toHaveCSS("text-align", "center");
  await expect(cell).toHaveCSS("vertical-align", "bottom");
  // a header cell is bold already: ⌘B makes it plain
  await page.keyboard.press("ArrowUp");
  await expect(tool(page, "Bold (⌘B)")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.locator(".region.table td[data-r='0'][data-c='0']")).toHaveCSS("font-weight", "400");
  await tools(page).getByLabel("Borders", { exact: true }).selectOption("outer");
  t = await tableOf(page);
  expect(t.borders).toBe("outer");
  await shot(page, "t7-formats-editing");
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await expect(cell).toHaveCSS("background-color", "rgb(255, 242, 204)");
  await expect(page.locator(".region.table td").nth(4)).toHaveCSS("border-top-style", "none");
  await shot(page, "t7-formats");
});

test("dragging a column border keeps the table as wide as the text column", async ({ page }) => {
  await blank(page);
  const col = await column(page);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.mouse.click(col.x + col.width / 2, col.y + col.height - 30);
  const table = page.locator(".region.table table.sheet");
  const before = (await table.boundingBox())!;
  await table.hover();
  const grip = page.locator(".region.table .col-grip").first();
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + 10);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 80, g.y + 10, { steps: 5 });
  await page.mouse.up();
  const after = (await table.boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThan(3);
  const t = await tableOf(page);
  const widths = (t.columns as { width: number }[]).map((c) => c.width);
  expect(widths[0]).toBeLessThan(widths[1] - 100);
  await shot(page, "t8-column-drag");
});

test("prints the same as on screen", async ({ page }) => {
  await blank(page);
  await tableButton(page).click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Item");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowRight");
  await tool(page, "Merge cells").click();
  await tools(page).getByLabel("Shading", { exact: true }).selectOption("#deeaf6");
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  const table = page.locator(".region.table table.sheet");
  const screen = (await table.boundingBox())!;
  await page.emulateMedia({ media: "print" });
  const print = (await table.boundingBox())!;
  expect(Math.abs(print.width - screen.width)).toBeLessThan(2);
  const first = page.locator(".region.table td[data-r='0'][data-c='0']");
  await expect(first).toHaveAttribute("colspan", "2");
  await expect(first).toHaveCSS("background-color", "rgb(222, 234, 246)");
  await page.emulateMedia({ media: "screen" });
});

test("a pasted spreadsheet keeps its old look: no new fields on it", async ({ page }) => {
  await blank(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "Load\tq\nDead\t4.5 kN/m");
    (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect(page.locator(".region.table")).toHaveCount(1);
  const t = await tableOf(page);
  expect(t.fit).toBeUndefined();
  expect(t.cellFormat).toBeUndefined();
  expect(t.borders).toBeUndefined();
});
