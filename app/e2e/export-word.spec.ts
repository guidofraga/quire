// File ▸ Export as Word…, against `quire serve`: a browser downloads the file the engine wrote,
// with the page's plots drawn into it as pictures.
import { expect, type Page, test } from "@playwright/test";
import { exportWord, pngSize } from "./docx";

async function beam(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Simply supported beam/ }).click();
  await expect(page.locator('[data-region="bmdnwh"]')).toContainText(/123\.11\s*kN/);
}

test("Export as Word downloads the report with its math as equations and its plots as pictures", async ({ page }) => {
  await beam(page);
  const { name, files } = await exportWord(page);
  // Linux WebKit saves downloads with underscores for spaces
  expect(name.replace(/_/g, " ")).toBe("Simply supported beam.docx");
  const body = files.get("word/document.xml")!.toString("utf8");
  // the design moment, as an equation with its result in kN·m
  expect(body).toContain("<m:oMath>");
  expect(body).toMatch(/>M<\/m:t>.*?>Ed<\/m:t>.*?>123\.11<\/m:t>.*?>kN<\/m:t>/);
  // the loads table repeats its header row on each page, and is captioned "Table 1"
  expect(body).toContain("<w:tblHeader/>");
  expect(body).toContain("SEQ Table");
  // both plots, drawn by the page at print resolution (310 px wide on the page)
  const pictures = [...files.keys()].filter((k) => k.startsWith("word/media/"));
  expect(pictures).toHaveLength(2);
  for (const p of pictures) expect(pngSize(files.get(p)!)[0]).toBeGreaterThanOrEqual(900);
  expect(body.match(/<w:drawing>/g)).toHaveLength(2);
  // the footer's page numbers are Word fields
  const footer = [...files.entries()].find(([k]) => k.startsWith("word/footer"))![1].toString("utf8");
  expect(footer).toContain(" PAGE ");
  expect(footer).toContain(" NUMPAGES ");
  await expect(page.getByRole("status")).toContainText("Downloaded Simply supported beam.docx");
});

test("a 3D plot goes into the Word file as the picture the page draws", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Blank document/ }).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Insert 3D Plot");
  await page.keyboard.press("Enter");
  await expect(page.locator(".region.plot3d canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  const { files } = await exportWord(page);
  const pictures = [...files.keys()].filter((k) => k.startsWith("word/media/"));
  expect(pictures).toHaveLength(1);
  const [w, h] = pngSize(files.get(pictures[0])!);
  expect(w).toBeGreaterThan(400);
  expect(h).toBeGreaterThan(300);
});
