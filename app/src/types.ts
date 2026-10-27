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
  defines: string | null;
  /** A spreadsheet table's cells. */
  cells?: CellView[][];
  /** Units the result can be shown in, with the result in each. */
  unitChoices?: UnitChoice[];
}

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
    numbering?: { headings?: string; figures?: string; tables?: string };
    [key: string]: unknown;
  };
  page?: { paper?: string | [string, string]; margins?: Record<string, string | number>; [key: string]: unknown };
  regions: Region[];
  [key: string]: unknown;
}
