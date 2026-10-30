//! The `.quire` document model (docs/02-file-format.md).
//!
//! Read-only in P1. Unknown keys are kept in `extra` maps so a future writer can
//! preserve them (format rule: readers ignore and preserve unknown keys).

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value as Json};

mod single;

pub use single::{SINGLE_FILE_EXT, is_single_file, pack, read_bytes, read_entry, unpack, write_bytes};

pub const FORMAT_MAJOR: &str = "quire/1";

#[derive(Debug)]
pub struct DocError(pub String);

impl fmt::Display for DocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DocError {}

#[derive(Debug, Deserialize)]
pub struct Document {
    pub format: String,
    #[serde(default)]
    pub meta: Json,
    #[serde(default)]
    pub settings: Settings,
    /// Custom units: name → linear-syntax definition.
    #[serde(default)]
    pub units: BTreeMap<String, String>,
    /// Spreadsheets carried with the document (read by `importData`): file name → sheet
    /// name → rows from A1, each cell a number, a string or null.
    #[serde(default)]
    pub data: BTreeMap<String, BTreeMap<String, Vec<Vec<Json>>>>,
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(flatten)]
    pub extra: Map<String, Json>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub display: DisplaySettings,
    #[serde(flatten)]
    pub extra: Map<String, Json>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySettings {
    pub decimals: Option<u32>,
    pub exponential_threshold: Option<i32>,
    pub trailing_zeros: Option<bool>,
    /// `"working"`: results in the document's own units; `"si"` (default): coherent SI.
    pub result_units: Option<String>,
    /// `"auto"` (default), `"engineering"` (powers of ten in steps of three) or
    /// `"prefix"` (the unit's SI prefix keeps the number between 1 and 1000).
    pub notation: Option<String>,
    /// Round results to this many significant figures instead of `decimals`.
    pub sig_figs: Option<u32>,
    #[serde(flatten)]
    pub extra: Map<String, Json>,
}

#[derive(Debug, Deserialize)]
pub struct Region {
    pub id: String,
    pub kind: String,
    pub at: [f64; 2],
    pub expr: Option<String>,
    pub show: Option<String>,
    pub display: Option<Display>,
    #[serde(default)]
    pub disabled: bool,
    /// Children of an `area`, positioned relative to it.
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(flatten)]
    pub extra: Map<String, Json>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Display {
    pub unit: Option<String>,
    pub decimals: Option<u32>,
    #[serde(flatten)]
    pub extra: Map<String, Json>,
}

/// `results.json`: displayed results keyed by region id, in linear syntax.
#[derive(Debug, Deserialize)]
pub struct Results {
    pub format: String,
    pub producer: Option<String>,
    pub results: BTreeMap<String, String>,
}

/// A region with its absolute position on the canvas.
#[derive(Debug, Clone, Copy)]
pub struct Placed<'a> {
    pub region: &'a Region,
    pub x: f64,
    pub y: f64,
}

impl Document {
    /// All regions with areas expanded, in reading order `(y, x)` — the evaluation order.
    pub fn flatten(&self) -> Vec<Placed<'_>> {
        fn walk<'a>(regions: &'a [Region], ox: f64, oy: f64, out: &mut Vec<Placed<'a>>) {
            for r in regions {
                let (x, y) = (ox + r.at[0], oy + r.at[1]);
                out.push(Placed { region: r, x, y });
                walk(&r.regions, x, y, out);
            }
        }
        let mut out = Vec::new();
        walk(&self.regions, 0.0, 0.0, &mut out);
        out.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
        out
    }
}

pub struct Bundle {
    pub path: PathBuf,
    pub document: Document,
    pub results: Option<Results>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, DocError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| DocError(format!("cannot read {}: {e}", path.display())))?;
    serde_json::from_str(&text).map_err(|e| DocError(format!("{}: {e}", path.display())))
}

fn parse_json<T: for<'de> Deserialize<'de>>(path: &Path, bytes: &[u8]) -> Result<T, DocError> {
    serde_json::from_slice(bytes).map_err(|e| DocError(format!("{}: {e}", path.display())))
}

fn check_format(document: &Document, path: &Path) -> Result<(), DocError> {
    if document.format != FORMAT_MAJOR && !document.format.starts_with(&format!("{FORMAT_MAJOR}.")) {
        return Err(DocError(format!(
            "{}: unsupported format \"{}\" (this build reads {FORMAT_MAJOR})",
            path.display(),
            document.format
        )));
    }
    Ok(())
}

/// Load a `.quire` directory bundle, a single-file `.quirez`, or a bare `document.json`.
pub fn load(path: impl AsRef<Path>) -> Result<Bundle, DocError> {
    let path = path.as_ref();
    if is_single_file(path) {
        let Some(doc) = read_entry(path, "document.json")? else {
            return Err(DocError(format!("{}: no document.json inside", path.display())));
        };
        let document: Document = parse_json(path, &doc)?;
        check_format(&document, path)?;
        let results = read_entry(path, "results.json")?.map(|r| parse_json(path, &r)).transpose()?;
        return Ok(Bundle { path: path.to_path_buf(), document, results });
    }
    let (dir, doc_path) = if path.is_dir() {
        (path.to_path_buf(), path.join("document.json"))
    } else {
        (path.parent().unwrap_or(Path::new(".")).to_path_buf(), path.to_path_buf())
    };
    let document: Document = read_json(&doc_path)?;
    check_format(&document, &doc_path)?;
    let results_path = dir.join("results.json");
    let results = if results_path.is_file() { Some(read_json(&results_path)?) } else { None };
    Ok(Bundle { path: dir, document, results })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_flatten_into_reading_order() -> Result<(), Box<dyn std::error::Error>> {
        let doc: Document = serde_json::from_str(
            r#"{ "format": "quire/1", "custom": 1, "regions": [
                { "id": "aaaaaa", "kind": "math", "at": [0, 10], "expr": "a := 1" },
                { "id": "bbbbbb", "kind": "area", "at": [0, 20], "regions": [
                    { "id": "cccccc", "kind": "math", "at": [5, 0], "expr": "b := a" } ] },
                { "id": "dddddd", "kind": "math", "at": [0, 15], "expr": "c := 2", "future": true }
            ] }"#,
        )?;
        let ids: Vec<_> = doc.flatten().iter().map(|p| (p.region.id.as_str(), p.x, p.y)).collect();
        assert_eq!(
            ids,
            [("aaaaaa", 0.0, 10.0), ("dddddd", 0.0, 15.0), ("bbbbbb", 0.0, 20.0), ("cccccc", 5.0, 20.0)]
        );
        assert!(doc.extra.contains_key("custom"));
        assert!(doc.regions.get(2).is_some_and(|r| r.extra.contains_key("future")));
        Ok(())
    }
}
