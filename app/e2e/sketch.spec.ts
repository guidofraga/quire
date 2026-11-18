// End to end: Insert ▸ Sketch, live parametric redraw when variables change, Inspector
// autocomplete + add/reorder/remove + undo, "defined further down" error with partial render,
// Canvas vs Pages zero layout shift, Word 300 dpi export, and axe in light & dark.
import { expect, test } from "@playwright/test";
import { audit } from "./axe";
import { exportWord, pngSize } from "./docx";

test("Insert ▸ Sketch on a blank document draws a concrete starter beam and passes axe", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Sketch" }).click();

  const sketch = page.locator(".region.sketch");
  await expect(sketch).toBeVisible();
  const svg = sketch.locator("svg[role='img']");
  await expect(svg).toHaveAttribute(
    "aria-label",
    "Beam 6 m long, pin at left, roller at right, uniform load q = 10 kN/m",
  );
  await expect(svg).toContainText("q = 10 kN/m");
  await expect(svg).toContainText("6 m");
  await audit(page, "blank starter sketch");
});

test("sketch binds to L and q above, redraws live, supports Inspector autocomplete & undo, exports to Word, and passes axe in light & dark", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();

  // Set working units so interpolated loads display in kN/m and kN
  await page.getByRole("button", { name: "Inspector" }).click();
  await page.getByRole("tab", { name: "Document" }).click();
  await page.getByLabel("Units").selectOption("working");

  // Click canvas and define L, q, P
  await page.locator(".viewport").click({ position: { x: 140, y: 120 } });
  await page.keyboard.type("L := 6 m");
  await page.keyboard.press("Enter");
  await page.keyboard.type("q := 10.6 kN/m");
  await page.keyboard.press("Enter");
  await page.keyboard.type("P := 24 kN");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Sketch" }).click();

  const sketch = page.locator(".region.sketch");
  const svg = sketch.locator("svg[role='img']");
  await expect(svg).toContainText("q = 10.6 kN/m");
  await expect(svg).toContainText("6 m");

  // Double-click sketch to focus Inspector Region tab and add a midspan point load with autocomplete
  await svg.dblclick();
  await expect(page.locator(".sketch-el")).toHaveCount(5);
  await page.getByRole("button", { name: /Add Element/ }).click();
  await page.getByRole("menuitem", { name: "Point Load" }).click();
  await expect(page.locator(".sketch-el")).toHaveCount(6);

  const pointCard = page.locator('[data-sketch-el="5"]');
  const atX = pointCard.getByLabel("At X");
  await atX.click();
  await atX.fill("");
  await page.keyboard.type("L");
  await expect(page.getByRole("listbox", { name: "Names" })).toBeVisible();
  await page.keyboard.type("/2");
  await page.keyboard.press("Enter");

  const labelInput = pointCard.getByLabel("Label");
  await labelInput.click();
  await labelInput.fill("");
  await page.keyboard.type("P = {P");
  await expect(page.getByRole("listbox", { name: "Names" })).toBeVisible();
  await page.keyboard.type("}");
  await page.keyboard.press("Enter");

  await expect(svg).toContainText("P = 24 kN");

  // Reorder and remove + Undo
  await pointCard.getByRole("button", { name: "Move element 6 up" }).click();
  await expect(page.locator('[data-sketch-el="4"]')).toContainText("Point load");
  await page.locator('[data-sketch-el="4"]').getByRole("button", { name: "Remove element 5" }).click();
  await expect(page.locator(".sketch-el")).toHaveCount(5);
  await page.locator(".viewport").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(svg).toContainText("P = 24 kN");

  // Live redraw when L changes from 6 m to 8 m
  await page.locator(".region.math").first().dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("L := 8 m");
  await page.keyboard.press("Escape");
  await expect(svg).toContainText("8 m");
  await expect(svg).toHaveAttribute("aria-label", /Beam 8 m long/);

  // Zero layout shift of sketch region and SVG box between Pages and Canvas views
  const pagesBox = await sketch.boundingBox();
  const pagesSvg = await sketch.locator(".sketch-box").boundingBox();
  expect(pagesSvg?.width).toBeCloseTo(480, 0);
  expect(pagesSvg?.height).toBeCloseTo(220, 0);
  await page.getByRole("button", { name: "Canvas" }).click();
  const canvasBox = await sketch.boundingBox();
  const canvasSvg = await sketch.locator(".sketch-box").boundingBox();
  expect(canvasSvg?.width).toBeCloseTo(480, 0);
  expect(canvasSvg?.height).toBeCloseTo(220, 0);
  expect(canvasBox?.width).toBeCloseTo(pagesBox!.width, 0);
  expect(canvasBox?.height).toBeCloseTo(pagesBox!.height, 0);
  await page.getByRole("button", { name: "Pages" }).click();

  // Axe audit in light mode (with Inspector open on the sketch)
  await sketch.click();
  await audit(page, "sketch light with inspector");

  // Axe audit in dark mode (sketch stays paper-white)
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await audit(page, "sketch dark with inspector");

  // Export as Word: sketch is rasterized at 300 dpi (>= 1400 px wide for 480 px CSS width)
  const { files } = await exportWord(page);
  const pictures = [...files.keys()].filter((k) => k.startsWith("word/media/"));
  expect(pictures).toHaveLength(1);
  const [pngW, pngH] = pngSize(files.get(pictures[0])!);
  expect(pngW).toBeGreaterThanOrEqual(1400);
  expect(pngH).toBeGreaterThanOrEqual(650);
});

test("sketch above variable definition shows defined-below error while keeping valid elements drawn", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();

  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Sketch" }).click();

  const sketch = page.locator(".region.sketch");
  const svg = sketch.locator("svg[role='img']");
  await svg.dblclick();

  // Change element 3 (support at right) to use `L`, then define `L := 6 m` below the sketch
  const rollerCard = page.locator('[data-sketch-el="2"]');
  const atX = rollerCard.getByLabel("At X");
  await atX.click();
  await atX.fill("L");
  await atX.press("Enter");

  const box = await sketch.boundingBox();
  if (!box) throw new Error("no sketch box");
  await page.mouse.click(box.x + 20, box.y + box.height + 50);
  await page.keyboard.type("L := 6 m");
  await page.keyboard.press("Escape");

  // Error explains that L is defined further down and offers the one-click Show definition button,
  // while valid elements (member 0..6 m, pin at 0, UDL, dimension) still render!
  await expect(sketch.locator(".err")).toContainText("L is defined further down");
  await expect(sketch.locator(".err-fix")).toHaveText("Show definition");
  expect(await svg.locator(".sketch-item").count()).toBeGreaterThanOrEqual(4);
});
