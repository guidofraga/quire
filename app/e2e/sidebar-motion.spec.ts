// The two sidebars move alike: the notebook (left) and the Inspector (right) slide with the
// same duration and easing, and with Reduce motion on both switch at once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quire-motion-e2e-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function open(page: Page) {
  await page.goto(`/?notebook=${encodeURIComponent(dir)}`);
  await expect(page.getByRole("navigation", { name: "Notebook" })).toBeVisible();
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
}

/** The transition of the property that moves a sidebar, as the browser computes it. */
const slide = (el: Locator, side: "left" | "right") =>
  el.evaluate((node, prop) => {
    const s = getComputedStyle(node);
    const props = s.transitionProperty.split(",").map((x) => x.trim());
    const i = props.indexOf(prop);
    const at = (list: string) => list.split(/,(?![^(]*\))/).map((x) => x.trim())[i];
    return i < 0 ? null : { duration: at(s.transitionDuration), easing: at(s.transitionTimingFunction) };
  }, `margin-${side}`);

test("the Inspector slides like the notebook sidebar", async ({ page }) => {
  await open(page);
  const left = await slide(page.locator(".sidebar"), "left");
  const right = await slide(page.locator(".inspector"), "right");
  expect(left).not.toBeNull();
  expect(left?.duration).toBe("0.24s");
  expect(right).toEqual(left);
});

test("with Reduce motion on, neither sidebar animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  for (const [sel, side] of [
    [".sidebar", "left"],
    [".inspector", "right"],
  ] as const) {
    const t = await slide(page.locator(sel), side);
    expect(t, sel).not.toBeNull();
    expect(Number.parseFloat(t!.duration) * (t!.duration.endsWith("ms") ? 1 : 1000), sel).toBeLessThan(1);
  }
});

test("the Inspector slides, then can't be reached, and gives the page its room back", async ({ page }) => {
  await open(page);
  const insp = page.locator(".inspector");
  const pane = page.locator(".canvas-pane");
  const width = (l: Locator) => l.evaluate((n) => n.getBoundingClientRect().width);
  // opened, once the slide is over
  await expect.poll(() => insp.evaluate((n) => getComputedStyle(n).marginRight)).toBe("0px");
  const open290 = await width(pane);

  await insp.getByRole("tab", { name: "Page" }).click();
  await page.keyboard.press("Alt+Meta+i");
  // part way: still taking room, not yet gone
  await expect.poll(async () => (await width(pane)) > open290).toBe(true);
  await expect(insp).toHaveClass(/collapsed/);
  await expect(insp).toHaveAttribute("inert", "");
  await expect(insp).toHaveAttribute("aria-hidden", "true");
  await expect(insp).toBeHidden();
  // once shut, nothing inside is kept up to date
  await expect(insp.locator("[role=tab]")).toHaveCount(0);
  await expect(insp.locator(".insp-body")).toHaveCount(0);
  // the page fills the room after the slide
  await expect.poll(async () => (await width(pane)) - open290).toBeGreaterThan(285);

  await page.keyboard.press("Alt+Meta+i");
  await expect(insp).toBeVisible();
  // content is there from the first frame, on the tab that was open
  await expect(insp.locator("[role=tab]")).toHaveCount(3);
  await expect(insp.getByRole("tab", { name: "Page" })).toHaveAttribute("aria-selected", "true");
  await expect(insp).not.toHaveAttribute("inert");
  await expect.poll(async () => Math.abs((await width(pane)) - open290)).toBeLessThan(2);
  // the panel kept its width the whole way: nothing squashed
  expect(await width(insp)).toBe(290);
});
