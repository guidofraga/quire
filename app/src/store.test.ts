import { beforeEach, describe, expect, it } from "vitest";
import { pageGeom } from "./pages";
import { AREA_COLLAPSED_HEIGHT, computeLayout, loadDoc, localized, mutate, noteRoom, redo, state, togglePageView, undo, undoDepth, updateRegion } from "./store";
import type { Doc, Region } from "./types";

const doc = (regions: Region[], page?: Doc["page"]): Doc => ({ format: "quire/1", meta: { title: "T" }, regions, page });
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
    const l = computeLayout(doc([math("a", 0, "1"), math("b", H - 10, "2"), math("c", H + 40, "3")]), { b: 30 }, true, false);
    const b = l.byId.get("b")!;
    expect(b.page).toBe(1);
    expect(b.top).toBeCloseTo(l.geom.margins.top);
    // what follows moves down with it
    expect(l.byId.get("c")!.top).toBeCloseTo(l.geom.margins.top + 50);
    expect(l.contentPages).toBe(2);
  });

  it("adds blank pages on request, but never prints them", () => {
    const d = doc([math("a", 0, "1")]);
    expect(computeLayout(d, {}, true, false, 3).pages).toBe(3);
    expect(computeLayout(d, {}, true, true, 3).pages).toBe(1);
  });

  it("maps document points to the scene and back", () => {
    const l = computeLayout(doc([math("a", 0, "1"), math("b", H * 2 + 50, "2")]), {}, true, false);
    for (const [x, y] of [[10, 5], [40, H + 100], [0, H * 2 + 50]] as [number, number][]) {
      const [sx, sy] = l.toScene(x, y);
      const [dx, dy] = l.fromScene(sx, sy);
      expect(dx).toBeCloseTo(x);
      expect(dy).toBeCloseTo(y);
    }
  });

  it("moves what is below a collapsed area up and hides its content", () => {
    const area: Region = { id: "ar", kind: "area", at: [0, 100], height: 200, collapsed: true, regions: [math("in", 20, "x")] };
    const l = computeLayout(doc([area, math("below", 400, "y")]), {}, false, false);
    expect(l.byId.get("in")!.hidden).toBe(true);
    expect(l.byId.get("below")!.top).toBe(400 - (200 - AREA_COLLAPSED_HEIGHT));
  });
});

describe("noteRoom", () => {
  const at = (id: string, x: number, y: number): Region => ({ id, kind: "math", at: [x, y], expr: "1" });
  const measured = { a: 40 };
  const l = computeLayout(doc([at("a", 0, 0), at("b", 300, 0), at("c", 200, 100), at("d", 500, 9)]), measured, false, false);
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
