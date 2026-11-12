// The document the report-polish tests open: one of each gap found while building the templates.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

const LONG_NOTE =
  "A long explanation of where this value comes from, which would run off the paper if it stayed on the formula's line, " +
  "so it wraps under the formula instead and keeps within the page.";

const regions = [
  { id: "re", kind: "math", at: [0, 0], expr: "Re:=152180", show: "value", display: { decimals: 0 } },
  {
    id: "wide",
    kind: "math",
    at: [0, 60],
    expr: "M.Rd:=(210*500*(450-0.5*210*500/(0.85*30*300)))/1.15+(210*500*(450-0.5*210*500/(0.85*30*300)))/1.15",
    note: LONG_NOTE,
    notePosition: "below",
  },
  {
    id: "beside",
    kind: "math",
    at: [0, 280],
    expr: "k:=1",
    note: "short note",
  },
  {
    id: "plot",
    kind: "plot2d",
    at: [0, 400],
    size: [310, 210],
    series: [
      { y: "x", range: "0..7", label: "line" },
      { y: "P", label: "point" },
    ],
    axes: { x: { label: "x" }, y: { label: "y" } },
    grid: true,
  },
  { id: "p", kind: "math", at: [0, 330], expr: 'P:=[3, 4, ".", 20, "Red"]' },
  {
    id: "plot3",
    kind: "plot3d",
    at: [340, 400],
    size: [310, 210],
    series: [{ surface: "x*y", xrange: "0..2", yrange: "0..1" }],
    axes: { x: { label: "span" }, y: { label: "width" }, z: { label: "load" } },
  },
  { id: "text", kind: "text", at: [0, 720], text: "Issued {date}, page {page} of {pages}: {title}" },
  { id: "s", kind: "math", at: [0, 780], expr: "s:=3" },
  {
    id: "table",
    kind: "table",
    at: [0, 840],
    rows: [
      ["Check", "Result", "Issued"],
      ["a", '=if(s>2,"OK","FAIL")', "{date}"],
      ["b", '=if(s<2,"OK","FAIL")', "{title}"],
    ],
  },
];

let dir = "";
/** Delete the document of the last `openDoc`. */
export function closeDoc() {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
}

export async function openDoc(page: Page) {
  dir = mkdtempSync(join(tmpdir(), "quire-polish-e2e-"));
  const doc = join(dir, "report.quire");
  mkdirSync(doc);
  await page.setViewportSize({ width: 1280, height: 1500 });
  writeFileSync(
    join(doc, "document.json"),
    JSON.stringify({
      format: "quire/1",
      meta: { title: "Beam report" },
      page: { view: "pages" },
      regions,
    }),
  );
  await page.goto(`/?open=${encodeURIComponent(doc)}`);
  await expect(page.locator('[data-region="table"]')).toBeVisible();
}
