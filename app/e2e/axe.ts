// axe for the end-to-end tests: serious and critical problems, measured on a settled page.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Fail on serious and critical problems; list them all so one run shows everything. */
export async function audit(page: Page, state: string, include?: string) {
  // measure a settled page: fonts in and two frames painted (CI's Linux WebKit is slower)
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  // a problem must still be there a moment later: right after a document opens, CI's Linux
  // WebKit has been seen to report text colours mid-update (black on the dark toolbar) that
  // its own screenshots show correctly
  let bad: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await page.waitForTimeout(300);
    const axe = new AxeBuilder({ page });
    const { violations } = await (include ? axe.include(include) : axe).analyze();
    bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    if (!bad.length) break;
  }
  const report = bad.map(
    (v) =>
      `${state}: ${v.id} (${v.impact}) ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")}  ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n")}`,
  );
  expect(report, report.join("\n")).toEqual([]);
}
