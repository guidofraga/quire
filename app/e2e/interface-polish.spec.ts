// The chrome in context: the format bar shows what applies, the palette groups its commands
// with recent ones first, and the Welcome screen previews each template.
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

// (with nothing to format it is no toolbar to a screen reader, so found by its class)
const bar = (page: Page) => page.locator(".formatbar");

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

test("the format bar floats: text controls only with text in context, and the page never moves", async ({ page }) => {
  await blank(page);
  // the page area starts right under the toolbar, and the sheet stays where it is, bar or no bar
  const toolbarBottom = async () => {
    const r = (await page.locator(".toolbar").boundingBox())!;
    return r.y + r.height;
  };
  const viewportTop = async () => (await page.locator(".viewport").boundingBox())!.y;
  const sheetTop = async () => (await page.locator(".sheet").first().boundingBox())!.y;
  const [top0, sheet0] = [await viewportTop(), await sheetTop()];
  expect(Math.abs(top0 - (await toolbarBottom()))).toBeLessThanOrEqual(1);
  // nothing selected: no bar at all
  await expect(bar(page)).toBeHidden();
  await expect(bar(page).locator("button")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Format" })).toHaveCount(0);
  // math being typed: the galleries, no text formatting
  await page.keyboard.type("a:=2");
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /Structures/ })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Bold" })).toHaveCount(0);
  expect([await viewportTop(), await sheetTop()]).toEqual([top0, sheet0]);
  // the math region selected, not edited: still the galleries
  await page.keyboard.press("Escape");
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toBeVisible();
  // text being typed: text formatting, no galleries
  await page.mouse.click(700, 450);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await page.keyboard.type("Some words");
  await expect(page.getByRole("toolbar", { name: "Format" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Align left" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toHaveCount(0);
  expect([await viewportTop(), await sheetTop()]).toEqual([top0, sheet0]);
  // floating over the top of the page area, centred
  const b = (await bar(page).boundingBox())!;
  const v = (await page.locator(".viewport").boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(v.y);
  expect(Math.abs(b.x + b.width / 2 - (v.x + v.width / 2))).toBeLessThanOrEqual(2);
  await audit(page, "format bar with text", ".formatbar");
  // back to nothing: gone again, and the page hasn't moved
  await page.keyboard.press("Escape");
  await page.mouse.click(1000, 650);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toBeHidden();
  expect([await viewportTop(), await sheetTop()]).toEqual([top0, sheet0]);
});

test("the format bar moves out of the way of the caret", async ({ page }) => {
  await blank(page);
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  // type at the top of the page area, right where the bar would float
  const v = (await page.locator(".viewport").boundingBox())!;
  await page.mouse.click(v.x + v.width / 2 - 20, v.y + 22);
  await page.keyboard.type("x:=1");
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toBeVisible();
  await expect(bar(page)).toHaveClass(/at-bottom/);
  const caret = (await page.locator(".math-input").boundingBox())!;
  const b = (await bar(page).boundingBox())!;
  expect(b.y).toBeGreaterThan(caret.y + caret.height);
  // its galleries open upwards there, inside the window
  await bar(page).getByRole("button", { name: "Symbols" }).click();
  const pop = (await page.getByRole("dialog", { name: "Symbols" }).boundingBox())!;
  expect(pop.y).toBeGreaterThanOrEqual(0);
  expect(pop.y + pop.height).toBeLessThanOrEqual(b.y + 1);
});

test("the galleries insert into the selected math", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("a:=2");
  await page.keyboard.press("Escape");
  await bar(page).getByRole("button", { name: "Symbols" }).click();
  await page.getByRole("tab", { name: "Greek", exact: true }).click();
  await page.locator(".gallery-tile.symbol").nth(1).click();
  await expect(page.locator(".math-input")).toHaveValue("a:=2β");
});

const groups = (page: Page) => page.getByRole("dialog", { name: "Command palette" }).getByRole("group");

test("the palette groups commands, recent ones first, notebook commands last without a notebook", async ({ page }) => {
  await blank(page);
  await page.keyboard.press("Meta+k");
  const names = await groups(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(names.slice(0, 4)).toEqual(["File", "Edit", "Insert", "View"]);
  for (const g of ["File", "Edit", "Insert", "View", "Help"]) expect(names).toContain(g);
  // no notebook open: its commands come last, and ⌘N makes a document
  expect(names.indexOf("Notebook")).toBeGreaterThan(names.indexOf("Help"));
  const first = page.getByRole("option").first();
  await expect(first).not.toHaveText(/New Note/);
  await expect(first).toHaveText(/New Document/);
  // each command has its icon
  await expect(first.locator("svg")).toHaveCount(1);
  // run one, and it is the first thing offered next time, in Recent
  await page.keyboard.type("zoom to width");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.keyboard.press("Meta+k");
  await expect(groups(page).first()).toHaveAttribute("aria-label", "Recent");
  await expect(groups(page).first().getByRole("option").first()).toHaveText(/Zoom to Width/);
  // fuzzy matching still finds commands, with their shortcuts on the right
  await page.keyboard.type("expdf");
  await expect(page.getByRole("option").first()).toHaveText(/Export as PDF…\s*⌘E/);
  await audit(page, "palette with a query");
});

test("the welcome screen previews each template's first page", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByRole("dialog", { name: "Welcome to Quire" });
  const template = welcome.getByRole("button", { name: /Simply supported beam/ });
  await expect(template).toBeVisible();
  const thumbs = welcome.locator(".welcome-thumb");
  await expect(thumbs).toHaveCount(5);
  // a page with its header, a title and the content of the first page
  await expect(template.locator(".welcome-thumb .t-title")).toHaveCount(1);
  expect(await template.locator(".welcome-thumb rect").count()).toBeGreaterThan(20);
  // Blank document and Open… have icons, their shortcuts on the right
  await expect(welcome.getByRole("button", { name: /Blank document/ }).locator("svg")).toHaveCount(1);
  await expect(welcome.getByRole("button", { name: /Open…/ }).first().locator(".welcome-key")).toHaveText("⌘O");
  // the brand mark beside the name (decorative: the heading says "Quire")
  await expect(welcome.getByRole("heading", { name: "Quire" })).toBeVisible();
  expect(await welcome.locator(".welcome-mark").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(
    0,
  );
});

test("in a narrow window the floating bar keeps inside the page area, the rest under ⋯", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(280, 250);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await page.keyboard.type("Some words");
  const more = bar(page).getByRole("button", { name: "More formatting" });
  await expect(more).toBeVisible();
  const b = (await bar(page).boundingBox())!;
  const v = (await page.locator(".viewport").boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(v.x);
  expect(b.x + b.width).toBeLessThanOrEqual(v.x + v.width);
  await more.click();
  const pop = page.getByRole("dialog", { name: "More formatting" });
  await expect(pop.getByRole("button", { name: "Align left" })).toBeVisible();
});
