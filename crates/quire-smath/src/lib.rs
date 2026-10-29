//! SMath Studio worksheet (`.sm`, XML) importer.
//!
//! [`convert`] turns the XML text of a `.sm` file into a Quire document
//! (`document.json`), the results SMath cached in it (`results.json`, the regression
//! oracle) and the binaries it embeds. Imported documents set `settings.units.marked`:
//! as in SMath, a bare name is always a variable, never a unit or a constant.
//!
//! Never panics: malformed input is an [`ImportError`] or, for a single region, a
//! warning plus a `legacy` region.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::unreachable,
        clippy::todo,
        clippy::unimplemented
    )
)]

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value as Json;

mod convert;
mod math;
mod text;

/// A binary embedded in the worksheet, stored content-addressed in the bundle.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    /// Path inside the bundle: `assets/<first 16 hex of sha256>.<ext>`.
    pub path: String,
    pub data: Vec<u8>,
}

/// A converted worksheet.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    /// The `document.json` value.
    pub document: Json,
    /// Results SMath cached, keyed by region id: the `results` member of `results.json`
    /// (the writer wraps it as `{"format": "quire-results/1", "producer": "SMath Studio
    /// (imported)", "results": …}`, and writes no file when it is empty). An empty object
    /// when none.
    pub results: Json,
    /// Embedded binaries, in first-seen order.
    pub assets: Vec<Asset>,
    /// Region counts by kind (`math`, `text`, `plot`, …), for the summary line.
    pub stats: BTreeMap<String, usize>,
    /// What could not be converted faithfully.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImportError {
    /// Not well-formed XML, or not an SMath worksheet.
    Xml(String),
    /// A math token stream that does not form an expression.
    Math(String),
    /// Something this importer does not handle.
    Unsupported(String),
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportError::Xml(m) => write!(f, "not a readable SMath worksheet: {m}"),
            ImportError::Math(m) => write!(f, "unreadable SMath math: {m}"),
            ImportError::Unsupported(m) => write!(f, "unsupported SMath content: {m}"),
        }
    }
}

impl std::error::Error for ImportError {}

pub type Result<T> = std::result::Result<T, ImportError>;

/// Deepest element nesting accepted. Real worksheets nest about 6 levels; the XML parser
/// recurses once per level, so hostile input must be turned away before parsing.
const MAX_XML_DEPTH: usize = 64;

/// Convert the XML text of an SMath `.sm` worksheet.
pub fn convert(xml: &str) -> Result<Imported> {
    if nesting_exceeds(xml, MAX_XML_DEPTH) {
        return Err(ImportError::Xml(format!("elements nested more than {MAX_XML_DEPTH} levels deep")));
    }
    convert::run(xml)
}

/// [`convert`] a worksheet read from a file: its name (`Beam.sm`) is recorded in
/// `meta.source.file`, as the Python importer does.
pub fn convert_file(xml: &str, file_name: &str) -> Result<Imported> {
    let mut imported = convert(xml)?;
    if let Some(source) =
        imported.document.get_mut("meta").and_then(|m| m.get_mut("source")).and_then(Json::as_object_mut)
    {
        source.insert("file".into(), Json::String(file_name.to_string()));
    }
    Ok(imported)
}

/// Whether elements nest deeper than `limit`, found in one pass over the text without
/// building a tree. Comments, CDATA, processing instructions and declarations are skipped;
/// `>` inside quoted attribute values does not end a tag. Malformed text is left for the
/// parser to reject.
fn nesting_exceeds(xml: &str, limit: usize) -> bool {
    let b = xml.as_bytes();
    let mut i = 0usize;
    let mut depth = 0usize;
    while let Some(off) = b.get(i..).and_then(|r| r.iter().position(|&c| c == b'<')) {
        i = i.saturating_add(off).saturating_add(1);
        let rest = b.get(i..).unwrap_or_default();
        if rest.starts_with(b"!--") {
            i = skip_past(b, i, b"-->");
        } else if rest.starts_with(b"![CDATA[") {
            i = skip_past(b, i, b"]]>");
        } else if rest.starts_with(b"?") || rest.starts_with(b"!") {
            i = skip_past(b, i, b">");
        } else if rest.starts_with(b"/") {
            depth = depth.saturating_sub(1);
            i = skip_past(b, i, b">");
        } else {
            let mut quote: Option<u8> = None;
            let mut last = 0u8;
            let mut end = None;
            for (k, &c) in rest.iter().enumerate() {
                match quote {
                    Some(q) if c == q => quote = None,
                    Some(_) => {}
                    None if c == b'"' || c == b'\'' => quote = Some(c),
                    None if c == b'>' => {
                        end = Some(k);
                        break;
                    }
                    None => {}
                }
                last = c;
            }
            let Some(k) = end else { return false };
            if last != b'/' {
                depth = depth.saturating_add(1);
                if depth > limit {
                    return true;
                }
            }
            i = i.saturating_add(k).saturating_add(1);
        }
    }
    false
}

/// The index just past the next `pat` at or after `from`, or the end of `b`.
fn skip_past(b: &[u8], from: usize, pat: &[u8]) -> usize {
    b.get(from..)
        .and_then(|r| r.windows(pat.len()).position(|w| w == pat))
        .map_or(b.len(), |p| from.saturating_add(p).saturating_add(pat.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nesting_is_measured_without_a_tree() {
        assert!(!nesting_exceeds("<a><b/><c x='>'><!-- <d><d><d> --><![CDATA[<e><e>]]></c></a>", 2));
        assert!(nesting_exceeds("<a><b><c/></b></a>", 1));
        assert!(!nesting_exceeds("<?xml version='1.0'?><a><b></b><b></b></a>", 2));
        assert!(!nesting_exceeds("<a><b", 1)); // malformed: the parser reports it
    }

    #[test]
    fn the_deepest_accepted_xml_parses_on_a_small_stack()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let n = MAX_XML_DEPTH;
        let xml = format!(
            "<regions xmlns=\"http://smath.info/schemas/worksheet/1.0\">{}{}</regions>",
            "<region><area/>".repeat(n / 2 - 1),
            "</region>".repeat(n / 2 - 1)
        );
        assert!(!nesting_exceeds(&xml, MAX_XML_DEPTH));
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || {
                let _ = convert(&xml);
            })?
            .join()
            .map_err(|_| "the importer thread failed")?;
        Ok(())
    }

    #[test]
    fn deep_xml_is_refused_on_a_small_stack() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let xml = format!("{}{}", "<regions>".repeat(1_000_000), "</regions>".repeat(1_000_000));
        let outcome = std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(move || matches!(convert(&xml), Err(ImportError::Xml(_))))?
            .join()
            .map_err(|_| "the importer thread failed")?;
        assert!(outcome);
        Ok(())
    }
}
