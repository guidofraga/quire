import { describe, expect, it } from "vitest";
import {
  assetRefs,
  classifyLine,
  clipFromHtml,
  clipHtml,
  decodeClip,
  encodeClip,
  htmlText,
  latexToLinear,
  mathParagraph,
  piecesFromText,
  portableHtml,
  tableFromHtml,
  tableHtml,
  tsv,
} from "./clipboard";
import type { Region } from "./types";

// the app's rule with no variables defined: a word of two letters or more is prose
const isProse = (s: string) => /^[\p{L}][\p{L}]+$/u.test(s) || /^[\p{L}][\p{L}\p{N}_.]*(?:\s+[\p{L}][\p{L}\p{N}_.]*)*\s+\p{L}{3,}$/u.test(s);

const regions: Region[] = [
  { id: "a", kind: "math", at: [36, 36], expr: "L:=6 m" },
  { id: "b", kind: "area", at: [36, 90], regions: [{ id: "c", kind: "image", at: [0, 18], src: "assets/0123456789abcdef.png", size: [10, 10] }] },
];

describe("regions on the clipboard", () => {
  it("round-trips regions and their images through JSON and HTML", () => {
    const clip = { regions, assets: { "assets/0123456789abcdef.png": "data:image/png;base64,iVBORw0KGgo=" } };
    expect(decodeClip(encodeClip(clip))).toEqual(clip);
    const html = clipHtml("<p>Ação: σ ≤ f.y</p>", clip);
    expect(html).toContain("<p>Ação: σ ≤ f.y</p>");
    expect(clipFromHtml(html)).toEqual(clip);
  });

  it("finds the images regions show, in areas too", () => {
    expect([...assetRefs(regions)]).toEqual(["assets/0123456789abcdef.png"]);
  });

  it("reads the bare list earlier versions copied, and ignores anything else", () => {
    expect(decodeClip(JSON.stringify(regions))?.regions).toHaveLength(2);
    expect(decodeClip("not json")).toBeNull();
    expect(decodeClip('{"regions": [{"kind": "math"}]}')).toBeNull();
    expect(clipFromHtml("<p>from a web page</p>")).toBeNull();
  });
});

describe("HTML for other apps", () => {
  it("turns Djot attributes into styles and drops the app's markup", () => {
    const html = portableHtml('<p><span color="#c00" size="14" class="x">red</span> see <a href="#ref:fig1" class="xref">Figure 1</a></p>');
    expect(html).toBe('<p><span style="font-size: 14pt; color: rgb(204, 0, 0);">red</span> see <span>Figure 1</span></p>');
  });

  it("gives math its MathML namespace and the linear text", () => {
    const p = mathParagraph('<math><mrow><mi data-v="M">M</mi><mo>=</mo><mrow class="res"><mn>54</mn></mrow></mrow></math>', "M:=q*L^2/8 =");
    expect(p).toBe('<p><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="M:=q*L^2/8 ="><mrow><mi>M</mi><mo>=</mo><mrow><mn>54</mn></mrow></mrow></math></p>');
  });

  it("writes tables with header cells and alignment", () => {
    const html = tableHtml([["Load", "q"], ["Dead", "4.5 kN/m"]], { headerRow: true, align: [undefined, "right"] });
    expect(html).toContain("<th style=\"border:1px solid #999;padding:2px 6px\">Load</th>");
    expect(html).toContain("text-align:right\">4.5 kN/m</td>");
    expect(tsv([["a", "b\tc"], ["1", '"x"']])).toBe('a\t"b\tc"\n1\t"""x"""');
  });

  it("reads rendered text as lines", () => {
    expect(htmlText("<h1>Loads</h1><p>Dead <b>load</b><br>and live</p>")).toBe("Loads\nDead load\nand live");
  });
});

describe("pasting tables", () => {
  it("reads a table copied from a spreadsheet", () => {
    const html =
      '<meta charset="utf-8"><google-sheets-html-origin><style>td { border: 1px }</style><table><tbody>' +
      "<tr><th>Load</th><th>q</th></tr><tr><td>Dead</td><td>4.5 kN/m</td></tr><tr><td colspan=2>Total</td></tr></tbody></table></google-sheets-html-origin>";
    expect(tableFromHtml(html)).toEqual({
      rows: [["Load", "q"], ["Dead", "4.5 kN/m"], ["Total", ""]],
      header: true,
    });
  });

  it("spreads merged rows and keeps line breaks in cells", () => {
    const html = "<table><tr><td rowspan=2>A</td><td>1<br>2</td></tr><tr><td>3</td></tr></table>";
    expect(tableFromHtml(html)).toEqual({ rows: [["A", "1\n2"], ["", "3"]], header: false });
  });

  it("leaves a document with a table in it to the text", () => {
    expect(tableFromHtml("<p>Intro</p><table><tr><td>1</td></tr></table>")).toBeNull();
    expect(tableFromHtml("<p>No table</p>")).toBeNull();
  });
});

describe("pasting text", () => {
  it("makes one region per line, math or text by the typing rules", () => {
    expect(piecesFromText("The span is simply supported.\nq := 12 kN/m\n\nL:=6 m\nM:=q*L^2/8=\nTotal load 12 kN", isProse)).toEqual([
      { kind: "text", text: "The span is simply supported." },
      { kind: "math", text: "q := 12 kN/m" },
      { kind: "math", text: "L:=6 m" },
      { kind: "math", text: "M:=q*L^2/8=" },
      { kind: "text", text: "Total load 12 kN" },
    ]);
  });

  it("keeps plain definitions and evaluations as math", () => {
    expect(classifyLine("E = 210 GPa", isProse).kind).toBe("math");
    expect(classifyLine("f(x) := x^2", isProse).kind).toBe("math");
    expect(classifyLine("2 m + 30 cm =", isProse).kind).toBe("math");
    expect(classifyLine("x", isProse).kind).toBe("math");
    expect(classifyLine("A medida da viga", isProse).kind).toBe("text");
    expect(classifyLine("The value of \\alpha is small", isProse).kind).toBe("text");
  });

  it("converts LaTeX lines and display blocks", () => {
    expect(piecesFromText("$\\sigma = \\frac{M}{W}$", isProse)).toEqual([{ kind: "math", text: "σ := M/W" }]);
    expect(piecesFromText("\\begin{align}\na &= 2 \\\\\nb &= a^{2}\n\\end{align}", isProse)).toEqual([
      { kind: "math", text: "a := 2" },
      { kind: "math", text: "b := a^2" },
    ]);
  });
});

describe("LaTeX to linear math", () => {
  const t = latexToLinear;

  it("leaves linear math alone", () => {
    expect(t("M := q*L^2/8")).toBeNull();
    expect(t("x^2 + A.net")).toBeNull();
  });

  it("converts fractions, roots and powers", () => {
    expect(t("\\frac{a}{b}")).toBe("a/b");
    expect(t("\\frac{a+b}{c d}")).toBe("(a + b)/(c*d)");
    expect(t("\\sqrt{x}")).toBe("sqrt(x)");
    expect(t("\\sqrt[3]{x+1}")).toBe("root(x + 1, 3)");
    expect(t("x^{2}")).toBe("x^2");
    expect(t("x^{n+1}")).toBe("x^(n + 1)");
    expect(t("e^{-x}")).toBe("e^(-x)");
    expect(t("$x^23$")).toBe("x^2*3");
    expect(t("M = \\frac{q L^2}{8}")).toBe("M := q*L^2/8");
  });

  it("knows Greek letters, subscripts and units", () => {
    expect(t("\\alpha + \\beta")).toBe("α + β");
    expect(t("\\sigma \\le f_{y}")).toBe("σ ≤ f.y");
    expect(t("A_{\\mathrm{net}}")).toBe("A.net");
    expect(t("x_{i+1}")).toBe("x[i + 1]");
    expect(t("F = 5\\,\\mathrm{kN}")).toBe("F := 5 kN");
    expect(t("\\Delta L = 2\\pi r")).toBe("ΔL := 2 π*r");
    expect(t("30^\\circ")).toBe("30 °");
  });

  it("reads products, functions and brackets", () => {
    expect(t("a \\cdot b \\times c")).toBe("a*b*c");
    expect(t("\\sin\\left(x\\right) + \\cos x")).toBe("sin(x) + cos(x)");
    expect(t("\\sin^2 x")).toBe("sin(x)^2");
    expect(t("\\left|x\\right|")).toBe("abs(x)");
    expect(t("\\operatorname{lsolve}\\left(A, b\\right)")).toBe("lsolve(A, b)");
    expect(t("2\\left(a+b\\right)")).toBe("2*(a + b)");
  });

  it("converts sums, integrals and derivatives", () => {
    expect(t("\\sum_{i=1}^{n} x_i")).toBe("sum(x.i, i, 1, n)");
    expect(t("\\int_{0}^{L} M(x)\\,\\mathrm{d}x")).toBe("int(M(x), x, 0, L)");
    expect(t("\\int_0^1 x^2 dx")).toBe("int(x^2, x, 0, 1)");
    expect(t("\\frac{\\mathrm{d}}{\\mathrm{d}x} f(x)")).toBe("diff(f(x), x)");
    expect(t("\\frac{d^2}{dx^2} y")).toBe("diff(y, x, 2)");
  });

  it("converts matrices and strings", () => {
    expect(t("\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}")).toBe("[1, 2; 3, 4]");
    expect(t("s = \\text{“OK”}")).toBe('s := "OK"');
  });

  it("reads back what Copy as LaTeX writes", () => {
    expect(t("M := \\frac{q \\cdot {L}^{2}}{8}")).toBe("M := q*L^2/8");
    expect(t("\\mathit{span} = 54 \\cdot \\mathrm{kN}\\,\\mathrm{m}")).toBe("span := 54*kN*m");
    expect(t("\\int_{0}^{1} f\\,\\mathrm{d}x")).toBe("int(f, x, 0, 1)");
  });
});
