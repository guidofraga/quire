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

test("the format bar shows text controls only with text in context, and keeps its height", async ({ page }) => {
  await blank(page);
  const height = async () => (await bar(page).boundingBox())!.height;
  const pageTop = async () => (await page.locator(".viewport").boundingBox())!.y;
  const [h0, top0] = [await height(), await pageTop()];
  // nothing selected: nothing to format
  await expect(bar(page).getByRole("button", { name: "Bold" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toHaveCount(0);
  await expect(bar(page).locator("button")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Format" })).toHaveCount(0);
  // math being typed: the galleries, no text formatting
  await page.keyboard.type("a:=2");
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: /Structures/ })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Bold" })).toHaveCount(0);
  expect(await height()).toBe(h0);
  // the math region selected, not edited: still the galleries
  await page.keyboard.press("Escape");
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toBeVisible();
  // text being typed: text formatting, no galleries
  await page.mouse.click(700, 450);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await page.keyboard.type("Some words");
  await expect(bar(page).getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Align left" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Symbols" })).toHaveCount(0);
  expect(await height()).toBe(h0);
  expect(await pageTop()).toBe(top0);
  await audit(page, "format bar with text", ".formatbar");
  // back to nothing
  await page.keyboard.press("Escape");
  await page.mouse.click(1000, 650);
  await page.keyboard.press("Escape");
  await expect(bar(page).getByRole("button", { name: "Bold" })).toHaveCount(0);
  expect(await pageTop()).toBe(top0);
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
