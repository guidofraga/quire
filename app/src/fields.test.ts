import { beforeEach, describe, expect, it } from "vitest";
import { fillOnPage, fillTextFields } from "./fields";
import { loadDoc } from "./store";
import type { Doc } from "./types";

const doc: Doc = {
  format: "quire/1",
  meta: { title: "Beam report", authors: ["A. Engineer"], company: "Acme" },
  regions: [{ id: "t", kind: "text", at: [0, 0], text: "x" }],
};

describe("fields in text and table cells", () => {
  beforeEach(() => loadDoc(structuredClone(doc), "/tmp/Report.quire"));

  it("fills the header and footer fields as on the page the text is on", () => {
    expect(fillOnPage("{title} by {author}, {company}", 0)).toBe("Beam report by A. Engineer, Acme");
    expect(fillOnPage("Page {page} of {pages}", 2)).toBe("Page 3 of 1");
    expect(fillOnPage("{date}", 0)).toBe(new Date().toLocaleDateString(undefined));
    expect(fillOnPage("{file}", 0)).toBe("Report.quire");
  });

  it("leaves other braces and plain text as they are", () => {
    expect(fillOnPage("{nope} and {1+2}", 0)).toBe("{nope} and {1+2}");
    expect(fillOnPage("plain", 0)).toBe("plain");
  });

  it("fills the text of rendered Djot, but not code", () => {
    const el = document.createElement("div");
    el.innerHTML = "<p>Issued {date} for <em>{title}</em> <code>{title}</code></p>";
    fillTextFields(el, 0);
    expect(el.textContent).toBe(`Issued ${new Date().toLocaleDateString(undefined)} for Beam report {title}`);
  });
});
