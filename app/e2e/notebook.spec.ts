// Notebooks: a folder of sections and notes in the sidebar, saved as you write.
// Each test works in a fresh folder and checks what lands on disk, not only the screen.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quire-nb-e2e-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const doc = (rel: string) => readFileSync(join(dir, rel, "document.json"), "utf8");
const row = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name });

async function openBook(page: Page) {
  await page.goto(`/?notebook=${encodeURIComponent(dir)}`);
  await expect(page.getByRole("navigation", { name: "Notebook" })).toBeVisible();
}

/** Type a name into the rename field that a new note or section opens with. */
async function name(page: Page, text: string) {
  const field = page.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await field.fill(text);
  await field.press("Enter");
}

test("an empty folder becomes a notebook with a first note, named as you type", async ({ page }) => {
  await openBook(page);
  await name(page, "Kinematics");
  await expect(row(page, "Kinematics")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".note-title")).toContainText("Kinematics");
  await expect.poll(() => existsSync(join(dir, "Kinematics.quire"))).toBe(true);
  expect(existsSync(join(dir, "Untitled.quire"))).toBe(false);
});

test("what you write is saved by itself, without Edited", async ({ page }) => {
  await openBook(page);
  await name(page, "Forces");
  await page.mouse.click(900, 300);
  await page.keyboard.type("F:=12 kN");
  await page.keyboard.press("Escape");
  await expect(page.locator(".region.math")).toHaveCount(1);
  await expect(page.locator(".edited")).toHaveCount(0);
  await expect.poll(() => doc("Forces.quire"), { timeout: 5000 }).toMatch(/F ?:= ?12 ?'?kN/);
  // the file name is the document's title, for headers and PDFs
  expect(JSON.parse(doc("Forces.quire")).meta.title).toBe("Forces");
});

test("sections hold notes; dragging a note into one moves its file", async ({ page }) => {
  await openBook(page);
  await name(page, "Newton");
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Mechanics");
  await expect(row(page, "Mechanics, section")).toBeVisible();
  await expect.poll(() => existsSync(join(dir, "Mechanics"))).toBe(true);

  await row(page, "Newton").dragTo(row(page, "Mechanics, section"));
  await expect.poll(() => existsSync(join(dir, "Mechanics", "Newton.quire"))).toBe(true);
  expect(existsSync(join(dir, "Newton.quire"))).toBe(false);
  // the open note follows its file
  await expect(page.locator(".note-title")).toContainText("Mechanics");
  await expect(page.locator(".note-title")).toContainText("Newton");
  await expect(row(page, "Newton")).toHaveAttribute("aria-level", "2");
});

test("a note made in a section goes into it, and switching notes switches the page", async ({ page }) => {
  await openBook(page);
  await name(page, "Syllabus");
  await page.mouse.click(900, 300);
  await page.keyboard.type("Problem sets are due on Fridays ");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Thermo");
  await page.getByRole("button", { name: "New note in Thermo" }).click({ force: true });
  await name(page, "Ideal gas");
  await expect.poll(() => existsSync(join(dir, "Thermo", "Ideal gas.quire"))).toBe(true);
  await expect(page.locator(".region")).toHaveCount(0);
  await row(page, "Syllabus").click();
  await expect(page.locator(".region").first()).toContainText("Problem sets are due on Fridays");
});

test("search finds a note by its content, ignoring accents, and opens it", async ({ page }) => {
  await openBook(page);
  await name(page, "Cálculo");
  await page.mouse.click(900, 300);
  await page.keyboard.type("The bending moment of a beam ");
  await page.keyboard.press("Escape");
  await page.locator(".nb-new").click();
  await name(page, "Other");
  await expect(page.locator(".region")).toHaveCount(0);

  const search = page.getByRole("searchbox", { name: "Search notes" });
  await search.fill("bending");
  const hit = page.getByRole("option", { name: /Cálculo/ });
  await expect(hit).toContainText("bending moment");
  await hit.click();
  await expect(page.locator(".note-title")).toContainText("Cálculo");
  await search.fill("calculo");
  await expect(page.getByRole("option", { name: /Cálculo/ })).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("tree")).toBeVisible();
});

test("clicking the title renames the note and its file", async ({ page }) => {
  await openBook(page);
  await name(page, "Draft");
  await page.locator(".crumb-note").click();
  await name(page, "Lab 1 — Pendulum");
  await expect(row(page, "Lab 1 — Pendulum")).toBeVisible();
  await expect.poll(() => existsSync(join(dir, "Lab 1 — Pendulum.quire"))).toBe(true);
  expect(existsSync(join(dir, "Draft.quire"))).toBe(false);
});

test("the tree works from the keyboard", async ({ page }) => {
  await openBook(page);
  await name(page, "A");
  await page.locator(".nb-new").click();
  await name(page, "B");
  await row(page, "B").focus();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "A")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(page, "A")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("F2");
  await name(page, "Alpha");
  await expect.poll(() => existsSync(join(dir, "Alpha.quire"))).toBe(true);
});

test("keys on a focused note stay in the tree and leave the page alone", async ({ page }) => {
  await openBook(page);
  await name(page, "A");
  await page.mouse.click(900, 300);
  await page.keyboard.type("x:=1");
  await page.keyboard.press("Escape");
  const region = page.locator(".region.math");
  await expect(region).toHaveCount(1);
  if (!(await region.evaluate((el) => el.classList.contains("selected")))) await region.click();
  await expect(region).toHaveClass(/selected/);
  // where the region sits on screen, to the pixel (results arriving shift it by fractions)
  const at = async () => {
    const box = (await region.boundingBox())!;
    return [Math.round(box.x), Math.round(box.y)];
  };
  const before = await at();

  await row(page, "A").focus();
  // keys the tree has no use for on a top-level note (⌘⌫ and Delete trash it)
  for (const key of ["ArrowRight", "ArrowLeft", "Backspace"]) {
    await page.keyboard.press(key);
    await expect(row(page, "A")).toBeFocused();
    await expect(region).toHaveCount(1);
    await expect(region).toHaveClass(/selected/);
    expect(await at(), key).toEqual(before);
  }

  // Tab leaves the tree instead of stepping through the page's regions
  await page.keyboard.press("Tab");
  await expect(row(page, "A")).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest("[role=tree]"))).toBe(false);
  await expect(region).toHaveClass(/selected/);

  // back on the page, the same keys act on the selection as before
  await page.mouse.click(900, 500);
  await page.keyboard.press("Tab");
  await expect(region).toHaveClass(/selected/);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await at())[0]).toBeGreaterThan(before[0]);
  await page.keyboard.press("Backspace");
  await expect(region).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const)
  test(`the sidebar passes axe in ${scheme}`, async ({ page }) => {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openBook(page);
    await name(page, "Kinematics");
    await page.getByRole("button", { name: "New section" }).click();
    await name(page, "Mechanics");
    await row(page, "Mechanics, section").click({ button: "right" });
    await page.getByRole("menuitemcheckbox", { name: "Blue" }).click();
    const audit = async (state: string) => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const { violations } = await new AxeBuilder({ page }).include(".sidebar").include(".toolbar").analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    };
    await audit("tree");
    await page.getByRole("searchbox", { name: "Search notes" }).fill("kin");
    await expect(page.getByRole("option", { name: /Kinematics/ })).toBeVisible();
    await audit("search results");
  });
