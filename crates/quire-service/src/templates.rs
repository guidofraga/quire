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

/// In the order the Welcome screen and the Templates dialog show them.
const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "builtin:report",
        name: "Calculation report",
        description: "A worked example to copy and make your own",
        json: include_str!("../templates/report.json"),
    },
    Builtin {
        id: "builtin:beam",
        name: "Simply supported beam",
        description: "EN 1993-1-1: bending, shear, deflection",
        json: include_str!("../templates/beam.json"),
    },
    Builtin {
        id: "builtin:combinations",
        name: "Load combinations",
        description: "EN 1990 (6.10) and (6.10a, b), ULS and SLS",
        json: include_str!("../templates/combinations.json"),
    },
    Builtin {
        id: "builtin:rc-section",
        name: "RC section in bending",
        description: "EN 1992-1-1: reinforcement, limits and ductility",
        json: include_str!("../templates/rc-section.json"),
    },
    Builtin {
        id: "builtin:bolted",
        name: "Bolted connection",
        description: "EN 1993-1-8: bolt shear, bearing, block tearing",
        json: include_str!("../templates/bolted.json"),
    },
    Builtin {
        id: "builtin:footing",
        name: "Pad footing",
        description: "Bearing pressure, sliding and overturning",
        json: include_str!("../templates/footing.json"),
    },
    Builtin {
        id: "builtin:pipe",
        name: "Pipe flow head loss",
        description: "Darcy–Weisbach, minor losses, pump duty",
        json: include_str!("../templates/pipe.json"),
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

    /// The checks each built-in template fails on purpose, to show what a failing check looks like.
    const FAILING_ON_PURPOSE: &[(&str, &[&str])] = &[
        ("builtin:beam", &["bmtfxx"]),   // total deflection
        ("builtin:bolted", &["bcmqgz"]), // bolt shear, shear plane through the thread
    ];

    #[test]
    fn builtin_templates_load_and_evaluate_cleanly() -> std::result::Result<(), Box<dyn std::error::Error>> {
        for b in BUILTIN {
            let doc: Json = serde_json::from_str(b.json).map_err(|e| format!("{}: {e}", b.id))?;
            let report = crate::report(&doc).map_err(|e| format!("{}: {}", b.id, e.0))?;
            let mut errors: Vec<_> = report
                .regions
                .iter()
                .filter_map(|r| r.error.as_ref().map(|e| format!("{}: {e}", r.id)))
                .collect();
            for r in &report.regions {
                for c in r.cells.iter().flatten().flatten() {
                    if let Some(e) = &c.error {
                        errors.push(format!("{} (cell): {e}", r.id));
                    }
                }
            }
            assert!(errors.is_empty(), "{}: {errors:?}", b.id);
            assert_eq!(report.error_count, 0, "{}", b.id);
            assert!(report.document_errors.is_empty(), "{}: {:?}", b.id, report.document_errors);
        }
        Ok(())
    }

    #[test]
    fn builtin_templates_pass_their_checks_except_the_ones_meant_to_fail()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        for b in BUILTIN {
            let doc: Json = serde_json::from_str(b.json)?;
            let report = crate::report(&doc).map_err(|e| e.0)?;
            let checks: Vec<(&str, bool)> =
                report.regions.iter().filter_map(|r| r.check.map(|c| (r.id.as_str(), c))).collect();
            let failing: Vec<&str> = checks.iter().filter(|(_, pass)| !pass).map(|(id, _)| *id).collect();
            let expected = FAILING_ON_PURPOSE.iter().find(|(id, _)| *id == b.id).map_or(&[][..], |(_, f)| *f);
            assert_eq!(failing, expected, "{}: failing checks", b.id);
            assert!(checks.len() > failing.len(), "{}: no passing checks", b.id);
        }
        Ok(())
    }

    #[test]
    fn builtin_template_region_ids_are_well_formed_and_unique()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let mut seen = std::collections::HashSet::new();
        for b in BUILTIN {
            let doc: Json = serde_json::from_str(b.json)?;
            for r in doc["regions"].as_array().ok_or("no regions")? {
                let id = r["id"].as_str().ok_or("region without an id")?;
                let ok =
                    id.len() == 6 && id.chars().all(|c| c.is_ascii_lowercase() || ('2'..='9').contains(&c));
                assert!(ok, "{}: id {id}", b.id);
                assert!(seen.insert(id.to_string()), "{}: duplicate id {id}", b.id);
            }
        }
        Ok(())
    }

    #[test]
    fn your_templates_round_trip() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = std::env::temp_dir().join(format!("quire-templates-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let doc = document(&dir, "builtin:beam")?.doc;
        let id = save_as(&dir, "My: beam", "Steel beams", &doc, None)?;
        assert!(id.ends_with("My- beam.quirez"));
        let listed = list(&dir);
        let mine = listed.iter().find(|t| !t.builtin).ok_or("the saved template is not listed")?;
        assert_eq!((mine.name.as_str(), mine.description.as_str()), ("My- beam", "Steel beams"));
        let back = document(&dir, &mine.id)?;
        assert_eq!(back.doc["regions"], doc["regions"]);
        assert!(back.doc["meta"].get("templateDescription").is_none());
        assert!(document(&dir, "/etc/passwd").is_err());
        delete(&dir, &mine.id)?;
        assert!(list(&dir).iter().all(|t| t.builtin));
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
