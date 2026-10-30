// Mirrors quire_ast::Expr as serialized by serde (adjacently tagged: { t, c }).
export type UnaryOp = "Neg" | "Pos" | "PlusMinus" | "Not";
export type BinaryOp = "Or" | "And" | "Add" | "Sub" | "PlusMinus" | "Mul" | "Div" | "Mod" | "Pow" | "Juxt";
export type CmpOp = "Eq" | "Ne" | "Lt" | "Le" | "Gt" | "Ge";

export type Expr =
  | { t: "Num"; c: string }
  | { t: "Ident"; c: string }
  | { t: "Unit"; c: string }
  | { t: "Str"; c: string }
  | { t: "Placeholder" }
  | { t: "Paren"; c: Expr }
  | { t: "Unary"; c: [UnaryOp, Expr] }
  | { t: "Factorial"; c: Expr }
  | { t: "Binary"; c: [BinaryOp, Expr, Expr] }
  | { t: "Compare"; c: [Expr, [CmpOp, Expr][]] }
  | { t: "Call"; c: [string, Expr[]] }
  | { t: "Index"; c: [Expr, Expr[]] }
  | { t: "Matrix"; c: Expr[][] }
  | { t: "Range"; c: [Expr, Expr] }
  | { t: "Define"; c: { lhs: Expr; rhs: Expr; global: boolean } };

/** quire_service::RegionView */
export interface RegionView {
  id: string;
  input: Expr | null;
  result: Expr | null;
  resultText: string | null;
  error: string | null;
  syntaxError: boolean;
  /** Plain names that mean units in this region (`2 m`). */
  units: string[];
  /** Plain names that mean built-in constants here (`g`, `c`). */
  constants: string[];
  /** Your variables here that hide a built-in constant. */
  shadowing: string[];
  /** Your variables read as a unit here because they follow a number (`10 m`). */
  unitsOverVariables?: string[];
  defines: string | null;
  /** A spreadsheet table's cells. */
  cells?: CellView[][];
  /** Units the result can be shown in, with the result in each. */
  unitChoices?: UnitChoice[];
  /** A one-click repair for `error`. */
  fix?: Fix;
  /** A plot's series, in its axis units. */
  plot?: PlotView;
  /** The result is symbolic (`→`). */
  symbolic?: boolean;
}

/** quire_service::PlotView */
export interface PlotView {
  /** Axis units (`kN*m`); empty for plain numbers. */
  xUnit: string;
  yUnit: string;
  /** The series as drawn (for an animation, its last frame). */
  series: PlotSeriesView[];
  /** Whether the axes are drawn (SMath's `axes`). */
  axes: boolean;
  /** Whether grid lines are drawn. */
  grid: boolean;
  /** One unit of x is drawn as long as one unit of y. */
  equal: boolean;
  /** Every frame's series, for an animated plot. */
  frames?: PlotSeriesView[][];
  /** Frames per second, for an animated plot. */
  fps?: number;
  /** A 3D plot: its axis units and series (the fields above are then unused). */
  three?: Plot3View;
}

/** quire_service::Plot3View */
export interface Plot3View {
  /** The x, y and z axis units; empty for plain numbers. */
  units: [string, string, string];
  series: Plot3SeriesView[];
}

/** quire_service::Series3View. `null` marks a point that could not be computed. */
export interface Plot3SeriesView {
  /** `surface`: a grid of points row by row, `cols` to a row; `curve`: points in order. */
  shape: "surface" | "curve";
  cols: number;
  xs: (number | null)[];
  ys: (number | null)[];
  zs: (number | null)[];
  error: string | null;
}

/** quire_service::SeriesView. `null` marks a gap (a point that could not be computed). */
export interface PlotSeriesView {
  xs: (number | null)[];
  ys: (number | null)[];
  error: string | null;
  /** Whether consecutive points are joined by a line. */
  connect: boolean;
  /** Per point: its marker, or `null` for a point of the line. Absent for a plain line. */
  marks?: (PlotMarkView | null)[];
}

/** quire_service::MarkView: SMath's marker on one point. */
export interface PlotMarkView {
  /** `.`, `o`, `+`, `x`, `*`, or `text` for a label. */
  shape: string;
  /** SMath's size number (a label's font size). */
  size: number;
  /** A CSS colour; absent for the series' colour. */
  color?: string;
  /** A label's words. */
  text?: string;
}

/** quire_service::FixView */
export type Fix = { kind: "rename"; from: string; to: string } | { kind: "definedBelow"; id: string };

/** quire_service::UnitChoice */
export interface UnitChoice {
  /** What to type after `=` (`kN*m`). */
  unit: string;
  /** The result in it, linear syntax (`54 'kN*'m`). */
  text: string;
}

/** quire_service::CellView */
export interface CellView {
  result: Expr | null;
  text: string | null;
  error: string | null;
  formula: boolean;
}

/** quire_service::Gloss */
export interface Gloss {
  title: string;
  value: string;
  meanings: ("constant" | "unit")[];
}

export interface LibraryEntry {
  name: string;
  title: string;
  value: string;
}

export interface Library {
  constants: LibraryEntry[];
  units: LibraryEntry[];
}

/** quire_service::Report */
export interface Report {
  regions: RegionView[];
  html: Record<string, string>;
  elapsedMs: number;
  errorCount: number;
  documentErrors: string[];
  /** What this version could not read in the document; it is kept as it is. */
  warnings: string[];
  /** Keyed `unit:<name>` / `constant:<name>`. */
  glossary: Record<string, Gloss>;
}

export type Localized = string | Record<string, string>;

/** A region of document.json (docs/02-file-format.md §4). Unknown keys are preserved. */
export interface Region {
  id: string;
  kind: string;
  at: [number, number];
  size?: [number, number];
  width?: number;
  height?: number;
  expr?: string;
  show?: "value" | "symbolic";
  display?: { unit?: string; decimals?: number };
  note?: string;
  text?: Localized;
  src?: string;
  source?: string | null;
  title?: Localized;
  collapsed?: boolean;
  caption?: { text: Localized; position?: "above" | "below" };
  header?: { row?: boolean; column?: boolean };
  style?: { font?: string; size?: number };
  regions?: Region[];
  [key: string]: unknown;
}

export interface TextStyle {
  font?: string;
  size?: number;
}

export interface Doc {
  format: string;
  meta?: { title?: Localized; lang?: string; [key: string]: unknown };
  styles?: {
    body?: TextStyle;
    math?: TextStyle;
    numbering?: { headings?: string; figures?: string; tables?: string; sections?: string };
    [key: string]: unknown;
  };
  page?: { paper?: string | [string, string]; margins?: Record<string, string | number>; [key: string]: unknown };
  regions: Region[];
  [key: string]: unknown;
}
