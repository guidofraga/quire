// Headers and footers edited in place on the page: a double-click on the margin, fields as
// chips, one undo step per session, the same band on every page.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { audit } from "./axe";

const sheet = (page: Page, k: number) => page.locator(".sheet").nth(k);
const band = (page: Page, k: number, which: "header" | "footer") =>
  sheet(page, k).locator(`.hf-band[data-band=${which}]`);
const docPage = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __quire: { state: { doc: { page?: unknown } } } }).__quire.state.doc.page,
  );

let dir = "";
test.afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A two-page document in the page view. */
async function openDoc(page: Page, extra: Record<string, unknown> = {}) {
  dir = mkdtempSync(join(tmpdir(), "quire-hf-e2e-"));
  const doc = join(dir, "report.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1280, height: 2600 });
  writeFileSync(
    join(doc, "document.json"),
    JSON.stringify({
      format: "quire/1",
      meta: { title: "Beam check" },
      page: { view: "pages", ...extra },
      regions: [
        { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
        { id: "b", kind: "math", at: [0, 1100], expr: "b:=2" },
      ],
    }),
  );
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  await expect(sheet(page, 1).locator('[data-region="b"]')).toBeVisible();
}

/** Double-click a band near its left, middle or right. */
async function dblclickBand(page: Page, k: number, which: "header" | "footer", where: number) {
  const box = (await band(page, k, which).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * where, box.y + box.height / 2);
}

test("a header typed on page 1, with a Page field, shows on every page and undoes in one step", async ({ page }) => {
  await openDoc(page);
  const header = band(page, 0, "header");
  // an empty band says how to fill it, on hover
  await header.hover();
  await expect(header.getByText("Double-click to add a header")).toBeVisible();

  await dblclickBand(page, 0, "header", 0.1);
  const left = page.getByRole("textbox", { name: "Header left" });
  await expect(left).toBeFocused();
  await expect(page.getByRole("group", { name: "Header, all pages" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Header tools" })).toContainText("All pages");
  await page.keyboard.type("Page ");
  await page.getByRole("button", { name: "Insert field" }).click();
  await page.getByRole("menuitem", { name: /^Page\W+1$/ }).click();
  await expect(left.locator(".hf-chip")).toHaveText("Page");
  await expect(left).toBeFocused();
  await page.keyboard.type(" of ");
  await page.getByRole("button", { name: "Insert field" }).click();
  await page.getByRole("menuitem", { name: /^Pages\W+2$/ }).click();
  await expect(left.locator(".hf-chip")).toHaveCount(2);
  // undo inside the session takes back the last step on the band, redo puts it back
  await page.keyboard.press("ControlOrMeta+z");
  await expect(left.locator(".hf-chip")).toHaveCount(1);
  await expect(left).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(left.locator(".hf-chip")).toHaveCount(2);

  // Tab goes on to the centre slot and then the right one
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Header centre" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Header right" })).toBeFocused();
  await page.keyboard.type("Beam");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("textbox", { name: "Header centre" })).toBeFocused();

  // the page body was dimmed while editing, and Esc ends it
  await expect(sheet(page, 0)).toHaveClass(/hf-active/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Header left" })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Header tools" })).toHaveCount(0);
  await expect(sheet(page, 0)).not.toHaveClass(/hf-active/);
  await expect(header.locator(".hf-left")).toHaveText("Page 1 of 2");
  await expect(header.locator(".hf-right")).toHaveText("Beam");
  await expect(band(page, 1, "header").locator(".hf-left")).toHaveText("Page 2 of 2");
  // in the file, fields stay text
  expect(await docPage(page)).toMatchObject({ header: { left: "Page {page} of {pages}", right: "Beam" } });

  // the whole session is one undo step
  await page.keyboard.press("ControlOrMeta+z");
  await expect(header.locator(".hf-left")).toHaveCount(0);
  await expect(band(page, 1, "header").locator(".hf-left")).toHaveCount(0);
  expect(await docPage(page)).not.toHaveProperty("header");
});

test("a field typed with braces becomes a chip, and Backspace deletes it whole", async ({ page }) => {
  await openDoc(page, { footer: { left: "x" } });
  // past the end of the text: the caret goes after it
  await dblclickBand(page, 1, "footer", 0.25);
  const left = page.getByRole("textbox", { name: "Footer left" });
  await expect(left).toBeFocused();
  await expect(page.getByRole("toolbar", { name: "Footer tools" })).toBeVisible();
  await page.keyboard.type(" {date}");
  await expect(left.locator(".hf-chip")).toHaveText("Date");
  await page.keyboard.press("Backspace");
  await expect(left.locator(".hf-chip")).toHaveCount(0);
  await expect(left).toHaveText("x ");
  // Enter ends editing too; what was typed stays
  await page.keyboard.type("{page}");
  await page.keyboard.press("Enter");
  await expect(band(page, 0, "footer").locator(".hf-left")).toHaveText("x 1");
  expect(await docPage(page)).toMatchObject({ footer: { left: "x {page}" } });
});

test("Different first page leaves page 1 blank and is edited there on its own", async ({ page }) => {
  await openDoc(page, { header: { center: "Report" } });
  await expect(band(page, 0, "header").locator(".hf-center")).toHaveText("Report");
  await dblclickBand(page, 1, "header", 0.5);
  await expect(page.getByRole("textbox", { name: "Header centre" })).toBeFocused();
  const toolbar = page.getByRole("toolbar", { name: "Header tools" });
  await toolbar.getByRole("checkbox", { name: "Different first page" }).check();
  await expect(toolbar).toContainText("All pages but the first");
  await expect(band(page, 0, "header").locator(".hf-center")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "Done" }).click();
  await expect(toolbar).toHaveCount(0);
  expect(await docPage(page)).toMatchObject({ firstPage: { header: false } });

  // page 1 has its own band: blank, with its toggle on
  await dblclickBand(page, 0, "header", 0.5);
  await expect(toolbar).toContainText("First page");
  await expect(band(page, 0, "header")).toContainText("No header on the first page");
  await expect(page.getByRole("textbox", { name: "Header centre" })).toHaveCount(0);
  const toggle = toolbar.getByRole("checkbox", { name: "Different first page" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByRole("textbox", { name: "Header centre" })).toHaveText("Report");
  await expect(toolbar).toContainText("All pages");
  // a click on the page body ends editing
  const body = (await sheet(page, 0).locator(".content-box").boundingBox())!;
  await page.mouse.click(body.x + 200, body.y + 300);
  await expect(toolbar).toHaveCount(0);
  await expect(band(page, 0, "header").locator(".hf-center")).toHaveText("Report");
  expect(await docPage(page)).not.toHaveProperty("firstPage");
});

test("Edit Footer from ⌘K edits the footer of the page in view", async ({ page }) => {
  await openDoc(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox", { name: "Command, variable or symbol" }).fill("Edit Footer");
  await page.keyboard.press("Enter");
  const left = page.getByRole("textbox", { name: "Footer left" });
  await expect(left).toBeFocused();
  await page.keyboard.type("Draft");
  await page.keyboard.press("Escape");
  await expect(band(page, 0, "footer").locator(".hf-left")).toHaveText("Draft");
  await expect(band(page, 1, "footer").locator(".hf-left")).toHaveText("Draft");
});

test("Inspector ▸ Page shows what is typed on the page", async ({ page }) => {
  await openDoc(page, { header: { left: "{title}" } });
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.getByRole("tab", { name: "Page" }).click();
  await expect(page.locator(".inspector").getByLabel("Header left")).toHaveValue("{title}");
  await dblclickBand(page, 0, "header", 0.9);
  await page.keyboard.type("Rev A");
  await expect(page.locator(".inspector").getByLabel("Header right")).toHaveValue("Rev A");
});

for (const scheme of ["light", "dark"] as const)
  test(`editing a header passes axe, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openDoc(page, { header: { left: "{title}", right: "Page {page} of {pages}", color: "#555b65" } });
    await dblclickBand(page, 0, "header", 0.5);
    await expect(page.getByRole("textbox", { name: "Header centre" })).toBeFocused();
    await audit(page, `header editing, ${scheme}`);
    await page.getByRole("button", { name: "Insert field" }).click();
    await expect(page.getByRole("menuitem", { name: /^Page\W+1$/ })).toBeVisible();
    await audit(page, `header field menu, ${scheme}`);
  });
