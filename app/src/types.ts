// Mirrors quire_ast::Expr as serialized by serde (adjacently tagged: { t, c }).
export type UnaryOp = "Neg" | "Pos" | "PlusMinus" | "Not";
export type BinaryOp = "Or" | "And" | "Add" | "Sub" | "PlusMinus" | "Mul" | "Div" | "Mod" | "Pow" | "Juxt";
export type CmpOp = "Eq" | "Ne" | "Lt" | "Le" | "Gt" | "Ge";

export type Expr =
  | { t: "Num"; c: string }
  | { t: "Ident"; c: string }
  | { t: "Unit"; c: string }
  /** A built-in constant whatever variables are defined: `#G`. */
  | { t: "Const"; c: string }
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
  /** Pass or fail of a line that is only a comparison, with or without `=`. */
  check?: boolean;
  error: string | null;
  syntaxError: boolean;
  /** Plain names that mean units in this region (`2 m`). */
  units: string[];
  /** Plain names that mean built-in constants here (`g`, `c`). */
  constants: string[];
  /** Your variables here that hide a built-in constant. */
  shadowing: string[];
  /** Plain names read as units where a variable is more usual (`W` in `M/W`, no `W` defined). */
  namesReadAsUnits?: { name: string; unit?: string }[];
  defines: string | null;
  /** The built-in unit or constant the name this region defines hides below it. */
  redefines?: Redefines;
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

/** quire_service::Redefines: `T := 300` hides the unit tesla. */
export interface Redefines {
  name: string;
  kind: "unit" | "constant";
  title: string;
}

/** quire_service::Completion: one meaning a name can have where it is typed. */
export interface Completion {
  name: string;
  kind: "variable" | "function" | "unit" | "constant";
  /** The text that gives the name this meaning there: `T`, `'T`, `#G`. */
  insert: string;
  preview: string;
  /** What a unit or constant is called: `degree Celsius`. */
  title?: string;
  /** What it measures: `temperature`. */
  quantity?: string;
  /** A unit only ever written quoted (`'c`, `'%`): listed only after a `'`. */
  quotedOnly?: boolean;
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
  /** What the unit is called: `kilonewton metre`. */
  title?: string;
  /** What it measures: `energy, moment`. */
  quantity?: string;
}

/** quire_service::CellView */
export interface CellView {
  result: Expr | null;
  text: string | null;
  error: string | null;
  formula: boolean;
  /** Pass or fail, for a cell that reads as one (`OK`, `FAIL`); absent for any other. */
  verdict?: boolean;
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

export interface PlotStyle {
  color?: string;
  width?: number;
  dash?: "dashed" | "dotted";
  draw?: "line" | "points" | "line+points";
}

export interface PlotSeries {
  y?: string;
  x?: string;
  range?: string;
  label?: string;
  style?: PlotStyle;
  surface?: string;
  parametric?: [string, string, string];
  xrange?: string;
  yrange?: string;
  urange?: string;
  vrange?: string;
}

export interface PlotAxis {
  unit?: string;
  label?: string;
  min?: number;
  max?: number;
  log?: boolean;
}

export interface PlotAxes {
  visible?: boolean;
  x?: PlotAxis;
  y?: PlotAxis;
  z?: PlotAxis;
}

/** A region of document.json (docs/02-file-format.md §4). Unknown keys are preserved. */
export interface Region {
  id: string;
  kind: string;
  at: [number, number];
  size?: [number, number];
  width?: number;
  height?: number;
  style?: TextStyle;
  keep?: boolean;
  disabled?: boolean;
  locked?: boolean;
  collapsed?: boolean;
  of?: "headings" | "figures" | "tables" | "checks";
  title?: Localized;
  name?: string;
  expr?: string;
  guesses?: string[];
  given?: string[];
  find?: string;
  show?: "value" | "symbolic";
  mode?: "numeric" | "symbolic";
  hideInput?: boolean;
  display?: { unit?: string; decimals?: number; notation?: "auto" | "sci" | "eng" | "fixed" };
  note?: string;
  /** Where `note` sits: right of the formula (default), left of it, above or below it (notePosition.ts). */
  notePosition?: "right" | "below" | "left" | "above";
  text?: Localized;
  src?: string;
  alt?: Localized;
  source?: string | null;
  header?: { row?: boolean; column?: boolean };
  columns?: { width?: number; align?: "left" | "center" | "right" | "decimal"; unit?: string; decimals?: number }[];
  rows?: string[][];
  series?: PlotSeries[];
  surface?: string;
  parametric?: [string, string, string];
  xrange?: string;
  yrange?: string;
  range?: string;
  urange?: string;
  vrange?: string;
  axes?: boolean | PlotAxes;
  grid?: boolean;
  aspect?: "auto" | "equal";
  animate?: { var: string; over: string; fps?: number };
  extrema?: boolean;
  /** `false` / `"none"` or `"top-left" | "top-right" | "bottom-left" | "bottom-right"`. */
  legend?: boolean | string;
  palette?: "default" | "smath";
  render?: string;
  camera?: { azimuth?: number; elevation?: number; distance?: number };
  caption?: { text: Localized; position?: "above" | "below"; numbered?: boolean };
  color?: string;
  background?: string;
  border?: boolean;
  regions?: Region[];
  [key: string]: unknown;
}

export interface TextStyle {
  ref?: string;
  font?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

export type Length = number | string;

export interface DocSettings {
  display?: {
    decimals?: number;
    exponentialThreshold?: number;
    approxEqualDigits?: number;
    trailingZeros?: boolean;
    resultUnits?: "si" | "working";
    notation?: "auto" | "engineering" | "prefix";
    sigFigs?: number;
    groupDigits?: boolean;
    fractions?: "decimal" | "fraction" | "mixed";
    decimalSeparator?: "auto" | "." | ",";
    [key: string]: unknown;
  };
  calc?: { angle?: "rad" | "deg" | "grad"; precision?: "double" | "arbitrary"; [key: string]: unknown };
  units?: {
    system?: "SI" | "US" | "Imperial" | "CGS";
    prefer?: Record<string, string>;
    quietNames?: string[];
    marked?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Doc {
  format: string;
  meta?: {
    title?: Localized;
    authors?: string[];
    company?: string;
    subject?: Localized;
    keywords?: string | string[];
    id?: string;
    lang?: string;
    source?: Record<string, unknown>;
    templateDescription?: string;
    [key: string]: unknown;
  };
  settings?: DocSettings;
  units?: Record<string, string>;
  styles?: {
    body?: TextStyle;
    math?: TextStyle;
    /** Which built-in typography applies where the styles say nothing: absent = 1 (typography.ts). */
    typography?: number;
    numbering?: {
      headings?: string | null;
      figures?: string | null;
      tables?: string | null;
      sections?: string | null;
    };
    [key: string]: unknown;
  };
  page?: {
    view?: "pages" | "canvas";
    paper?: string | [Length, Length];
    orientation?: "portrait" | "landscape";
    margins?: Record<string, Length>;
    header?: object;
    footer?: object;
    firstPage?: { header?: boolean; footer?: boolean };
    backgrounds?: { pages?: string; src: string; fit?: "page" | "margins" }[];
    pageNumber?: { start?: number; style?: "arabic" | "roman" | "ROMAN" };
    [key: string]: unknown;
  };
  requires?: string[];
  regions: Region[];
  [key: string]: unknown;
}
