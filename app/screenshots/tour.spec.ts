// The README's tour: each picture is a real document opened in the app, so the pictures
// follow the app as it changes. Run `npm run screenshots` and commit docs/images.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const images = join(root, "docs/images");
const work = mkdtempSync(join(tmpdir(), "quire-tour-"));
mkdirSync(images, { recursive: true });

/** A document from the repository as a bundle named like its title, which the window shows. */
function bundle(name: string, documentJson: string): string {
  const dir = join(work, `${name}.quire`);
  mkdirSync(dir, { recursive: true });
  cpSync(documentJson, join(dir, "document.json"));
  return dir;
}

const docs = {
  beam: bundle("Simply supported beam", join(root, "crates/quire-service/templates/beam.json")),
  combinations: bundle("Load combinations", join(root, "crates/quire-service/templates/combinations.json")),
  projectile: bundle("Projectile motion", join(root, "docs/examples/projectile.quire/document.json")),
  calculus: bundle("Calculus", join(root, "docs/examples/calculus.quire/document.json")),
};

/** Wait until results, plots and fonts are drawn, with nothing selected or moving. */
async function settled(page: Page) {
  await expect(page.locator(".region.math").first()).toBeVisible();
  await expect(page.locator(".toolbar .errors")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 799);
  await page.waitForTimeout(800);
}

async function shoot(page: Page, name: string, scheme: "light" | "dark" = "light") {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(images, `${name}${scheme === "dark" ? "-dark" : ""}.png`) });
}

/** Open a document, one zoom step out so a page's plot fits beside its maths, and scroll down by `scroll` pixels. */
async function open(page: Page, path: string, scroll = 0) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?open=${encodeURIComponent(path)}`);
  await settled(page);
  await page.keyboard.press("Meta+-");
  if (scroll) {
    await page.mouse.move(640, 500);
    await page.mouse.wheel(0, scroll);
  }
  await settled(page);
}

test("hero: a calculation report with a table, a plot and checks", async ({ page }) => {
  await open(page, docs.beam);
  await shoot(page, "hero");
  await shoot(page, "hero", "dark");
});

test("units: a physics problem with units on every result", async ({ page }) => {
  await open(page, docs.projectile, 110);
  await shoot(page, "units");
});

test("symbolic: calculus worked out with →", async ({ page }) => {
  await open(page, docs.calculus);
  await shoot(page, "symbolic");
});

test("tables: spreadsheet tables in the document", async ({ page }) => {
  await open(page, docs.combinations);
  await shoot(page, "tables");
});

test("notebooks: a course's notes in sections", async ({ page }) => {
  const book = join(work, "Physics 101");
  cpSync(docs.projectile, join(book, "Mechanics", "Projectile motion.quire"), { recursive: true });
  cpSync(docs.calculus, join(book, "Maths review", "Calculus.quire"), { recursive: true });
  cpSync(docs.beam, join(book, "Statics", "Beams.quire"), { recursive: true });
  mkdirSync(join(book, "Lab reports"), { recursive: true });
  writeFileSync(
    join(book, ".quire-notebook.json"),
    JSON.stringify({
      order: { "": ["Mechanics", "Statics", "Maths review", "Lab reports"] },
      style: { Mechanics: { color: "#3e63dd" }, Statics: { color: "#f76b15" }, "Maths review": { color: "#30a46c" } },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?notebook=${encodeURIComponent(book)}`);
  await expect(page.getByRole("navigation", { name: "Notebook" })).toBeVisible();
  for (const section of ["Mechanics", "Statics", "Maths review"]) {
    const row = page.getByRole("treeitem", { name: `${section}, section` });
    if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
  }
  await page.getByRole("treeitem", { name: "Projectile motion" }).click();
  await settled(page);
  await shoot(page, "notebooks");
});
