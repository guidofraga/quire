import { describe, expect, it } from "vitest";
import { pdfLinks, pdfMeta, pdfOutline } from "./export";
import { pageGeom } from "./pages";
import { computeLayout } from "./store";
import type { Doc, Region } from "./types";

const text = (id: string, y: number, t: string): Region => ({ id, kind: "text", at: [0, y], text: t });
const doc = (regions: Region[], extra: Partial<Doc> = {}): Doc => ({ format: "quire/1", regions, ...extra });

describe("pdfMeta", () => {
  it("takes the details from the document", () => {
    const d = doc([], {
      meta: { title: { en: "Deck check", pt: "Verificação" }, lang: "pt-BR", authors: ["A. Engineer", "B. Checker"], company: "Acme", keywords: ["steel", "bridge"] },
      page: { pageNumber: { start: 3 } },
    });
    expect(pdfMeta(d, "file")).toEqual({
      title: "Verificação",
      author: "A. Engineer, B. Checker",
      subject: "",
      keywords: "steel, bridge",
      company: "Acme",
      lang: "pt-BR",
      firstPage: 3,
    });
  });

  it("falls back to the file name and page 1", () => {
    const m = pdfMeta(doc([]), "beam");
    expect(m.title).toBe("beam");
    expect(m.author).toBe("");
    expect(m.firstPage).toBe(1);
  });
});

describe("pdfOutline", () => {
  const regions = [
    text("t", 0, "{.title}\n# Report"),
    text("h1", 36, "# Loads"),
    text("p", 72, "Plain text, not a heading."),
    text("h11", 108, "## Dead *load*"),
    text("h2", 2000, "# Checks"),
  ];
  const l = computeLayout(doc(regions, { page: { paper: "A4" } }), {}, true, true);
  const g = pageGeom(doc([]));

  it("lists numbered headings with their level, page and place in points", () => {
    const html = { h11: "<h2>Dead <em>load</em></h2>" };
    const out = pdfOutline(l.list, html, true);
    expect(out.map((h) => [h.title, h.level, h.page])).toEqual([
      ["1 Loads", 1, 0],
      ["1.1 Dead load", 2, 0],
      ["2 Checks", 1, 2],
    ]);
    // 6 px above the region, in points
    expect(out[0].top).toBeCloseTo((g.margins.top + 36 - 6) * 0.75);
  });

  it("leaves numbers out when headings are not numbered", () => {
    expect(pdfOutline(l.list, {}, false).map((h) => h.title)).toEqual(["Loads", "Dead *load*", "Checks"]);
  });

  it("skips headings inside collapsed areas", () => {
    const area: Region = { id: "a", kind: "area", at: [0, 300], height: 200, collapsed: true, regions: [text("hid", 20, "# Hidden")] };
    const hidden = computeLayout(doc([text("h1", 0, "# Shown"), area]), {}, true, true);
    expect(pdfOutline(hidden.list, {}, true).map((h) => h.title)).toEqual(["1 Shown"]);
  });
});

describe("pdfLinks", () => {
  const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height }) as DOMRect;

  it("measures contents rows on each sheet in points, whatever the zoom", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="sheet" data-page="1"><div class="contents-row" data-ref="h1"></div><a class="xref" data-ref="h1" href="#ref:h1"></a></div>
      <div class="sheet" data-page="2"><div class="contents-row" data-ref="f1"></div></div>`;
    const [s1, s2] = root.querySelectorAll<HTMLElement>(".sheet");
    // shown at 50 %: a 800 px wide paper takes 400 screen pixels
    s1.getBoundingClientRect = rect(100, 50, 400, 566);
    s2.getBoundingClientRect = rect(100, 650, 400, 566);
    (s1.firstElementChild as HTMLElement).getBoundingClientRect = rect(130, 110, 300, 10);
    (s2.firstElementChild as HTMLElement).getBoundingClientRect = rect(100, 650, 200, 8);
    expect(pdfLinks(800, root)).toEqual([
      { page: 0, left: 45, top: 90, width: 450, height: 15, to: "h1" },
      { page: 1, left: 0, top: 0, width: 300, height: 12, to: "f1" },
    ]);
  });
});
