// Organising a notebook in the sidebar: dragging, selecting several items, moving, deleting
// and the keyboard. Each test works in a fresh folder and checks what lands on disk.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quire-nb-org-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const on = (...parts: string[]) => existsSync(join(dir, ...parts));

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
  await expect(field).toHaveCount(0);
}

/** A section with notes, made in the sidebar as a user would. */
async function section(page: Page, title: string, notes: string[]) {
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, title);
  for (const n of notes) {
    await page.getByRole("button", { name: `New note in ${title}` }).click({ force: true });
    await name(page, n);
  }
}

/** Drag `from` over `to`, letting go `fy` of the way down it (0 top, 1 bottom). */
async function drag(page: Page, from: Locator, to: Locator, fy = 0.5, dx = 0) {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2 + 8, { steps: 2 });
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + 40 + dx, b.y + b.height * fy, { steps: 6 });
  await page.mouse.up();
}

/** The names in the tree as shown, indented by level: ["Mechanics", "  Newton"]. */
async function shown(page: Page) {
  return page
    .getByRole("tree")
    .locator(".nb-row")
    .evaluateAll((rows) =>
      rows.map(
        (r) => " ".repeat(2 * (Number(r.getAttribute("aria-level")) - 1)) + r.querySelector(".nb-name")!.textContent,
      ),
    );
}

/** The system's Trash, stubbed as the other notebook tests do (the real one hangs here). */
async function stubTrash(page: Page) {
  await page.route("**/api/notebook", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.op !== "trash") return route.continue();
    rmSync(join(dir, body.args.rel), { recursive: true, force: true });
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
}

/** A notebook made on disk, then opened: Intro, and Mechanics holding Newton, Euler, Hooke. */
async function physics(page: Page) {
  await openBook(page);
  await name(page, "Intro");
  await section(page, "Mechanics", ["Newton", "Euler", "Hooke"]);
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Euler", "  Hooke", "  Newton"]);
}

for (const scheme of ["light", "dark"] as const)
  test(`a selection, Move to… and the Trash question pass axe in ${scheme}`, async ({ page }) => {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await physics(page);
    const audit = async (what: string, where: string) => {
      const { violations } = await new AxeBuilder({ page }).include(where).analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${what}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    };
    await row(page, "Euler").click();
    await row(page, "Newton").click({ modifiers: ["Shift"] });
    await audit("selection", ".sidebar");
    await row(page, "Newton").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move 3 Items to…" }).click();
    await expect(page.getByRole("dialog", { name: "Move 3 items to…" })).toBeVisible();
    await audit("move to", ".nb-move");
    await page.keyboard.press("Escape");
    await row(page, "Newton").focus();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await audit("trash", ".nb-dialog");
    await page.keyboard.press("Escape");
  });

test("a note dropped on a new, empty section goes into it, not out of its own section", async ({ page }) => {
  await openBook(page);
  await name(page, "Intro");
  await section(page, "Mechanics", ["Newton", "Euler"]);
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Optics");
  await expect(row(page, "Add a note to Optics")).toBeVisible();

  await row(page, "Newton").dragTo(row(page, "Add a note to Optics"));
  await expect.poll(() => on("Optics", "Newton.quire")).toBe(true);
  expect(on("Newton.quire"), "never to the notebook's top level").toBe(false);
  expect(on("Mechanics", "Euler.quire")).toBe(true);
});

test("dragging between rows reorders, at the line drawn where the note will land", async ({ page }) => {
  await physics(page);
  const a = (await row(page, "Newton").boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  const b = (await row(page, "Euler").boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + b.height * 0.2, { steps: 6 });
  // a line above Euler, at Euler's level, while the pointer is down
  const line = page.locator(".nb-drop-line");
  // (it glides from row to row, so it is measured once it settles)
  await expect.poll(async () => Math.abs((await line.boundingBox())!.y + 1 - b.y)).toBeLessThan(3);
  expect((await line.boundingBox())!.x).toBeGreaterThan(b.x + 16);
  await expect(row(page, "Newton")).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Newton", "  Euler", "  Hooke"]);
  // the order is the notebook's, not the screen's: it is there after reopening
  await page.reload();
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Newton", "  Euler", "  Hooke"]);
  expect(on("Mechanics", "Newton.quire")).toBe(true);
});

test("a section dragged into another takes its notes; it can't go into itself", async ({ page }) => {
  await physics(page);
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Physics");
  await drag(page, row(page, "Mechanics, section"), row(page, "Physics, section"));
  await expect.poll(() => on("Physics", "Mechanics", "Hooke.quire")).toBe(true);
  expect(on("Mechanics")).toBe(false);
  await expect(row(page, "Mechanics, section")).toHaveAttribute("aria-level", "2");
  await expect(row(page, "Newton")).toHaveAttribute("aria-level", "3");

  // into itself or what is inside it: nothing moves
  await drag(page, row(page, "Physics, section"), row(page, "Euler"), 0.2);
  await drag(page, row(page, "Physics, section"), row(page, "Mechanics, section"));
  await page.waitForTimeout(300);
  expect(on("Physics", "Mechanics", "Euler.quire")).toBe(true);
  await expect(row(page, "Physics, section")).toHaveAttribute("aria-level", "1");
});

test("several notes picked with ⌘/Ctrl and Shift move together, keeping their order", async ({ page }) => {
  await physics(page);
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Optics");
  await row(page, "Euler").click();
  await row(page, "Newton").click({ modifiers: ["Shift"] });
  await row(page, "Intro").click({ modifiers: ["ControlOrMeta"] });
  for (const n of ["Euler", "Hooke", "Newton", "Intro"])
    await expect(row(page, n)).toHaveAttribute("aria-selected", "true");
  await row(page, "Hooke").click({ modifiers: ["ControlOrMeta"] });
  await expect(row(page, "Hooke")).toHaveAttribute("aria-selected", "false");

  await drag(page, row(page, "Newton"), row(page, "Optics, section"));
  await expect(page.locator(".nb-undo")).toContainText("Moved 3 items to Optics");
  await expect.poll(() => shown(page)).toEqual(["Mechanics", "  Hooke", "Optics", "  Intro", "  Euler", "  Newton"]);
  expect(on("Optics", "Intro.quire") && on("Optics", "Euler.quire") && on("Optics", "Newton.quire")).toBe(true);

  // and back where they were, with Undo
  await page.locator(".nb-undo").getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Euler", "  Hooke", "  Newton", "Optics"]);
  expect(on("Intro.quire") && on("Mechanics", "Euler.quire") && on("Mechanics", "Newton.quire")).toBe(true);
});

test("Esc cancels a drag, and a section held under the pointer opens", async ({ page }) => {
  await physics(page);
  await row(page, "Mechanics, section").click();
  await expect(row(page, "Mechanics, section")).toHaveAttribute("aria-expanded", "false");
  const a = (await row(page, "Intro").boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  const b = (await row(page, "Mechanics, section").boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 6 });
  await expect(row(page, "Mechanics, section")).toHaveClass(/drop-inside/);
  await expect(row(page, "Mechanics, section")).toHaveAttribute("aria-expanded", "true", { timeout: 2000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".nb-ghost")).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(on("Intro.quire")).toBe(true);
});

test("Delete asks first, names what goes, and the open note moves on to its neighbour", async ({ page }) => {
  await physics(page);
  await stubTrash(page);
  await row(page, "Hooke").click();
  await row(page, "Newton").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Delete");
  const ask = page.getByRole("alertdialog", { name: "Move 2 items to the Trash?" });
  await expect(ask).toContainText("Hooke");
  await expect(ask).toContainText("Newton");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(on("Mechanics", "Hooke.quire")).toBe(true);

  await row(page, "Newton").click();
  await row(page, "Hooke").click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Backspace");
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect.poll(() => on("Mechanics", "Newton.quire") || on("Mechanics", "Hooke.quire")).toBe(false);
  await expect(row(page, "Euler")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".note-title")).toContainText("Euler");

  // a section says what it holds
  await row(page, "Mechanics, section").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Move “Mechanics” to the Trash?" })).toContainText(
    "The note in it goes too",
  );
  await page.keyboard.press("Enter");
  await expect.poll(() => on("Mechanics")).toBe(false);
  await expect(page.locator(".note-title")).toContainText("Intro");
});

test("the keyboard moves through the tree, picks a range, renames and reorders", async ({ page }) => {
  await physics(page);
  await row(page, "Intro").click();
  // a click opens the note; the tree keeps the place for the keyboard
  await row(page, "Intro").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Mechanics, section")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Mechanics, section")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Mechanics, section")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Euler")).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(row(page, "Euler")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "Hooke")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(row(page, "Euler")).toHaveAttribute("aria-selected", "false");
  await expect(row(page, "Hooke")).toBeFocused();
  // ⌥↑ moves it up one place
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Hooke", "  Euler", "  Newton"]);
  await page.keyboard.press("F2");
  await name(page, "Hooke's law");
  await expect.poll(() => on("Mechanics", "Hooke's law.quire")).toBe(true);
  await expect.poll(() => shown(page)).toEqual(["Intro", "Mechanics", "  Hooke's law", "  Euler", "  Newton"]);
});

test("Move to… picks a section from a list, and New Section with N Items gathers them", async ({ page }) => {
  await physics(page);
  await page.getByRole("button", { name: "New section" }).click();
  await name(page, "Optics");
  await row(page, "Newton").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const picker = page.getByRole("dialog", { name: "Move “Newton” to…" });
  await expect(picker.getByRole("option", { name: /Mechanics/ })).toContainText("Here now");
  await page.keyboard.type("opt");
  await page.keyboard.press("Enter");
  await expect.poll(() => on("Optics", "Newton.quire")).toBe(true);
  // a section isn't offered as a place inside itself
  await row(page, "Mechanics, section").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByRole("option")).toHaveText([/quire-nb-org/, /Optics/]);
  await page.keyboard.press("Escape");

  await row(page, "Euler").click();
  await row(page, "Hooke").click({ modifiers: ["Shift"] });
  await row(page, "Hooke").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New Section with 2 Items" }).click();
  await name(page, "Classical");
  await expect
    .poll(() => on("Mechanics", "Classical", "Euler.quire") && on("Mechanics", "Classical", "Hooke.quire"))
    .toBe(true);
  await expect
    .poll(() => shown(page))
    .toEqual(["Intro", "Mechanics", "  Classical", "    Euler", "    Hooke", "Optics", "  Newton"]);
});
