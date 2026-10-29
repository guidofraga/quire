//! Editor backend shared by the desktop app (Tauri commands) and `quire serve`
//! (the same API over localhost HTTP, for developing the UI in a browser).
//!
//! The editor holds the document as JSON; every call takes or returns that JSON,
//! so unknown keys survive editing untouched.

pub mod assets;
pub mod canonical;
pub mod notebook;
pub mod templates;
mod text;

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use base64::Engine;
use quire_ast::{Expr, parse};
use quire_doc::Document;
use quire_eval::{
    Animate, DisplaySettings, DisplaySpec, Fix, Marker, MathInput, Notation, Outcome, PlotInput, PlotOutcome,
    SeriesInput, SeriesOutcome, TableInput, Worksheet,
};
use serde::Serialize;
use serde_json::{Value as Json, json};

pub use text::{inline_math, render_djot, render_djot_editable, render_djot_with_math};

#[derive(Debug)]
pub struct ServiceError(pub String);

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ServiceError {}

impl From<std::io::Error> for ServiceError {
    fn from(e: std::io::Error) -> Self {
        ServiceError(e.to_string())
    }
}

impl From<serde_json::Error> for ServiceError {
    fn from(e: serde_json::Error) -> Self {
        ServiceError(format!("invalid document: {e}"))
    }
}

impl From<quire_doc::DocError> for ServiceError {
    fn from(e: quire_doc::DocError) -> Self {
        ServiceError(e.0)
    }
}

pub type Result<T> = std::result::Result<T, ServiceError>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

pub struct Evaluated {
    pub inputs: Vec<MathInput>,
    pub outcomes: Vec<Outcome>,
    pub worksheet: Worksheet,
    pub elapsed_ms: f64,
    /// Custom unit definitions that failed: (name, message).
    pub unit_errors: Vec<(String, String)>,
}

pub fn settings_of(doc: &Document) -> DisplaySettings {
    let d = &doc.settings.display;
    let base = DisplaySettings::default();
    DisplaySettings {
        decimals: d.decimals.unwrap_or(base.decimals),
        exponential_threshold: d.exponential_threshold.unwrap_or(base.exponential_threshold),
        trailing_zeros: d.trailing_zeros.unwrap_or(base.trailing_zeros),
        working_units: d.result_units.as_deref() == Some("working"),
        notation: match d.notation.as_deref() {
            Some("engineering") => Notation::Engineering,
            Some("prefix") => Notation::Prefix,
            _ => Notation::Auto,
        },
        sig_figs: d.sig_figs.filter(|n| *n > 0),
        marked_units: marked_units(doc),
    }
}

/// `"settings": {"units": {"marked": true}}`: SMath documents, where every unit is written
/// quoted (`'m`) and a bare name is always a variable.
fn marked_units(doc: &Document) -> bool {
    doc.settings.extra.get("units").and_then(|u| u.get("marked")).and_then(Json::as_bool).unwrap_or(false)
}

fn display_of(r: &quire_doc::Region) -> DisplaySpec {
    DisplaySpec {
        unit: r.display.as_ref().and_then(|d| d.unit.clone()),
        decimals: r.display.as_ref().and_then(|d| d.decimals),
    }
}

/// A literal table (`"rows"`): cells are text, values or `=` formulas.
fn table_input(r: &quire_doc::Region) -> TableInput {
    let cell = |v: &Json| match v {
        Json::String(s) => s.clone(),
        Json::Null => String::new(),
        other => other.to_string(),
    };
    let rows = r
        .extra
        .get("rows")
        .and_then(Json::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| row.as_array().map(|c| c.iter().map(cell).collect()).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    let columns = r
        .extra
        .get("columns")
        .and_then(Json::as_array)
        .map(|cols| {
            cols.iter()
                .map(|c| DisplaySpec {
                    unit: c
                        .get("unit")
                        .and_then(Json::as_str)
                        .filter(|u| !u.trim().is_empty())
                        .map(String::from),
                    decimals: c.get("decimals").and_then(Json::as_u64).map(|d| d as u32),
                })
                .collect()
        })
        .unwrap_or_default();
    TableInput {
        name: r.extra.get("name").and_then(Json::as_str).map(String::from),
        rows,
        columns,
        display: display_of(r),
    }
}

/// A `plot2d` region's series and axis units (docs/02-file-format.md §4.7).
fn plot_input(r: &quire_doc::Region) -> PlotInput {
    let text = |v: Option<&Json>| {
        v.and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
    };
    let series = r
        .extra
        .get("series")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .map(|s| SeriesInput {
                    y: text(s.get("y")).unwrap_or_default(),
                    x: text(s.get("x")),
                    range: text(s.get("range")),
                })
                .collect()
        })
        .unwrap_or_default();
    let axis = |a: &str| text(r.extra.get("axes").and_then(|x| x.get(a)).and_then(|x| x.get("unit")));
    // `axes` is a boolean or an object of axis settings; only `false` hides them
    // `"axes": false`, or a window with `"visible": false` (an SMath plot drawn without axes)
    let axes = match r.extra.get("axes") {
        Some(Json::Bool(b)) => *b,
        Some(a) => a.get("visible").and_then(Json::as_bool).unwrap_or(true),
        None => true,
    };
    let grid = !matches!(r.extra.get("grid"), Some(Json::Bool(false)));
    let equal = text(r.extra.get("aspect")).as_deref() == Some("equal");
    let animate = r.extra.get("animate").and_then(|a| {
        let var = text(a.get("var"))?;
        let over = text(a.get("over"))?;
        let fps = a.get("fps").and_then(Json::as_f64).filter(|f| f.is_finite() && *f > 0.0);
        Some(Animate { var, over, fps: fps.unwrap_or(quire_eval::DEFAULT_FPS) })
    });
    PlotInput { series, x_unit: axis("x"), y_unit: axis("y"), axes, grid, equal, animate }
}

/// Trailing `→` (or `->`) inside text asks for the expression worked out symbolically.
fn split_symbolic(expr: &str) -> Option<String> {
    let t = expr.trim_end();
    t.strip_suffix('→').or_else(|| t.strip_suffix("->")).map(|rest| rest.trim_end().to_string())
}

/// Trailing `=` asks for the result (`` $`A =` `` inside text).
fn split_show(expr: &str) -> (String, bool) {
    let t = expr.trim_end();
    match t.strip_suffix('=') {
        Some(rest) if !rest.ends_with(['=', ':', '<', '>', '!', '≠']) => {
            (rest.trim_end().to_string(), true)
        }
        _ => (expr.to_string(), false),
    }
}

/// Math in evaluation order: math regions, inline math inside text (`<id>:m<n>`) and,
/// with `tables`, bound tables (`"source"`), so the editor can show their matrix.
pub fn math_inputs(doc: &Document, tables: bool) -> Vec<MathInput> {
    let lang = doc.meta.get("lang").and_then(Json::as_str);
    let mut out = Vec::new();
    for p in doc.flatten() {
        let r = p.region;
        if r.disabled {
            continue;
        }
        match r.kind.as_str() {
            "math" => {
                if let Some(expr) = &r.expr {
                    let symbolic = r.show.as_deref() == Some("symbolic");
                    let show = r.show.is_some() && !symbolic;
                    out.push(MathInput {
                        id: r.id.clone(),
                        expr: expr.clone(),
                        show,
                        display: display_of(r),
                        table: None,
                        plot: None,
                        symbolic,
                    });
                }
            }
            "text" => {
                let Some(text) = r.extra.get("text").and_then(|t| localized(t, lang)) else { continue };
                for (n, m) in inline_math(text).into_iter().enumerate() {
                    let symbolic = split_symbolic(&m);
                    let (expr, show) = match &symbolic {
                        Some(e) => (e.clone(), false),
                        None => split_show(&m),
                    };
                    let symbolic = symbolic.is_some();
                    out.push(MathInput {
                        id: format!("{}:m{n}", r.id),
                        expr,
                        show,
                        display: DisplaySpec::default(),
                        table: None,
                        plot: None,
                        symbolic,
                    });
                }
            }
            // a spreadsheet table always runs: it may define a variable for the math below
            "table" if r.extra.get("rows").is_some_and(Json::is_array) => {
                out.push(MathInput {
                    id: r.id.clone(),
                    expr: String::new(),
                    show: false,
                    display: display_of(r),
                    table: Some(table_input(r)),
                    plot: None,
                    symbolic: false,
                });
            }
            "plot2d" => {
                out.push(MathInput {
                    id: r.id.clone(),
                    expr: String::new(),
                    show: false,
                    display: DisplaySpec::default(),
                    table: None,
                    plot: Some(plot_input(r)),
                    symbolic: false,
                });
            }
            "table" if tables => {
                if let Some(src) = r.extra.get("source").and_then(Json::as_str) {
                    out.push(MathInput {
                        id: r.id.clone(),
                        expr: src.to_string(),
                        show: true,
                        display: display_of(r),
                        table: None,
                        plot: None,
                        symbolic: false,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Milliseconds since an arbitrary start; the browser build has no clock here (its caller
/// times the call instead).
#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1e3
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    0.0
}

fn run(doc: &Document, tables: bool) -> Evaluated {
    let start = now_ms();
    let mut worksheet = Worksheet::new(settings_of(doc));
    let unit_errors = doc
        .units
        .iter()
        .filter_map(|(name, def)| worksheet.define_unit(name, def).err().map(|e| (name.clone(), e.message)))
        .collect();
    let inputs = math_inputs(doc, tables);
    let outcomes = worksheet.run(&inputs);
    Evaluated { inputs, outcomes, worksheet, elapsed_ms: now_ms() - start, unit_errors }
}

/// Evaluate the math regions of a document (what `quire eval`/`check` use).
pub fn evaluate(doc: &Document) -> Evaluated {
    run(doc, false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionView {
    pub id: String,
    /// Parsed input, for 2D rendering. `None` on a syntax error.
    pub input: Option<Expr>,
    pub result: Option<Expr>,
    pub result_text: Option<String>,
    pub error: Option<String>,
    pub syntax_error: bool,
    /// Plain names that mean units here (`2 m`), drawn as units.
    pub units: Vec<String>,
    /// Plain names that mean built-in constants here (`g`, `c`).
    pub constants: Vec<String>,
    /// Your variables here that hide a built-in constant.
    pub shadowing: Vec<String>,
    /// Your variables read as a unit here because they follow a number (`10 m`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub units_over_variables: Vec<String>,
    /// The name this region defines (`L`, `f(x)`), for the editor's knowledge of variables.
    pub defines: Option<String>,
    /// A spreadsheet table's cells, row-major.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<Vec<CellView>>>,
    /// Units the result can be shown in, with the result in each (`30 'cm`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unit_choices: Vec<UnitChoice>,
    /// A one-click repair for `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<FixView>,
    /// A 2D plot's series, in its axis units.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot: Option<PlotView>,
    /// The result is the expression worked out symbolically (shown after `→`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub symbolic: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotView {
    /// Axis units (`kN*m`), empty for plain numbers.
    pub x_unit: String,
    pub y_unit: String,
    /// The series as drawn (for an animation, its last frame).
    pub series: Vec<SeriesView>,
    pub axes: bool,
    pub grid: bool,
    /// One unit of x is drawn as long as one of y.
    pub equal: bool,
    /// Every frame's series, for an animated plot.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<Vec<SeriesView>>,
    /// Frames per second, for an animated plot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesView {
    /// `null` where a point could not be computed (a gap in the line).
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub error: Option<String>,
    /// Whether consecutive points are joined by a line.
    pub connect: bool,
    /// Per point: its marker, or `null` for a point of the line. Empty for a plain line.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<Option<MarkView>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkView {
    /// `.`, `o`, `+`, `x`, `*`, or `text` for a label.
    pub shape: String,
    /// SMath's size number (a label's font size).
    pub size: f64,
    /// A CSS colour; absent for the series' colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// A label's words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

fn series_view(s: &SeriesOutcome) -> SeriesView {
    SeriesView {
        xs: s.xs.clone(),
        ys: s.ys.clone(),
        error: s.error.clone(),
        connect: s.connect,
        marks: s.marks.iter().map(|m| m.as_ref().map(mark_view)).collect(),
    }
}

fn mark_view(m: &Marker) -> MarkView {
    MarkView { shape: m.shape.clone(), size: m.size, color: m.color.clone(), text: m.text.clone() }
}

fn plot_view(p: &PlotOutcome) -> PlotView {
    PlotView {
        x_unit: p.x.unit.clone(),
        y_unit: p.y.unit.clone(),
        series: p.series.iter().map(series_view).collect(),
        axes: p.axes,
        grid: p.grid,
        equal: p.equal,
        frames: p.frames.iter().map(|f| f.iter().map(series_view).collect()).collect(),
        fps: p.fps,
    }
}

fn fix_view(f: &Fix, inputs: &[MathInput]) -> FixView {
    match f {
        Fix::Rename { from, to } => FixView::Rename { from: from.clone(), to: to.clone() },
        Fix::DefinedBelow { index } => FixView::DefinedBelow {
            id: inputs.get(*index).map_or_else(String::new, |input| input.id.clone()),
        },
    }
}

/// quire_eval::Fix, with regions named by id.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FixView {
    /// Write `to` in place of the name `from`.
    Rename { from: String, to: String },
    /// The name is defined further down, by region `id`.
    DefinedBelow { id: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitChoice {
    /// What to type after `=` (`kN*m`).
    pub unit: String,
    /// The result in it, linear syntax.
    pub text: String,
}

/// Units offered for a result, smallest first within each kind; only those of the
/// result's kind are shown.
const UNIT_CHOICES: &[&str] = &[
    "mm", "cm", "m", "km", "in", "ft", "mm^2", "cm^2", "m^2", "ft^2", "mm^3", "cm^3", "L", "m^3", "mm^4",
    "cm^4", "m^4", "g", "kg", "t", "lb", "N", "kN", "MN", "kgf", "tf", "lbf", "kip", "N/m", "kN/m", "kgf/m",
    "tf/m", "N/m^2", "kN/m^2", "kgf/m^2", "tf/m^2", "Pa", "kPa", "MPa", "GPa", "N/mm^2", "kgf/cm^2", "bar",
    "psi", "ksi", "N/m^3", "kN/m^3", "kgf/m^3", "kg/m^3", "t/m^3", "N*m", "kN*m", "kgf*m", "tf*m", "kN*cm",
    "J", "kJ", "kW*h", "W", "kW", "hp", "s", "min", "h", "day", "m/s", "km/h", "m/s^2", "Hz", "K", "°C",
    "°F",
];

fn unit_choices(
    value: Option<&quire_eval::Value>,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &quire_units::UnitRegistry,
    candidates: &[(&'static str, quire_units::Dim)],
) -> Vec<UnitChoice> {
    let Some(v @ quire_eval::Value::Num(q)) = value else { return Vec::new() };
    if q.dim.is_dimensionless() {
        return Vec::new();
    }
    candidates
        .iter()
        .filter(|(_, d)| *d == q.dim)
        .filter_map(|(u, _)| {
            let spec = DisplaySpec { unit: Some((*u).to_string()), decimals: spec.decimals };
            quire_eval::format_value(v, &spec, settings, units)
                .ok()
                .map(|text| UnitChoice { unit: (*u).to_string(), text })
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellView {
    /// The value, for 2D rendering; `None` for text and blank cells.
    pub result: Option<Expr>,
    /// The same in linear syntax (`4.5 'kN/'m`).
    pub text: Option<String>,
    pub error: Option<String>,
    pub formula: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub regions: Vec<RegionView>,
    /// Rendered Djot for text regions, area titles and captions, keyed by region id
    /// (captions use `<id>:caption`, area titles `<id>:title`).
    pub html: BTreeMap<String, String>,
    pub elapsed_ms: f64,
    pub error_count: usize,
    pub document_errors: Vec<String>,
    /// What each unit/constant used in the document means, keyed `unit:<name>` / `constant:<name>`.
    pub glossary: BTreeMap<String, Gloss>,
}

/// The meaning of a plain name, for tooltips and disambiguation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gloss {
    pub title: String,
    /// The value in linear syntax, e.g. `9.80665 'm/'s^2`.
    pub value: String,
    /// Every meaning the name can have: "constant", "unit".
    pub meanings: Vec<&'static str>,
}

fn quantity_text(v: f64, dim: quire_units::Dim, units: &quire_units::UnitRegistry) -> String {
    let settings = DisplaySettings { decimals: 10, exponential_threshold: 6, ..Default::default() };
    quire_eval::format_value(
        &quire_eval::Value::Num(quire_eval::Quantity::new(v, dim)),
        &DisplaySpec::default(),
        &settings,
        units,
    )
    .unwrap_or_default()
}

fn meanings(name: &str, units: &quire_units::UnitRegistry) -> Vec<&'static str> {
    let mut m = Vec::new();
    if quire_eval::constant(name).is_some() {
        m.push("constant");
    }
    if units.lookup(name).is_some() {
        m.push("unit");
    }
    m
}

fn constant_gloss(name: &str, units: &quire_units::UnitRegistry) -> Option<Gloss> {
    let c = quire_eval::constant(name)?;
    Some(Gloss {
        title: c.title.to_string(),
        value: quantity_text(c.value, c.dim(), units),
        meanings: meanings(name, units),
    })
}

fn unit_gloss(name: &str, units: &quire_units::UnitRegistry) -> Option<Gloss> {
    let u = units.lookup(name)?;
    let value = quantity_text(u.factor, u.dim, units);
    let (title, value) =
        if value == format!("1 '{name}") { ("SI unit", String::new()) } else { ("unit", value) };
    Some(Gloss { title: title.to_string(), value, meanings: meanings(name, units) })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub name: String,
    pub title: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub constants: Vec<LibraryEntry>,
    pub units: Vec<LibraryEntry>,
}

/// Constants and units for the editor's symbol library.
pub fn library() -> Library {
    let units = quire_units::UnitRegistry::new();
    let constants = quire_eval::CONSTANTS
        .iter()
        .filter(|c| !matches!(c.name, "pi" | "∞"))
        .map(|c| LibraryEntry {
            name: c.name.to_string(),
            title: c.title.to_string(),
            value: quantity_text(c.value, c.dim(), &units),
        })
        .collect();
    let unit_list = quire_units::UnitRegistry::builtin()
        .into_iter()
        .map(|(name, u, prefixable)| LibraryEntry {
            name: name.to_string(),
            title: if prefixable { "unit · takes SI prefixes".into() } else { "unit".into() },
            value: quantity_text(u.factor, u.dim, &units),
        })
        .collect();
    Library { constants, units: unit_list }
}

/// Pick the text for the document language from a localized value: the document's language,
/// else English, else the first one written. SMath worksheets carry several translations and
/// no document language, often with Russian first.
fn localized<'a>(v: &'a Json, lang: Option<&str>) -> Option<&'a str> {
    match v {
        Json::String(s) => Some(s),
        Json::Object(m) => lang
            .and_then(|l| m.iter().find(|(k, _)| l.starts_with(k.as_str())))
            .or_else(|| m.iter().find(|(k, _)| k.as_str() == "en"))
            .or_else(|| m.iter().next())
            .and_then(|(_, v)| v.as_str()),
        _ => None,
    }
}

/// Everything the editor needs to draw a document: evaluation results plus rendered text.
pub fn report(doc_json: &Json) -> Result<Report> {
    let doc: Document = serde_json::from_value(doc_json.clone())?;
    let ev = run(&doc, true);
    let units = ev.worksheet.units();
    let candidates: Vec<(&'static str, quire_units::Dim)> = UNIT_CHOICES
        .iter()
        .filter_map(|u| quire_eval::parse_unit_spec(u, units).ok().map(|s| (*u, s.dim)))
        .collect();
    let mut regions = Vec::with_capacity(ev.inputs.len());
    let mut error_count = 0;
    for (input, o) in ev.inputs.iter().zip(&ev.outcomes) {
        if let Some(p) = &o.plot {
            if o.error.is_some() {
                error_count += 1;
            }
            regions.push(RegionView {
                id: input.id.clone(),
                input: None,
                result: None,
                result_text: None,
                error: o.error.clone(),
                syntax_error: false,
                units: o.units.clone(),
                constants: o.constants.clone(),
                shadowing: Vec::new(),
                units_over_variables: Vec::new(),
                defines: None,
                cells: None,
                unit_choices: Vec::new(),
                fix: o.fix.as_ref().map(|f| fix_view(f, &ev.inputs)),
                plot: Some(plot_view(p)),
                symbolic: false,
            });
            continue;
        }
        if input.table.is_some() {
            if o.error.is_some() {
                error_count += 1;
            }
            let cells = o
                .cells
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|c| CellView {
                            result: c.shown.as_deref().and_then(|s| parse(s).ok()),
                            text: c.shown.clone(),
                            error: c.error.clone(),
                            formula: c.formula,
                        })
                        .collect()
                })
                .collect();
            regions.push(RegionView {
                id: input.id.clone(),
                input: None,
                result: None,
                result_text: None,
                error: o.error.clone(),
                syntax_error: false,
                units: o.units.clone(),
                constants: o.constants.clone(),
                shadowing: Vec::new(),
                units_over_variables: Vec::new(),
                defines: o.defines.clone(),
                cells: Some(cells),
                unit_choices: Vec::new(),
                fix: None,
                plot: None,
                symbolic: false,
            });
            continue;
        }
        let parsed = parse(&input.expr);
        let syntax_error = parsed.is_err();
        if o.error.is_some() {
            error_count += 1;
        }
        regions.push(RegionView {
            id: input.id.clone(),
            input: parsed.ok(),
            result: o.shown.as_deref().and_then(|s| parse(s).ok()),
            result_text: o.shown.clone(),
            error: o.error.clone(),
            syntax_error,
            units: o.units.clone(),
            constants: o.constants.clone(),
            shadowing: o.shadowing.clone(),
            units_over_variables: o.units_over_variables.clone(),
            defines: o.defines.clone(),
            cells: None,
            unit_choices: if input.show && o.error.is_none() {
                unit_choices(o.value.as_ref(), &input.display, ev.worksheet.settings(), units, &candidates)
            } else {
                Vec::new()
            },
            fix: o.fix.as_ref().map(|f| fix_view(f, &ev.inputs)),
            plot: None,
            symbolic: input.symbolic,
        });
    }

    let lang = doc.meta.get("lang").and_then(Json::as_str);
    let mut html = BTreeMap::new();
    for p in doc.flatten() {
        let r = p.region;
        if let Some(t) = r.extra.get("text").and_then(|t| localized(t, lang)) {
            html.insert(r.id.clone(), render_djot_with_math(t, &r.id));
        }
        if let Some(t) = r.extra.get("title").and_then(|t| localized(t, lang)) {
            html.insert(format!("{}:title", r.id), render_djot(t));
        }
        if let Some(t) = r.extra.get("caption").and_then(|c| c.get("text")).and_then(|t| localized(t, lang)) {
            html.insert(format!("{}:caption", r.id), render_djot(t));
        }
        if let Some(t) = r.extra.get("note").and_then(Json::as_str) {
            html.insert(format!("{}:note", r.id), render_djot(t));
        }
    }

    let document_errors = ev.unit_errors.iter().map(|(n, m)| format!("unit {n}: {m}")).collect();
    // keyed by meaning ("unit:g", "constant:g"): one name can mean both in different places
    let mut glossary = BTreeMap::new();
    for v in &regions {
        for name in &v.units {
            if let Some(g) = unit_gloss(name, units) {
                glossary.entry(format!("unit:{name}")).or_insert(g);
            }
        }
        for name in v.constants.iter().chain(&v.shadowing) {
            if let Some(g) = constant_gloss(name, units) {
                glossary.entry(format!("constant:{name}")).or_insert(g);
            }
        }
    }
    Ok(Report { regions, html, elapsed_ms: ev.elapsed_ms, error_count, document_errors, glossary })
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// The bundle directory for a path that may point at the bundle or its document.json.
pub fn bundle_dir(path: &Path) -> PathBuf {
    if path.file_name().is_some_and(|n| n == "document.json") {
        path.parent().unwrap_or(Path::new(".")).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

/// Load a bundle's document as JSON (validated against the model first). An SMath
/// Studio worksheet (`.sm`) is converted; see [`open_smath`].
pub fn open(path: &Path) -> Result<Json> {
    if is_smath_file(path) {
        return open_smath(&std::fs::read(path)?, path.file_name().and_then(|n| n.to_str()));
    }
    if quire_doc::is_single_file(path) {
        quire_doc::load(path)?;
        let bytes = quire_doc::read_entry(path, "document.json")?.unwrap_or_default();
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let dir = bundle_dir(path);
    quire_doc::load(&dir)?;
    let text = std::fs::read_to_string(dir.join("document.json"))?;
    Ok(serde_json::from_str(&text)?)
}

/// A scratch folder that removes itself.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Result<Self> {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("quire-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write `document.json` canonically (regions sorted, fixed key order).
/// Other bundle files (assets, results.json) are left untouched.
///
/// `from` is the bundle the document was opened from: on Save As its images are
/// copied along. Images inserted since opening are written from the staging area.
pub fn save(path: &Path, doc: &Json, from: Option<&Path>) -> Result<()> {
    if is_smath_file(path) {
        return Err(ServiceError(
            "an SMath worksheet is not saved over: save to a .quire or .quirez file".into(),
        ));
    }
    let _: Document = serde_json::from_value(doc.clone())?;
    // images to carry over may sit inside a single file: unpack it first
    let unpacked = match from {
        Some(f) if quire_doc::is_single_file(f) && f.is_file() => {
            let t = TempDir::new("from")?;
            quire_doc::unpack(f, &t.0)?;
            Some(t)
        }
        _ => None,
    };
    let from = unpacked.as_ref().map(|t| t.0.as_path()).or(from);
    if quire_doc::is_single_file(path) {
        let work = TempDir::new("save")?;
        if let Some(results) = from.map(|f| bundle_dir(f).join("results.json")).filter(|p| p.is_file()) {
            std::fs::copy(results, work.0.join("results.json"))?;
        }
        write_bundle(&work.0, doc, from)?;
        quire_doc::pack(&work.0, path)?;
        return Ok(());
    }
    write_bundle(&bundle_dir(path), doc, from)
}

fn write_bundle(dir: &Path, doc: &Json, from: Option<&Path>) -> Result<()> {
    let dir = dir.to_path_buf();
    std::fs::create_dir_all(&dir)?;
    assets::write_into(&dir, doc, from.map(bundle_dir).as_deref())?;
    let mut doc = doc.clone();
    canonical::sort_regions(&mut doc);
    let tmp = dir.join(".document.json.tmp");
    std::fs::write(&tmp, canonical::to_string(&doc))?;
    std::fs::rename(&tmp, dir.join("document.json"))?;
    Ok(())
}

/// A document held in memory, for the browser build: a `.quirez` (its images are staged, so
/// `read_asset` finds them) or a bare `document.json`.
pub fn open_bytes(bytes: &[u8]) -> Result<Json> {
    if is_smath(bytes) {
        return open_smath(bytes, None);
    }
    let doc: Json = if bytes.first() == Some(&b'{') {
        serde_json::from_slice(bytes)?
    } else {
        let mut doc = None;
        for (name, data) in quire_doc::read_bytes(bytes)? {
            if name == "document.json" {
                doc = Some(serde_json::from_slice(&data)?);
            } else if name.starts_with("assets/") {
                // a file that isn't a well-formed asset name is ignored, as on disk
                let _ = assets::stage_named(&name, data);
            }
        }
        doc.ok_or_else(|| ServiceError("not a Quire document: there is no document.json in it".into()))?
    };
    let _: Document = serde_json::from_value(doc.clone())?;
    Ok(doc)
}

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// An SMath Studio worksheet is named `.sm` (any case); its contents decide the rest.
fn is_smath_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("sm"))
}

/// SMath worksheets are XML: after an optional byte-order mark and whitespace, a `<` and
/// the worksheet namespace (or a bare `<regions>` root from SMath 0.55).
fn is_smath(bytes: &[u8]) -> bool {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    let start = body.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(body.len());
    let body = body.get(start..).unwrap_or_default();
    let contains = |needle: &[u8]| body.windows(needle.len()).any(|w| w == needle);
    body.first() == Some(&b'<') && (contains(b"smath.info/schemas/worksheet") || contains(b"<regions"))
}

/// Convert the bytes of an SMath worksheet with `quire_smath`: the document and its images.
/// `file_name` (`Beam.sm`) is recorded as the document's source when known.
pub fn import_smath(bytes: &[u8], file_name: Option<&str>) -> Result<quire_smath::Imported> {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    let text = std::str::from_utf8(body)
        .map_err(|e| ServiceError(format!("not a readable SMath worksheet: {e}")))?;
    match file_name {
        Some(name) => quire_smath::convert_file(text, name),
        None => quire_smath::convert(text),
    }
    .map_err(|e| ServiceError(e.to_string()))
}

/// An SMath worksheet as an unsaved document. Its images are staged like the ones a `.quirez`
/// brings, so they show without a bundle on disk. The caller starts it without a path, so
/// Save asks for a new file and the `.sm` is never written.
fn open_smath(bytes: &[u8], file_name: Option<&str>) -> Result<Json> {
    let imported = import_smath(bytes, file_name)?;
    let _: Document = serde_json::from_value(imported.document.clone())?;
    for asset in imported.assets {
        assets::stage_named(&asset.path, asset.data)?;
    }
    Ok(imported.document)
}

/// A document as `.quirez` bytes, with the images it uses (they must have been staged).
pub fn save_bytes(doc: &Json) -> Result<Vec<u8>> {
    let _: Document = serde_json::from_value(doc.clone())?;
    let mut doc = doc.clone();
    canonical::sort_regions(&mut doc);
    let mut entries = vec![("document.json".to_string(), canonical::to_string(&doc).into_bytes())];
    for src in assets::referenced(&doc) {
        if let Some(bytes) = assets::staged(&src) {
            entries.push((src, bytes));
        }
    }
    Ok(quire_doc::write_bytes(entries)?)
}

pub fn new_document() -> Json {
    json!({
        "format": quire_doc::FORMAT_MAJOR,
        "meta": { "title": "Untitled" },
        "settings": { "display": { "decimals": 4 } },
        "page": {
            "view": "pages",
            "paper": "A4",
            "margins": { "top": "20mm", "right": "20mm", "bottom": "20mm", "left": "20mm" },
            "footer": { "right": "{page} / {pages}" }
        },
        "regions": []
    })
}

/// Asset references are content-addressed names inside the bundle: `assets/<16 hex>.<ext>`.
pub fn checked_asset(src: &str) -> Result<&str> {
    let ok = src.strip_prefix("assets/").and_then(|f| f.split_once('.')).is_some_and(|(hash, ext)| {
        hash.len() == 16
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
            && !ext.is_empty()
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    if ok { Ok(src) } else { Err(ServiceError(format!("not a bundle asset: {src}"))) }
}

/// An image asset as a `data:` URL (images are few; this avoids exposing the filesystem).
pub fn read_asset(bundle: &Path, src: &str) -> Result<String> {
    let src = checked_asset(src)?;
    let mime = assets::mime(src).ok_or_else(|| ServiceError(format!("{src} is not an image")))?;
    let bytes = match assets::staged(src) {
        Some(b) => b,
        None if quire_doc::is_single_file(bundle) => quire_doc::read_entry(bundle, src)?
            .ok_or_else(|| ServiceError(format!("{src} is missing from {}", bundle.display())))?,
        None => std::fs::read(bundle_dir(bundle).join(src))?,
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    #[test]
    fn a_garbage_sm_file_is_an_error_not_a_panic() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let path = std::env::temp_dir().join(format!("quire-garbage-{}.SM", std::process::id()));
        std::fs::write(&path, "not an SMath worksheet")?;
        let opened = open(&path);
        std::fs::remove_file(&path)?;
        assert!(opened.is_err(), "garbage must not open");
        assert!(open_bytes(b"<regions").is_err(), "a truncated worksheet must not open");
        assert!(open_bytes(b"\xEF\xBB\xBF  <?xml version=\"1.0\"?><smath.info/schemas/worksheet>").is_err());
        assert!(open_bytes(b"\xFF\xFE<regions").is_err(), "invalid UTF-8 must not open");
        Ok(())
    }

    #[test]
    fn an_smath_worksheet_opens_as_a_document() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let xml = concat!(
            r#"<regions xmlns="http://smath.info/schemas/worksheet/1.0"><settings/>"#,
            r#"<region left="0" top="0" width="200" height="20"><text><p>Hello</p></text></region>"#,
            r#"<region left="0" top="40" width="200" height="30"><math><input>"#,
            r#"<e type="operand">x</e><e type="operand">2</e><e type="operator" args="2">:</e>"#,
            r#"</input></math></region></regions>"#
        );
        let doc = open_bytes(xml.as_bytes())?;
        let exprs: Vec<&str> =
            doc["regions"].as_array().into_iter().flatten().filter_map(|r| r["expr"].as_str()).collect();
        assert_eq!(exprs, ["x := 2"]);
        Ok(())
    }

    #[test]
    fn results_offer_the_units_they_can_be_shown_in() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "a", "kind": "math", "at": [0, 0], "expr": "d:=30 cm" },
                { "id": "b", "kind": "math", "at": [0, 30], "expr": "d", "show": "value" },
                { "id": "c", "kind": "math", "at": [0, 60], "expr": "2*3", "show": "value" },
                { "id": "e", "kind": "math", "at": [0, 90], "expr": "F:=10 N", "show": "value", "display": { "unit": "kg" } }
            ]
        });
        let r = report(&doc)?;
        let view = |id: &str| r.regions.iter().find(|v| v.id == id).ok_or_else(|| format!("no region {id}"));
        let choices: Vec<(&str, &str)> =
            view("b")?.unit_choices.iter().map(|c| (c.unit.as_str(), c.text.as_str())).collect();
        assert_eq!(&choices[..3], [("mm", "300 'mm"), ("cm", "30 'cm"), ("m", "0.3 'm")]);
        assert!(choices.iter().all(|(u, _)| !u.contains('N')), "only lengths: {choices:?}");
        assert!(view("c")?.unit_choices.is_empty(), "plain numbers have no units to pick");
        assert!(view("a")?.unit_choices.is_empty(), "only shown results");
        // a unit of another kind keeps the rest in SI
        assert_eq!(view("e")?.result_text.as_deref(), Some("10 'kg*'m/'s^2"));
        assert!(view("e")?.unit_choices.iter().any(|c| c.unit == "kN"));
        Ok(())
    }

    /// A small saved bundle with text, math, inline math and an image, in a temp folder.
    fn fixture(tag: &str) -> std::result::Result<PathBuf, Box<dyn std::error::Error>> {
        let src = assets::stage(PNG.to_vec(), "png")?;
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "head01", "kind": "text", "at": [0, 0], "text": "# Loads" },
                { "id": "prose1", "kind": "text", "at": [0, 36], "text": "Width $`b := 20 'cm` and depth $`h := 40 'cm`" },
                { "id": "areaa1", "kind": "math", "at": [0, 72], "expr": "A := b*h", "show": "value" },
                { "id": "weight", "kind": "math", "at": [0, 108], "expr": "W := 2 'kg*g", "show": "value" },
                { "id": "scheme", "kind": "image", "at": [0, 144], "size": [10, 10], "src": src,
                  "caption": { "text": "Static scheme" } }
            ]
        });
        let dir = std::env::temp_dir().join(format!("quire-{tag}-{}.quire", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save(&dir, &doc, None)?;
        Ok(dir)
    }

    #[test]
    fn documents_round_trip_in_memory_with_their_images()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let src = assets::stage(vec![0x89, b'P', b'N', b'G', 1], "png")?;
        let mut doc = new_document();
        doc["regions"] = json!([{ "id": "a", "kind": "image", "at": [0, 0], "src": src }]);
        let saved = quire_doc::read_bytes(&save_bytes(&doc)?)?;
        assert_eq!(
            saved.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            ["document.json", src.as_str()]
        );

        // opening stages the images it carries, so they show without a bundle on disk
        let other = "assets/00000000000000aa.png";
        doc["regions"][0]["src"] = json!(other);
        let bytes = quire_doc::write_bytes(vec![
            ("document.json".into(), canonical::to_string(&doc).into_bytes()),
            (other.into(), vec![0x89, b'P', b'N', b'G', 2]),
        ])?;
        assert_eq!(open_bytes(&bytes)?["regions"][0]["src"], json!(other));
        assert!(read_asset(Path::new(""), other)?.starts_with("data:image/png;base64,"));
        // a bare document.json opens too, and anything else says what it is not
        assert_eq!(open_bytes(canonical::to_string(&doc).as_bytes())?["meta"], doc["meta"]);
        assert!(open_bytes(b"PK nonsense").err().is_some_and(|e| e.0.contains("not a Quire document")));
        Ok(())
    }

    #[test]
    fn report_for_a_document() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture("report")?;
        let doc = open(&dir)?;
        std::fs::remove_dir_all(&dir)?;
        let r = report(&doc)?;
        let area =
            r.regions.iter().find(|v| v.result_text.as_deref() == Some("0.08 'm^2")).ok_or("no area")?;
        assert!(area.input.is_some() && area.result.is_some());
        // 2 math regions + 2 inline in the paragraph
        assert_eq!(r.regions.len(), 4);
        assert_eq!(r.error_count, 0);
        assert!(r.html.values().any(|h| h.contains("<h1>Loads</h1>")));
        assert!(r.html.contains_key("scheme:caption"));
        assert!(r.glossary.contains_key("constant:g"));
        Ok(())
    }

    #[test]
    fn marked_units_setting_reaches_the_engine() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let regions = serde_json::json!([
            { "id": "aaaaaa", "kind": "math", "at": [0, 0], "expr": "c", "show": "value" },
            { "id": "bbbbbb", "kind": "math", "at": [0, 40], "expr": "10 'm", "show": "value" },
            { "id": "cccccc", "kind": "math", "at": [0, 80], "expr": "10 c", "show": "value" },
            { "id": "dddddd", "kind": "math", "at": [0, 120], "expr": "10 c", "show": "symbolic" }
        ]);
        let doc = |settings: Json| serde_json::json!({ "format": "quire/1", "settings": settings, "regions": regions.clone() });
        // unmarked: `c` is the speed of light and `m` is metres
        let plain = report(&doc(serde_json::json!({})))?;
        assert!(plain.regions[0].error.is_none(), "c is a constant unless the document is marked");
        assert_ne!(plain.regions[2].result_text.as_deref(), Some("10*c"));
        // marked (SMath): a bare `c` with no value is a symbol, not the speed of light, so
        // `=` (a number) says it is not defined, `→` works with it, and quoted units still work
        let marked = report(&doc(serde_json::json!({ "units": { "marked": true } })))?;
        assert_eq!(marked.regions[0].error.as_deref(), Some("c is not defined"));
        assert_eq!(marked.regions[1].result_text.as_deref(), Some("10 'm"));
        assert_eq!(marked.regions[2].error.as_deref(), Some("c is not defined"));
        assert_eq!(marked.regions[3].result_text.as_deref(), Some("10*c"));
        let unmarked: Document =
            serde_json::from_value(doc(serde_json::json!({ "units": { "marked": false } })))?;
        assert!(!settings_of(&unmarked).marked_units);
        Ok(())
    }

    #[test]
    fn inline_math_in_text_is_evaluated_in_reading_order()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "aaaaaa", "kind": "text", "at": [0, 0], "text": "Span $`L := 2 'm` and area $`L^2 =`" },
                { "id": "bbbbbb", "kind": "math", "at": [0, 40], "expr": "L*3", "show": "value" }
            ]
        });
        let r = report(&doc)?;
        let by_id = |id: &str| r.regions.iter().find(|v| v.id == id).ok_or_else(|| format!("no region {id}"));
        assert_eq!(by_id("aaaaaa:m1")?.result_text.as_deref(), Some("4 'm^2"));
        assert_eq!(by_id("bbbbbb")?.result_text.as_deref(), Some("6 'm"));
        assert!(r.html["aaaaaa"].contains(r#"data-math="aaaaaa:m0""#));
        assert_eq!(split_show("a ≤ b ="), ("a ≤ b".to_string(), true));
        assert_eq!(split_show("x := 1"), ("x := 1".to_string(), false));
        assert_eq!(split_show("a <="), ("a <=".to_string(), false));
        Ok(())
    }

    #[test]
    fn staged_images_are_written_and_save_as_copies_assets()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let png = b"\x89PNG\r\n\x1a\nfake".to_vec();
        let src = assets::stage(png.clone(), "PNG")?;
        assert!(src.starts_with("assets/") && src.ends_with(".png"));
        assert!(read_asset(Path::new("/nonexistent"), &src)?.starts_with("data:image/png;base64,"));
        let original = fixture("saveas-src")?;
        let mut doc = open(&original)?;
        let carried = doc["regions"][4]["src"].as_str().ok_or("no image")?.to_string();
        doc["regions"].as_array_mut().ok_or("no regions")?.push(serde_json::json!(
            { "id": "zzzzzz", "kind": "image", "at": [0, 9000], "size": [10, 10], "src": src }
        ));
        let dir = std::env::temp_dir().join(format!("quire-saveas-test-{}.quire", std::process::id()));
        save(&dir, &doc, Some(&original))?;
        assert_eq!(std::fs::read(dir.join(&src))?, png);
        assert!(dir.join(&carried).exists(), "existing images are carried over");
        std::fs::remove_dir_all(&dir)?;
        std::fs::remove_dir_all(&original)?;
        assert!(assets::stage(vec![1, 2, 3], "exe").is_err());
        Ok(())
    }

    #[test]
    fn glossary_explains_units_and_constants() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "aaaaaa", "kind": "math", "at": [0, 0], "expr": "m := 500 g" },
                { "id": "bbbbbb", "kind": "math", "at": [0, 40], "expr": "F := m*g", "show": "value" }
            ]
        });
        let r = report(&doc)?;
        assert_eq!(r.glossary["unit:g"].value, "0.001 'kg");
        assert_eq!(r.glossary["constant:g"].title, "standard gravity");
        assert_eq!(r.glossary["constant:g"].meanings, ["constant", "unit"]);
        let lib = library();
        assert!(lib.constants.iter().any(|c| c.name == "k.B"));
        assert!(lib.units.iter().any(|u| u.name == "kgf") || lib.units.iter().any(|u| u.name == "gf"));
        Ok(())
    }

    #[test]
    fn assets_cannot_escape_the_bundle() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture("assets")?;
        let src = open(&dir)?["regions"][4]["src"].as_str().ok_or("no image")?.to_string();
        assert!(read_asset(&dir, "../../Cargo.toml").is_err());
        assert!(read_asset(&dir, "assets/../../../x.png").is_err());
        assert!(read_asset(&dir, &src)?.starts_with("data:image/png;base64,"));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn single_file_documents_round_trip() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = fixture("single")?;
        let doc = open(&dir)?;
        let src = doc["regions"][4]["src"].as_str().ok_or("no image")?.to_string();
        let file = std::env::temp_dir().join(format!("quire-single-{}.quirez", std::process::id()));
        save(&file, &doc, Some(&dir))?;
        std::fs::remove_dir_all(&dir)?;
        assert!(file.is_file());
        assert_eq!(open(&file)?, doc);
        assert!(read_asset(&file, &src)?.starts_with("data:image/png;base64,"));
        assert!(read_asset(&file, "assets/0000000000000000.png").is_err());
        // saving over itself keeps the images; saving back out as a folder works too
        save(&file, &doc, Some(&file))?;
        assert!(read_asset(&file, &src).is_ok());
        let back = std::env::temp_dir().join(format!("quire-unpacked-{}.quire", std::process::id()));
        save(&back, &doc, Some(&file))?;
        assert!(back.join(&src).is_file());
        assert_eq!(report(&open(&file)?)?.error_count, 0);
        assert!(quire_doc::load(&file).is_ok());
        std::fs::remove_file(&file)?;
        std::fs::remove_dir_all(&back)?;
        Ok(())
    }

    #[test]
    fn save_then_open_is_identical() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let first = fixture("save-a")?;
        let doc = open(&first)?;
        let dir = std::env::temp_dir().join(format!("quire-save-test-{}.quire", std::process::id()));
        save(&dir, &doc, Some(&first))?;
        let original = std::fs::read_to_string(first.join("document.json"))?;
        let written = std::fs::read_to_string(dir.join("document.json"))?;
        std::fs::remove_dir_all(&dir)?;
        std::fs::remove_dir_all(&first)?;
        assert_eq!(written, original);
        Ok(())
    }

    #[test]
    fn several_translations_and_no_document_language_read_in_english() {
        let v = serde_json::json!({ "ru": "Входные данные:", "en": "Input data:", "ind": "Data masukan:" });
        assert_eq!(localized(&v, None), Some("Input data:"));
        assert_eq!(localized(&v, Some("pt-BR")), Some("Input data:"));
        assert_eq!(localized(&v, Some("ru")), Some("Входные данные:"));
        assert_eq!(localized(&serde_json::json!({ "ru": "Только" }), None), Some("Только"));
    }
}
