// Text regions are stored as Djot. The editor loads the HTML the backend renders from it
// (`djot_html`) and writes Djot back with `toDjot`; a round trip must give back the source.
import { describe, expect, it } from "vitest";
import { escapeText, fromHtml, toDjot } from "./richtext";

// [Djot, what `quire_service::render_djot_editable` returns for it]
const CASES: [string, string][] = [
  [
    "*bold* _it_ [u]{.underline} {-gone-} x^2^ H~2~O",
    '<p><strong>bold</strong> <em>it</em> <span class="underline">u</span> <del>gone</del> x<sup>2</sup> H<sub>2</sub>O</p>',
  ],
  ['[red]{color="#c00" size=9}', '<p><span color="#c00" size="9">red</span></p>'],
  ["{.center size=14}\nCentred", '<p class="center" size="14">Centred</p>'],
  ["{.title}\n# Report", '<section class="title" id="Report">\n<h1>Report</h1>\n</section>'],
  ["## Loads", '<section id="Loads">\n<h2>Loads</h2>\n</section>'],
  [
    "- one\n- two\n\n1. a\n2. b",
    "<ul>\n<li>\none\n</li>\n<li>\ntwo\n</li>\n</ul>\n<ol>\n<li>\na\n</li>\n<li>\nb\n</li>\n</ol>",
  ],
  [
    "See [](#ref:fig1){.page} and $`q*L^2/8`.",
    '<p>See <a href="#ref:fig1" class="page"></a> and <span class="qmath" data-expr="q*L^2/8"></span>.</p>',
  ],
  ["Line\\\nbreak", "<p>Line<br>\nbreak</p>"],
  ["Price \\*not\\* bold", "<p>Price *not* bold</p>"],
  ["1\\. not a list", "<p>1. not a list</p>"],
  ['{font="Times New Roman"}\nSerif', '<p font="Times New Roman">Serif</p>'],
  ['[*red bold*]{color="#c00"}', '<p><span color="#c00"><strong>red bold</strong></span></p>'],
];

describe("Djot round trip", () => {
  it.each(CASES)("%j", (djot, html) => {
    expect(toDjot(fromHtml(html))).toBe(djot);
  });

  it("drops empty paragraphs", () => {
    expect(toDjot(fromHtml("<p>a</p><p></p><p>b</p>"))).toBe("a\n\nb");
  });

  it("ignores colours and sizes that are not plain values", () => {
    expect(toDjot(fromHtml('<p><span color="red;x:y" size="9pt">t</span></p>'))).toBe("t");
  });
});

describe("escapeText", () => {
  it("escapes everything Djot would read as markup", () => {
    expect(escapeText('a*b_c [d] {e} `f` ~g^ $h <i> #j |k "l" \\')).toBe(
      'a\\*b\\_c \\[d\\] \\{e\\} \\`f\\` \\~g\\^ \\$h \\<i\\> \\#j \\|k \\"l\\" \\\\',
    );
  });
});
