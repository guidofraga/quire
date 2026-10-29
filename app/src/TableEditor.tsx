// Spreadsheet tables: cells hold text, values (12 kN) or formulas (=SUM(B2:B4)).
// The engine evaluates them (crates/quire-eval/src/sheet.rs); this is the grid you edit.
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show, untrack } from "solid-js";
import { render } from "solid-js/web";
import { api, isTauri } from "./api";
import { esc, prettyValue } from "./math";
import { verdictOf } from "./checks";
import { decimalComma, parseCsv, tableNameFrom, toCsv, withDecimalComma } from "./csv";
import { tableFromHtml } from "./clipboard";
import {
  availableWidth,
  commitEditing,
  contentBottom,
  flash,
  insertRegion,
  layout,
  type Placed,
  LINE,
  redo,
  setState,
  snap,
  startEditing,
  state,
  undo,
  updateRegion,
} from "./store";
import type { Region } from "./types";
import {
  a1,
  anchorOf,
  applyFormat,
  type Borders,
  bordersOf,
  type CellFormat,
  expandRange,
  fitsColumn,
  formatAt,
  formatsOf,
  mergeCells,
  reorderFormats,
  SHADES,
  shiftFormats,
  spansOf,
  splitCells,
  tidyFormats,
} from "./tableFormat";
import { DEFAULT_TABLE, openTablePicker, TablePicker } from "./TablePicker";

export interface Column {
  width?: number;
  align?: "left" | "center" | "right";
  unit?: string;
  decimals?: number;
}

/** The selection: (r, c) is the active cell, (r2, c2) the other corner of the range. */
interface Sel {
  r: number;
  c: number;
  r2: number;
  c2: number;
}

const [sel, setSel] = createSignal<Sel>({ r: 0, c: 0, r2: 0, c2: 0 });
/** Text of the cell being typed into, or null when only navigating. */
const [draft, setDraft] = createSignal<string | null>(null);
/** Typing over a cell (arrows commit and move) rather than editing it in place (F2, Enter). */
let typedOver = false;

export const activeCell = () => sel();

export const rowsOf = (r: Region): string[][] => (r.rows as string[][] | undefined) ?? [];
export const columnsOf = (r: Region): Column[] => (r.columns as Column[] | undefined) ?? [];
export const isSheet = (r: Region | undefined) => r?.kind === "table" && Array.isArray(r.rows);
const sizeOf = (r: Region): [number, number] => {
  const rows = rowsOf(r);
  return [rows.length, Math.max(0, ...rows.map((x) => x.length))];
};

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export const colName = (c: number): string => (c < 26 ? "" : colName(Math.floor(c / 26) - 1)) + String.fromCharCode(65 + (c % 26));
export const cellName = (r: number, c: number) => `${colName(c)}${r + 1}`;
const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// a reference not inside a name (M.B2), not another table's (loads!B2), not a function (LOG10()
const REF = /(?<![\p{L}\p{N}_.!$])(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![\p{L}\p{N}_(])/gu;

/** Rewrite the references of a formula, leaving quoted text alone. */
function mapRefs(formula: string, fn: (r: number, c: number, absR: boolean, absC: boolean) => [number, number] | null): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(REF, (_m, ac: string, col: string, ar: string, row: string) => {
            const to = fn(Number(row) - 1, colIndex(col), ar === "$", ac === "$");
            return to ? `${ac}${colName(to[1])}${ar}${to[0] + 1}` : "#REF!";
          }),
    )
    .join("");
}

/** Rows or columns inserted (delta > 0) or deleted (delta < 0) at `at`: references follow. */
export function shiftRefs(formula: string, axis: "row" | "col", at: number, delta: number): string {
  const move = (i: number) => (i < at ? i : delta < 0 && i < at - delta ? null : i + delta);
  return mapRefs(formula, (r, c) => {
    const k = move(axis === "row" ? r : c);
    if (k === null) return null;
    return axis === "row" ? [k, c] : [r, k];
  });
}

/** A formula copied dr rows down and dc columns right: relative references move with it. */
export function moveRefs(formula: string, dr: number, dc: number): string {
  return mapRefs(formula, (r, c, absR, absC) => {
    const to: [number, number] = [absR ? r : r + dr, absC ? c : c + dc];
    return to[0] < 0 || to[1] < 0 ? null : to;
  });
}

// ---------------------------------------------------------------------------
// Editing the cells
// ---------------------------------------------------------------------------

/** Rectangular rows, padded with blanks. */
function normalize(rows: string[][]) {
  const w = Math.max(1, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < w) r.push("");
  if (!rows.length) rows.push(Array(w).fill(""));
}

function editRows(id: string, fn: (rows: string[][], r: Region) => void) {
  updateRegion(id, (r) => {
    const rows = ((r.rows as string[][] | undefined) ?? []).map((x) => [...x]);
    fn(rows, r);
    normalize(rows);
    r.rows = rows;
  });
}

function setCells(id: string, at: [number, number], block: string[][]) {
  editRows(id, (rows) => {
    block.forEach((line, i) =>
      line.forEach((v, j) => {
        const r = at[0] + i;
        const c = at[1] + j;
        while (rows.length <= r) rows.push([]);
        while (rows[r].length <= c) rows[r].push("");
        rows[r][c] = v;
      }),
    );
  });
}

const range = (s: Sel) => ({
  r0: Math.min(s.r, s.r2),
  r1: Math.max(s.r, s.r2),
  c0: Math.min(s.c, s.c2),
  c1: Math.max(s.c, s.c2),
});

const editingTable = (): Region | undefined => {
  const r = state.editing ? layout().byId.get(state.editing)?.region : undefined;
  return isSheet(r) ? r : undefined;
};

function focusGrid() {
  queueMicrotask(() => document.querySelector<HTMLElement>(".region.editing .sheet-wrap")?.focus({ preventScroll: true }));
}

const spansFor = (t: Region) => spansOf(t, ...sizeOf(t));

function select(r: number, c: number, extend = false) {
  const t = editingTable();
  if (!t) return;
  const [h, w] = sizeOf(t);
  r = Math.max(0, Math.min(h - 1, r));
  c = Math.max(0, Math.min(w - 1, c));
  // a merged cell is selected as a whole
  if (!extend) [r, c] = anchorOf(spansFor(t), r, c);
  setSel((s) => (extend ? { ...s, r2: r, c2: c } : { r, c, r2: r, c2: c }));
}

/** The cell one step away, stepping over a merged cell's full width or height. */
function stepFrom(t: Region, i: number, j: number, dr: number, dc: number): [number, number] {
  const [h, w] = spansFor(t).span(i, j);
  return [dr > 0 ? i + h : i + dr, dc > 0 ? j + w : j + dc];
}

/** Word's Tab: the next cell, on to the next row; past the last cell a new row. */
function tabFrom(t: Region, back: boolean) {
  const { r, c } = sel();
  const [h, w] = sizeOf(t);
  const s = spansFor(t);
  const cells: [number, number][] = [];
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) if (!s.covered.has(`${i},${j}`)) cells.push([i, j]);
  const k = cells.findIndex(([i, j]) => i === r && j === c);
  if (back) {
    if (k > 0) select(...cells[k - 1]);
    return;
  }
  if (k >= 0 && k < cells.length - 1) return select(...cells[k + 1]);
  editRows(t.id, (rows) => rows.push(Array(w).fill("")));
  select(h, 0);
}

function beginEdit(text: string | null, typed: boolean) {
  const t = editingTable();
  if (!t) return;
  const { r, c } = sel();
  typedOver = typed;
  setDraft(text ?? rowsOf(t)[r]?.[c] ?? "");
  setSel((s) => ({ ...s, r2: s.r, c2: s.c }));
  queueMicrotask(() => {
    const input = document.querySelector<HTMLInputElement>(".region.editing .cell-input");
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

/** Write the cell being typed and move by (dr, dc); Enter past the last row adds one. */
function commitDraft(dr = 0, dc = 0, tab?: "next" | "back") {
  const t = editingTable();
  const text = draft();
  if (!t || text === null) return;
  const { r, c } = sel();
  setDraft(null);
  if ((rowsOf(t)[r]?.[c] ?? "") !== text) setCells(t.id, [r, c], [[text]]);
  const [nr, nc] = stepFrom(t, r, c, dr, dc);
  if (dr > 0 && nr >= sizeOf(t)[0]) editRows(t.id, (rows) => rows.push([]));
  if (tab) tabFrom(editingTable()!, tab === "back");
  else if (dr || dc) select(nr, nc);
  focusGrid();
}

function cancelDraft() {
  setDraft(null);
  focusGrid();
}

function clearSelection() {
  const t = editingTable();
  if (!t) return;
  const { r0, r1, c0, c1 } = range(sel());
  setCells(
    t.id,
    [r0, c0],
    Array.from({ length: r1 - r0 + 1 }, () => Array(c1 - c0 + 1).fill("")),
  );
}

/** Fill the selection from its first row (down) or first column (right), formulas adjusted. */
function fill(dir: "down" | "right") {
  const t = editingTable();
  if (!t) return;
  let { r0, r1, c0, c1 } = range(sel());
  // a single cell fills from the one above (left of) it
  if (dir === "down" && r0 === r1) r0 = Math.max(0, r0 - 1);
  if (dir === "right" && c0 === c1) c0 = Math.max(0, c0 - 1);
  editRows(t.id, (rows) => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const [sr, sc] = dir === "down" ? [r0, c] : [r, c0];
        if (r === sr && c === sc) continue;
        const src = rows[sr]?.[sc] ?? "";
        rows[r][c] = src.startsWith("=") ? `=${moveRefs(src.slice(1), r - sr, c - sc)}` : src;
      }
  });
}

/**
 * Sort the rows by the active cell's column, by value: numbers by size, text alphabetically,
 * empty cells last. A header row, and rows that add up a range (a Total row, =SUM(B2:B4)),
 * stay where they are; the other rows are reordered among themselves, and every reference
 * in the table follows the row it pointed at, so =B2*C2 and the totals stay right.
 */
function sortRows(descending: boolean) {
  const t = editingTable();
  if (!t) return;
  const c = sel().c;
  const first = t.header?.row ? 1 : 0;
  const cells = state.views[t.id]?.cells ?? [];
  const key = (i: number): number | string | null => {
    const text = cells[i]?.[c]?.text ?? null;
    if (!text) return null;
    const n = parseFloat(text);
    return Number.isFinite(n) && !text.startsWith('"') ? n : text.replace(/^"|"$/g, "").toLowerCase();
  };
  editRows(t.id, (rows) => {
    const sums = (i: number) => rows[i].some((cell) => cell.startsWith("=") && /[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+/i.test(cell));
    const movable = rows.map((_, i) => i).filter((i) => i >= first && !sums(i));
    const sorted = [...movable].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
      const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
      return descending ? -cmp : cmp;
    });
    // where each row ends up (rows are 1-based in references)
    const newRow = new Map<number, number>();
    sorted.forEach((from, k) => newRow.set(from + 1, movable[k] + 1));
    const follow = (formula: string) =>
      formula.replace(/(^|[^A-Za-z0-9_!.$])(\$?[A-Z]{1,3})(\$?)(\d+)(?![\w(])/g, (m, pre: string, col: string, abs: string, row: string) => {
        const to = newRow.get(Number(row));
        return to ? `${pre}${col}${abs}${to}` : m;
      });
    const next = rows.map((row) => row.map((cell) => (cell.startsWith("=") ? `=${follow(cell.slice(1))}` : cell)));
    const result = next.map((row) => [...row]);
    sorted.forEach((from, k) => (result[movable[k]] = next[from]));
    rows.splice(0, rows.length, ...result);
    // bold, shading… go with their rows
    const order = rows.map((_, i) => i);
    sorted.forEach((from, k) => (order[movable[k]] = from));
    if (t.cellFormat) setFormats(t, reorderFormats(formatsOf(t), order));
  });
}

function setFormats(r: Region, f: ReturnType<typeof formatsOf>) {
  const tidy = tidyFormats(f);
  if (tidy) r.cellFormat = tidy;
  else delete r.cellFormat;
}

// ---------------------------------------------------------------------------
// Word-like formatting of the selected cells
// ---------------------------------------------------------------------------

const tableById = (id: string) => {
  const r = layout().byId.get(id)?.region;
  return isSheet(r) ? r : undefined;
};

/** The cells of the selection (merged cells once, by their top-left cell). */
function selectedCells(t: Region): [number, number][] {
  const { r0, r1, c0, c1 } = range(sel());
  const s = spansFor(t);
  const out: [number, number][] = [];
  for (let i = r0; i <= r1; i++) for (let j = c0; j <= c1; j++) if (!s.covered.has(`${i},${j}`)) out.push([i, j]);
  return out.length ? out : [anchorOf(s, r0, c0)];
}

/** Bold, italic, alignment, shading on the selected cells (`undefined` clears). */
export function formatCells(id: string, patch: Partial<CellFormat>) {
  const t = tableById(id);
  if (!t) return;
  const cells = selectedCells(t);
  updateRegion(id, (r) => setFormats(r, applyFormat(formatsOf(r), cells, patch)));
}

/** The format of the active cell, for the toolbar's pressed buttons. */
export function activeFormat(r: Region): CellFormat {
  const { r: i, c: j } = sel();
  return formatAt(r, i, j);
}

/** Header cells are bold without saying so. */
const headerCell = (t: Region, i: number, j: number) => (!!t.header?.row && i === 0) || (!!t.header?.column && j === 0);

/** ⌘B / ⌘I: on for all, or off if every selected cell already has it. */
export function toggleCells(id: string, key: "bold" | "italic") {
  const t = tableById(id);
  if (!t) return;
  const cells = selectedCells(t);
  // header cells are bold by default: plain needs saying so
  const implied = (i: number, j: number) => key === "bold" && headerCell(t, i, j);
  const on = !cells.every(([i, j]) => formatAt(t, i, j)[key] ?? implied(i, j));
  updateRegion(id, (r) => {
    const f = { ...formatsOf(r) };
    for (const [i, j] of cells) f[a1(i, j)] = { ...f[a1(i, j)], [key]: on === implied(i, j) ? undefined : on };
    setFormats(r, f);
  });
}

export function mergeSelection(id: string) {
  const t = tableById(id);
  if (!t) return;
  const rg = expandRange(spansFor(t), range(sel()));
  if (rg.r0 === rg.r1 && rg.c0 === rg.c1) return flash("Select two or more cells to merge");
  editRows(id, (rows, r) => setFormats(r, mergeCells(rows, formatsOf(r), rg)));
  setSel({ r: rg.r0, c: rg.c0, r2: rg.r0, c2: rg.c0 });
}

export function splitSelection(id: string) {
  const t = tableById(id);
  if (!t) return;
  const rg = expandRange(spansFor(t), range(sel()));
  updateRegion(id, (r) => setFormats(r, splitCells(formatsOf(r), rg)));
}

/** Whether the selection holds a merged cell (Split Cells applies). */
export function selectionHasMerge(t: Region): boolean {
  return selectedCells(t).some(([i, j]) => {
    const [h, w] = spansFor(t).span(i, j);
    return h > 1 || w > 1;
  });
}

export const setBorders = (id: string, b: Borders) => updateRegion(id, { borders: b === "all" ? undefined : b });
export const setFit = (id: string, on: boolean) =>
  updateRegion(id, (r) => {
    if (on) r.fit = true;
    else delete r.fit;
  });

/** Insert or delete whole rows/columns at the selection; formulas follow. */
export function structure(op: "row_above" | "row_below" | "col_left" | "col_right" | "delete_rows" | "delete_cols") {
  const t = editingTable();
  if (!t) return;
  const { r0, r1, c0, c1 } = range(sel());
  const [h, w] = sizeOf(t);
  const axis = op.includes("row") ? "row" : "col";
  let at: number;
  let delta: number;
  switch (op) {
    case "row_above":
      [at, delta] = [r0, 1];
      break;
    case "row_below":
      [at, delta] = [r1 + 1, 1];
      break;
    case "col_left":
      [at, delta] = [c0, 1];
      break;
    case "col_right":
      [at, delta] = [c1 + 1, 1];
      break;
    case "delete_rows":
      if (r1 - r0 + 1 >= h) return flash("A table keeps at least one row");
      [at, delta] = [r0, -(r1 - r0 + 1)];
      break;
    case "delete_cols":
      if (c1 - c0 + 1 >= w) return flash("A table keeps at least one column");
      [at, delta] = [c0, -(c1 - c0 + 1)];
      break;
  }
  editRows(t.id, (rows, r) => {
    for (const row of rows)
      for (let c = 0; c < row.length; c++)
        if (row[c].startsWith("=")) row[c] = `=${shiftRefs(row[c].slice(1), axis, at, delta)}`;
    // formats and merged cells follow their cells
    if (r.cellFormat) setFormats(r, shiftFormats(formatsOf(r), axis, at, delta));
    if (axis === "row") {
      if (delta > 0) rows.splice(at, 0, ...Array.from({ length: delta }, () => Array(w).fill("")));
      else rows.splice(at, -delta);
    } else {
      for (const row of rows) {
        if (delta > 0) row.splice(at, 0, ...Array(delta).fill(""));
        else row.splice(at, -delta);
      }
      const cols = [...((r.columns as Column[] | undefined) ?? [])];
      if (cols.length > at) {
        if (delta > 0) cols.splice(at, 0, ...Array.from({ length: delta }, () => ({})));
        else cols.splice(at, -delta);
        r.columns = cols;
      }
    }
  });
  if (delta < 0) select(axis === "row" ? Math.min(r0, h + delta - 1) : r0, axis === "col" ? Math.min(c0, w + delta - 1) : c0);
  else if (op === "row_below") select(r1 + 1, c0);
  else if (op === "col_right") select(r0, c1 + 1);
}

// ---------------------------------------------------------------------------
// Clipboard: tab-separated text, what spreadsheets exchange
// ---------------------------------------------------------------------------

/** A cell that starts with `"` is quoted and may hold tabs and line breaks (Excel's Alt+Enter). */
export function parseTsv(text: string): string[][] {
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [[]];
  let i = 0;
  for (;;) {
    let cell = "";
    const quoted = src[i] === '"' ? /^"((?:[^"]|"")*)"(?=\t|\n|$)/.exec(src.slice(i)) : null;
    if (quoted) {
      cell = quoted[1].replace(/""/g, '"');
      i += quoted[0].length;
    } else {
      while (i < src.length && src[i] !== "\t" && src[i] !== "\n") cell += src[i++];
    }
    rows[rows.length - 1].push(cell);
    if (i >= src.length) return rows;
    if (src[i++] === "\n") rows.push([]);
  }
}

const tsvCell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function copyCells(e: ClipboardEvent, cut: boolean) {
  const t = editingTable();
  if (!t || draft() !== null) return;
  const { r0, r1, c0, c1 } = range(sel());
  const rows = rowsOf(t);
  const block = [];
  for (let r = r0; r <= r1; r++) block.push(Array.from({ length: c1 - c0 + 1 }, (_, j) => tsvCell(rows[r]?.[c0 + j] ?? "")).join("\t"));
  e.clipboardData?.setData("text/plain", block.join("\n"));
  e.preventDefault();
  e.stopPropagation();
  if (cut) clearSelection();
}

function pasteCells(e: ClipboardEvent) {
  const t = editingTable();
  if (!t || draft() !== null) return;
  const text = e.clipboardData?.getData("text/plain");
  // a table from Word or a web page may come without tabs in its text
  const html = text?.includes("\t") ? null : tableFromHtml(e.clipboardData?.getData("text/html"));
  e.preventDefault();
  e.stopPropagation();
  if (!text && !html) return;
  const block = html?.rows ?? parseTsv(text!);
  const { r, c } = sel();
  setCells(t.id, [r, c], block);
  setSel({ r, c, r2: r + block.length - 1, c2: c + Math.max(...block.map((b) => b.length)) - 1 });
}

/** Menu commands while a table is being edited; true when handled. */
export function tableCommand(id: string): boolean {
  if (!editingTable() || draft() !== null) return false;
  switch (id) {
    case "duplicate":
      fill("down");
      return true;
    case "select_all": {
      const [h, w] = sizeOf(editingTable()!);
      setSel({ r: 0, c: 0, r2: h - 1, c2: w - 1 });
      return true;
    }
    case "delete":
      clearSelection();
      return true;
  }
  return false;
}

export function tableMenuItems(run: (fn: () => void) => () => void) {
  const t = editingTable();
  const id = t?.id ?? "";
  const { r0, r1, c0, c1 } = range(sel());
  const many = r0 !== r1 || c0 !== c1;
  return [
    { label: "Merge Cells", disabled: !many, run: run(() => mergeSelection(id)) },
    { label: "Split Cells", disabled: !t || !selectionHasMerge(t), run: run(() => splitSelection(id)) },
    null,
    { label: "Bold", shortcut: "⌘B", run: run(() => toggleCells(id, "bold")) },
    { label: "Italic", shortcut: "⌘I", run: run(() => toggleCells(id, "italic")) },
    { label: "Align Left", shortcut: "⌘L", run: run(() => formatCells(id, { align: "left" })) },
    { label: "Align Centre", shortcut: "⌘E", run: run(() => formatCells(id, { align: "center" })) },
    { label: "Align Right", shortcut: "⌘R", run: run(() => formatCells(id, { align: "right" })) },
    null,
    { label: "Insert Row Above", run: run(() => structure("row_above")) },
    { label: "Insert Row Below", run: run(() => structure("row_below")) },
    { label: "Insert Column Left", run: run(() => structure("col_left")) },
    { label: "Insert Column Right", run: run(() => structure("col_right")) },
    null,
    { label: "Delete Rows", run: run(() => structure("delete_rows")) },
    { label: "Delete Columns", run: run(() => structure("delete_cols")) },
    null,
    { label: "Sort Ascending by This Column", run: run(() => sortRows(false)) },
    { label: "Sort Descending by This Column", run: run(() => sortRows(true)) },
    null,
    { label: "Fill Down", shortcut: "⌘D", run: run(() => fill("down")) },
    { label: "Fill Right", run: run(() => fill("right")) },
    { label: "Clear Cells", shortcut: "⌫", run: run(clearSelection) },
    null,
  ];
}

/** What was typed into the size picker: the first characters of the new table's first cell. */
let pendingTyped: string | null = null;

function consumeTyped() {
  const typed = pendingTyped;
  pendingTyped = null;
  if (typed && editingTable()) beginEdit(typed, true);
}

let pickerMounted = false;

/** The size picker lives outside the app's tree: mount it the first time it is needed. */
function mountPicker() {
  if (pickerMounted) return;
  pickerMounted = true;
  const host = document.createElement("div");
  host.className = "table-picker-host";
  document.body.append(host);
  render(() => <TablePicker />, host);
}

const blankRows = (h: number, w: number) => Array.from({ length: h }, () => Array<string>(w).fill(""));

/**
 * Insert ▸ Table. With a click (toolbar, menu) Word's grid opens to choose rows × columns;
 * from the keyboard (⌥⌘T) the default size goes in at once. `rows` (paste, CSV) inserts those.
 */
export function insertTable(rows: string[][], name?: string): string;
export function insertTable(): string | undefined;
export function insertTable(rows?: string[][], name?: string): string | undefined {
  if (!rows) {
    const ev = typeof window !== "undefined" ? (window.event as Event | undefined) : undefined;
    if (!(ev instanceof KeyboardEvent)) {
      mountPicker();
      const target = ev instanceof MouseEvent ? (ev.target as Element | null) : null;
      const button = target?.closest?.(".toolbar button") ?? null;
      const anchor = button ?? (ev instanceof MouseEvent ? { x: ev.clientX, y: ev.clientY } : null);
      openTablePicker(anchor, (h, w, typed) => createTable(blankRows(h, w), undefined, typed, true));
      return;
    }
    return createTable(blankRows(...DEFAULT_TABLE), undefined, undefined, true);
  }
  return createTable(rows, name);
}

/** A table at the insertion point with a header row, ready to type into; `fit`: as wide as the text column. */
function createTable(rows: string[][], name?: string, typed?: string, fit = false) {
  commitEditing();
  // without an insertion point, below everything
  const at = state.caret ?? [36, snap(contentBottom() + LINE)];
  const id = insertRegion({ kind: "table", at, rows, header: { row: true }, ...(fit ? { fit: true } : {}), ...(name ? { name } : {}) });
  setState({ caret: null });
  pendingTyped = typed ?? null;
  startEditing(id);
  setSel({ r: 0, c: 0, r2: 0, c2: 0 });
  focusGrid();
  if (pendingTyped) queueMicrotask(consumeTyped);
  return id;
}

// ---------------------------------------------------------------------------
// CSV files
// ---------------------------------------------------------------------------

/** A cell as it reads on the page: the value of a formula, `#ERROR`, or what was typed. */
export function cellText(raw: string, v: { result: { t: string; c?: unknown } | null; text: string | null; error: string | null } | undefined): string {
  if (v?.error) return "#ERROR";
  if (v?.result?.t === "Str") return String(v.result.c);
  if (v?.text) return prettyValue(v.text);
  return raw.startsWith("=") ? "" : raw;
}

function pickCsv(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/tab-separated-values";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Insert ▸ Table from CSV…: a table of the file's cells, named after the file. */
export async function importCsv() {
  const file = await pickCsv();
  if (!file) return;
  const rows = parseCsv(await file.text());
  if (!rows.length) return flash(`${file.name} has no cells to import`);
  const taken = new Set(layout().list.map((p) => p.region.name));
  const base = tableNameFrom(file.name);
  let name = base;
  for (let n = 2; name && taken.has(name); n++) name = `${base}_${n}`;
  insertTable(rows, name);
  flash(`Imported ${rows.length} rows from ${file.name}${name ? ` as the table ${name}` : ""}`);
}

/** Export as CSV…: the values as shown, in the document language's number format. */
export async function exportCsv(id: string) {
  const t = layout().byId.get(id)?.region;
  if (!t || !isSheet(t)) return;
  const comma = decimalComma(state.doc.meta?.lang);
  const cells = state.views[id]?.cells ?? [];
  const rows = rowsOf(t).map((row, i) =>
    row.map((raw, j) => {
      const text = cellText(raw, cells[i]?.[j]);
      return comma && cells[i]?.[j]?.result && cells[i][j]!.result!.t !== "Str" ? withDecimalComma(text) : text;
    }),
  );
  const csv = toCsv(rows, comma ? ";" : ",");
  const suggested = `${(t.name as string | undefined) ?? "table"}.csv`;
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: suggested, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  try {
    await api.exportCsv(path.toLowerCase().endsWith(".csv") ? path : `${path}.csv`, csv);
    flash(`Exported ${rows.length} rows`);
  } catch (e) {
    flash(`Could not export the table: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

const isNumeric = (e: { t: string } | null | undefined) => !!e && e.t !== "Str";

/** `4.5 'kN/'m` → 4.5 <unit>kN/m</unit>, with superscript powers and ·10ⁿ. */
function cellValueHtml(linear: string): string {
  const pretty = prettyValue(linear);
  const m = /^(-?[\d.]+(?:·10[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)?)\s*(.*)$/.exec(pretty);
  if (!m) return esc(pretty);
  return `<span class="cell-num">${esc(m[1])}</span>${m[2] ? ` <span class="cell-unit">${esc(m[2])}</span>` : ""}`;
}

/** The row-number column while editing. */
const ROW_HEAD_W = 26;
const MIN_COL = 28;
/** A region's left and right padding (styles.css `.region`). */
const REGION_PAD = 6;

/** A table that fits the text column: columns with a width keep it, the others share what is left. */
export function fitWidths(cols: Column[], n: number, total: number): number[] {
  const set = Array.from({ length: n }, (_, j) => cols[j]?.width);
  const fixed = set.reduce<number>((a, w) => a + (w ?? 0), 0);
  const free = set.filter((w) => w === undefined).length;
  const share = free ? Math.max(MIN_COL, (total - fixed) / free) : 0;
  return set.map((w) => w ?? share);
}

/** Small line icons for the table toolbar: alignment as lines of text. */
function AlignIcon(props: { h?: "left" | "center" | "right"; v?: "top" | "middle" | "bottom" }) {
  const lines = props.h
    ? [14, 9, 14, 9].map((w, k) => {
        const x = props.h === "left" ? 1 : props.h === "right" ? 15 - w : (16 - w) / 2;
        return <line x1={x} x2={x + w} y1={3 + k * 3.4} y2={3 + k * 3.4} />;
      })
    : [10, 10].map((w, k) => {
        const y0 = props.v === "top" ? 3 : props.v === "bottom" ? 9.5 : 6.3;
        return <line x1={(16 - w) / 2} x2={(16 - w) / 2 + w} y1={y0 + k * 3.2} y2={y0 + k * 3.2} />;
      });
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      {props.v ? <rect x="0.8" y="0.8" width="14.4" height="14.4" rx="1.5" fill="none" stroke-width="1" opacity="0.55" /> : null}
      {lines}
    </svg>
  );
}

/** Word's Table Design / Layout tabs, in a strip above the table being edited. */
function TableTools(props: { r: Region }) {
  const id = () => props.r.id;
  const fmt = () => activeFormat(props.r);
  const head = () => headerCell(props.r, sel().r, sel().c);
  const keep = (e: Event) => {
    // the grid (or the cell being typed) keeps the keyboard; the canvas doesn't start a drag
    e.preventDefault();
    e.stopPropagation();
  };
  const act = (fn: () => void) => () => {
    if (draft() !== null) commitDraft();
    fn();
    focusGrid();
  };
  const Btn = (p: { label: string; pressed?: boolean; disabled?: boolean; run: () => void; children: JSX.Element; wide?: boolean }) => (
    <button
      class="tt-btn"
      classList={{ wide: !!p.wide }}
      title={p.label}
      aria-label={p.label}
      aria-pressed={p.pressed === undefined ? undefined : p.pressed}
      disabled={p.disabled}
      tabIndex={-1}
      onPointerDown={keep}
      onClick={act(p.run)}
    >
      {/* the glyph is a picture of the label: screen readers read the label */}
      <span aria-hidden="true">{p.children}</span>
    </button>
  );
  const many = () => {
    const { r0, r1, c0, c1 } = range(sel());
    return r0 !== r1 || c0 !== c1;
  };
  return (
    <div class="table-tools" role="toolbar" aria-label="Table tools" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <div class="tt-group" role="group" aria-label="Text">
        <Btn label="Bold (⌘B)" pressed={fmt().bold ?? head()} run={() => toggleCells(id(), "bold")}>
          <b>B</b>
        </Btn>
        <Btn label="Italic (⌘I)" pressed={!!fmt().italic} run={() => toggleCells(id(), "italic")}>
          <i style={{ "font-family": "Georgia, serif" }}>I</i>
        </Btn>
      </div>
      <div class="tt-group" role="group" aria-label="Alignment">
        <For each={["left", "center", "right"] as const}>
          {(h) => (
            <Btn label={`Align ${h === "center" ? "centre" : h}`} pressed={fmt().align === h} run={() => formatCells(id(), { align: fmt().align === h ? undefined : h })}>
              <AlignIcon h={h} />
            </Btn>
          )}
        </For>
        <For each={["top", "middle", "bottom"] as const}>
          {(v) => (
            <Btn label={`Align ${v}`} pressed={(fmt().valign ?? "middle") === v} run={() => formatCells(id(), { valign: v === "middle" ? undefined : v })}>
              <AlignIcon v={v} />
            </Btn>
          )}
        </For>
      </div>
      <div class="tt-group" role="group" aria-label="Shading and borders">
        <label class="tt-select" title="Cell shading">
          <span class="tt-swatch" style={{ background: fmt().fill ?? "transparent" }} aria-hidden="true" />
          <select
            aria-label="Shading"
            value={fmt().fill ?? ""}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (draft() !== null) commitDraft();
              formatCells(id(), { fill: e.currentTarget.value || undefined });
              focusGrid();
            }}
          >
            <For each={SHADES}>{([v, label]) => <option value={v}>{label}</option>}</For>
          </select>
        </label>
        <label class="tt-select" title="Borders">
          <select
            aria-label="Borders"
            value={bordersOf(props.r)}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              setBorders(id(), e.currentTarget.value as Borders);
              focusGrid();
            }}
          >
            <option value="all">All borders</option>
            <option value="outer">Outside borders</option>
            <option value="none">No borders</option>
          </select>
        </label>
      </div>
      <div class="tt-group" role="group" aria-label="Rows and columns">
        <Btn label="Insert row above" run={() => structure("row_above")} wide>
          +row↑
        </Btn>
        <Btn label="Insert row below" run={() => structure("row_below")} wide>
          +row↓
        </Btn>
        <Btn label="Insert column left" run={() => structure("col_left")} wide>
          +column←
        </Btn>
        <Btn label="Insert column right" run={() => structure("col_right")} wide>
          +column→
        </Btn>
        <Btn label="Delete rows" run={() => structure("delete_rows")} wide>
          −rows
        </Btn>
        <Btn label="Delete columns" run={() => structure("delete_cols")} wide>
          −columns
        </Btn>
      </div>
      <div class="tt-group" role="group" aria-label="Merge">
        <Btn label="Merge cells" disabled={!many()} run={() => mergeSelection(id())} wide>
          Merge
        </Btn>
        <Btn label="Split cells" disabled={!selectionHasMerge(props.r)} run={() => splitSelection(id())} wide>
          Split
        </Btn>
      </div>
      <div class="tt-group" role="group" aria-label="Table">
        <Btn
          label="Header row"
          pressed={!!props.r.header?.row}
          run={() => updateRegion(id(), { header: { ...props.r.header, row: !props.r.header?.row } })}
          wide
        >
          Header
        </Btn>
        <Btn label="Fit the text column" pressed={fitsColumn(props.r)} run={() => setFit(id(), !fitsColumn(props.r))} wide>
          ⟷ Fit
        </Btn>
      </div>
    </div>
  );
}

export function SheetGrid(props: { p: Placed }) {
  const r = () => props.p.region;
  // a memo: the placement changes on every layout, editing doesn't (an effect on it would
  // otherwise rerun and drop what is being typed)
  const editing = createMemo(() => state.editing === r().id);
  const size = createMemo(() => sizeOf(r()));
  const rowIdx = createMemo(() => Array.from({ length: size()[0] }, (_, i) => i));
  const colIdx = createMemo(() => Array.from({ length: size()[1] }, (_, i) => i));
  const spans = createMemo(() => spansOf(r(), ...size()));
  const cols = () => columnsOf(r());
  const view = (i: number, j: number) => state.views[r().id]?.cells?.[i]?.[j];
  const raw = (i: number, j: number) => rowsOf(r())[i]?.[j] ?? "";
  const inSel = (i: number, j: number) => {
    if (!editing()) return false;
    const { r0, r1, c0, c1 } = range(sel());
    return i >= r0 && i <= r1 && j >= c0 && j <= c1;
  };
  const active = (i: number, j: number) => editing() && sel().r === i && sel().c === j;

  // Word-like widths: the table fits the text column, its columns share it
  const fit = () => fitsColumn(r());
  const [liveWidths, setLiveWidths] = createSignal<number[] | null>(null);
  // inside the region's padding, so its edges line up with the text's
  const widthsNow = createMemo(() => liveWidths() ?? (fit() ? fitWidths(cols(), size()[1], availableWidth(props.p.x) - REGION_PAD) : null));
  const colWidth = (j: number): number | undefined => widthsNow()?.[j] ?? cols()[j]?.width;
  const tableWidth = () => {
    const w = widthsNow();
    if (!w) return undefined;
    return w.reduce((a, b) => a + b, 0) + (editing() ? ROW_HEAD_W : 0);
  };

  // a new edit starts on the cell that was double-clicked
  createEffect(
    on(editing, (on) => {
      if (on) {
        setDraft(null);
        const hit = untrack(() => pendingCell);
        pendingCell = null;
        if (hit) {
          const [i, j] = anchorOf(untrack(spans), hit[0], hit[1]);
          setSel({ r: i, c: j, r2: i, c2: j });
        } else if (untrack(sel).r >= untrack(size)[0] || untrack(sel).c >= untrack(size)[1]) setSel({ r: 0, c: 0, r2: 0, c2: 0 });
        focusGrid();
        if (pendingTyped) queueMicrotask(consumeTyped);
      } else if (untrack(draft) !== null) {
        setDraft(null);
      }
    }),
  );

  // clicking cells while typing a formula puts their references into it
  let refInsert: { start: number; end: number; from: [number, number] } | null = null;
  const formulaInput = () => document.querySelector<HTMLInputElement>(".region.editing .cell-input");

  const onCellDown = (e: PointerEvent, i: number, j: number) => {
    if (!editing() || e.button !== 0) return;
    const d = draft();
    if (d !== null && d.startsWith("=") && !(sel().r === i && sel().c === j)) {
      e.preventDefault();
      const input = formulaInput();
      if (!input) return;
      const start = input.selectionStart ?? d.length;
      const end = input.selectionEnd ?? d.length;
      const ref = cellName(i, j);
      setDraft(d.slice(0, start) + ref + d.slice(end));
      refInsert = { start, end: start + ref.length, from: [i, j] };
      queueMicrotask(() => input.setSelectionRange(start + ref.length, start + ref.length));
      trackDrag((ci, cj) => {
        if (!refInsert) return;
        const text = ci === refInsert.from[0] && cj === refInsert.from[1] ? ref : `${ref}:${cellName(ci, cj)}`;
        const cur = draft() ?? "";
        setDraft(cur.slice(0, refInsert.start) + text + cur.slice(refInsert.end));
        refInsert.end = refInsert.start + text.length;
        queueMicrotask(() => input.setSelectionRange(refInsert!.end, refInsert!.end));
      });
      return;
    }
    if (d !== null) commitDraft();
    e.preventDefault();
    select(i, j, e.shiftKey);
    focusGrid();
    trackDrag((ci, cj) => select(ci, cj, true));
  };

  const trackDrag = (onCell: (i: number, j: number) => void) => {
    let last = "";
    const move = (ev: PointerEvent) => {
      const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(`[data-sheet="${r().id}"] td[data-r]`);
      if (!td) return;
      const key = `${td.dataset.r},${td.dataset.c}`;
      if (key === last) return;
      last = key;
      onCell(Number(td.dataset.r), Number(td.dataset.c));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      refInsert = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** ⌘B, ⌘I, ⌘L/E/R: Word's shortcuts on the selected cells; true when handled. */
  const formatKey = (e: KeyboardEvent): boolean => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    const align: Record<string, "left" | "center" | "right"> = { l: "left", e: "center", r: "right" };
    if (k === "b" || k === "i") toggleCells(r().id, k === "b" ? "bold" : "italic");
    else if (align[k]) formatCells(r().id, { align: align[k] });
    else return false;
    return true;
  };

  const onGridKey = (e: KeyboardEvent) => {
    if (!editing()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (draft() !== null) {
      // typed faster than the cell's field took the focus: the keys still go into it
      if (e.key.length === 1 && !mod && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setDraft((d) => (d ?? "") + e.key);
        const input = formulaInput();
        if (input) {
          input.focus();
          queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
        }
      }
      return;
    }
    const { r: i, c: j, r2, c2 } = sel();
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key] && !mod) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      if (e.shiftKey) select(r2 + dr, c2 + dc, true);
      else select(...stepFrom(r(), i, j, dr, dc));
    } else if (e.key === "Tab") {
      e.preventDefault();
      tabFrom(r(), e.shiftKey);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      beginEdit(null, false);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      clearSelection();
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitEditing();
    } else if (formatKey(e)) {
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      fill("down");
    } else if (mod && e.key.toLowerCase() === "r" && e.shiftKey) {
      e.preventDefault();
      fill("right");
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      tableCommand("select_all");
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      beginEdit(e.key, true);
    } else return;
    e.stopPropagation();
  };

  const onInputKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitDraft(0, 0, e.shiftKey ? "back" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelDraft();
    } else if (typedOver && !(draft() ?? "").startsWith("=") && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      commitDraft(...d[e.key]);
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ["b", "i"].includes(e.key.toLowerCase())) {
      // the whole cell, as there is no formatting inside a cell
      e.preventDefault();
      commitDraft();
      formatKey(e);
    }
  };

  // column edges on the page (not editing): measured when the pointer comes over the table
  let tableEl!: HTMLTableElement;
  const [edges, setEdges] = createSignal<{ j: number; x: number; h: number }[]>([]);
  const measureEdges = () => {
    if (editing() || !tableEl.rows[0]) return;
    const box = tableEl.getBoundingClientRect();
    const z = state.view.zoom;
    const w = widthsNow();
    if (w) {
      // fitted columns: the edges are the widths, whatever cells are merged
      let x = 0;
      setEdges(w.map((cw, j) => ({ j, x: (x += cw), h: box.height / z })));
      return;
    }
    setEdges([...tableEl.rows[0].cells].map((td, j) => ({ j, x: (td.getBoundingClientRect().right - box.left) / z, h: box.height / z })));
  };
  const setColumnWidth = (j: number, w: number | undefined) =>
    updateRegion(r().id, (reg) => {
      const list = [...((reg.columns as Column[] | undefined) ?? [])];
      while (list.length <= j) list.push({});
      list[j] = { ...list[j], width: w };
      if (w === undefined) delete list[j].width;
      reg.columns = list;
    });

  /** Drag a column's right border, Word-like: the column to the right gives the room, so the table keeps its width. */
  const dragFitted = (e: PointerEvent, j: number) => {
    e.preventDefault();
    e.stopPropagation();
    const w0 = widthsNow()!;
    const n = w0.length;
    const x0 = e.clientX;
    let w = [...w0];
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / state.view.zoom;
      w = [...w0];
      if (j < n - 1) {
        const d = Math.max(MIN_COL - w0[j], Math.min(w0[j + 1] - MIN_COL, dx));
        w[j] = w0[j] + d;
        w[j + 1] = w0[j + 1] - d;
      } else w[j] = Math.max(MIN_COL, w0[j] + dx);
      setLiveWidths(w);
      measureEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLiveWidths(null);
      updateRegion(r().id, (reg) => {
        const list = [...((reg.columns as Column[] | undefined) ?? [])];
        while (list.length < n) list.push({});
        reg.columns = list.map((c, k) => (k < n ? { ...c, width: Math.round(w[k]) } : c));
      });
      measureEdges();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragEdge = (e: PointerEvent, j: number) => {
    if (widthsNow()) return dragFitted(e, j);
    e.preventDefault();
    e.stopPropagation();
    const col = tableEl.querySelectorAll("col")[j] as HTMLTableColElement | undefined;
    const cell = tableEl.rows[0]?.cells[j];
    if (!col || !cell) return;
    const startW = cell.getBoundingClientRect().width / state.view.zoom;
    const x0 = e.clientX;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(MIN_COL, Math.round(startW + (ev.clientX - x0) / state.view.zoom));
      col.style.width = `${w}px`;
      measureEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setColumnWidth(j, w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // column widths: drag the edge of a column letter
  const startResize = (e: PointerEvent, j: number) => {
    if (widthsNow()) return dragFitted(e, j);
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement!;
    const startW = th.getBoundingClientRect().width / state.view.zoom;
    const x0 = e.clientX;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(MIN_COL, Math.round(startW + (ev.clientX - x0) / state.view.zoom));
      th.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setColumnWidth(j, w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const align = (i: number, j: number) => cols()[j]?.align ?? (isNumeric(view(i, j)?.result) ? "right" : "left");

  /** A cell's own format over its column's: alignment, bold, italic, shading. */
  const cellStyle = (i: number, j: number): JSX.CSSProperties => {
    const f = formatAt(r(), i, j);
    return {
      "text-align": f.align ?? align(i, j),
      "vertical-align": f.valign,
      "font-weight": f.bold === true ? "700" : f.bold === false ? "400" : undefined,
      "font-style": f.italic ? "italic" : undefined,
      "background-color": f.fill,
    };
  };

  const cellContent = (i: number, j: number) => {
    const v = view(i, j);
    if (v?.error) return `<span class="cell-err">#ERROR</span>`;
    // compact like a spreadsheet: 4.5 kN/m on one line, units in their colour
    if (v?.result?.t === "Str") return esc(v.result.c);
    if (v?.text) return cellValueHtml(v.text);
    const text = raw(i, j);
    return text.startsWith("=") ? "" : esc(text);
  };

  const onCopy = (e: ClipboardEvent) => copyCells(e, false);
  const onCut = (e: ClipboardEvent) => copyCells(e, true);
  onCleanup(() => setDraft(null));

  return (
    <div
      class="sheet-wrap"
      tabIndex={editing() ? 0 : -1}
      // while editing, a spreadsheet grid whose active cell (B2) a screen reader follows
      role={editing() ? "group" : undefined}
      aria-label={editing() ? `Table ${(r().name as string | undefined) ?? ""}`.trim() : undefined}
      aria-activedescendant={editing() && draft() === null ? `${r().id}-cell-${sel().r}-${sel().c}` : undefined}
      data-sheet={r().id}
      onKeyDown={onGridKey}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={pasteCells}
    >
      <Show when={editing() && !state.printing}>
        <div class="sheet-chrome">
        <TableTools r={r()} />
        <div class="sheet-bar" aria-hidden="true" onPointerDown={(e) => e.stopPropagation()}>
          <span class="sheet-ref">
            {(() => {
              const { r0, r1, c0, c1 } = range(sel());
              return r0 === r1 && c0 === c1 ? cellName(r0, c0) : `${cellName(r0, c0)}:${cellName(r1, c1)}`;
            })()}
          </span>
          <span class="sheet-raw" classList={{ error: !!view(sel().r, sel().c)?.error }}>
            {view(sel().r, sel().c)?.error ?? (raw(sel().r, sel().c) || " ")}
          </span>
        </div>
        </div>
      </Show>
      <table
        ref={tableEl}
        class="sheet"
        classList={{
          "head-row": !!r().header?.row,
          "head-col": !!r().header?.column,
          editing: editing(),
          fit: !!widthsNow(),
          [`borders-${bordersOf(r())}`]: true,
        }}
        style={{ width: tableWidth() !== undefined ? `${tableWidth()}px` : undefined }}
        role={editing() ? "grid" : undefined}
        aria-label={(r().name as string | undefined) ?? "Table"}
        aria-multiselectable={editing() || undefined}
        onPointerEnter={measureEdges}
      >
        <colgroup>
          <Show when={editing()}>
            <col class="row-head-col" style={{ width: widthsNow() ? `${ROW_HEAD_W}px` : undefined }} />
          </Show>
          <For each={colIdx()}>{(j) => <col style={{ width: colWidth(j) ? `${colWidth(j)}px` : undefined }} />}</For>
        </colgroup>
        <Show when={editing()}>
          <thead>
            <tr>
              <th class="corner" aria-label="Select all" onPointerDown={(e) => (e.preventDefault(), tableCommand("select_all"))} />
              <For each={colIdx()}>
                {(j) => (
                  <th
                    class="col-head"
                    classList={{ on: j >= range(sel()).c0 && j <= range(sel()).c1 }}
                    style={{ width: colWidth(j) ? `${colWidth(j)}px` : undefined }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      if (draft() !== null) commitDraft();
                      const h = size()[0] - 1;
                      if (e.shiftKey) setSel((s) => ({ ...s, r: 0, r2: h, c2: j }));
                      else setSel({ r: 0, c: j, r2: h, c2: j });
                      focusGrid();
                    }}
                  >
                    {colName(j)}
                    <span class="col-resize" onPointerDown={(e) => startResize(e, j)} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
        </Show>
        <tbody>
          <For each={rowIdx()}>
            {(i) => (
              <tr classList={{ "head-row-tr": i === 0 && !!r().header?.row }}>
                <Show when={editing()}>
                  <th
                    class="row-head"
                    classList={{ on: i >= range(sel()).r0 && i <= range(sel()).r1 }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      if (draft() !== null) commitDraft();
                      const w = size()[1] - 1;
                      if (e.shiftKey) setSel((s) => ({ ...s, c: 0, c2: w, r2: i }));
                      else setSel({ r: i, c: 0, r2: i, c2: w });
                      focusGrid();
                    }}
                  >
                    {i + 1}
                  </th>
                </Show>
                <For each={colIdx()}>
                  {(j) => (
                    <Show when={!spans().covered.has(`${i},${j}`)}>
                      <td
                        id={`${r().id}-cell-${i}-${j}`}
                        role={editing() ? (i === 0 && r().header?.row ? "columnheader" : "gridcell") : undefined}
                        aria-selected={editing() ? inSel(i, j) : undefined}
                        data-r={i}
                        data-c={j}
                        rowSpan={spans().span(i, j)[0] > 1 ? spans().span(i, j)[0] : undefined}
                        colSpan={spans().span(i, j)[1] > 1 ? spans().span(i, j)[1] : undefined}
                        classList={{
                          sel: inSel(i, j),
                          active: active(i, j),
                          err: !!view(i, j)?.error,
                          formula: !!view(i, j)?.formula,
                          filled: !!formatAt(r(), i, j).fill,
                          "check-pass": !view(i, j)?.error && verdictOf(view(i, j)?.text) === true,
                          "check-fail": !view(i, j)?.error && verdictOf(view(i, j)?.text) === false,
                        }}
                        style={cellStyle(i, j)}
                        title={view(i, j)?.error ?? undefined}
                        onPointerDown={(e) => onCellDown(e, i, j)}
                        onDblClick={(e) => {
                          if (!editing()) return;
                          e.stopPropagation();
                          select(i, j);
                          beginEdit(null, false);
                        }}
                        onContextMenu={() => {
                          if (editing() && !inSel(i, j)) select(i, j);
                        }}
                      >
                        <Show when={editing()}>
                          <span class="sr-only">{cellName(i, j)} </span>
                        </Show>
                        <Show when={active(i, j) && draft() !== null} fallback={<span class="cell" innerHTML={cellContent(i, j)} />}>
                          <input
                            class="cell-input"
                            aria-label={`Cell ${cellName(i, j)}`}
                            value={draft() ?? ""}
                            spellcheck={false}
                            autocomplete="off"
                            onInput={(e) => setDraft(e.currentTarget.value)}
                            onKeyDown={onInputKey}
                            onPointerDown={(e) => e.stopPropagation()}
                          />
                        </Show>
                      </td>
                    </Show>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      {/* outside editing: drag a column's edge to resize it, double-click to fit its contents */}
      <Show when={!editing() && !state.printing}>
        <For each={edges()}>
          {(e) => (
            <div
              class="col-grip"
              style={{ left: `${e.x - 3}px`, height: `${e.h}px` }}
              title="Drag to resize · double-click to fit"
              onPointerDown={(ev) => dragEdge(ev, e.j)}
              onDblClick={(ev) => {
                ev.stopPropagation();
                setColumnWidth(e.j, undefined);
              }}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

/** The cell a double-click on a table landed on, for the edit it starts. */
let pendingCell: [number, number] | null = null;

export function cellAtPoint(x: number, y: number): [number, number] | null {
  const td = document.elementFromPoint(x, y)?.closest<HTMLElement>("td[data-r]");
  return td ? [Number(td.dataset.r), Number(td.dataset.c)] : null;
}

/** Start editing a table at the double-clicked cell. */
export function editTableAt(id: string, at?: [number, number]) {
  pendingCell = at ? cellAtPoint(at[0], at[1]) : null;
  startEditing(id, at);
}
