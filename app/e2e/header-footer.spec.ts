// Headers and footers edited in place on the page: a double-click on the margin, fields as
// chips, one undo step per session, the same band on every page.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A two-page document (three with `pages: 3`) in the page view; returns the bundle's path. */
async function openDoc(page: Page, extra: Record<string, unknown> = {}, pages = 2) {
  dir = mkdtempSync(join(tmpdir(), "quire-hf-e2e-"));
  const doc = join(dir, "report.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1280, height: pages > 2 ? 3700 : 2600 });
  writeFileSync(
    join(doc, "document.json"),
    JSON.stringify({
      format: "quire/1",
      meta: { title: "Beam check" },
      page: { view: "pages", ...extra },
      regions: [
        { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
        { id: "b", kind: "math", at: [0, 1100], expr: "b:=2" },
        ...(pages > 2 ? [{ id: "c", kind: "math", at: [0, 2100], expr: "c:=3" }] : []),
      ],
    }),
  );
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  await expect(sheet(page, pages - 1).locator(`[data-region="${pages > 2 ? "c" : "b"}"]`)).toBeVisible();
  return doc;
}

/** The toolbar sits beside its band, never over the content of the page being edited. */
async function toolbarClearOfContent(page: Page, k: number) {
  const body = (await sheet(page, k).locator(".content-box").boundingBox())!;
  await expect
    .poll(async () => {
      const bar = (await page.locator(".hf-toolbar").boundingBox())!;
      return bar.y + bar.height <= body.y || bar.y >= body.y + body.height;
    })
    .toBe(true);
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
  // page 1 has little room above it: the page moves down to make room for the toolbar
  await toolbarClearOfContent(page, 0);
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
  await toolbarClearOfContent(page, 1);
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
  // the app takes the test browser for a Mac: ⌘K is Meta, wherever the test runs
  await page.keyboard.press("Meta+k");
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
    await page.keyboard.press("Escape");
    await toolbar(page).getByRole("button", { name: "Line under the header" }).click();
    await expect(page.getByRole("menuitemradio", { name: "No line" })).toBeVisible();
    await audit(page, `header line menu, ${scheme}`);
  });

// ---------------------------------------------------------------------------
// More settings: odd and even pages, a rule, a logo, distance, type
// ---------------------------------------------------------------------------

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
<rect width="120" height="40" rx="6" fill="#1d5fa8"/><circle cx="20" cy="20" r="10" fill="#fff"/>
<rect x="38" y="14" width="70" height="12" rx="3" fill="#fff"/></svg>`;

function toolbar(page: Page, which: "Header" | "Footer" = "Header") {
  return page.getByRole("toolbar", { name: `${which} tools` });
}

/** The app's Save, as the menu sends it (the browser setup has no menu). */
const save = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true })));

test("Different odd and even pages gives even pages their own header", async ({ page }) => {
  await openDoc(page, { header: { left: "Odd {page}" } }, 3);
  await dblclickBand(page, 1, "header", 0.5);
  await expect(page.getByRole("textbox", { name: "Header centre" })).toBeFocused();
  await toolbar(page).getByRole("checkbox", { name: "Different odd and even pages" }).check();
  await expect(toolbar(page)).toContainText("Even pages");
  // even pages start as a mirror of the odd ones: the page number moves to the outer edge
  await expect(page.getByRole("textbox", { name: "Header right" })).toContainText("Odd");
  await expect(page.getByRole("textbox", { name: "Header left" })).toHaveText("");
  await page.getByRole("textbox", { name: "Header left" }).click();
  await page.keyboard.type("Even {page}");
  await page.keyboard.press("Escape");

  await expect(band(page, 0, "header").locator(".hf-left")).toHaveText("Odd 1");
  await expect(band(page, 1, "header").locator(".hf-left")).toHaveText("Even 2");
  await expect(band(page, 1, "header").locator(".hf-right")).toHaveText("Odd 2");
  await expect(band(page, 2, "header").locator(".hf-left")).toHaveText("Odd 3");
  await expect(band(page, 2, "header").locator(".hf-right")).toHaveText("");
  expect(await docPage(page)).toMatchObject({
    header: { left: "Odd {page}", even: { left: "Even {page}", right: "Odd {page}" } },
  });

  // an odd page edits the odd pages, and says so
  await dblclickBand(page, 2, "header", 0.1);
  await expect(toolbar(page)).toContainText("Odd pages");
  await expect(page.getByRole("textbox", { name: "Header left" })).toContainText("Odd");
  await page.keyboard.press("Escape");

  // the session that turned it on is one undo step
  await page.keyboard.press("ControlOrMeta+z");
  await expect(band(page, 1, "header").locator(".hf-left")).toHaveText("Odd 2");
  expect(await docPage(page)).toEqual({ view: "pages", header: { left: "Odd {page}" } });
});

test("a line under the header shows on every page, below its text", async ({ page }) => {
  await openDoc(page, { header: { center: "Report" } });
  await dblclickBand(page, 0, "header", 0.5);
  await toolbar(page).getByRole("button", { name: "Line under the header" }).click();
  await page.getByRole("menuitemradio", { name: "Medium, 1 pt" }).click();
  await toolbar(page).getByRole("button", { name: "Done" }).click();
  for (const k of [0, 1]) {
    const rule = band(page, k, "header").locator(".hf-rule");
    await expect(rule).toBeVisible();
    const text = (await band(page, k, "header").locator(".hf-center").boundingBox())!;
    const line = (await rule.boundingBox())!;
    const body = (await sheet(page, k).locator(".content-box").boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
    expect(line.y + line.height).toBeLessThanOrEqual(body.y);
    expect(line.width).toBeGreaterThan(text.width);
  }
  expect(await docPage(page)).toMatchObject({ header: { center: "Report", rule: { width: "1pt" } } });
});

test("a logo added from the toolbar shows on every page and survives saving and reopening", async ({ page }) => {
  const doc = await openDoc(page, { header: { right: "{title}" } });
  const logo = join(dir, "logo.svg");
  writeFileSync(logo, LOGO);
  await dblclickBand(page, 0, "header", 0.1);
  await expect(page.getByRole("textbox", { name: "Header left" })).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await toolbar(page).getByRole("button", { name: "Image…" }).click();
  await (await chooser).setFiles(logo);
  // in the slot the caret was in, while editing too
  await expect(band(page, 0, "header").locator(".hf-left .hf-image")).toBeVisible();
  await expect(toolbar(page).getByRole("button", { name: "Image", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // saved at once: `quire serve` is shared by the tests running alongside, and a document one
  // of them opens releases the images staged for this one (one editor per server)
  await save(page);
  await expect(page.locator(".toast")).toHaveText("Saved report");
  const written = JSON.parse(readFileSync(join(doc, "document.json"), "utf8"));
  const src = written.page.header.image.src as string;
  expect(src).toMatch(/^assets\/[0-9a-f]{16}\.svg$/);
  await expect.poll(() => existsSync(join(doc, src))).toBe(true);

  for (const k of [0, 1]) {
    const room = (await band(page, k, "header").boundingBox())!;
    const img = band(page, k, "header").locator(".hf-left .hf-image");
    await expect(img).toBeVisible();
    const box = (await img.boundingBox())!;
    // half the margin high by default, inside it, and as wide as its shape says
    expect(Math.abs(box.height - room.height / 2)).toBeLessThan(1.5);
    expect(Math.abs(box.width - box.height * 3)).toBeLessThan(2);
    expect(box.y).toBeGreaterThanOrEqual(room.y);
    expect(box.y + box.height).toBeLessThanOrEqual(room.y + room.height);
  }
  await expect(band(page, 1, "header").locator(".hf-right")).toHaveText("Beam check");

  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  for (const k of [0, 1]) {
    const img = band(page, k, "header").locator(".hf-left .hf-image");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }
});

test("distance from the edge moves the band's text, apart from the margins", async ({ page }) => {
  await openDoc(page, { header: { left: "Top" }, footer: { left: "Bottom" } });
  const paper = (await sheet(page, 0).boundingBox())!;
  const scale = paper.width / ((210 * 96) / 25.4);
  const fromTop = async () => ((await band(page, 0, "header").locator(".page-hf").boundingBox())!.y - paper.y) / scale;
  const fromBottom = async () => {
    const row = (await band(page, 0, "footer").locator(".page-hf").boundingBox())!;
    return (paper.y + paper.height - row.y - row.height) / scale;
  };
  // centred in the 20 mm margin, as before
  expect(await fromTop()).toBeGreaterThan(25);

  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.getByRole("tab", { name: "Page" }).click();
  await page.locator(".inspector").getByLabel("From top mm").fill("5");
  await page.keyboard.press("Enter");
  await expect.poll(fromTop).toBeCloseTo((5 * 96) / 25.4, 0);
  await page.locator(".inspector").getByLabel("From bottom mm").fill("8");
  await page.keyboard.press("Enter");
  await expect.poll(fromBottom).toBeCloseTo((8 * 96) / 25.4, 0);
  // the content keeps its margins
  const body = (await sheet(page, 0).locator(".content-box").boundingBox())!;
  expect((body.y - paper.y) / scale).toBeCloseTo((20 * 96) / 25.4, 0);
  expect(await docPage(page)).toMatchObject({ header: { distance: "5mm" }, footer: { distance: "8mm" } });
});

test("type and line set from the toolbar undo inside the session, and the session in one step", async ({ page }) => {
  await openDoc(page, { header: { center: "Report" } });
  await dblclickBand(page, 0, "header", 0.5);
  const centre = page.getByRole("textbox", { name: "Header centre" });
  await expect(centre).toBeFocused();
  await toolbar(page)
    .getByRole("button", { name: /^Text size/ })
    .click();
  await page.getByRole("menuitemradio", { name: "11 pt" }).click();
  await toolbar(page).getByRole("button", { name: "Bold" }).click();
  await expect(toolbar(page).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  await toolbar(page).getByRole("button", { name: "Line under the header" }).click();
  await page.getByRole("menuitemradio", { name: "Thin, 0.5 pt" }).click();
  await expect(centre).toHaveCSS("font-weight", "700");
  await expect(centre).toHaveCSS("font-size", /^14\.66/); // 11 pt
  await expect(band(page, 0, "header").locator(".hf-rule")).toBeVisible();
  // the caret stayed in the slot
  await expect(centre).toBeFocused();

  // undo inside the session takes back the line, then bold; redo puts bold back
  await page.keyboard.press("ControlOrMeta+z");
  await expect(band(page, 0, "header").locator(".hf-rule")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(toolbar(page).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(toolbar(page).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  expect(await docPage(page)).toMatchObject({ header: { center: "Report", size: 11, bold: true } });

  // the session is one step
  await page.keyboard.press("ControlOrMeta+z");
  expect(await docPage(page)).toEqual({ view: "pages", header: { center: "Report" } });
  await expect(band(page, 1, "header").locator(".hf-center")).toHaveCSS("font-weight", "400");
});

test("print draws the logo, line and text where the page shows them", async ({ page }) => {
  const header = {
    left: "{title}",
    right: "{page}",
    size: 10,
    distance: "6mm",
    rule: { width: "1pt" },
    image: { src: "assets/0123456789abcdef.svg", slot: "center", height: "8mm" },
  };
  // the logo is already in the bundle, as in a saved document
  dir = mkdtempSync(join(tmpdir(), "quire-hf-e2e-"));
  const doc = join(dir, "report.quire");
  mkdirSync(join(doc, "assets"), { recursive: true });
  writeFileSync(join(doc, "assets", "0123456789abcdef.svg"), LOGO);
  writeFileSync(
    join(doc, "document.json"),
    JSON.stringify({
      format: "quire/1",
      meta: { title: "Beam check" },
      page: { view: "pages", header },
      regions: [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }],
    }),
  );
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  await expect(band(page, 0, "header").locator(".hf-image")).toBeVisible();

  // where each part sits on the first sheet, as a fraction of the sheet's width
  const measure = () => {
    const sheet = document.querySelector(".sheet")!.getBoundingClientRect();
    const at = (sel: string) => {
      const b = document.querySelector(`.sheet ${sel}`)!.getBoundingClientRect();
      return [b.left - sheet.left, b.top - sheet.top, b.height].map((v) => Math.round((v / sheet.width) * 1000));
    };
    return { row: at(".page-hf"), image: at(".hf-image"), rule: at(".hf-rule"), left: at(".hf-left") };
  };
  const onScreen = await page.evaluate(measure);
  await page.evaluate((fn) => {
    const w = window as unknown as Record<string, unknown>;
    // the print dialog is where the page is measured
    w.print = () => (w.__printed = new Function(`return (${fn})()`)());
  }, measure.toString());
  await page.evaluate(() =>
    (window as unknown as { __quire: { runCommand: (id: string) => void } }).__quire.runCommand("print"),
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__printed ?? null))
    .toEqual(onScreen);
  // and the band is not the on-screen one there
  expect(await page.locator(".hf-band").count()).toBeGreaterThan(0);
});
