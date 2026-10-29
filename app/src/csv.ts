// CSV in and out of spreadsheet tables (RFC 4180, plus what Excel writes in other locales).

export type Delimiter = "," | ";" | "\t";

/** The delimiter of the first line: Excel writes `;` where the decimal separator is a comma. */
export function detectDelimiter(text: string): Delimiter {
  let line = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "\n" && !quoted) break;
    if (!quoted) line += ch;
  }
  const count = (d: string) => line.split(d).length - 1;
  const best = (["\t", ";", ","] as const).reduce((a, b) => (count(b) > count(a) ? b : a));
  return count(best) ? best : ",";
}

/** Rows of cells; quoted fields keep delimiters, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') cell += src[i++];
      else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  // every row as wide as the widest, so the table is a rectangle
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r));
}

/** CSV text, quoting only cells that need it. Starts with a BOM so Excel reads it as UTF-8. */
export function toCsv(rows: string[][], delimiter: Delimiter = ","): string {
  const quote = (s: string) => (s.includes(delimiter) || /["\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "﻿" + rows.map((r) => r.map(quote).join(delimiter)).join("\r\n") + "\r\n";
}

/** Whether a language writes 1,5 for one and a half (and so `;` between CSV fields). */
export const decimalComma = (lang: string | undefined) => {
  try {
    return (1.5).toLocaleString(lang || undefined).includes(",");
  } catch {
    return false;
  }
};

/** `4.5 kN/m` → `4,5 kN/m`: the number at the start written with a decimal comma. */
export const withDecimalComma = (s: string) => s.replace(/^(-?\d+)\.(\d)/, "$1,$2");

/** A table name from a file name: `Wind loads 2024.csv` → `Wind_loads_2024`. */
export function tableNameFrom(file: string): string | undefined {
  const stem = file.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const name = stem.trim().replace(/[\s-]+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "");
  return /^\p{L}/u.test(name) ? name : undefined;
}
