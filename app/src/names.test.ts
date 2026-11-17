import { describe, expect, it } from "vitest";
import { placeList } from "./Completion";
import { cycleOrder, currentMeaning, looselyIn, nameSpan, unitPosition } from "./names";
import type { Completion } from "./types";

const c = (name: string, kind: Completion["kind"], insert: string): Completion => ({ name, kind, insert, preview: "" });

describe("nameSpan", () => {
  it("finds the name the caret is in or right after", () => {
    expect(nameSpan("x:=2T=", 5)).toMatchObject({ from: 4, to: 5, name: "T", typed: "T", marker: "" });
    expect(nameSpan("q*L.span^2", 5)).toMatchObject({ from: 2, to: 8, name: "L.span", typed: "L.s" });
    expect(nameSpan("1.5m", 4)).toMatchObject({ from: 3, name: "m" });
  });
  it("takes a ' or # with the name", () => {
    expect(nameSpan("2 'T", 4)).toMatchObject({ from: 2, to: 4, name: "T", marker: "'" });
    expect(nameSpan("y:=#G", 5)).toMatchObject({ from: 3, to: 5, name: "G", marker: "#" });
  });
  it("is nothing on a number or an operator", () => {
    expect(nameSpan("x:=25", 5)).toBeNull();
    expect(nameSpan("a + b", 2)).toBeNull();
    expect(nameSpan("25T", 1)).toBeNull();
  });
});

describe("cycling a name", () => {
  const T = [c("T", "variable", "T"), c("T", "unit", "'T"), c("Ts", "unit", "Ts")];
  it("visits yours, the unit, then the constant, only those that exist", () => {
    expect(cycleOrder(T, "T").map((m) => m.insert)).toEqual(["T", "'T"]);
    const G = [c("G", "constant", "#G"), c("G", "variable", "G"), c("G", "unit", "'G")];
    expect(cycleOrder(G, "G").map((m) => m.kind)).toEqual(["variable", "unit", "constant"]);
  });
  it("knows what the name means as written", () => {
    const order = cycleOrder(T, "T");
    expect(currentMeaning(order, nameSpan("x:=2T", 5)!, "x:=2T")).toBe(0);
    expect(currentMeaning(order, nameSpan("x:=2'T", 6)!, "x:=2'T")).toBe(1);
    // a plain name with no variable: the unit after a number, the constant elsewhere
    const g = cycleOrder([c("g", "unit", "'g"), c("g", "constant", "#g")], "g");
    expect(currentMeaning(g, nameSpan("500 g", 5)!, "500 g")).toBe(0);
    expect(currentMeaning(g, nameSpan("m*g", 3)!, "m*g")).toBe(1);
  });
});

describe("where a unit goes", () => {
  it("takes °C as one name", () => {
    expect(nameSpan("T:=20 °C", 8)).toMatchObject({ from: 6, to: 8, name: "°C", typed: "°C" });
    expect(nameSpan("T:=20°", 6)).toMatchObject({ from: 5, name: "°" });
  });
  it("is right after a number, or after a unit that follows one", () => {
    const at = (text: string) => unitPosition(text, text.length);
    expect(at("T:=20 ")).toBe(true);
    expect(at("T:=20")).toBe(true);
    expect(at("x:=1.5e3 ")).toBe(true);
    expect(at("g:=9.81 m/")).toBe(true);
    expect(at("M:=5 kN*")).toBe(true);
    expect(at("y:=")).toBe(false);
    expect(at("y:=a*")).toBe(false);
    expect(at("y:=x2 ")).toBe(false);
  });
  it("narrows a shorter answer loosely while the engine is asked", () => {
    expect(looselyIn("cel", "°C degree Celsius")).toBe(true);
    expect(looselyIn("kN", "kN kilonewton")).toBe(true);
    expect(looselyIn("xyz", "kN kilonewton")).toBe(false);
  });
});

describe("placing the list", () => {
  const view = { width: 1000, height: 800 };
  it("goes below the caret when it fits", () => {
    expect(placeList({ x: 100, y: 200, top: 170 }, { width: 300, height: 250 }, view)).toEqual({
      left: 100,
      top: 200,
    });
  });
  it("goes above the caret's line near the bottom, so it never covers it", () => {
    expect(placeList({ x: 100, y: 700, top: 670 }, { width: 300, height: 250 }, view)).toEqual({
      left: 100,
      top: 420,
    });
  });
  it("stays inside the window sideways", () => {
    expect(placeList({ x: 900, y: 200 }, { width: 300, height: 100 }, view).left).toBe(692);
  });
});
