// Linked Excel data (dataLinks): the worksheet follows the file while automatic updates
// are on, stops when they are turned off, and ⟳ Update reads it on demand.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("Excel data updates automatically, and the toolbar turns that off", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "quire-data-"));
  const csv = join(dir, "t.csv");
  writeFileSync(csv, "a;b\n1;2\n");
  const bundle = join(dir, "doc.quire");
  mkdirSync(bundle);
  writeFileSync(
    join(bundle, "document.json"),
    JSON.stringify({
      format: "quire/1",
      dataLinks: { "t.csv": { path: csv, auto: true } },
      data: { "t.csv": { Sheet1: [["a", "b"], [1, 2]] } },
      regions: [
        { id: "a", kind: "math", at: [40, 40], expr: 'T := importData("t.csv", "Sheet1", "A2:B2")' },
        { id: "b", kind: "math", at: [40, 80], expr: "x := T[1, 2]", show: "value" },
      ],
    }),
  );
  const x = page.locator(".region").nth(1);
  await page.goto(`/?open=${encodeURIComponent(bundle)}`);
  await expect(x).toContainText(/=\s*2$/);

  // the file changes: the worksheet follows within a few seconds
  writeFileSync(csv, "a;b\n1;5\n");
  await expect(x).toContainText(/=\s*5$/, { timeout: 10_000 });

  // turned off: a change is not read
  await page.getByRole("button", { name: /Auto ✓/ }).click();
  await expect(page.getByRole("button", { name: /Auto ✗/ })).toBeVisible();
  writeFileSync(csv, "a;b\n1;9\n");
  await page.waitForTimeout(4500);
  await expect(x).toContainText(/=\s*5$/);

  // ⟳ Update reads it now
  await page.getByRole("button", { name: /Update/ }).click();
  await expect(x).toContainText(/=\s*9$/, { timeout: 10_000 });
});
