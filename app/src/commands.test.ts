import { beforeEach, describe, expect, it } from "vitest";
import { arrange, type Item, recentCommands, rememberCommand } from "./commands";

const cmd = (command: string, label: string, group: Item["group"]): Item => ({
  label,
  hint: "",
  group,
  icon: "command",
  command,
  run: () => {},
});

const ALL: Item[] = [
  cmd("new_document", "New Document", "File"),
  cmd("open", "Open…", "File"),
  cmd("undo", "Undo", "Edit"),
  cmd("new_section", "New Section", "Notebook"),
  cmd("zoom_in", "Zoom In", "View"),
  cmd("help", "Quire Help", "Help"),
  { label: "α  alpha", hint: "Greek", group: "Symbols", icon: "math", run: () => {} },
];

const shape = (sections: ReturnType<typeof arrange>) => sections.map((s) => [s.group, s.items.map((i) => i.label)]);

describe("palette order", () => {
  beforeEach(() => localStorage.clear());

  it("lists areas in the menus' order, a notebook's commands last outside one", () => {
    expect(shape(arrange(ALL, "", [], false))).toEqual([
      ["File", ["New Document", "Open…"]],
      ["Edit", ["Undo"]],
      ["View", ["Zoom In"]],
      ["Help", ["Quire Help"]],
      ["Notebook", ["New Section"]],
    ]);
  });

  it("puts a notebook's commands first in a notebook", () => {
    expect(arrange(ALL, "", [], true)[0].group).toBe("Notebook");
  });

  it("shows recent commands first, newest first, moved out of their area", () => {
    const s = arrange(ALL, "", ["zoom_in", "undo"], false);
    expect(shape(s)[0]).toEqual(["Recent", ["Zoom In", "Undo"]]);
    expect(s.find((x) => x.group === "Edit")).toBeUndefined();
  });

  it("ranks the best-matching group first and a notebook's commands lower outside one", () => {
    // "new" starts both; the document comes first outside a notebook
    expect(shape(arrange(ALL, "new", [], false))).toEqual([
      ["File", ["New Document"]],
      ["Notebook", ["New Section"]],
    ]);
    expect(arrange(ALL, "new", [], true)[0].group).toBe("Notebook");
    // letters in order still match, and symbols are found when asked for
    expect(arrange(ALL, "zmi", [], false)[0].items[0].label).toBe("Zoom In");
    expect(arrange(ALL, "alpha", [], false)[0].group).toBe("Symbols");
  });

  it("keeps recent commands, and survives storage that refuses", () => {
    rememberCommand("undo");
    rememberCommand("open");
    rememberCommand("undo");
    expect(recentCommands()).toEqual(["undo", "open"]);
    localStorage.setItem("quire.palette.recent", "not json");
    expect(recentCommands()).toEqual([]);
  });
});
