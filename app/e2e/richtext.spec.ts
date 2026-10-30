// End to end: editing text regions writes back exactly what wasn't changed.
import { expect, type Page, test } from "@playwright/test";

/** A blank document with a text region holding this Djot, pasted as another Quire window would. */
async function withText(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(700, 250);
  const clip = { quire: 1, regions: [{ id: "t1", kind: "text", at: [0, 0], text }] };
  const b64 = Buffer.from(JSON.stringify(clip)).toString("base64");
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(e);
  }, `<div data-quire-clip="${b64}"><p>text</p></div>`);
  await expect(page.locator(".region.text")).toHaveCount(1);
}

/** Start editing the text region: a click selects it, a second one edits it at that word. */
async function edit(page: Page, word: string) {
  const at = page.locator(".region.text").getByText(word).first();
  await at.click();
  await at.click();
  await expect(page.locator(".rich-editor")).toBeFocused();
}

/** The Djot of the only region, as a copy puts it on the clipboard. */
async function storedText(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+a");
  return page.evaluate(() => {
    const e = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(e);
    return JSON.parse(e.clipboardData!.getData("application/x-quire-regions")).regions[0].text;
  });
}

const SOURCE = [
  "See [the docs](https://example.com/a) and `x := 2`.",
  "#### Small print",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "* one\n* two",
].join("\n\n");

test("typing in a text region with a link keeps the link and everything else", async ({ page }) => {
  await withText(page, SOURCE);
  await edit(page, "Small print");
  const editor = page.locator(".rich-editor");
  // the table can't be edited in place: it is shown as it renders, and kept
  await expect(editor.locator(".djot-kept table")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await page.keyboard.type("Please ");
  await page.keyboard.press("Escape");
  await expect(page.locator(".rich-editor")).toHaveCount(0);
  // only the paragraph typed in is written anew; the heading, table and list are as they were
  expect(await storedText(page)).toBe(`Please ${SOURCE}`);
});

test("the format bar edits and removes a link", async ({ page }) => {
  await withText(page, "See [the docs](https://example.com/a).");
  await edit(page, "the docs");
  await page.locator(".rich-editor a").click();
  await page.getByRole("button", { name: "Edit link" }).click();
  const address = page.getByRole("textbox", { name: "Link address" });
  await expect(address).toHaveValue("https://example.com/a");
  await address.fill("quire.example/docs");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rich-editor a")).toHaveAttribute("href", "https://quire.example/docs");
  await page.getByRole("button", { name: "Edit link" }).click();
  await page.getByRole("button", { name: "Remove link" }).click();
  await expect(page.locator(".rich-editor a")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(await storedText(page)).toBe("See the docs.");
});
