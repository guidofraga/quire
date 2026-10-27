//! Document templates: a few built in, plus your own (`.quirez` files in a folder the app
//! owns). A new document from a template is a copy with no file yet.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value as Json;

use crate::{Result, ServiceError, open, save};

struct Builtin {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    json: &'static str,
}

const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "builtin:report",
        name: "Calculation report",
        description: "Title block, numbered sections, headers and footers with your name and company.",
        json: include_str!("../templates/report.json"),
    },
    Builtin {
        id: "builtin:beam",
        name: "Simply supported beam",
        description: "Loads table, bending and deflection of a steel beam, and a summary of checks.",
        json: include_str!("../templates/beam.json"),
    },
    Builtin {
        id: "builtin:combinations",
        name: "Load combinations",
        description: "Actions and factors in tables; the governing combination is found with formulas.",
        json: include_str!("../templates/combinations.json"),
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    /// `builtin:<name>`, or the path of your template file.
    pub id: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
}

/// What a new document from a template starts with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDocument {
    pub doc: Json,
    /// Where the template's images are read from until the document is saved.
    pub origin: Option<PathBuf>,
}

const EXT: &str = "quirez";

/// Built-in templates first, then yours by name.
pub fn list(dir: &Path) -> Vec<TemplateInfo> {
    let mut out: Vec<TemplateInfo> = BUILTIN
        .iter()
        .map(|b| TemplateInfo {
            id: b.id.into(),
            name: b.name.into(),
            description: b.description.into(),
            builtin: true,
        })
        .collect();
    let mut mine: Vec<TemplateInfo> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == EXT))
        .map(|p| {
            let description = open(&p)
                .ok()
                .and_then(|d| d.pointer("/meta/templateDescription").and_then(Json::as_str).map(String::from))
                .unwrap_or_default();
            TemplateInfo {
                name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                id: p.to_string_lossy().into_owned(),
                description,
                builtin: false,
            }
        })
        .collect();
    mine.sort_by_key(|t| t.name.to_lowercase());
    out.extend(mine);
    out
}

fn yours(dir: &Path, id: &str) -> Result<PathBuf> {
    let p = PathBuf::from(id);
    let inside = p
        .parent()
        .zip(dir.canonicalize().ok())
        .is_some_and(|(parent, d)| parent.canonicalize().ok() == Some(d));
    if !inside || p.extension().is_none_or(|e| e != EXT) {
        return Err(ServiceError(format!("{id} is not one of your templates")));
    }
    Ok(p)
}

pub fn document(dir: &Path, id: &str) -> Result<TemplateDocument> {
    if let Some(b) = BUILTIN.iter().find(|b| b.id == id) {
        return Ok(TemplateDocument { doc: serde_json::from_str(b.json)?, origin: None });
    }
    let path = yours(dir, id)?;
    let mut doc = open(&path)?;
    if let Some(meta) = doc.get_mut("meta").and_then(Json::as_object_mut) {
        meta.remove("templateDescription");
        meta.remove("id");
    }
    Ok(TemplateDocument { doc, origin: Some(path) })
}

/// Save a document as your template `name` (replacing one of the same name).
pub fn save_as(dir: &Path, name: &str, description: &str, doc: &Json, from: Option<&Path>) -> Result<String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_matches(['.', ' ']).to_string();
    if clean.is_empty() {
        return Err(ServiceError("a template needs a name".into()));
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{clean}.{EXT}"));
    let mut doc = doc.clone();
    if let Some(meta) = doc.get_mut("meta").and_then(Json::as_object_mut) {
        meta.remove("id");
        if description.trim().is_empty() {
            meta.remove("templateDescription");
        } else {
            meta.insert("templateDescription".into(), Json::String(description.trim().into()));
        }
    }
    save(&path, &doc, from)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn delete(dir: &Path, id: &str) -> Result<()> {
    std::fs::remove_file(yours(dir, id)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_templates_load_and_evaluate_cleanly() {
        for b in BUILTIN {
            let doc: Json = serde_json::from_str(b.json).unwrap_or_else(|e| panic!("{}: {e}", b.id));
            let report = crate::report(&doc).unwrap_or_else(|e| panic!("{}: {e}", b.id));
            let errors: Vec<_> = report
                .regions
                .iter()
                .filter_map(|r| r.error.as_ref().map(|e| format!("{}: {e}", r.id)))
                .collect();
            assert!(errors.is_empty(), "{}: {errors:?}", b.id);
        }
    }

    #[test]
    fn your_templates_round_trip() {
        let dir = std::env::temp_dir().join(format!("quire-templates-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let doc = document(&dir, "builtin:beam").unwrap().doc;
        let id = save_as(&dir, "My: beam", "Steel beams", &doc, None).unwrap();
        assert!(id.ends_with("My- beam.quirez"));
        let listed = list(&dir);
        let mine = listed.iter().find(|t| !t.builtin).unwrap();
        assert_eq!((mine.name.as_str(), mine.description.as_str()), ("My- beam", "Steel beams"));
        let back = document(&dir, &mine.id).unwrap();
        assert_eq!(back.doc["regions"], doc["regions"]);
        assert!(back.doc["meta"].get("templateDescription").is_none());
        assert!(document(&dir, "/etc/passwd").is_err());
        delete(&dir, &mine.id).unwrap();
        assert!(list(&dir).iter().all(|t| t.builtin));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
