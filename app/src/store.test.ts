import { beforeEach, describe, expect, it } from "vitest";
import { pageGeom, SHEET_GAP } from "./pages";
import {
  AREA_COLLAPSED_HEIGHT,
  availableWidth,
  normalizeOrigin,
  originShift,
  pullOnPaper,
  commitEditing,
  computeLayout,
  deleteRegions,
  insertAtCaret,
  insertRegion,
  layout,
  loadDoc,
  localized,
  markSaved,
  moveTo,
  placeAt,
  mutate,
  noteRoom,
  keptPages,
  removeBlankPage,
  PAGE_BREAK_HEIGHT,
  atPageTop,
  insertPageBreak,
  pullToPreviousPage,
  nudge,
  onCommitEditing,
  originsOf,
  redo,
  regroup,
  releaseErrors,
  sectionOn,
  setDocTitle,
  setState,
  setLive,
  showReport,
  pushBelow,
  scheduleGrowth,
  setHeights,
  setWidths,
  settleRegions,
  startEditing,
  state,
  togglePageView,
  undo,
  undoDepth,
  updateRegion,
  withLocalized,
} from "./store";
import type { Doc, Region, RegionView, Report } from "./types";

const doc = (regions: Region[], page?: Doc["page"]): Doc => ({
  format: "quire/1",
  meta: { title: "T" },
  regions,
  page,
});
const text = (id: string, y: number, t: string): Region => ({ id, kind: "text", at: [0, y], text: t });
const math = (id: string, y: number, expr: string): Region => ({ id, kind: "math", at: [0, y], expr });

describe("undo and redo", () => {
  beforeEach(() => loadDoc(doc([math("a", 0, "x := 1")]), null));

  it("undoes and redoes a change", () => {
    updateRegion("a", { expr: "x := 2" });
    expect(state.doc.regions[0].expr).toBe("x := 2");
    expect(state.dirty).toBe(true);
    undo();
    expect(state.doc.regions[0].expr).toBe("x := 1");
    redo();
    expect(state.doc.regions[0].expr).toBe("x := 2");
  });

  it("forgets the redo branch after a new change", () => {
    updateRegion("a", { expr: "x := 2" });
    undo();
    updateRegion("a", { expr: "x := 3" });
    redo();
    expect(state.doc.regions[0].expr).toBe("x := 3");
  });

  it("switches views without an edit or an undo step", () => {
    togglePageView();
    expect(state.doc.page?.view).toBe("pages");
    expect(state.dirty).toBe(false);
    updateRegion("a", { expr: "x := 2" });
    undo();
    // undoing an edit doesn't switch the view back
    expect(state.doc.page?.view).toBe("pages");
    expect(state.doc.regions[0].expr).toBe("x := 1");
  });

  it("does nothing with an empty history", () => {
    undo();
    redo();
    expect(state.doc.regions[0].expr).toBe("x := 1");
  });

  it("keeps changes made without history out of it", () => {
    mutate((d) => d.regions.push(math("b", 40, "y := 2")));
    mutate((d) => (d.regions[0].note = "silent"), false);
    undo();
    expect(state.doc.regions.map((r) => r.id)).toEqual(["a"]);
  });

  it("starts a fresh history with each document", () => {
    updateRegion("a", { expr: "x := 2" });
    loadDoc(doc([math("z", 0, "z := 0")]), null);
    undo();
    expect(state.doc.regions[0].id).toBe("z");
    expect(state.dirty).toBe(false);
  });

  it("skips steps that changed nothing", () => {
    updateRegion("a", { expr: "x := 2" });
    mutate(() => {});
    mutate(() => {});
    expect(undoDepth().steps).toBe(2);
    undo();
    expect(state.doc.regions[0].expr).toBe("x := 1");
  });

  it("keeps 300 steps of a short document", () => {
    for (let i = 0; i < 350; i++) updateRegion("a", { expr: `x := ${i}` });
    expect(undoDepth().steps).toBe(300);
    for (let i = 0; i < 300; i++) undo();
    expect(state.doc.regions[0].expr).toBe("x := 49");
  });

  it("keeps fewer steps of a long document, but at least 20", () => {
    const long = "y".repeat(500_000);
    loadDoc(doc([math("a", 0, "x := 1"), { id: "big", kind: "text", at: [0, 40], text: long }]), null);
    for (let i = 0; i < 40; i++) updateRegion("a", { expr: `x := ${i}` });
    const { steps, chars } = undoDepth();
    // 40 steps of ~0.5 M characters is over the budget: it keeps what fits
    expect(steps).toBeGreaterThanOrEqual(20);
    expect(steps).toBeLessThan(40);
    expect(chars).toBeLessThanOrEqual(20_000_000);
    for (let i = 0; i < steps; i++) undo();
    expect(state.doc.regions[0].expr).toBe(`x := ${39 - steps}`);
  });

  it("never keeps fewer than 20 steps", () => {
    loadDoc(doc([math("a", 0, "x := 1"), { id: "big", kind: "text", at: [0, 40], text: "y".repeat(2_000_000) }]), null);
    for (let i = 0; i < 30; i++) updateRegion("a", { expr: `x := ${i}` });
    expect(undoDepth().steps).toBe(20);
  });

  it("removes properties set to nothing", () => {
    updateRegion("a", { note: "check" });
    updateRegion("a", { note: "" });
    expect("note" in state.doc.regions[0]).toBe(false);
  });
});

describe("localized", () => {
  it("picks the document language, else the first", () => {
    expect(localized("plain")).toBe("plain");
    expect(localized({ en: "Load", pt: "Carga" }, "pt-BR")).toBe("Carga");
    expect(localized({ en: "Load", pt: "Carga" }, "de")).toBe("Load");
    expect(localized(undefined)).toBe("");
    expect(localized({})).toBe("");
  });

  it("edits the translation that is shown, keeping the others", () => {
    // an SMath worksheet: Russian first, English too, no document language; English is shown
    const ruEn = { ru: "Нагрузка", en: "Load" };
    expect(localized(ruEn)).toBe("Load");
    expect(withLocalized(ruEn, "Loads")).toEqual({ ru: "Нагрузка", en: "Loads" });
    expect(withLocalized(ruEn, "Нагрузки", "ru-RU")).toEqual({ ru: "Нагрузки", en: "Load" });
    expect(withLocalized({ ru: "Нагрузка", de: "Last" }, "x")).toEqual({ ru: "x", de: "Last" });
    expect(withLocalized("Load", "Loads", "ru")).toBe("Loads");
    expect(withLocalized(undefined, "Loads")).toBe("Loads");
  });

  it("typing into text in several languages changes the one on the page", () => {
    loadDoc(doc([{ id: "t", kind: "text", at: [0, 0], text: { ru: "Нагрузка", en: "Load" } }]), null);
    setLive("t", "Loads");
    expect(state.doc.regions[0].text).toEqual({ ru: "Нагрузка", en: "Loads" });
    expect(localized(state.doc.regions[0].text)).toBe("Loads");
  });
});

describe("the document title", () => {
  it("an edit changes the translation that is shown and keeps the others", () => {
    const d = doc([]);
    d.meta = { title: { ru: "Расчёт", en: "Calculation" } };
    loadDoc(d, null);
    setDocTitle("Beam calculation");
    expect(state.doc.meta?.title).toEqual({ ru: "Расчёт", en: "Beam calculation" });
    undo();
    expect(state.doc.meta?.title).toEqual({ ru: "Расчёт", en: "Calculation" });
  });

  it("a plain title stays a plain string, and an empty one is removed", () => {
    loadDoc(doc([]), null);
    setDocTitle("Beam");
    expect(state.doc.meta?.title).toBe("Beam");
    setDocTitle("");
    expect(state.doc.meta).not.toHaveProperty("title");
  });
});

describe("saving", () => {
  beforeEach(() => loadDoc(doc([math("a", 0, "x := 1")]), null));

  it("a save marks the document clean", () => {
    updateRegion("a", { expr: "x := 2" });
    markSaved(state.rev);
    expect(state.dirty).toBe(false);
  });

  it("an edit made while saving keeps the document Edited", () => {
    updateRegion("a", { expr: "x := 2" });
    const rev = state.rev; // the save starts
    updateRegion("a", { expr: "x := 3" }); // typed before it finished
    markSaved(rev);
    expect(state.dirty).toBe(true);
  });
});

describe("ending an edit", () => {
  it("lets an editor put what is half typed into the document first", () => {
    loadDoc(doc([math("a", 0, "x := 1")]), null);
    let pending: string | null = null;
    onCommitEditing(() => {
      if (pending !== null && state.editing === "a") updateRegion("a", { expr: pending });
      pending = null;
    });
    startEditing("a");
    pending = "x := 42";
    commitEditing();
    expect(state.editing).toBe(null);
    expect(state.doc.regions[0].expr).toBe("x := 42");
  });
});

describe("opening another document", () => {
  const view = (id: string, error: string | null): RegionView => ({
    id,
    input: null,
    result: null,
    resultText: null,
    error,
    syntaxError: false,
    units: [],
    constants: [],
    shadowing: [],
    defines: null,
  });
  const report = (...regions: RegionView[]): Report => ({
    regions,
    html: {},
    elapsedMs: 0,
    errorCount: regions.filter((v) => v.error).length,
    documentErrors: [],
    warnings: [],
    glossary: {},
  });

  it("never shows the last document's results or held-back errors", () => {
    loadDoc(doc([math("a", 0, "x := 1")]), null);
    startEditing("a");
    setLive("a", "x := y");
    // the error on the line being typed waits for a pause
    showReport(report(view("a", "y is not defined")));
    expect(state.views.a.error).toBe(null);

    loadDoc(doc([math("b", 0, "z := 2")]), null);
    expect(state.report).toBe(null);
    // the pause or the end of the edit comes after the switch: nothing of the old note shows
    releaseErrors();
    expect(state.report).toBe(null);
    expect(state.views).toEqual({});

    // and the new document's own errors are not held back as if still typing
    showReport(report(view("b", "z is wrong")));
    expect(state.views.b.error).toBe("z is wrong");
  });
});

describe("computeLayout numbering", () => {
  const regions: Region[] = [
    text("t", 0, "{.title}\n# Report"),
    text("h1", 30, "# Loads"),
    text("h11", 60, "## Dead load"),
    text("h12", 90, "## Live load"),
    { id: "f1", kind: "image", at: [0, 120], caption: { text: "Beam" } },
    { id: "tb1", kind: "table", at: [0, 150], caption: { text: "Loads" } },
    text("h2", 180, "# Checks"),
    text("h21", 210, "## Bending"),
    { id: "f2", kind: "plot", at: [0, 240], caption: { text: "Moment" } },
    { id: "img", kind: "image", at: [0, 270] },
  ];
  const n = (id: string) => computeLayout(doc(regions), {}, false, false).byId.get(id)?.number;

  it("numbers headings by level, restarting below", () => {
    expect([n("h1"), n("h11"), n("h12"), n("h2"), n("h21")]).toEqual(["1", "1.1", "1.2", "2", "2.1"]);
  });

  it("does not number the title", () => {
    expect(n("t")).toBeUndefined();
  });

  it("numbers figures and tables separately, only when captioned", () => {
    expect([n("f1"), n("f2"), n("tb1"), n("img")]).toEqual(["1", "2", "1", undefined]);
  });

  it("orders by position, not by storage order", () => {
    const l = computeLayout(doc([text("b", 100, "# Second"), text("a", 10, "# First")]), {}, false, false);
    expect(l.list.map((p) => [p.region.id, p.number])).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });
});

describe("computeLayout pages", () => {
  const H = pageGeom(doc([])).contentH;

  it("keeps a region whole by starting it on the next page", () => {
    const l = computeLayout(
      doc([math("a", 0, "1"), math("b", H - 10, "2"), math("c", H + 40, "3")]),
      { b: 30 },
      true,
      false,
    );
    const b = l.byId.get("b")!;
    expect(b.page).toBe(1);
    expect(b.top).toBeCloseTo(l.geom.margins.top);
    // what follows moves down with it
    expect(l.byId.get("c")!.top).toBeCloseTo(l.geom.margins.top + 50);
    expect(l.contentPages).toBe(2);
  });

  it("gives {section} the first-level heading a page is in", () => {
    const l = computeLayout(
      doc([
        text("t", 0, "{.title}\n# Report"),
        text("h1", 40, "# Loads"),
        text("h11", 80, "## Dead load"),
        math("a", H + 20, "1"),
        text("h2", H * 2 + 20, "{#checks}\n# Checks {.x}"),
      ]),
      {},
      true,
      false,
    );
    expect([0, 1, 2].map((k) => sectionOn(l, k))).toEqual(["Loads", "Loads", "Checks"]);
    expect(sectionOn(computeLayout(doc([math("a", 0, "1")]), {}, true, false), 0)).toBe("");
  });

  it("adds blank pages on request, but never prints them", () => {
    const d = doc([math("a", 0, "1")]);
    expect(computeLayout(d, {}, true, false, 3).pages).toBe(3);
    expect(computeLayout(d, {}, true, true, 3).pages).toBe(1);
  });

  it("maps document points to the scene and back", () => {
    const l = computeLayout(doc([math("a", 0, "1"), math("b", H * 2 + 50, "2")]), {}, true, false);
    for (const [x, y] of [
      [10, 5],
      [40, H + 100],
      [0, H * 2 + 50],
    ] as [number, number][]) {
      const [sx, sy] = l.toScene(x, y);
      const [dx, dy] = l.fromScene(sx, sy);
      expect(dx).toBeCloseTo(x);
      expect(dy).toBeCloseTo(y);
    }
  });

  const pagebreak = (id: string, y: number): Region => ({ id, kind: "pagebreak", at: [0, y] });

  it("starts what follows a page break on the next page, keeping its distance from the break", () => {
    const l = computeLayout(doc([math("a", 0, "1"), pagebreak("br", 100), math("b", 136, "2")]), {}, true, false);
    expect(l.byId.get("br")!.page).toBe(0);
    const b = l.byId.get("b")!;
    expect(b.page).toBe(1);
    expect(b.top).toBeCloseTo(l.geom.margins.top + 136 - (100 + PAGE_BREAK_HEIGHT));
    expect(l.contentPages).toBe(2);
    // the insertion point below the break is on the new page too
    expect(l.toScene(0, 100 + PAGE_BREAK_HEIGHT)[1]).toBeCloseTo(l.geom.paperH + SHEET_GAP + l.geom.margins.top);
  });

  it("shows the page a final page break starts, but doesn't print it", () => {
    const d = doc([math("a", 0, "1"), pagebreak("br", 100)]);
    expect(computeLayout(d, {}, true, false).pages).toBe(2);
    expect(computeLayout(d, {}, true, true).pages).toBe(1);
  });

  it("moves a heading to the next page with the region after it", () => {
    const l = computeLayout(
      doc([math("a", 0, "1"), text("h", H - 60, "## Loads"), math("b", H - 20, "2")]),
      { h: 30, b: 30 },
      true,
      false,
    );
    expect(l.byId.get("a")!.page).toBe(0);
    for (const id of ["h", "b"]) expect(l.byId.get(id)!.page).toBe(1);
    expect(l.byId.get("h")!.top).toBeCloseTo(l.geom.margins.top);
    expect(l.byId.get("b")!.top).toBeCloseTo(l.geom.margins.top + 40);
    // the insertion point between them is on the new page too
    expect(l.toScene(0, H - 25)[1]).toBeGreaterThan(l.geom.paperH);
  });

  it("moves only the heading, not what is before it", () => {
    const l = computeLayout(
      doc([text("p", H - 100, "Intro"), text("h", H - 60, "# Loads"), math("b", H - 20, "2")]),
      { p: 30, h: 30, b: 30 },
      true,
      false,
    );
    expect(l.byId.get("p")!.page).toBe(0);
    expect(l.byId.get("h")!.page).toBe(1);
  });

  it("leaves a heading where it is when the region after it fits", () => {
    const l = computeLayout(
      doc([text("h", H - 100, "# Loads"), math("b", H - 60, "2"), math("c", H + 40, "3")]),
      { h: 30, b: 30 },
      true,
      false,
    );
    expect(["h", "b", "c"].map((id) => l.byId.get(id)!.page)).toEqual([0, 0, 1]);
    expect(l.byId.get("h")!.top).toBeCloseTo(l.geom.margins.top + H - 100);
  });

  it("moves what is below a collapsed area up and hides its content", () => {
    const area: Region = {
      id: "ar",
      kind: "area",
      at: [0, 100],
      height: 200,
      collapsed: true,
      regions: [math("in", 20, "x")],
    };
    const l = computeLayout(doc([area, math("below", 400, "y")]), {}, false, false);
    expect(l.byId.get("in")!.hidden).toBe(true);
    expect(l.byId.get("below")!.top).toBe(400 - (200 - AREA_COLLAPSED_HEIGHT));
  });
});

describe("pulling content back at the top of a page", () => {
  const H = pageGeom(doc([])).contentH;
  const at = (id: string) => state.doc.regions.find((r) => r.id === id)!.at;
  beforeEach(() => {
    loadDoc(doc([math("a", 0, "1"), math("b", H + 200, "2"), math("c", H + 260, "3")], { view: "pages" }), null);
  });

  it("knows the top of a page from the rest of it", () => {
    expect(atPageTop(H + 100)).toBe(true);
    expect(atPageTop(H + 200)).toBe(true);
    expect(atPageTop(H + 230)).toBe(false);
    // the first page has nothing to go back to
    expect(atPageTop(0)).toBe(false);
  });

  it("brings what starts the page back onto the previous one, in one undo step", () => {
    setState({ caret: [0, H + 100], selection: [] });
    expect(pullToPreviousPage(H + 100)).toBe(true);
    // up to a grid step below what is above, keeping the spacing below it
    const top = at("b")[1];
    expect(top).toBeGreaterThanOrEqual(22 + 9);
    expect(top).toBeLessThan(22 + 18);
    expect(at("c")[1] - top).toBe(60);
    expect(layout().byId.get("b")!.page).toBe(0);
    expect(state.caret![1]).toBe(top);
    undo();
    expect(at("b")).toEqual([0, H + 200]);
    expect(at("c")).toEqual([0, H + 260]);
  });
});

describe("blank pages added with + New page", () => {
  const H = pageGeom(doc([])).contentH;
  const stride = () => layout().geom.paperH + SHEET_GAP;
  /** A document point on page k, below its top margin. */
  const on = (k: number) => layout().fromScene(100, k * stride() + layout().geom.margins.top + 50)[1];
  beforeEach(() => {
    loadDoc(doc([math("a", 0, "1"), math("b", H + 40, "2")], { view: "pages" }), null);
    setState({ pagesWanted: 4 });
  });

  it("keep only up to the one with the insertion point", () => {
    expect(layout().pages).toBe(4);
    expect(layout().needed).toBe(2);
    expect(keptPages(layout(), on(3))).toBe(4);
    expect(keptPages(layout(), on(2))).toBe(3);
    // on a page with content, or with no insertion point, the blank ones all go
    expect(keptPages(layout(), on(0))).toBe(0);
    expect(keptPages(layout(), null)).toBe(0);
  });

  it("go one at a time with Backspace, never a page with content", () => {
    expect(removeBlankPage(on(2))).toBe(false); // not the last
    expect(removeBlankPage(on(3))).toBe(true);
    expect(layout().pages).toBe(3);
    expect(removeBlankPage(on(2))).toBe(true);
    expect(layout().pages).toBe(2);
    // the insertion point after what ends the page before
    expect(layout().byId.get("b")!.page).toBe(1);
    expect(state.caret).toEqual([0, Math.ceil((H + 40 + 22) / 9) * 9 + 9]);
    expect(removeBlankPage(on(1))).toBe(false);
    expect(layout().pages).toBe(2);
    expect(state.dirty).toBe(false);
  });
});

describe("inserting a page break", () => {
  beforeEach(() => loadDoc(doc([math("a", 0, "1"), math("b", 36, "2")], { view: "pages" }), null));

  it("puts it at the insertion point, makes room, and starts the next page", () => {
    setState({ caret: [0, 27], selection: [] });
    insertPageBreak();
    const br = state.doc.regions.find((r) => r.kind === "pagebreak")!;
    expect(br.at).toEqual([0, 27]);
    // what was right under it moved down, clear of the mark
    expect(state.doc.regions.find((r) => r.id === "b")!.at[1]).toBeGreaterThanOrEqual(27 + PAGE_BREAK_HEIGHT);
    expect(layout().byId.get("b")!.page).toBe(1);
    expect(state.caret).toEqual([0, 27 + PAGE_BREAK_HEIGHT]);
    undo();
    expect(state.doc.regions.map((r) => r.id)).toEqual(["a", "b"]);
    expect(state.doc.regions[1].at).toEqual([0, 36]);
  });
});

describe("regroup: a moved region belongs where it lands", () => {
  const area = (extra: Partial<Region> = {}): Region => ({
    id: "ar",
    kind: "area",
    at: [0, 100],
    height: 200,
    regions: [math("in", 20, "x")],
    ...extra,
  });
  const parentOf = (id: string) => state.doc.regions.find((r) => r.regions?.some((c) => c.id === id))?.id ?? null;

  it("leaves the area when dragged below it, keeping its place on the page", () => {
    loadDoc(doc([area()]), null);
    moveTo(originsOf(["in"]), 0, 250); // from 120 to 370, past the area's bottom at 300
    regroup(["in"]);
    expect(parentOf("in")).toBe(null);
    expect(state.doc.regions.find((r) => r.id === "in")!.at).toEqual([0, 370]);
  });

  it("joins an open area when dropped in its band, at the same place on the page", () => {
    loadDoc(doc([area(), math("out", 400, "y")]), null);
    moveTo(originsOf(["out"]), 36, -250); // to (36, 150), inside the band 100…300
    regroup(["out"]);
    expect(parentOf("out")).toBe("ar");
    expect(state.doc.regions[0].regions!.find((r) => r.id === "out")!.at).toEqual([36, 50]);
  });

  it("stays put when moved within its area, and takes the innermost of nested areas", () => {
    const inner: Region = { id: "inner", kind: "area", at: [0, 100], height: 60, regions: [] };
    loadDoc(doc([area({ regions: [math("in", 20, "x"), inner] })]), null);
    nudge(["in"], 0, 18);
    expect(parentOf("in")).toBe("ar");
    nudge(["in"], 0, 80); // to 218 on the page, inside the inner area's band 200…260
    expect(state.doc.regions[0].regions!.find((r) => r.id === "inner")!.regions!.map((r) => r.id)).toEqual(["in"]);
  });

  it("puts a region typed or inserted in an area's band into the area, as one undo step", () => {
    loadDoc(doc([area(), math("out", 400, "y")]), null);
    setState({ caret: [36, 180] });
    insertAtCaret("math", "z");
    const typed = state.editing!;
    commitEditing();
    expect(parentOf(typed)).toBe("ar");
    expect(state.doc.regions[0].regions!.find((r) => r.id === typed)!.at).toEqual([36, 80]);
    setState({ caret: [36, 500] });
    insertAtCaret("math", "w");
    const below = state.editing!;
    commitEditing();
    expect(parentOf(below)).toBe(null);
    const plot = insertRegion({ kind: "plot2d", at: [36, 260] });
    expect(parentOf(plot)).toBe("ar");
    undo();
    expect(JSON.stringify(state.doc).includes(`"${plot}"`)).toBe(false);
  });

  it("never drops a region into a collapsed area, and undoes as one step with the move", () => {
    loadDoc(doc([area({ collapsed: true }), math("out", 400, "y")]), null);
    nudge(["out"], 0, -295); // onto the collapsed area's place
    expect(state.doc.regions.map((r) => r.id)).toEqual(["ar", "out"]);
    loadDoc(doc([area()]), null);
    nudge(["in"], 0, 250);
    expect(parentOf("in")).toBe(null);
    undo();
    expect(parentOf("in")).toBe("ar");
    expect(state.doc.regions[0].regions![0].at).toEqual([0, 20]);
  });
});

describe("deleteRegions", () => {
  const area = (collapsed?: true): Region => ({
    id: "ar",
    kind: "area",
    at: [0, 100],
    height: 200,
    collapsed,
    regions: [math("in", 20, "x")],
  });

  it("deletes a collapsed area and its content, and keeps what is below where it was seen (#8)", () => {
    loadDoc(doc([math("above", 0, "a"), area(true), text("below", 400, "Conclusion"), math("end", 500, "b")]), null);
    const seen = computeLayout(state.doc, {}, false, false).byId.get("below")!.top;
    deleteRegions(["ar"]);
    expect(state.doc.regions.map((r) => r.id)).toEqual(["above", "below", "end"]);
    expect(state.doc.regions.map((r) => r.at[1])).toEqual([0, 200, 300]);
    // it moves up by the bar the collapsed area showed, not down by the band it hid
    expect(computeLayout(state.doc, {}, false, false).byId.get("below")!.top).toBe(seen - AREA_COLLAPSED_HEIGHT);
    undo();
    expect(state.doc.regions.map((r) => [r.id, r.at[1]])).toEqual([
      ["above", 0],
      ["ar", 100],
      ["below", 400],
      ["end", 500],
    ]);
  });

  it("closes an open area's band too, and leaves what is above or beside it", () => {
    loadDoc(doc([area(), { ...math("beside", 150, "c"), at: [400, 150] }, math("below", 300, "y")]), null);
    deleteRegions(["ar"]);
    expect(state.doc.regions.map((r) => [r.id, r.at[1]])).toEqual([
      ["beside", 150],
      ["below", 100],
    ]);
  });

  it("keeps a region dragged out of the area when the area goes", () => {
    loadDoc(doc([area(), math("below", 400, "y")]), null);
    moveTo(originsOf(["in"]), 0, 200);
    regroup(["in"]);
    deleteRegions(["ar"]);
    expect(state.doc.regions.map((r) => r.id).sort()).toEqual(["below", "in"]);
  });

  it("moves only the area's own level", () => {
    const outer: Region = {
      id: "out",
      kind: "area",
      at: [0, 0],
      height: 600,
      regions: [area(), math("inner", 350, "z")],
    };
    loadDoc(doc([outer, math("top", 700, "t")]), null);
    deleteRegions(["ar"]);
    const out = state.doc.regions[0];
    expect(out.regions!.map((r) => [r.id, r.at[1]])).toEqual([["inner", 150]]);
    expect(state.doc.regions[1].at[1]).toBe(700);
  });
});

describe("noteRoom", () => {
  const at = (id: string, x: number, y: number): Region => ({ id, kind: "math", at: [x, y], expr: "1" });
  const measured = { a: 40 };
  const l = computeLayout(
    doc([at("a", 0, 0), at("b", 300, 0), at("c", 200, 100), at("d", 500, 9)]),
    measured,
    false,
    false,
  );
  const room = (id: string) => noteRoom(l.byId.get(id)!, l.list, measured, 640);
  it("stops at the nearest region to the right on the same rows", () => {
    expect(room("a")).toBe(300 - 12);
    expect(room("b")).toBe(200 - 12);
  });
  it("has the printable width when nothing is beside it", () => {
    expect(room("c")).toBe(640);
  });
  it("never shrinks below a readable width", () => {
    const tight = computeLayout(doc([at("a", 0, 0), at("b", 40, 0)]), {}, false, false);
    expect(noteRoom(tight.byId.get("a")!, tight.list, {}, 640)).toBe(120);
  });
});

describe("settleRegions (imported SMath positions)", () => {
  const box = (id: string, x: number, y: number, extra: Partial<Region> = {}): Region => ({
    id,
    kind: "text",
    at: [x, y],
    text: "t",
    ...extra,
  });
  const area = (
    id: string,
    x: number,
    y: number,
    height: number,
    regions: Region[],
    extra: Partial<Region> = {},
  ): Region => ({
    id,
    kind: "area",
    at: [x, y],
    height,
    regions,
    ...extra,
  });
  const wide = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 100]));

  it("pushes an overlapping region below to the next grid line under the one above", () => {
    const regions = [box("r", 0, 0), box("q", 0, 20)];
    const changes = settleRegions(regions, { r: 40, q: 30 }, wide(["r", "q"]));
    // 40 px bottom → the grid line at 45, one grid step further: 54
    expect(changes.get("q")?.at).toEqual([0, 54]);
    expect(changes.has("r")).toBe(false);
  });

  it("leaves regions alone that do not share a column", () => {
    const regions = [box("r", 0, 0), box("q", 200, 20)];
    expect(settleRegions(regions, { r: 40, q: 30 }, wide(["r", "q"])).size).toBe(0);
  });

  it("cascades: a pushed region pushes what it now overlaps", () => {
    const regions = [box("r", 0, 0), box("q1", 0, 20), box("q2", 0, 50)];
    const changes = settleRegions(regions, { r: 40, q1: 30, q2: 20 }, wide(["r", "q1", "q2"]));
    expect(changes.get("q1")?.at).toEqual([0, 54]);
    expect(changes.get("q2")?.at).toEqual([0, 99]);
  });

  it("moves an area's height to hold its children, and what is below it", () => {
    const a = area("a", 0, 0, 90, [box("c", 0, 30)]);
    const below = box("b", 0, 120);
    const changes = settleRegions([a, below], { c: 100, b: 20 }, wide(["c", "b", "a"]));
    // children end at 130: the grid line under it is 135, plus one step of padding: 144
    expect(changes.get("a")?.height).toBe(144);
    // the area grew by 54: what was at 120 is now at 174
    expect(changes.get("b")?.at).toEqual([0, 174]);
  });

  it("settles a nested area first, then the area that holds it", () => {
    const inner = area("b", 0, 10, 50, [box("c", 0, 5, {})]);
    const d = box("d", 0, 60);
    const outer = area("a", 0, 0, 90, [inner, d]);
    const e = box("e", 0, 100);
    const changes = settleRegions([outer, e], { c: 80, d: 20, e: 20 }, wide(["c", "d", "e", "a", "b"]));
    expect(changes.get("b")?.height).toBe(99);
    // d moved down with the growth of b, then was pushed by b's new bottom
    expect(changes.get("d")?.at).toEqual([0, 126]);
    expect(changes.get("a")?.height).toBe(162);
    expect(changes.get("e")?.at).toEqual([0, 172]);
  });

  it("leaves a collapsed area's children and its height alone", () => {
    const a = area("a", 0, 0, 90, [box("c", 0, 30)], { collapsed: true });
    const changes = settleRegions([a], { c: 300 }, wide(["c"]));
    expect(changes.size).toBe(0);
  });

  it("does not move regions it has no measurement for, and moves what is below a pushed region with it", () => {
    const unmeasured = box("x", 0, 20);
    expect(settleRegions([box("r", 0, 0), unmeasured], { r: 40 }, wide(["r"])).size).toBe(0);

    const q = box("q", 0, 20);
    const below = box("x", 200, 60);
    const changes = settleRegions([box("r", 0, 0), q, below], { r: 40, q: 30 }, wide(["r", "q"]));
    expect(changes.get("q")?.at).toEqual([0, 54]);
    expect(changes.get("x")?.at).toEqual([200, 94]);
  });

  it("pushes only from the regions it is asked about", () => {
    const regions = [box("r", 0, 0), box("q", 0, 20)];
    expect(settleRegions(regions, { r: 40, q: 30 }, wide(["r", "q"]), new Set(["q"])).size).toBe(0);
    expect(settleRegions(regions, { r: 40, q: 30 }, wide(["r", "q"]), new Set(["r"])).get("q")?.at).toEqual([0, 54]);
  });

  it("does not change its input", () => {
    const regions = [box("r", 0, 0), box("q", 0, 20)];
    settleRegions(regions, { r: 40, q: 30 }, wide(["r", "q"]));
    expect(regions[1].at).toEqual([0, 20]);
  });
});

describe("placing at a point on the screen", () => {
  const geom = () => layout().geom;
  const stride = () => geom().paperH + SHEET_GAP;

  it("pulls a point outside the content area of a page into it", () => {
    loadDoc(doc([math("a", 0, "1")], { view: "pages" }), null);
    const { margins, contentW, contentH } = geom();
    const [x, y] = placeAt(margins.left + contentW + 300, margins.top + 40);
    expect(x).toBeLessThanOrEqual(contentW);
    expect(y).toBe(Math.round(40 / 9) * 9);
    expect(placeAt(-50, margins.top + 40)[0]).toBe(0);
    // under the content: above the bottom margin
    expect(placeAt(margins.left + 10, margins.top + contentH + 30)[1]).toBeLessThan(contentH);
  });

  it("puts a point in the grey between sheets on the nearer sheet", () => {
    loadDoc(doc([math("a", 0, "1"), math("b", pageGeom(doc([])).contentH + 40, "2")], { view: "pages" }), null);
    const { margins, paperH, contentH } = geom();
    const [, below] = placeAt(100, paperH + 4); // just under sheet 1: stays on it
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(contentH);
    const [, above] = placeAt(100, stride() - 4); // just above sheet 2: lands on it
    expect(above).toBeGreaterThanOrEqual(contentH);
    expect(layout().toScene(0, above)[1]).toBeGreaterThanOrEqual(stride() + margins.top);
  });

  it("leaves canvas view alone", () => {
    loadDoc(doc([math("a", 0, "1")], { view: "canvas" }), null);
    expect(placeAt(5000, 300)).toEqual([5004, 297]);
  });
});

describe("pushBelow (a region grew after an edit)", () => {
  const box = (id: string, x: number, y: number): Region => ({ id, kind: "math", at: [x, y], expr: id });
  const area = (id: string, y: number, height: number, regions: Region[]): Region => ({
    id,
    kind: "area",
    at: [0, y],
    height,
    regions,
  });
  const wide = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 100]));
  const grew = (id: string, from: number) => new Map([[id, from]]);

  it("pushes the line below to a grid step under the new bottom, and what follows keeps its spacing", () => {
    // r grew from 18 to 40 (an error line appeared under it); q was a grid step below it
    const regions = [box("r", 0, 0), box("q", 0, 27), box("s", 0, 90)];
    const changes = pushBelow(regions, { r: 40, q: 18, s: 18 }, wide(["r", "q", "s"]), grew("r", 18));
    // 40 px bottom → the grid line at 45, one grid step further: 54
    expect(changes.get("q")?.at).toEqual([0, 54]);
    expect(changes.get("s")?.at).toEqual([0, 117]);
    expect(changes.has("r")).toBe(false);
  });

  it("leaves what already has room, and never pulls up", () => {
    const regions = [box("r", 0, 0), box("q", 0, 90)];
    expect(pushBelow(regions, { r: 40, q: 18 }, wide(["r", "q"]), grew("r", 18)).size).toBe(0);
    // r shrank: q stays where the user put it
    expect(pushBelow(regions, { r: 18, q: 18 }, wide(["r", "q"]), grew("r", 40)).size).toBe(0);
  });

  it("leaves another column alone, beside the line that grew or beside the one pushed", () => {
    const regions = [box("r", 0, 0), box("side", 200, 0), box("q", 0, 27), box("next", 200, 27)];
    const heights = { r: 40, side: 18, q: 18, next: 18 };
    const changes = pushBelow(regions, heights, wide(["r", "side", "q", "next"]), grew("r", 18));
    expect(changes.get("q")?.at).toEqual([0, 54]);
    expect(changes.has("side")).toBe(false);
    expect(changes.has("next")).toBe(false);
  });

  it("leaves a region that starts beside the one that grew rather than below it", () => {
    const regions = [box("r", 0, 0), box("q", 50, 9)];
    expect(pushBelow(regions, { r: 40, q: 18 }, wide(["r", "q"]), grew("r", 18)).size).toBe(0);
  });

  it("grows an expanded area for a child that grew, and pushes what is below the area", () => {
    const a = area("a", 0, 54, [box("c", 0, 0), box("d", 0, 27)]);
    const changes = pushBelow([a, box("b", 0, 63)], { c: 30, d: 18, b: 18 }, wide(["a", "c", "d", "b"]), grew("c", 18));
    // c ends at 30 → 36 + 9: d moves to 45 and ends at 63, so the area needs 63 + 9 = 72
    expect(changes.get("d")?.at).toEqual([0, 45]);
    expect(changes.get("a")?.height).toBe(72);
    // the area now ends at 72: b goes to 81
    expect(changes.get("b")?.at).toEqual([0, 81]);
  });

  it("moves the insertion point under a line that grew", () => {
    const changes = pushBelow([box("r", 0, 0)], { r: 40 }, wide(["r"]), grew("r", 18), [0, 27]);
    expect([...changes.values()].map((c) => c.at)).toEqual([[0, 54]]);
  });

  it("does not change its input", () => {
    const regions = [box("r", 0, 0), box("q", 0, 27)];
    pushBelow(regions, { r: 40, q: 18 }, wide(["r", "q"]), grew("r", 18));
    expect(regions[1].at).toEqual([0, 27]);
  });
});

describe("growth after an edit", () => {
  const settle = async (h: Record<string, number>) => {
    for (const [id, v] of Object.entries(h)) setHeights(id, v);
    scheduleGrowth();
    await Promise.resolve();
  };
  beforeEach(async () => {
    loadDoc(doc([math("a", 0, "x := 1"), math("b", 27, "y := x")]), null);
    setWidths({ a: 100, b: 100 });
    await settle({ a: 18, b: 18 });
  });

  it("doesn't move a document that was only opened", async () => {
    // fonts or the first results arriving
    await settle({ a: 40 });
    expect(state.doc.regions[1].at).toEqual([0, 27]);
    expect(state.dirty).toBe(false);
  });

  it("pushes the line below as part of the edit's undo step", async () => {
    updateRegion("a", { expr: "x := 1 + zz" });
    // the error line under a appears with the next report
    await settle({ a: 40 });
    expect(state.doc.regions[1].at).toEqual([0, 54]);
    undo();
    expect(state.doc.regions[0].expr).toBe("x := 1");
    expect(state.doc.regions[1].at).toEqual([0, 27]);
  });
});

describe("the free canvas", () => {
  const at = (id: string, x: number, y: number): Region => ({ id, kind: "math", at: [x, y], expr: id });
  const contentW = pageGeom(doc([])).contentW;

  it("wraps text at the column's width from wherever the box starts", () => {
    loadDoc(doc([]), null);
    expect(availableWidth(0)).toBe(contentW);
    expect(availableWidth(558)).toBe(contentW);
    // the page view still wraps at the printable column's edge
    loadDoc(doc([], { view: "pages" }), null);
    expect(availableWidth(0)).toBe(contentW);
    expect(availableWidth(400)).toBeCloseTo(contentW - 400);
    expect(availableWidth(contentW - 120)).toBeCloseTo(120);
    // past that it is drawn pulled onto the paper, at the width it has on the canvas
    expect(availableWidth(600)).toBe(contentW);
  });

  it("puts the insertion point above and left of the start; the page keeps it on the paper", () => {
    loadDoc(doc([]), null);
    expect(placeAt(-50, -100)).toEqual([-54, -99]);
    loadDoc(doc([], { view: "pages" }), null);
    const [x, y] = placeAt(-50, -100);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it("shifts by the grid steps that bring the topmost and leftmost regions back to the start", () => {
    expect(originShift([])).toEqual([0, 0]);
    expect(originShift([at("a", 0, 0), at("b", 90, 30)])).toEqual([0, 0]);
    expect(originShift([at("a", -90, 18), at("b", 40, -18)])).toEqual([90, 18]);
    // off the grid (a smart guide): still whole grid steps, so the rest stays on the grid
    expect(originShift([at("a", -5, -10)])).toEqual([9, 18]);
  });

  it("moves regions above and left of the start, then shifts the document and the view back as one step", () => {
    loadDoc(doc([at("a", 0, 0), at("b", 90, 90)]), null);
    setState({ view: { x: 100, y: 50, zoom: 2 }, caret: [36, 180] });
    nudge(["b"], -180, -144);
    // b went to (-90, -54): everything moves right 90 and down 54, and the view the other way
    expect(state.doc.regions.map((r) => r.at)).toEqual([
      [90, 54],
      [0, 0],
    ]);
    expect(state.view).toEqual({ x: 100 - 90 * 2, y: 50 - 54 * 2, zoom: 2 });
    expect(state.caret).toEqual([126, 234]);
    // on screen nothing but b moved: a is drawn where it was
    const sx = (x: number) => state.view.x + x * state.view.zoom;
    expect(sx(layout().byId.get("a")!.left)).toBe(100);
    // undo and redo pan back with the document, so a stays put on screen through both
    undo();
    expect(state.doc.regions.map((r) => r.at)).toEqual([
      [0, 0],
      [90, 90],
    ]);
    expect(sx(layout().byId.get("a")!.left)).toBe(100);
    redo();
    expect(state.doc.regions[0].at).toEqual([90, 54]);
    expect(sx(layout().byId.get("a")!.left)).toBe(100);
  });

  it("joins the shift to the step of a line typed above the start", () => {
    loadDoc(doc([at("a", 0, 0)]), null);
    setState({ view: { x: 300, y: 300, zoom: 1 }, caret: [-90, -45] });
    insertAtCaret("math", "c:=3");
    commitEditing();
    expect(state.doc.regions.map((r) => r.at)).toEqual([
      [90, 45],
      [0, 0],
    ]);
    expect(state.view).toEqual({ x: 210, y: 255, zoom: 1 });
    undo();
    expect(state.doc.regions.map((r) => r.at)).toEqual([[0, 0]]);
    expect(state.view).toEqual({ x: 300, y: 300, zoom: 1 });
  });

  it("keeps a region in an area within the area's left edge, but lets it leave upwards", () => {
    const area: Region = { id: "ar", kind: "area", at: [0, 90], height: 90, regions: [at("in", 0, 18)] };
    loadDoc(doc([area]), null);
    moveTo(originsOf(["in"]), -45, 0);
    expect(state.doc.regions[0].regions![0].at).toEqual([0, 18]);
    moveTo(originsOf(["in"]), 0, -54);
    regroup(["in"]);
    expect(state.doc.regions.map((r) => r.id)).toEqual(["ar", "in"]);
    expect(state.doc.regions[1].at).toEqual([0, 54]);
  });

  it("does nothing to a document that starts at the origin", () => {
    loadDoc(doc([at("a", 0, 0)]), null);
    const view = { ...state.view };
    expect(normalizeOrigin()).toBe(false);
    expect(state.view).toEqual(view);
    expect(state.dirty).toBe(false);
  });
});

describe("page view keeps what is past the printable column on the paper", () => {
  const geom = pageGeom(doc([]));
  const { contentW } = geom;
  const right = geom.margins.right;

  it("leaves what fits on the paper where it is, margin overhang included", () => {
    expect(pullOnPaper(0, 200, contentW, right)).toBe(0);
    expect(pullOnPaper(400, contentW - 400 + right - 1, contentW, right)).toBe(400);
  });

  it("draws what runs off the paper, or starts past the column, with its right edge on the column's", () => {
    expect(pullOnPaper(800, 100, contentW, right)).toBe(contentW - 100);
    expect(pullOnPaper(contentW - 60, 40, contentW, right)).toBe(contentW - 60);
    expect(pullOnPaper(contentW - 100, 300, contentW, right)).toBe(contentW - 300);
    // wider than the column: from its left edge
    expect(pullOnPaper(300, contentW + 50, contentW, right)).toBe(0);
  });

  it("draws it pulled in without changing the document, and moves it from where it is seen", () => {
    const d = doc(
      [
        { id: "far", kind: "math", at: [900, 0], expr: "far" },
        { id: "near", kind: "math", at: [36, 0], expr: "near" },
      ],
      { view: "pages" },
    );
    const l = computeLayout(d, {}, true, false, 0, { far: 100, near: 100 });
    const far = l.byId.get("far")!;
    expect(far.left).toBeCloseTo(l.geom.margins.left + contentW - 100);
    expect(far.pulled).toBeCloseTo(900 - (contentW - 100));
    expect(l.byId.get("near")!.pulled).toBe(0);
    expect(d.regions[0].at).toEqual([900, 0]);
    // canvas view draws it where it is
    expect(computeLayout(d, {}, false, false, 0, { far: 100 }).byId.get("far")!.left).toBe(900);

    loadDoc(d, null);
    setWidths({ far: 100 });
    expect(state.doc.regions[0].at).toEqual([900, 0]);
    // a drag starts from the place it is drawn at, and only then writes it
    expect(originsOf(["far"]).get("far")![0]).toBeCloseTo(contentW - 100);
  });

  it("knows where each page starts, as the canvas's page guides draw it", () => {
    const H = geom.contentH;
    const pagebreak: Region = { id: "br", kind: "pagebreak", at: [0, 100] };
    const l = computeLayout(
      doc([at2("a", 0), at2("b", H - 10), at2("c", H * 2 + 40), pagebreak]),
      { b: 30 },
      true,
      false,
    );
    // a page break: page 2 starts right under its mark
    expect(l.pageStarts[0]).toBe(0);
    expect(l.pageStarts[1]).toBe(100 + PAGE_BREAK_HEIGHT);
    // b doesn't fit at the bottom of page 1, so page 2 starts at b, not at the page's height
    const plain = computeLayout(doc([at2("a", 0), at2("b", H - 10), at2("c", H + 40)]), { b: 30 }, true, false);
    expect(plain.pageStarts).toEqual([0, H - 10]);
    expect(computeLayout(doc([at2("a", 0)]), {}, false, false).pageStarts).toEqual([]);
  });
});

function at2(id: string, y: number): Region {
  return { id, kind: "math", at: [0, y], expr: id };
}

describe("computeLayout splits tall regions across pages", () => {
  const H = pageGeom(doc([])).contentH;
  const { margins } = pageGeom(doc([]));
  const table = (id: string, y: number): Region => ({ id, kind: "table", at: [0, y], rows: [], header: { row: true } });
  // a table of 25 px rows under a 30 px header: cuts below every row but the first
  const rows = (n: number) => Array.from({ length: n - 1 }, (_, i) => 30 + 25 * (i + 1));
  const cuts = (n: number) => ({ t: { at: rows(n), rows: rows(n).map((_, i) => i + 2), head: 30 } });

  it("fills a page with whole rows, and goes on under the header on the next", () => {
    const h = 30 + 25 * 80;
    const l = computeLayout(doc([table("t", 100), at2("after", 100 + h + 18)]), { t: h }, true, false, 0, {}, cuts(80));
    const parts = l.byId.get("t")!.parts!;
    expect(parts.length).toBe(3);
    // the first part ends at a row's bottom that fits on page 1
    expect(parts[0]).toMatchObject({ page: 0, from: 0 });
    expect(100 + parts[0].to).toBeLessThanOrEqual(H);
    expect(100 + parts[0].to + 25).toBeGreaterThan(H);
    // later parts start where the one before ended, at the top of their page
    expect(parts[1]).toMatchObject({ page: 1, from: parts[0].to });
    expect(parts[1].top).toBeCloseTo(margins.top);
    expect(30 + parts[1].to - parts[1].from).toBeLessThanOrEqual(H);
    expect(parts[2]).toMatchObject({ page: 2, from: parts[1].to, to: h });
    // what follows keeps its distance below the last part
    const after = l.byId.get("after")!;
    expect(after.page).toBe(2);
    expect(after.top).toBeCloseTo(margins.top + 30 + (h - parts[2].from) + 18);
    expect(l.contentPages).toBe(3);
  });

  it("moves a split region on when not even its first rows fit", () => {
    const h = 30 + 25 * 80;
    const l = computeLayout(doc([table("t", H - 40)]), { t: h }, true, false, 0, {}, cuts(80));
    const p = l.byId.get("t")!;
    expect(p.page).toBe(1);
    expect(p.parts![0]).toMatchObject({ page: 1, from: 0 });
    expect(p.parts![0].top).toBeCloseTo(margins.top);
  });

  it("keeps a region shorter than half a page whole, and one without cuts as before", () => {
    const short = computeLayout(doc([table("t", H - 100)]), { t: 300 }, true, false, 0, {}, cuts(11));
    expect(short.byId.get("t")!.parts).toBeUndefined();
    expect(short.byId.get("t")!.page).toBe(1);
    const tall = computeLayout(doc([table("t", 0)]), { t: 2 * H }, true, false);
    expect(tall.byId.get("t")!.parts).toBeUndefined();
    // nor one to be kept whole (SMath's isBreakable=false)
    const kept = computeLayout(doc([{ ...table("t", 100), keep: true }]), { t: 2 * H }, true, false, 0, {}, cuts(80));
    expect(kept.byId.get("t")!.parts).toBeUndefined();
    // and nothing splits on the canvas
    const canvas = computeLayout(doc([table("t", 0)]), { t: 2 * H }, false, false, 0, {}, cuts(80));
    expect(canvas.byId.get("t")!.parts).toBeUndefined();
  });

  it("places what sits beside a split region on the page of the part it is beside", () => {
    const h = 30 + 25 * 80;
    const beside: Region = { id: "b", kind: "math", at: [400, 100 + 1200], expr: "b" };
    const l = computeLayout(doc([table("t", 100), beside]), { t: h, b: 20 }, true, false, 0, {}, cuts(80));
    const parts = l.byId.get("t")!.parts!;
    const b = l.byId.get("b")!;
    const part = parts.findIndex((q) => q.from <= 1200 && 1200 < q.to);
    expect(b.page).toBe(parts[part].page);
    expect(b.top).toBeCloseTo(margins.top + 30 + 1200 - parts[part].from);
  });

  it("maps document points inside a split region onto its parts", () => {
    const h = 30 + 25 * 80;
    const l = computeLayout(doc([table("t", 100)]), { t: h }, true, false, 0, {}, cuts(80));
    const q = l.byId.get("t")!.parts![1];
    const stride = pageGeom(doc([])).paperH + SHEET_GAP;
    const [, sy] = l.toScene(0, 100 + q.from + 10);
    expect(sy).toBeCloseTo(stride + margins.top + 30 + 10);
    expect(l.fromScene(margins.left, sy)[1]).toBeCloseTo(100 + q.from + 10);
  });
});
