import { describe, expect, it } from "vitest";
import { decimalComma, detectDelimiter, parseCsv, tableNameFrom, toCsv, withDecimalComma } from "./csv";

describe("detectDelimiter", () => {
  it.each([
    ["a,b,c\n1,2,3", ","],
    ["a;b;c\n1,5;2,5;3", ";"],
    ["a\tb\n1\t2", "\t"],
    ['"x;y",b,c', ","],
    ["single column", ","],
  ])("%j → %j", (text, want) => {
    expect(detectDelimiter(text)).toBe(want);
  });
});

describe("parseCsv", () => {
  it("reads rows and cells", () => {
    expect(parseCsv("Load,q\nDead,4.5 kN/m\r\nLive,1.5 kN/m\n")).toEqual([
      ["Load", "q"],
      ["Dead", "4.5 kN/m"],
      ["Live", "1.5 kN/m"],
    ]);
  });

  it("reads what Excel writes with decimal commas", () => {
    expect(parseCsv("\uFEFFCarga;q\nPermanente;1,5\n")).toEqual([
      ["Carga", "q"],
      ["Permanente", "1,5"],
    ]);
  });

  it("keeps delimiters, quotes and line breaks inside quoted fields", () => {
    expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\n')).toEqual([["a", "b,c", 'say "hi"', "two\nlines"]]);
  });

  it("keeps empty cells and pads short rows", () => {
    expect(parseCsv("a,,c\nd\n,")).toEqual([
      ["a", "", "c"],
      ["d", "", ""],
      ["", "", ""],
    ]);
  });

  it("reads a quote inside an unquoted field as text", () => {
    expect(parseCsv('12" pipe,b')).toEqual([['12" pipe', "b"]]);
  });

  it("reads an empty file as no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("toCsv", () => {
  it("quotes only what needs it, with a BOM and CRLF", () => {
    expect(toCsv([["a", "b,c", 'x"y'], ["two\nlines", " pad", "σ = 3 kN·m"]])).toBe(
      '\uFEFFa,"b,c","x""y"\r\n"two\nlines"," pad",σ = 3 kN·m\r\n',
    );
  });

  it("round-trips through parseCsv", () => {
    const rows = [["Load", "q; per m", "note"], ["Dead", "4,5 kN/m", 'the "usual"\nvalue']];
    for (const d of [",", ";", "\t"] as const) expect(parseCsv(toCsv(rows, d), d)).toEqual(rows);
  });
});

describe("number format", () => {
  it("knows which languages write a decimal comma", () => {
    expect(decimalComma("pt-BR")).toBe(true);
    expect(decimalComma("de")).toBe(true);
    expect(decimalComma("en-US")).toBe(false);
    expect(decimalComma("not a language")).toBe(false);
  });

  it("writes the leading number with a comma", () => {
    expect(withDecimalComma("4.5 kN/m")).toBe("4,5 kN/m");
    expect(withDecimalComma("-0.25")).toBe("-0,25");
    expect(withDecimalComma("1.25·10¹⁰ Pa")).toBe("1,25·10¹⁰ Pa");
    expect(withDecimalComma("OK")).toBe("OK");
    expect(withDecimalComma("12")).toBe("12");
  });
});

describe("tableNameFrom", () => {
  it.each([
    ["/Users/a/Wind loads 2024.csv", "Wind_loads_2024"],
    ["C:\\data\\cargas-permanentes.csv", "cargas_permanentes"],
    ["σ data.csv", "σ_data"],
    ["2024.csv", undefined],
    ["(copy).csv", "copy"],
  ])("%j → %j", (file, want) => {
    expect(tableNameFrom(file)).toBe(want);
  });
});
