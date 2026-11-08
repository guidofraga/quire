// Vertical rhythm: lines are spaced by their real height, and a line that grows pushes what is below.
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");
/** One grid step, in screen px at 100 %. */
const GRID = 9;

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

async function typeLines(page: Page, ...lines: string[]) {
  for (const [i, line] of lines.entries()) {
    await page.keyboard.type(line);
    await page.keyboard.press(i < lines.length - 1 ? "Enter" : "Escape");
  }
}

const box = async (page: Page, i: number) => {
  const b = (await regions(page).nth(i).boundingBox())!;
  return { left: b.x, top: b.y, bottom: b.y + b.height };
};
/** The free space between region `i` and the one after it. */
const gap = async (page: Page, i: number) => (await box(page, i + 1)).top - (await box(page, i)).bottom;

/** Edit the math of region `i` from scratch. */
async function retype(page: Page, i: number, text: string) {
  await regions(page).nth(i).dblclick();
  await expect(page.locator("input.math-input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

test("a line typed under a fraction keeps a grid step clear of it", async ({ page }) => {
  await blank(page);
  await typeLines(page, "q:=12 kN/m", "L:=6 m", "M:=q*L^2/8", "V:=q*L/2");
  await expect(regions(page)).toHaveCount(4);
  await expect(regions(page).nth(2).locator("mfrac")).toHaveCount(1);
  await expect.poll(() => gap(page, 2)).toBeGreaterThanOrEqual(GRID - 0.5);
});

test("an error appearing under a line pushes the next line down, and undo puts both back", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=1", "b:=a+1", "c:=2");
  await expect(regions(page)).toHaveCount(3);
  const before = await box(page, 2);
  // renaming a breaks the line below it, which wasn't edited
  await retype(page, 0, "x:=1");
  const error = regions(page)
    .nth(1)
    .getByText(/a is not defined/);
  await expect(error).toBeVisible();
  // the error, and its button, stay a grid step clear of the line below
  await expect.poll(() => gap(page, 1)).toBeGreaterThanOrEqual(GRID - 0.5);
  expect((await box(page, 2)).top).toBeGreaterThan(before.top);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(error).toHaveCount(0);
  await expect(regions(page).first()).toContainText("a");
  await expect.poll(async () => (await box(page, 2)).top).toBe(before.top);
});

test("a line growing leaves what is in another column where it is", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=1", "b:=2");
  const line = (name: string) => regions(page).filter({ hasText: `${name} is defined as` });
  const top = async (name: string) => (await line(name).boundingBox())!.y;
  const b = await line("b").boundingBox();
  // a line in a column to the right, level with b
  await page.mouse.click(b!.x + 300, b!.y + 4);
  await typeLines(page, "c:=3");
  await expect(line("c")).toHaveCount(1);
  const c = await top("c");
  await retype(page, 0, "a:=1+zz");
  await expect(
    regions(page)
      .first()
      .getByText(/zz is not defined/),
  ).toBeVisible();
  await expect.poll(() => top("b")).toBeGreaterThan(b!.y);
  expect(await top("c")).toBe(c);
});

test("typing in a line doesn't move the lines around it", async ({ page }) => {
  await blank(page);
  await typeLines(page, "a:=1", "b:=a+1", "c:=2");
  await expect(regions(page)).toHaveCount(3);
  const where = () => regions(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  await regions(page).nth(1).dblclick();
  const input = page.locator("input.math-input");
  await expect(input).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  let typed = "b:=a+1";
  await page.keyboard.type(typed);
  await expect(input).toHaveValue(typed);
  const start = await where();
  // each keystroke is evaluated; the half-typed `b:=a+1/zz` is an error, held back while typing
  for (const key of ["/", "z", "z", "/", "a"]) {
    await page.keyboard.type(key);
    typed += key;
    await expect(input).toHaveValue(typed);
    expect(await where()).toEqual(start);
  }
  // after a pause the line's error shows; the line below makes room once the edit ends
  await expect(
    regions(page)
      .nth(1)
      .getByText(/zz is not defined/),
  ).toBeVisible();
  expect(await where()).toEqual(start);
  await page.keyboard.press("Escape");
  await expect.poll(() => gap(page, 1)).toBeGreaterThanOrEqual(GRID - 0.5);
});
