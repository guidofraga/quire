import { describe, expect, it } from "vitest";
import { documentPath } from "./api";

describe("documentPath", () => {
  it("resolves document.json inside a .quire bundle to the bundle folder", () => {
    expect(documentPath("/Users/a/Beam.quire/document.json")).toBe("/Users/a/Beam.quire");
    expect(documentPath("C:\\Calc\\Beam.quire\\document.json")).toBe("C:\\Calc\\Beam.quire");
  });

  it("keeps standalone document.json paths untouched", () => {
    expect(documentPath("/Users/a/Downloads/document.json")).toBe("/Users/a/Downloads/document.json");
    expect(documentPath("/Users/a/Beam.quirez")).toBe("/Users/a/Beam.quirez");
  });
});
