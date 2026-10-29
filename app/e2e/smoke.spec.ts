// End to end: the UI in WebKit against `quire serve`, typing as a user would.
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");

/** A blank document with the insertion point on the page. */
async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

/** Type each line as a new region, as on a fresh page. */
async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

test("evaluates math with units as you type", async ({ page }) => {
  await blank(page);
  await typeLines(page, "q:=12 kN/m", "L:=6 m", "M:=q*L^2/8=");
  await expect(regions(page)).toHaveCount(3);
  // the result keeps the units of the inputs: 54 kN·m, not 54000 J
  await expect(regions(page).nth(2)).toContainText(/=54\s*kN\W?m$/);
  await expect(page.locator(".status .muted").first()).toContainText("3 math");
});

test("typing starts right after choosing Blank document", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await typeLines(page, "a:=2", "b:=a*3=");
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=6$/);
});

test("switching views doesn't make a document Edited", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".toolbar .title")).toHaveText("Untitled");
});

test("the insert tools stay put as the status changes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  const left = () => page.locator(".toolbar .tools").evaluate((el) => el.getBoundingClientRect().left);
  const before = await left();
  await typeLines(page, "q:=12 kN/m", "x:=1 m + q=");
  await expect(page.locator(".toolbar .errors")).toBeVisible();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  expect(await left()).toBe(before);
});

test("explains a unit mismatch", async ({ page }) => {
  await blank(page);
  await typeLines(page, "x:=1 m + 2 kN=");
  await expect(regions(page).first()).toContainText(/cannot add a length \(m\) and a force/);
});

test("fits data and solves an ODE with units", async ({ page }) => {
  await blank(page);
  await typeLines(
    page,
    "x:=[1;2;3;4] m",
    "F:=[5;7;9;11] kN",
    "slope(x, F)=kN/m",
    "D(t, y):=-y/(2 s)",
    "Y:=rkfixed(10 mm, 0, 4 s, 40, D)",
    "Y[41, 2]=mm",
  );
  await expect(regions(page)).toHaveCount(6);
  await expect(regions(page).nth(2)).toContainText(/=2\s*kN\W?m$/);
  // 10 mm·e^−2
  await expect(regions(page).nth(5)).toContainText(/=1\.3534\s*mm$/);
});

test("a word followed by a space becomes text", async ({ page }) => {
  await blank(page);
  await typeLines(page, "The span is simply supported.");
  await expect(regions(page)).toHaveCount(1);
  await expect(regions(page).first()).toHaveClass(/\btext\b/);
  await expect(regions(page).first()).toContainText("The span is simply supported.");
});

test("undo and redo a new region", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=2", "b:=a*3=");
  await expect(regions(page)).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(regions(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(regions(page)).toHaveCount(2);
  await expect(regions(page).nth(1)).toContainText(/=6$/);
});

test("a change upstream updates results below", async ({ page }) => {
  await blank(page);
  await typeLines(page, "L:=2 m", "A:=L*3=");
  await expect(regions(page).nth(1)).toContainText(/=6\s*m$/);
  await regions(page).first().dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("L:=5 m");
  await page.keyboard.press("Escape");
  await expect(regions(page).nth(1)).toContainText(/=15\s*m$/);
});

test("imports a CSV file as a table and exports its values", async ({ page }) => {
  await blank(page);
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 250, { button: "right" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Insert Table from CSV…").click();
  await (await chooser).setFiles({
    name: "wind loads.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('Load,q,twice\nDead,4.5 kN/m,=B2*2\n"Live, roof",1.5 kN/m,=B3*2\n'),
  });
  const table = regions(page).first();
  await expect(table).toContainText("Live, roof");
  await expect(page.locator(".flash, .message, body")).toContainText("as the table wind_loads");

  await page.keyboard.press("Escape");
  await table.click({ button: "right" });
  const download = page.waitForEvent("download");
  await page.getByText("Export as CSV…").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("wind_loads.csv");
  const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  expect(lines[0]).toBe("Load,q,twice");
  expect(lines[1]).toMatch(/^Dead,4\.5 kN\/m,9\b/);
  expect(lines[2]).toMatch(/^"Live, roof",1\.5 kN\/m,3\b/);
});
