// End to end: zooming the page view out draws a scaled-down picture of the page at 100% (#116):
// every region shrinks by the zoom, and text keeps its line breaks.
import { expect, type Page, test } from "@playwright/test";

type Box = { w: number; h: number; breaks: number[] };

/** Each region on screen: its size, and where its text's lines start (character offsets). */
function measure(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, Box> = {};
    for (const el of document.querySelectorAll<HTMLElement>(".pages [data-region]")) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      const breaks: number[] = [];
      if (el.classList.contains("text")) {
        // a new line starts where a character sits below the previous one
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let i = 0;
        let lastTop: number | null = null;
        let lastH = 0;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? "";
          for (let k = 0; k < text.length; k++, i++) {
            if (!text[k].trim()) continue;
            range.setStart(n, k);
            range.setEnd(n, k + 1);
            const q = range.getBoundingClientRect();
            if (!q.height) continue;
            if (lastTop !== null && q.top > lastTop + lastH / 2) breaks.push(i);
            lastTop = q.top;
            lastH = q.height;
          }
        }
      }
      out[el.dataset.region!] = { w: r.width, h: r.height, breaks };
    }
    return out;
  });
}

/** Measurements once fonts are in and nothing has changed size for three samples in a row. */
async function steady(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let m = await measure(page);
  let still = 0;
  await expect
    .poll(
      async () => {
        const was = m;
        m = await measure(page);
        const ids = Object.keys(m);
        const same =
          ids.length > 0 &&
          ids.every((id) => was[id] && Math.abs(was[id].w - m[id].w) < 0.5 && Math.abs(was[id].h - m[id].h) < 0.5);
        still = same ? still + 1 : 0;
        return still >= 3;
      },
      { intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return m;
}

async function zoomLabel(page: Page) {
  return (await page.locator("button.zoom").textContent())?.trim();
}

test("zooming the page view out scales every region and keeps line breaks", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("dialog", { name: "Welcome to Quire" })
    .getByRole("button", { name: /All templates/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "New from template" });
  await dialog.getByRole("button", { name: /Simply supported beam/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".pages .region.math").first()).toBeVisible();
  expect(await zoomLabel(page)).toBe("100%");
  const full = await steady(page);
  // the template has wrapped paragraphs to check line breaks on
  const wrapped = Object.keys(full).filter((id) => full[id].breaks.length >= 2);
  expect(wrapped.length).toBeGreaterThan(0);

  const zoomTo = async (label: string) => {
    for (let i = 0; i < 10 && (await zoomLabel(page)) !== label; i++) {
      await page.locator("button.zoom").click();
      const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
      // 25% is not in the menu: Zoom Out down to it (the smallest zoom)
      await ((await item.count()) ? item : page.getByRole("menuitem", { name: "Zoom Out" })).click();
    }
    expect(await zoomLabel(page)).toBe(label);
  };

  for (const [label, z] of [
    ["50%", 0.5],
    ["25%", 0.25],
  ] as const) {
    await zoomTo(label);
    const now = await steady(page);
    const off: string[] = [];
    for (const [id, b] of Object.entries(full)) {
      const s = now[id];
      if (!s) {
        off.push(`${id} not shown`);
        continue;
      }
      // within a screen pixel, or 2% of the region's size for big ones
      const tol = (n: number) => Math.max(1.25, 0.02 * n * z);
      if (Math.abs(s.w - b.w * z) > tol(b.w) || Math.abs(s.h - b.h * z) > tol(b.h))
        off.push(
          `${id}: ${s.w.toFixed(1)}×${s.h.toFixed(1)}, expected ${(b.w * z).toFixed(1)}×${(b.h * z).toFixed(1)}`,
        );
      if (b.breaks.join() !== s.breaks.join()) off.push(`${id}: lines start at ${s.breaks}, at 100% ${b.breaks}`);
    }
    expect(off, `at ${label}`).toEqual([]);
  }

  // still at 25%: a click lands where it is aimed, on a region and on the paper beside it
  const heading = page.locator(".pages .region.text", { hasText: "Design basis" }).first();
  const box = (await heading.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(heading).toHaveClass(/selected/);
  const at = { x: box.x + box.width + 30, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y);
  const caret = (await page.locator(".caret").boundingBox())!;
  // the insertion point snaps to the grid, a few screen pixels at this zoom
  expect(Math.abs(caret.x - at.x)).toBeLessThan(6);
  expect(Math.abs(caret.y - at.y)).toBeLessThan(12);
});
