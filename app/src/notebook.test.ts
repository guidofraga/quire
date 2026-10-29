import { describe, expect, it } from "vitest";
import { absPath, baseOf, parentOf, relOf, setNb, titleOf, trail, walk } from "./notebook";

const book = (path: string) =>
  setNb("book", {
    name: "Physics",
    path,
    children: [
      {
        kind: "section",
        name: "Mechanics",
        rel: "Mechanics",
        children: [
          { kind: "section", name: "Forces", rel: "Mechanics/Forces", children: [{ kind: "note", name: "Friction", rel: "Mechanics/Forces/Friction.quire" }] },
          { kind: "note", name: "Kinematics", rel: "Mechanics/Kinematics.quirez" },
        ],
      },
      { kind: "note", name: "Syllabus", rel: "Syllabus.quire" },
    ],
  });

describe("notebook paths", () => {
  it("splits relative paths", () => {
    expect(parentOf("Mechanics/Forces/Friction.quire")).toBe("Mechanics/Forces");
    expect(parentOf("Syllabus.quire")).toBe("");
    expect(baseOf("Mechanics/Kinematics.quirez")).toBe("Kinematics.quirez");
    expect(titleOf("Mechanics/Kinematics.quirez")).toBe("Kinematics");
    expect(titleOf("Lab 1 — Pendulum.quire")).toBe("Lab 1 — Pendulum");
  });

  it("joins and recognises paths on macOS and Linux", () => {
    book("/Users/ana/Physics/");
    expect(absPath("Mechanics/Kinematics.quirez")).toBe("/Users/ana/Physics/Mechanics/Kinematics.quirez");
    expect(relOf("/Users/ana/Physics/Mechanics/Kinematics.quirez")).toBe("Mechanics/Kinematics.quirez");
    expect(relOf("/Users/ana/Physics2/Note.quire")).toBeNull();
    expect(relOf("/Users/ana/Physics/Mechanics")).toBeNull();
    expect(relOf(null)).toBeNull();
  });

  it("joins and recognises paths on Windows", () => {
    book("C:\\Users\\ana\\Physics");
    expect(absPath("Mechanics/Kinematics.quirez")).toBe("C:\\Users\\ana\\Physics\\Mechanics\\Kinematics.quirez");
    expect(relOf("C:\\Users\\ana\\Physics\\Mechanics\\Kinematics.quirez")).toBe("Mechanics/Kinematics.quirez");
  });

  it("walks the tree in sidebar order and finds the sections above a note", () => {
    book("/nb");
    expect(walk().map((n) => n.name)).toEqual(["Mechanics", "Forces", "Friction", "Kinematics", "Syllabus"]);
    expect(trail("Mechanics/Forces/Friction.quire").map((n) => n.name)).toEqual(["Mechanics", "Forces"]);
    expect(trail("Syllabus.quire")).toEqual([]);
  });
});
