// End to end: the states of the table, find bar and 3D plot that a mouse or Enter can leave wrong.
import { expect, type Page, test } from "@playwright/test";

const regions = (page: Page) => page.locator(".region");

/** A blank document with the insertion point on the page. */
async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
}

test("right-clicking another cell while typing keeps the text in its own cell", async ({ page }) => {
  await blank(page);
  await page.keyboard.press("ControlOrMeta+Alt+t");
  await expect(page.getByRole("grid")).toBeVisible();
  // the table takes the keys once it has focus: a key typed before that is lost
  await expect(page.locator(".region.editing .sheet-wrap")).toBeFocused();
  await page.keyboard.type("hello");
  await expect(page.getByRole("textbox", { name: "Cell A1" })).toHaveValue("hello");
  // the cell being typed is A1; a right-click on B2 must not move the text there
  await page.locator('td[data-r="1"][data-c="1"]').click({ button: "right" });
  const menu = page.getByRole("menu");
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.locator('td[data-r="0"][data-c="0"]')).toContainText("hello");
  await expect(page.locator('td[data-r="1"][data-c="1"]')).not.toContainText("hello");
});

test("Enter on Close closes the find bar and leaves the math alone", async ({ page }) => {
  await blank(page);
  await page.keyboard.type("alpha:=2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Alt+f");
  const bar = page.getByRole("search");
  await expect(bar).toBeVisible();
  // the bar opens with the replace row shown; a click there would close it again
  const toggle = page.getByRole("button", { name: "Show replace" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("textbox", { name: "Find", exact: true }).fill("alpha");
  // the match is the current one, so a replace would change the math
  await expect(page.locator(".find-status")).toHaveText("1 of 1");
  await page.getByRole("textbox", { name: "Replace with" }).fill("zeta");
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(bar).toHaveCount(0);
  await expect(regions(page).first()).toContainText("alpha");
  await expect(regions(page).first()).not.toContainText("zeta");
});

test("a zoom with ⌥ + scroll during a drag is kept when the drag ends", async ({ page }) => {
  await blank(page);
  await page.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("menuitem", { name: "3D Plot" }).click();
  const plot = page.locator(".region.plot3d");
  const canvas = plot.getByRole("img", { name: "3D plot of sin(x)*cos(y)" });
  await expect(canvas).toBeVisible();
  await expect(plot).toHaveClass(/\bselected\b/);
  const distance = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __quire: { state: { doc: { regions: { camera?: { distance: number } }[] } } };
          }
        ).__quire.state.doc.regions.find((r) => r.camera)?.camera?.distance,
    );
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 5 });
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Alt");
  await page.mouse.move(x + 80, y, { steps: 5 });
  await page.mouse.up();
  await expect(plot.getByRole("button", { name: "Back to the standard view" })).toBeVisible();
  // the zoom in (distance 3 is the standard view) is saved with the turn
  await expect.poll(distance).toBeLessThan(3);
});
