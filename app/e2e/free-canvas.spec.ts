// The free canvas is a worksheet without page edges (#104): boxes keep their shape wherever
// they are moved, content goes above and left of the start, and faint page guides show what
// prints where. The page view stays the printed report: it draws what is past the printable
// column on the paper without changing the document.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const region = (page: Page, id: string) => page.locator(`[data-region="${id}"]`);

/** Open a document written for the test, in the page view or on the canvas. */
async function openDoc(page: Page, view: "pages" | "canvas", regions: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "quire-canvas-e2e-"));
  const doc = join(dir, "canvas.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1500, height: 1100 });
  writeFileSync(join(doc, "document.json"), JSON.stringify({ format: "quire/1", page: { view }, regions }));
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  return dir;
}

/** The document's regions as they are now (development builds expose the store). */
function positions(page: Page) {
  return page.evaluate(() => {
    const q = (window as unknown as { __quire: { state: { doc: { regions: { id: string; at: number[] }[] } } } })
      .__quire;
    return Object.fromEntries(q.state.doc.regions.map((r) => [r.id, [r.at[0], r.at[1]]]));
  });
}

/** A box's place on screen once it has stopped moving. */
async function settled(l: Locator) {
  let b = (await l.boundingBox())!;
  await expect
    .poll(async () => {
      const was = b;
      b = (await l.boundingBox())!;
      return b.x === was.x && b.y === was.y && b.width === was.width && b.height === was.height;
    })
    .toBe(true);
  return b;
}

/** No part of the box is cut off: nothing inside is wider than what shows it. */
function clipped(l: Locator) {
  return l.evaluate((el) =>
    [el, ...el.querySelectorAll("*")].some((e) => {
      const s = getComputedStyle(e);
      return s.overflow !== "visible" && e.scrollWidth > e.clientWidth + 1;
    }),
  );
}

test("a title dragged far right on the canvas keeps its full width", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: /Simply supported beam/ }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  const title = region(page, "b00");
  await expect(title).toContainText("Simply supported steel beam");
  const before = await settled(title);
  await page.mouse.move(before.x + 6, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + 300, before.y + before.height / 2, { steps: 5 });
  await page.mouse.move(before.x + 564, before.y + before.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await positions(page)).b00[0]).toBeGreaterThan(500);
  const after = await settled(title);
  // the box didn't shrink to the room left before a page edge, and nothing in it is cut off
  expect(after.width).toBeGreaterThanOrEqual(before.width - 1);
  expect(after.height).toBeLessThanOrEqual(before.height + 1);
  expect(await clipped(title)).toBe(false);
});

test("a long title wraps on the page instead of being cut off", async ({ page }) => {
  const words = "Design of the composite floor beams for the third storey of the north wing";
  const dir = await openDoc(page, "pages", [
    { id: "t", kind: "text", at: [0, 0], text: `{.title}\n# ${words}` },
    { id: "a", kind: "math", at: [0, 120], expr: "a:=1" },
  ]);
  try {
    const title = region(page, "t");
    await expect(title).toContainText("north wing");
    const sheet = (await page.locator(".sheet").first().boundingBox())!;
    const box = await settled(title);
    expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
    expect(await clipped(title)).toBe(false);
    // on more than one line
    const line = await title.locator("h1").evaluate((h) => parseFloat(getComputedStyle(h).lineHeight) || 30);
    expect(box.height).toBeGreaterThan(line * 1.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dragging above and left of the start moves the document back without a jump", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [
    { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
    { id: "b", kind: "math", at: [180, 90], expr: "b:=2" },
  ]);
  try {
    const a = region(page, "a");
    const b = region(page, "b");
    await expect(b).toBeVisible();
    const a0 = await settled(a);
    const b0 = await settled(b);
    await page.mouse.move(a0.x + 4, a0.y + a0.height / 2);
    await page.mouse.down();
    await page.mouse.move(a0.x - 60, a0.y - 40, { steps: 5 });
    await page.mouse.move(a0.x - 116, a0.y + a0.height / 2 - 81, { steps: 5 });
    // where it is just before it is let go: above and left of where the document started
    const held = (await a.boundingBox())!;
    expect(held.x).toBeLessThan(a0.x - 100);
    expect(held.y).toBeLessThan(a0.y - 60);
    await page.mouse.up();

    // nothing moves on screen as the document shifts back
    const a1 = await settled(a);
    const b1 = await settled(b);
    expect(Math.abs(a1.x - held.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a1.y - held.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(b1.x - b0.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(b1.y - b0.y)).toBeLessThanOrEqual(1);

    // stored coordinates stay at or after the origin: a is now the document's top-left
    const at = await positions(page);
    expect(Math.min(at.a[0], at.b[0])).toBe(0);
    expect(Math.min(at.a[1], at.b[1])).toBe(0);
    expect(at.b[0] - at.a[0]).toBe(180 + 117);
    expect(at.b[1] - at.a[1]).toBe(90 + 81);

    // one undo step puts it all back
    await page.keyboard.press("Meta+z");
    await expect.poll(() => positions(page)).toEqual({ a: [0, 0], b: [180, 90] });
    // and the view with it: b doesn't jump, a is back where it started
    const b2 = await settled(b);
    expect(Math.abs(b2.x - b0.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(b2.y - b0.y)).toBeLessThanOrEqual(1);
    const a2 = await settled(a);
    expect(Math.abs(a2.x - a0.x)).toBeLessThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("typing above and left of the start puts the new line where it was clicked", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [{ id: "a", kind: "math", at: [0, 0], expr: "a:=1" }]);
  try {
    const a = region(page, "a");
    // pan, so there is canvas above and left of the document's start
    const start = await settled(a);
    await page.mouse.move(start.x + 300, start.y + 300);
    await page.mouse.wheel(-200, -200);
    const a0 = await settled(a);
    expect(a0.x).toBeGreaterThan(start.x + 150);
    await page.mouse.click(a0.x - 140, a0.y - 120);
    await page.keyboard.type("c:=3");
    await page.keyboard.press("Escape");
    const c = page.locator('.region.math:not([data-region="a"])');
    await expect(page.locator(".region.math")).toHaveCount(2);
    const box = await settled(c);
    // within a grid step of the click, and a hasn't moved on screen
    expect(Math.abs(box.x - (a0.x - 140))).toBeLessThan(12);
    expect(Math.abs(box.y - (a0.y - 120))).toBeLessThan(24);
    const a1 = await settled(a);
    expect(Math.abs(a1.x - a0.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a1.y - a0.y)).toBeLessThanOrEqual(1);
    const at = Object.values(await positions(page));
    expect(Math.min(...at.map((p) => p[0]))).toBe(0);
    expect(Math.min(...at.map((p) => p[1]))).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page guides show the printable column and page breaks, toggle, and are remembered", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [
    { id: "a", kind: "math", at: [0, 0], expr: "a:=1" },
    { id: "far", kind: "math", at: [0, 1300], expr: "far:=2" },
  ]);
  try {
    const guides = page.locator(".page-guides");
    const column = guides.locator(".page-column");
    // on by default: the column, page 1's top and the start of page 2
    await expect(column).toBeVisible();
    await expect(guides.locator(".page-break")).toHaveCount(2);
    const col = (await column.boundingBox())!;
    const a = (await region(page, "a").boundingBox())!;
    expect(Math.abs(col.x - a.x)).toBeLessThanOrEqual(1);
    // A4 with 20 mm margins: a 170 mm column
    expect(Math.abs(col.width - (170 * 96) / 25.4)).toBeLessThanOrEqual(2);
    // page 2 starts between the two regions, where the page view breaks
    const second = (await guides.locator('.page-break[data-page="2"]').boundingBox())!;
    const far = (await region(page, "far").boundingBox())!;
    expect(second.y).toBeGreaterThan(a.y + a.height);
    expect(second.y).toBeLessThanOrEqual(far.y + 1);

    // off from the command palette
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("page guides");
    await page.keyboard.press("Enter");
    await expect(column).toHaveCount(0);
    // an app setting: still off after a reload
    await page.reload();
    await expect(region(page, "a")).toBeVisible();
    await expect(column).toHaveCount(0);
    // back on from the toolbar's zoom menu (the web version's View options)
    await page.locator("button.zoom").click();
    await page.getByRole("menuitemcheckbox", { name: /Page Guides/ }).click();
    await expect(column).toBeVisible();
    // never on the page view or on paper
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    await expect(column).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the page view keeps what is past the printable column on the paper, without changing it", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [
    { id: "near", kind: "math", at: [0, 0], expr: "near:=1" },
    { id: "far", kind: "math", at: [900, 90], expr: "far:=2" },
  ]);
  try {
    await expect(region(page, "far")).toBeVisible();
    const before = await positions(page);
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    const sheet = await settled(page.locator(".sheet").first());
    const margin = (sheet.width * 20) / 210;
    const far = await settled(region(page, "far"));
    expect(far.x).toBeGreaterThanOrEqual(sheet.x + margin - 1);
    expect(far.x + far.width).toBeLessThanOrEqual(sheet.x + sheet.width - margin + 1);
    // a short note says so; the document is as it was, and not edited
    await expect(page.locator(".toast")).toContainText("printable width");
    expect(await positions(page)).toEqual(before);
    await expect(page.locator(".toolbar .title .edited")).toHaveCount(0);
    // back on the canvas it is where it was put
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    const near = await settled(region(page, "near"));
    const back = await settled(region(page, "far"));
    expect(Math.round(back.x - near.x)).toBe(900);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every region's width on screen, by id (at zoom 100%). */
function widthsOf(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-region]")]
        .filter((el) => el.offsetParent)
        .map((el) => [el.dataset.region!, el.getBoundingClientRect().width]),
    ),
  );
}

/** Widths measured on the canvas and then in the page view, once each has settled. */
async function bothViews(page: Page, ids: string[]) {
  // fonts in, results drawn, and no width changing for three samples in a row
  const steady = async () => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    let w = await widthsOf(page);
    let still = 0;
    await expect
      .poll(
        async () => {
          const was = w;
          w = await widthsOf(page);
          const same = ids.every((id) => w[id] !== undefined && Math.abs(w[id] - was[id]) < 0.5);
          still = same ? still + 1 : 0;
          return still >= 3;
        },
        { intervals: [200], timeout: 10_000 },
      )
      .toBe(true);
    return w;
  };
  const canvas = await steady();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".sheet").first()).toBeVisible();
  return { canvas, pages: await steady() };
}

test("a table keeps its column widths on the canvas, as on the page", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: /Simply supported beam/ }).click();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await expect(region(page, "b08").locator("table")).toBeVisible();
  const ids = ["b00", "b01", "b02", "b03", "b05", "b08", "b11", "b12", "b12b", "b16", "b17"];
  const { canvas, pages } = await bothViews(page, ids);
  // Table 1's columns are 110 + 110 + 70 + 110 px wide
  expect(canvas.b08).toBeGreaterThan(400);
  for (const id of ids)
    expect(
      Math.abs(canvas[id] - pages[id]),
      `${id}: ${canvas[id]} on the canvas, ${pages[id]} on the page`,
    ).toBeLessThanOrEqual(1);
});

test("every kind of region is as wide on the canvas as on the page", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [
    {
      id: "ar",
      kind: "area",
      at: [0, 0],
      height: 72,
      title: "Area",
      regions: [{ id: "in", kind: "math", at: [0, 27], expr: "x:=1" }],
    },
    { id: "chk", kind: "toc", at: [0, 108], of: "checks", title: "Summary of Checks" },
    {
      id: "sized",
      kind: "text",
      at: [0, 198],
      width: 300,
      text: "Text with a width of its own, long enough to wrap at it.",
    },
    { id: "centred", kind: "text", at: [0, 288], text: "{.center}\nCentred text" },
    { id: "plain", kind: "text", at: [0, 342], text: "Plain text that hugs its words" },
    { id: "img", kind: "image", at: [0, 396], size: [200, 100], src: "assets/missing.png" },
    {
      id: "plot",
      kind: "plot2d",
      at: [0, 540],
      size: [300, 160],
      series: [{ expr: "sin(t)", var: "t", from: "0", to: "6" }],
    },
    { id: "m", kind: "math", at: [0, 760], expr: "y:=[1;2;3]" },
  ]);
  try {
    await expect(region(page, "m")).toBeVisible();
    const ids = ["ar", "in", "chk", "sized", "centred", "plain", "img", "plot", "m"];
    const { canvas, pages } = await bothViews(page, ids);
    for (const id of ids)
      expect(
        Math.abs(canvas[id] - pages[id]),
        `${id}: ${canvas[id]} on the canvas, ${pages[id]} on the page`,
      ).toBeLessThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Whether two boxes on screen overlap. */
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("a message never covers the page's pills, nor they it", async ({ page }) => {
  const dir = await openDoc(page, "canvas", [
    { id: "near", kind: "math", at: [0, 0], expr: "near:=1" },
    { id: "far", kind: "math", at: [900, 90], expr: "far:=2" },
    { id: "next", kind: "math", at: [0, 1300], expr: "next:=3" },
  ]);
  try {
    await expect(region(page, "far")).toBeVisible();
    // the page view's note, while "Page 1 of 2" shows as the pages scroll
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    const toast = page.locator(".toast");
    await expect(toast).toContainText("printable width");
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 120);
    const hint = page.locator(".page-hint");
    await expect(hint).toBeVisible();
    await expect.poll(async () => overlap((await toast.boundingBox())!, (await hint.boundingBox())!)).toBe(false);
    // and once the message goes, the pill is back in its place below where it was lifted to
    const lifted = (await hint.boundingBox())!;
    await toast.click();
    await expect(toast).toHaveCount(0);
    await page.mouse.wheel(0, 120);
    await expect(hint).toBeVisible();
    await expect.poll(async () => (await hint.boundingBox())!.y).toBeGreaterThan(lifted.y + 20);

    // the canvas's way back, and any other message (⇧⌘R with no text to put it in)
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    await settled(region(page, "near"));
    await page.mouse.move(700, 500);
    await page.mouse.wheel(3000, 4000);
    const back = page.getByRole("button", { name: "Back to your document" });
    await expect(back).toBeVisible();
    await page.locator(".viewport").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("Meta+Shift+r");
    await expect(toast).toContainText("Put the cursor in text first");
    await expect.poll(async () => overlap((await toast.boundingBox())!, (await back.boundingBox())!)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
