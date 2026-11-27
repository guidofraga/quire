// End to end: programs (#165 phase 3a, #175). If-chains are drawn as `if … else if … else` for
// everyone; with Settings ▸ Editing ▸ Edit math in place on, programs are typed in place (Enter
// adds a line, `else if ` adds a branch), ⌥← ⌥→ jump by words, and a screen reader hears where
// the caret goes. The keys: docs/07-math-editing.md § Programs.
import { expect, type Page, test } from "@playwright/test";

const inPlace = (page: Page) =>
  page.addInitScript(() => {
    const prefs = JSON.parse(localStorage.getItem("quire.prefs") ?? "{}");
    localStorage.setItem("quire.prefs", JSON.stringify({ ...prefs, mathInPlace: true }));
  });

async function blank(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.mouse.click(400, 260);
}

const editing = (page: Page) => page.locator(".region.math.editing");
const formula = (page: Page) => editing(page).locator(".math-line > .m");
const caret = (page: Page) => page.locator(".mip-caret");
const said = (page: Page) => page.locator('[role="status"][aria-live="polite"]');

/** What the document stores for each math region, in order. */
const stored = (page: Page) =>
  page.evaluate(() => {
    const q = (window as unknown as { __quire: { state: { doc: { regions: { kind: string; expr?: string }[] } } } })
      .__quire;
    return q.state.doc.regions.filter((r) => r.kind === "math").map((r) => r.expr ?? "");
  });

/** Type text one key at a time, as a person does. */
async function typeKeys(page: Page, text: string) {
  for (const ch of text) await page.keyboard.type(ch);
}

/** ⌥ on a Mac, Ctrl elsewhere: the word-jump modifier. */
const wordKey = (page: Page) =>
  page.evaluate(() => (/Mac/.test(navigator.userAgent) ? "Alt" : "Control")) as Promise<"Alt" | "Control">;

test.describe("edited in place", () => {
  test.beforeEach(({ page }) => inPlace(page));

  test("Structures ▸ if / else if / else, filled in: the grade example, stored as nested if", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "grade(x):=");
    await page.getByRole("button", { name: /Structures/ }).click();
    await page.locator('.gallery-tile[title^="if / else if / else"]').click();
    // drawn on rows straight away, the caret in the first condition
    await expect(formula(page).locator("mtext.kw")).toHaveText(["if", "else if", "else"]);
    await typeKeys(page, "x>=90");
    await page.keyboard.press("Tab");
    await typeKeys(page, '"A"');
    await page.keyboard.press("Tab");
    await typeKeys(page, "x>=80");
    await page.keyboard.press("Tab");
    await typeKeys(page, '"B"');
    await page.keyboard.press("Tab");
    await typeKeys(page, '"C"');
    expect((await stored(page))[0]).toBe('grade(x) := if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))');
    // Enter adds a line to the else; Enter on that empty line takes it away and ends the edit
    await page.keyboard.press("Enter");
    await expect(formula(page).locator(".q-program")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(editing(page)).toHaveCount(0);
    expect((await stored(page))[0]).toBe('grade(x) := if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))');
    await typeKeys(page, "grade(85)=");
    await page.keyboard.press("Escape");
    const result = page.locator(".region.math").nth(1).locator(".res");
    await expect(result).toContainText("B");
    // the definition, as the view draws it: on rows
    await expect(page.locator(".region.math").first().locator("mtext.kw")).toHaveText(["if", "else if", "else"]);
  });

  test("typing else if at the start of the else adds a branch", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "y:=if(x>0,1,-1)");
    // a single if with plain values stays on one line
    await expect(formula(page).locator(".q-stack")).toHaveCount(0);
    await page.keyboard.press("Home");
    // y, ≔, then the condition x>0, the value 1, the else -1: to the else's start
    for (let k = 0; k < 9; k++) await page.keyboard.press("ArrowRight");
    await typeKeys(page, "else if ");
    await expect(formula(page).locator("mtext.kw")).toHaveText(["if", "else if", "else"]);
    expect((await stored(page))[0]).toBe("y := if(x > 0, 1, if(?, ?, -1))");
    await typeKeys(page, "x<0");
    await page.keyboard.press("ArrowDown");
    await typeKeys(page, "0");
    expect((await stored(page))[0]).toBe("y := if(x > 0, 1, if(x < 0, 0, -1))");
    // emptied, the branch goes with one more Backspace, with nothing stray left in the text
    for (let k = 0; k < 5; k++) await page.keyboard.press("Backspace");
    expect((await stored(page))[0]).toBe("y := if(x > 0, 1, if(?, ?, -1))");
    await page.keyboard.press("Backspace");
    expect((await stored(page))[0]).toBe("y := if(x > 0, 1, -1)");
    await page.keyboard.press("Escape");
  });

  test("Enter adds a line in a block; Enter on the empty last line ends the edit", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "t:=\\block ");
    await expect(formula(page).locator(".q-program > mtr")).toHaveCount(2);
    await typeKeys(page, "a:=2");
    await page.keyboard.press("Enter");
    await expect(formula(page).locator(".q-program > mtr")).toHaveCount(3);
    await typeKeys(page, "b:=a+1");
    await page.keyboard.press("ArrowDown");
    await typeKeys(page, "a*b");
    expect((await stored(page))[0]).toBe("t := block(a := 2, b := a + 1, a*b)");
    await page.keyboard.press("Enter");
    await expect(formula(page).locator(".q-program > mtr")).toHaveCount(4);
    await page.keyboard.press("Enter");
    // the edit ended: the next region is typed under it
    await typeKeys(page, "t=");
    await page.keyboard.press("Escape");
    expect(await stored(page)).toEqual(["t := block(a := 2, b := a + 1, a*b)", "t"]);
    await expect(page.locator(".region.math").nth(1).locator(".res")).toContainText("6");
  });

  test("⌥→ and ⌥← jump by whole names, numbers and structures", async ({ page }) => {
    await blank(page);
    const mod = await wordKey(page);
    await typeKeys(page, "M:=q*L^2/8+x.net ");
    await page.keyboard.press("Home");
    await page.keyboard.press(`${mod}+ArrowRight`);
    const afterName = (await caret(page).boundingBox())!;
    await page.keyboard.press(`${mod}+ArrowRight`);
    // over ≔ and the whole fraction, at once
    const afterFraction = (await caret(page).boundingBox())!;
    const frac = (await formula(page).locator("mfrac").boundingBox())!;
    expect(afterFraction.x).toBeGreaterThan(afterName.x);
    expect(Math.abs(afterFraction.x + afterFraction.width / 2 - (frac.x + frac.width))).toBeLessThan(4);
    await typeKeys(page, "+1");
    expect((await stored(page))[0]).toBe("M := q*L^2/8 + 1 + x.net");
    // with Shift they select: the name with its subscript, typed over
    await page.keyboard.press("End");
    await page.keyboard.press(`Shift+${mod}+ArrowLeft`);
    await typeKeys(page, "y");
    expect((await stored(page))[0]).toBe("M := q*L^2/8 + 1 + y");
    await page.keyboard.press("Escape");
  });

  test("a screen reader hears where the caret goes and what was deleted", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "a/");
    await expect(said(page)).toContainText("in the denominator of a over blank");
    await typeKeys(page, "b");
    await page.keyboard.press("ArrowUp");
    await expect(said(page)).toContainText("in the numerator of a over b");
    await page.keyboard.press("End");
    await expect(said(page)).toContainText("on the main line");
    await page.keyboard.press("Backspace");
    await expect(said(page)).toContainText("deleted b");
    await page.keyboard.press("Backspace");
    await expect(said(page)).toContainText("removed the fraction");
    await page.keyboard.press("Escape");
  });

  test("a for loop built in place, line by line", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "n:=4");
    await page.keyboard.press("Enter");
    await typeKeys(page, "total:=\\block ");
    await typeKeys(page, "s:=0");
    await page.keyboard.press("ArrowDown");
    await typeKeys(page, "\\for ");
    await typeKeys(page, "i");
    await page.keyboard.press("Tab");
    await typeKeys(page, "1..n");
    await page.keyboard.press("Tab");
    await typeKeys(page, "s:=s+i");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    // out of the loop's body: a new line in the block, after the loop
    await typeKeys(page, "s");
    expect((await stored(page))[1]).toBe("total := block(s := 0, for(i, 1..n, s := s + i), s)");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await typeKeys(page, "total=");
    await page.keyboard.press("Escape");
    await expect(page.locator(".region.math").nth(2).locator(".res")).toContainText("10");
  });

  test("a line with an error ends its edit without moving", async ({ page }) => {
    await blank(page);
    await typeKeys(page, "z:=w+1=kN");
    await expect(formula(page).locator(".res .ph")).toHaveCount(1);
    const during = (await formula(page).locator("math").boundingBox())!;
    await page.keyboard.press("Escape");
    await expect(editing(page)).toHaveCount(0);
    const math = page.locator(".region.math").first().locator(".math-line > .m math");
    expect(await math.boundingBox()).toEqual(during);
    await expect(page.locator(".region.math").first().locator(".err")).toBeVisible();
  });
});

test("with the setting off, an if-chain is drawn as rows, and a single if on one line", async ({ page }) => {
  await blank(page);
  await typeKeys(page, "g(x):=if(x>0,1,if(x<0,-1,0))");
  await page.keyboard.press("Enter");
  await typeKeys(page, "s(x):=if(x>0,1,-1)");
  await page.keyboard.press("Escape");
  const chain = page.locator(".region.math").first();
  await expect(chain.locator(".q-stack")).toHaveCount(1);
  await expect(chain.locator("mtext.kw")).toHaveText(["if", "else if", "else"]);
  const single = page.locator(".region.math").nth(1);
  await expect(single.locator(".q-stack")).toHaveCount(0);
  await expect(single.locator("mtext.kw")).toHaveCount(0);
  expect(await stored(page)).toEqual(["g(x):=if(x>0,1,if(x<0,-1,0))", "s(x):=if(x>0,1,-1)"]);
});
