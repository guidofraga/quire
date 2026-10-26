//! Editor backend shared by the desktop app (Tauri commands) and `quire serve`
//! (the same API over localhost HTTP, for developing the UI in a browser).
//!
//! The editor holds the document as JSON; every call takes or returns that JSON,
//! so unknown keys survive editing untouched.

pub mod assets;
pub mod canonical;
mod text;

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use quire_ast::{Expr, parse};
use quire_doc::Document;
use quire_eval::{DisplaySettings, DisplaySpec, MathInput, Outcome, Worksheet};
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
    }
}

fn display_of(r: &quire_doc::Region) -> DisplaySpec {
    DisplaySpec {
        unit: r.display.as_ref().and_then(|d| d.unit.clone()),
        decimals: r.display.as_ref().and_then(|d| d.decimals),
    }
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
                    let show = r.show.is_some();
                    out.push(MathInput {
                        id: r.id.clone(),
                        expr: expr.clone(),
                        show,
                        display: display_of(r),
                    });
                }
            }
            "text" => {
                let Some(text) = r.extra.get("text").and_then(|t| localized(t, lang)) else { continue };
                for (n, m) in inline_math(text).into_iter().enumerate() {
                    let (expr, show) = split_show(&m);
                    out.push(MathInput {
                        id: format!("{}:m{n}", r.id),
                        expr,
                        show,
                        display: DisplaySpec::default(),
                    });
                }
            }
            "table" if tables => {
                if let Some(src) = r.extra.get("source").and_then(Json::as_str) {
                    out.push(MathInput {
                        id: r.id.clone(),
                        expr: src.to_string(),
                        show: true,
                        display: display_of(r),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn run(doc: &Document, tables: bool) -> Evaluated {
    let start = Instant::now();
    let mut worksheet = Worksheet::new(settings_of(doc));
    let unit_errors = doc
        .units
        .iter()
        .filter_map(|(name, def)| worksheet.define_unit(name, def).err().map(|e| (name.clone(), e.message)))
        .collect();
    let inputs = math_inputs(doc, tables);
    let outcomes = worksheet.run(&inputs);
    Evaluated { inputs, outcomes, worksheet, elapsed_ms: start.elapsed().as_secs_f64() * 1e3, unit_errors }
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
    /// The name this region defines (`L`, `f(x)`), for the editor's knowledge of variables.
    pub defines: Option<String>,
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
    let settings = DisplaySettings { decimals: 10, exponential_threshold: 6, trailing_zeros: false };
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

/// Pick the text for the document language from a localized value.
fn localized<'a>(v: &'a Json, lang: Option<&str>) -> Option<&'a str> {
    match v {
        Json::String(s) => Some(s),
        Json::Object(m) => lang
            .and_then(|l| m.iter().find(|(k, _)| l.starts_with(k.as_str())))
            .or_else(|| m.iter().next())
            .and_then(|(_, v)| v.as_str()),
        _ => None,
    }
}

/// Everything the editor needs to draw a document: evaluation results plus rendered text.
pub fn report(doc_json: &Json) -> Result<Report> {
    let doc: Document = serde_json::from_value(doc_json.clone())?;
    let ev = run(&doc, true);
    let mut regions = Vec::with_capacity(ev.inputs.len());
    let mut error_count = 0;
    for (input, o) in ev.inputs.iter().zip(&ev.outcomes) {
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
            defines: o.defines.clone(),
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
    let units = ev.worksheet.units();
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

/// Load a bundle's document as JSON (validated against the model first).
pub fn open(path: &Path) -> Result<Json> {
    let dir = bundle_dir(path);
    quire_doc::load(&dir)?;
    let text = std::fs::read_to_string(dir.join("document.json"))?;
    Ok(serde_json::from_str(&text)?)
}

/// Write `document.json` canonically (regions sorted, fixed key order).
/// Other bundle files (assets, results.json) are left untouched.
///
/// `from` is the bundle the document was opened from: on Save As its images are
/// copied along. Images inserted since opening are written from the staging area.
pub fn save(path: &Path, doc: &Json, from: Option<&Path>) -> Result<()> {
    let _: Document = serde_json::from_value(doc.clone())?;
    let dir = bundle_dir(path);
    std::fs::create_dir_all(&dir)?;
    assets::write_into(&dir, doc, from.map(bundle_dir).as_deref())?;
    let mut doc = doc.clone();
    canonical::sort_regions(&mut doc);
    let tmp = dir.join(".document.json.tmp");
    std::fs::write(&tmp, canonical::to_string(&doc))?;
    std::fs::rename(&tmp, dir.join("document.json"))?;
    Ok(())
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
pub(crate) fn checked_asset(src: &str) -> Result<&str> {
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
        None => std::fs::read(bundle_dir(bundle).join(src))?,
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/beam-check.quire")
    }

    #[test]
    fn report_for_sample() {
        let doc = open(&sample()).unwrap();
        let r = report(&doc).unwrap();
        let area = r.regions.iter().find(|v| v.result_text.as_deref() == Some("800 'cm^2")).unwrap();
        assert!(area.input.is_some() && area.result.is_some());
        // 19 math regions + 2 inline in the loads paragraph
        assert_eq!(r.regions.len(), 21);
        assert_eq!(r.error_count, 0);
        assert!(r.html.values().any(|h| h.contains("<h1>Loads</h1>")));
        assert!(r.html.contains_key("scheme:caption"));
        assert!(r.glossary.contains_key("constant:g"));
    }

    #[test]
    fn inline_math_in_text_is_evaluated_in_reading_order() {
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "aaaaaa", "kind": "text", "at": [0, 0], "text": "Span $`L := 2 'm` and area $`L^2 =`" },
                { "id": "bbbbbb", "kind": "math", "at": [0, 40], "expr": "L*3", "show": "value" }
            ]
        });
        let r = report(&doc).unwrap();
        let by_id = |id: &str| r.regions.iter().find(|v| v.id == id).unwrap();
        assert_eq!(by_id("aaaaaa:m1").result_text.as_deref(), Some("4 'm^2"));
        assert_eq!(by_id("bbbbbb").result_text.as_deref(), Some("6 'm"));
        assert!(r.html["aaaaaa"].contains(r#"data-math="aaaaaa:m0""#));
        assert_eq!(split_show("a ≤ b ="), ("a ≤ b".to_string(), true));
        assert_eq!(split_show("x := 1"), ("x := 1".to_string(), false));
        assert_eq!(split_show("a <="), ("a <=".to_string(), false));
    }

    #[test]
    fn staged_images_are_written_and_save_as_copies_assets() {
        let png = b"\x89PNG\r\n\x1a\nfake".to_vec();
        let src = assets::stage(png.clone(), "PNG").unwrap();
        assert!(src.starts_with("assets/") && src.ends_with(".png"));
        assert!(read_asset(Path::new("/nonexistent"), &src).unwrap().starts_with("data:image/png;base64,"));
        let mut doc = open(&sample()).unwrap();
        doc["regions"].as_array_mut().unwrap().push(serde_json::json!(
            { "id": "zzzzzz", "kind": "image", "at": [0, 9000], "size": [10, 10], "src": src }
        ));
        let dir = std::env::temp_dir().join(format!("quire-saveas-test-{}.quire", std::process::id()));
        save(&dir, &doc, Some(&sample())).unwrap();
        assert_eq!(std::fs::read(dir.join(&src)).unwrap(), png);
        assert!(dir.join("assets/e027afbe9d4229fa.png").exists(), "existing images are carried over");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(assets::stage(vec![1, 2, 3], "exe").is_err());
    }

    #[test]
    fn glossary_explains_units_and_constants() {
        let doc = serde_json::json!({
            "format": "quire/1",
            "regions": [
                { "id": "aaaaaa", "kind": "math", "at": [0, 0], "expr": "m := 500 g" },
                { "id": "bbbbbb", "kind": "math", "at": [0, 40], "expr": "F := m*g", "show": "value" }
            ]
        });
        let r = report(&doc).unwrap();
        assert_eq!(r.glossary["unit:g"].value, "0.001 'kg");
        assert_eq!(r.glossary["constant:g"].title, "standard gravity");
        assert_eq!(r.glossary["constant:g"].meanings, ["constant", "unit"]);
        let lib = library();
        assert!(lib.constants.iter().any(|c| c.name == "k.B"));
        assert!(lib.units.iter().any(|u| u.name == "kgf") || lib.units.iter().any(|u| u.name == "gf"));
    }

    #[test]
    fn assets_cannot_escape_the_bundle() {
        assert!(read_asset(&sample(), "../../Cargo.toml").is_err());
        assert!(read_asset(&sample(), "assets/../../../x.png").is_err());
        assert!(
            read_asset(&sample(), "assets/e027afbe9d4229fa.png")
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn save_then_open_is_identical() {
        let doc = open(&sample()).unwrap();
        let dir = std::env::temp_dir().join(format!("quire-save-test-{}.quire", std::process::id()));
        save(&dir, &doc, None).unwrap();
        let original = std::fs::read_to_string(sample().join("document.json")).unwrap();
        let written = std::fs::read_to_string(dir.join("document.json")).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(written, original);
    }
}
