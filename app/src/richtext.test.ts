// Text regions are stored as Djot. The editor loads the HTML the backend renders from it
// (`djot_html`) and writes Djot back with `toDjot`; a round trip must give back the source.
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import cases from "./richtext.cases.json?raw";
import { commands, escapeText, fromHtml, isLiteral, linkAt, normalizeHref, parseEditable, toDjot } from "./richtext";

// [Djot, what `quire_service::render_djot_editable` returns for it, what the editor writes
// when it rewrites it]. The Rust tests in `text.rs` check the HTML, and that the rewrite reads
// the same, for every construct the renderer handles.
const CASES = JSON.parse(cases) as { djot: string; html: string; written: string }[];

describe("Djot → editor → Djot", () => {
  it.each(CASES.map((c) => [c.djot, c] as const))("%j comes back byte for byte", (_, c) => {
    const { doc, loaded } = parseEditable(c.html);
    expect(toDjot(doc, loaded)).toBe(c.djot);
  });

  it.each(CASES.map((c) => [c.djot, c] as const))("%j is rewritten as Djot that reads the same", (_, c) => {
    expect(toDjot(fromHtml(c.html))).toBe(c.written);
  });

  it("keeps what it can't edit as uneditable blocks", () => {
    const kept = CASES.filter((c) => c.html.split("data-keep").length === c.html.split("<div data-djot").length);
    expect(kept.length).toBeGreaterThan(10);
    for (const c of kept) expect(fromHtml(c.html).firstChild?.type.name).toBe("djot_block");
  });
});

/** The whole-document case: a heading, a paragraph with a link, a table, a list. */
const DOC = CASES[CASES.length - 1];

function edited(at: (s: EditorState) => EditorState) {
  const { doc, loaded } = parseEditable(DOC.html);
  return toDjot(at(EditorState.create({ doc })).doc, loaded);
}

/** The position just after the first occurrence of `text`. */
function after(state: EditorState, text: string): number {
  let pos = -1;
  state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text) + text.length;
  });
  return pos;
}

describe("editing one block", () => {
  it("rewrites only that block", () => {
    const out = edited((s) => s.apply(s.tr.insertText("all ", after(s, "for "))));
    // the heading, the table and the list (with its `*` bullets) are as they were
    expect(out).toBe("# Loads\n\nSee [the docs](https://example.com) for all *q*.\n\n| a |\n|---|\n\n* one\n* two\n");
  });

  it("keeps the link when typing inside it", () => {
    const out = edited((s) => s.apply(s.tr.insertText("se", after(s, "the doc"))));
    expect(out).toBe(DOC.djot.replace("the docs", "the docses").replace(".\n\n\n|", ".\n\n|"));
  });

  it("writes a block typed in and undone as it was", () => {
    const out = edited((s) => {
      const pos = after(s, "two");
      const typed = s.apply(s.tr.insertText("!", pos));
      return typed.apply(typed.tr.delete(pos, pos + 1));
    });
    expect(out).toBe(DOC.djot);
  });

  it("keeps a table that is moved", () => {
    const out = edited((s) => {
      const table = s.doc.child(2);
      const start = s.doc.child(0).nodeSize + s.doc.child(1).nodeSize;
      return s.apply(s.tr.delete(start, start + table.nodeSize).insert(0, table));
    });
    expect(out).toBe("| a |\n|---|\n\n# Loads\n\nSee [the docs](https://example.com) for *q*.\n\n* one\n* two\n");
  });
});

describe("links", () => {
  const state = () => EditorState.create({ doc: fromHtml(DOC.html) });

  it("finds the whole link around the caret", () => {
    const s = state();
    const at = s.apply(s.tr.setSelection(TextSelection.create(s.doc, after(s, "the d"))));
    expect(linkAt(at)).toEqual({ from: after(s, "See "), to: after(s, "the docs"), href: "https://example.com" });
  });

  it("changes and removes a link", () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, after(s, "the d"))));
    commands.link("https://quire.example")(s, (tr) => (s = s.apply(tr)));
    expect(toDjot(s.doc)).toContain("[the docs](https://quire.example) for");
    commands.link(null)(s, (tr) => (s = s.apply(tr)));
    expect(toDjot(s.doc)).toContain("See the docs for");
  });

  it("links the selection", () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, after(s, "for "), after(s, "for ") + 1)));
    commands.link("#Loads")(s, (tr) => (s = s.apply(tr)));
    expect(toDjot(s.doc)).toContain("for [*q*](#Loads).");
  });

  it("reads a typed address as a web address unless it says otherwise", () => {
    expect(normalizeHref("example.com/a")).toBe("https://example.com/a");
    expect(normalizeHref("me@example.com")).toBe("mailto:me@example.com");
    expect(normalizeHref("#Loads")).toBe("#Loads");
    expect(normalizeHref("http://x.y")).toBe("http://x.y");
  });

  it("encodes parentheses so Djot doesn't end the address early", () => {
    let s = state();
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, after(s, "the d"))));
    commands.link("https://en.wikipedia.org/wiki/Beam_(structure)")(s, (tr) => (s = s.apply(tr)));
    expect(toDjot(s.doc)).toContain("(https://en.wikipedia.org/wiki/Beam_%28structure%29)");
  });
});

// Earlier HTML, without the source of each block: everything is rewritten
const LEGACY: [string, string][] = [
  ["{.title}\n# Report", '<section class="title" id="Report">\n<h1>Report</h1>\n</section>'],
  ["#### Four", '<section id="Four">\n<h4>Four</h4>\n</section>'],
  ["Use ``a`b`` here", "<p>Use <code>a`b</code> here</p>"],
  ["> quoted\n>\n> two", "<blockquote>\n<p>quoted</p>\n<p>two</p>\n</blockquote>"],
];

describe("toDjot", () => {
  it.each(LEGACY)("%j", (djot, html) => {
    expect(toDjot(fromHtml(html))).toBe(djot);
  });

  it("drops empty paragraphs", () => {
    expect(toDjot(fromHtml("<p>a</p><p></p><p>b</p>"))).toBe("a\n\nb");
  });

  it("ignores colours and sizes that are not plain values", () => {
    expect(toDjot(fromHtml('<p><span color="red;x:y" size="9pt">t</span></p>'))).toBe("t");
  });

  it("keeps text that looks like the start of a list, a div or a rule literal", () => {
    const para = (t: string) => toDjot(fromHtml(`<p>${t}</p>`));
    expect(para("a) first")).toBe("a\\) first");
    expect(para("(iv) fourth")).toBe("\\(iv\\) fourth");
    expect(para("+ plus")).toBe("\\+ plus");
    expect(para("::: note")).toBe("\\::: note");
    expect(para("---")).toBe("\\---");
  });
});

describe("isLiteral", () => {
  it("is true only when writing the text back changes nothing", () => {
    expect(isLiteral("Plain words, numbers 1.5 and don't")).toBe(true);
    expect(isLiteral('Say "hi"')).toBe(false);
    expect(isLiteral("a. first")).toBe(false);
  });
});

describe("escapeText", () => {
  it("escapes everything Djot would read as markup", () => {
    expect(escapeText('a*b_c [d] {e} `f` ~g^ $h <i> #j |k "l" \\')).toBe(
      'a\\*b\\_c \\[d\\] \\{e\\} \\`f\\` \\~g\\^ \\$h \\<i\\> \\#j \\|k \\"l\\" \\\\',
    );
  });
});
