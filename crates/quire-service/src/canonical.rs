//! Canonical `document.json` serialization (docs/02-file-format.md §5).
//! The SMath importer (`quire import`) writes bundles with it too.

use serde_json::Value as Json;

/// Fixed key order at the document root; unknown keys precede `regions`.
const TOP_ORDER: &[&str] = &["format", "meta", "settings", "units", "styles", "page", "requires", "regions"];

/// Fixed key order for regions; unknown keys sort alphabetically before `regions`.
const REGION_ORDER: &[&str] = &[
    "id",
    "kind",
    "at",
    "size",
    "width",
    "height",
    "style",
    "keep",
    "disabled",
    "locked",
    "collapsed",
    "of",
    "title",
    "name",
    "expr",
    "guesses",
    "given",
    "find",
    "show",
    "mode",
    "hideInput",
    "display",
    "note",
    "notePosition",
    "text",
    "src",
    "alt",
    "format",
    "inline",
    "source",
    "header",
    "columns",
    "rows",
    "series",
    "surface",
    "parametric",
    "xrange",
    "yrange",
    "range",
    "urange",
    "vrange",
    "grid",
    "axes",
    "aspect",
    "animate",
    "extrema",
    "legend",
    "palette",
    "render",
    "camera",
    "caption",
    "legacy",
    "color",
    "background",
    "border",
];

/// Values under these keys are always written one entry per line.
const EXPANDED: &[&str] = &["regions", "results", "meta", "settings", "styles", "page"];
const WIDTH: usize = 100;

fn rank(order: &[&str], k: &str) -> (u8, usize) {
    if k == "regions" {
        (2, 0)
    } else if let Some(i) = order.iter().position(|x| *x == k) {
        (0, i)
    } else {
        (1, 0)
    }
}

fn quote(s: &str) -> String {
    // a JSON string value always serializes; this is the same text as `serde_json::to_string`
    Json::String(s.to_string()).to_string()
}

/// Compact form used only to measure: `{"a": 1, "b": [1, 2]}`.
fn compact(v: &Json) -> String {
    match v {
        Json::Array(a) => format!("[{}]", a.iter().map(compact).collect::<Vec<_>>().join(", ")),
        Json::Object(m) => {
            let items: Vec<String> = m.iter().map(|(k, x)| format!("{}: {}", quote(k), compact(x))).collect();
            format!("{{{}}}", items.join(", "))
        }
        other => other.to_string(),
    }
}

/// One-line form as written: `{ "a": 1 }`, `[1, 2]`.
fn inline(v: &Json) -> String {
    match v {
        Json::Array(a) => format!("[{}]", a.iter().map(inline).collect::<Vec<_>>().join(", ")),
        Json::Object(m) if m.is_empty() => "{}".to_string(),
        Json::Object(m) => {
            let items: Vec<String> = m.iter().map(|(k, x)| format!("{}: {}", quote(k), inline(x))).collect();
            format!("{{ {} }}", items.join(", "))
        }
        other => other.to_string(),
    }
}

fn dump(out: &mut String, v: &Json, indent: usize, key: Option<&str>) {
    let pad = "  ".repeat(indent);
    let inner = "  ".repeat(indent + 1);
    let force = key.is_some_and(|k| EXPANDED.contains(&k)) || v.get("kind").is_some();
    let container = v.is_array() || v.is_object();
    let measured = compact(v);
    if !container
        || (!force && pad.chars().count() + measured.chars().count() <= WIDTH && !measured.contains("\\n"))
    {
        out.push_str(&inline(v));
        return;
    }
    match v {
        Json::Array(a) if a.is_empty() => out.push_str("[]"),
        Json::Array(a) => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&inner);
                dump(out, x, indent + 1, None);
            }
            out.push('\n');
            out.push_str(&pad);
            out.push(']');
        }
        Json::Object(m) if m.is_empty() => out.push_str("{}"),
        Json::Object(m) => {
            let mut items: Vec<(&String, &Json)> = m.iter().collect();
            if m.contains_key("kind") {
                items
                    .sort_by(|a, b| rank(REGION_ORDER, a.0).cmp(&rank(REGION_ORDER, b.0)).then(a.0.cmp(b.0)));
            } else if indent == 0 {
                items.sort_by(|a, b| rank(TOP_ORDER, a.0).cmp(&rank(TOP_ORDER, b.0)).then(a.0.cmp(b.0)));
            }
            out.push_str("{\n");
            for (i, (k, x)) in items.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&inner);
                out.push_str(&quote(k));
                out.push_str(": ");
                dump(out, x, indent + 1, Some(k));
            }
            out.push('\n');
            out.push_str(&pad);
            out.push('}');
        }
        other => out.push_str(&inline(other)),
    }
}

/// Canonical text, with trailing newline.
pub fn to_string(doc: &Json) -> String {
    let mut out = String::new();
    dump(&mut out, doc, 0, None);
    out.push('\n');
    out
}

/// Sort `regions` arrays (recursively, inside areas) by reading order `(y, x)`.
pub fn sort_regions(v: &mut Json) {
    let Some(regions) = v.get_mut("regions").and_then(Json::as_array_mut) else { return };
    let pos = |r: &Json, i: usize| r.get("at").and_then(|a| a.get(i)).and_then(Json::as_f64).unwrap_or(0.0);
    regions.sort_by(|a, b| pos(a, 1).total_cmp(&pos(b, 1)).then(pos(a, 0).total_cmp(&pos(b, 0))));
    for r in regions {
        sort_regions(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_values_stay_inline_and_regions_expand() -> Result<(), Box<dyn std::error::Error>> {
        let v: Json = serde_json::from_str(
            r#"{"regions": [{"kind": "math", "expr": "x := 1", "id": "abcdef", "at": [9, 18]}], "format": "quire/1"}"#,
        )?;
        assert_eq!(
            to_string(&v),
            "{\n  \"format\": \"quire/1\",\n  \"regions\": [\n    {\n      \"id\": \"abcdef\",\n      \"kind\": \"math\",\n      \"at\": [9, 18],\n      \"expr\": \"x := 1\"\n    }\n  ]\n}\n"
        );
        Ok(())
    }

    #[test]
    fn data_format_and_area_unknown_keys_keep_region_key_order() -> Result<(), Box<dyn std::error::Error>> {
        let v: Json = serde_json::from_str(
            r#"{
              "format": "quire/1",
              "regions": [
                { "format": "csv", "src": "assets/0123456789abcdef.csv", "name": "loads", "at": [0, 0], "kind": "data", "id": "dataaa" },
                { "regions": [], "futureKey": 1, "at": [0, 50], "kind": "area", "id": "areaaa" }
              ]
            }"#,
        )?;
        let out = to_string(&v);
        let data_id = out.find("\"id\": \"dataaa\"").ok_or("missing data id")?;
        let data_fmt = out.find("\"format\": \"csv\"").ok_or("missing data format")?;
        assert!(data_id < data_fmt, "{out}");
        let area_future = out.find("\"futureKey\": 1").ok_or("missing futureKey")?;
        let area_children = out.find("\"regions\": []").ok_or("missing area regions")?;
        assert!(area_future < area_children, "{out}");
        Ok(())
    }

    #[test]
    fn schema_keys_and_fixtures_stay_in_sync() -> Result<(), Box<dyn std::error::Error>> {
        use std::collections::{BTreeMap, BTreeSet};
        use std::path::Path;

        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let schema: Json =
            serde_json::from_str(&std::fs::read_to_string(root.join("../../schema/quire-1.schema.json"))?)?;
        let top_props = schema["properties"].as_object().ok_or("schema.properties")?;
        for k in top_props.keys() {
            assert!(TOP_ORDER.contains(&k.as_str()), "TOP_ORDER is missing schema key {k}");
        }

        let region_def = &schema["$defs"]["region"];
        let common_props: BTreeSet<&str> = region_def["properties"]
            .as_object()
            .ok_or("region.properties")?
            .keys()
            .map(String::as_str)
            .collect();
        for k in &common_props {
            assert!(REGION_ORDER.contains(k), "REGION_ORDER is missing region key {k}");
        }
        let kinds: BTreeSet<&str> = region_def["properties"]["kind"]["enum"]
            .as_array()
            .ok_or("kind.enum")?
            .iter()
            .filter_map(Json::as_str)
            .collect();
        let mut by_kind: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for rule in region_def["allOf"].as_array().ok_or("region.allOf")? {
            let cond = &rule["if"]["properties"]["kind"];
            let rule_kinds: Vec<&str> = match cond.get("const").and_then(Json::as_str) {
                Some(k) => vec![k],
                None => cond["enum"].as_array().ok_or("rule kind")?.iter().filter_map(Json::as_str).collect(),
            };
            let props = rule["then"]["properties"].as_object().ok_or("then.properties")?;
            for k in props.keys() {
                assert!(
                    k == "regions" || REGION_ORDER.contains(&k.as_str()),
                    "REGION_ORDER is missing {k} for {rule_kinds:?}"
                );
                for rk in &rule_kinds {
                    by_kind.entry(rk).or_default().insert(k.as_str());
                }
            }
        }

        let check_keys =
            |label: &str, obj: &serde_json::Map<String, Json>, allowed: &serde_json::Map<String, Json>| {
                for k in obj.keys() {
                    assert!(allowed.contains_key(k), "{label}: key {k:?} is not declared in schema");
                }
            };
        let mut check_region = None::<()>;
        let _ = check_region.take();
        fn validate_region(
            file: &str,
            r: &Json,
            kinds: &BTreeSet<&str>,
            common: &BTreeSet<&str>,
            by_kind: &BTreeMap<&str, BTreeSet<&str>>,
        ) -> Result<(), Box<dyn std::error::Error>> {
            let obj = r.as_object().ok_or("region must be object")?;
            let kind = obj.get("kind").and_then(Json::as_str).ok_or("region.kind")?;
            assert!(kinds.contains(kind), "{file}: unknown region kind {kind:?}");
            let specific = by_kind.get(kind);
            for k in obj.keys() {
                let ok = common.contains(k.as_str()) || specific.is_some_and(|s| s.contains(k.as_str()));
                assert!(ok, "{file}: {kind} region key {k:?} is not declared in schema");
            }
            if let Some(children) = obj.get("regions").and_then(Json::as_array) {
                for child in children {
                    validate_region(file, child, kinds, common, by_kind)?;
                }
            }
            Ok(())
        }

        let mut docs = vec![
            root.join("tests/fixtures/every-region.quire/document.json"),
            root.join("../../app/src-tauri/tests/fixtures/report.quire/document.json"),
        ];
        for entry in std::fs::read_dir(root.join("templates"))? {
            let p = entry?.path();
            if p.extension().is_some_and(|e| e == "json") {
                docs.push(p);
            }
        }
        docs.sort();

        let meta_props = top_props["meta"]["properties"].as_object().ok_or("meta.properties")?;
        let settings_props = top_props["settings"]["properties"].as_object().ok_or("settings.properties")?;
        let page_props = schema["$defs"]["page"]["properties"].as_object().ok_or("page.properties")?;
        for path in docs {
            let label = path.display().to_string();
            let doc: Json = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
            let root_obj = doc.as_object().ok_or("doc root")?;
            check_keys(&label, root_obj, top_props);
            if let Some(meta) = root_obj.get("meta").and_then(Json::as_object) {
                check_keys(&format!("{label}.meta"), meta, meta_props);
            }
            if let Some(settings) = root_obj.get("settings").and_then(Json::as_object) {
                check_keys(&format!("{label}.settings"), settings, settings_props);
                for (sub, sub_val) in settings {
                    if let (Some(obj), Some(allowed)) =
                        (sub_val.as_object(), settings_props[sub]["properties"].as_object())
                    {
                        check_keys(&format!("{label}.settings.{sub}"), obj, allowed);
                    }
                }
            }
            if let Some(page) = root_obj.get("page").and_then(Json::as_object) {
                check_keys(&format!("{label}.page"), page, page_props);
            }
            for r in root_obj["regions"].as_array().ok_or("doc.regions")? {
                validate_region(&label, r, &kinds, &common_props, &by_kind)?;
            }
        }
        Ok(())
    }
}
