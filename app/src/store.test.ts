import { beforeEach, describe, expect, it } from "vitest";
import { pageGeom } from "./pages";
import { AREA_COLLAPSED_HEIGHT, computeLayout, loadDoc, localized, mutate, noteRoom, redo, settleRegions, state, togglePageView, undo, undoDepth, updateRegion } from "./store";
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

describe("settleRegions (imported SMath positions)", () => {
  const box = (id: string, x: number, y: number, extra: Partial<Region> = {}): Region => ({ id, kind: "text", at: [x, y], text: "t", ...extra });
  const area = (id: string, x: number, y: number, height: number, regions: Region[], extra: Partial<Region> = {}): Region => ({
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
