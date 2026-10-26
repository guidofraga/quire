//! Canonical `document.json` serialization (docs/02-file-format.md §5).
//! Must stay byte-compatible with `dump()` in tools/sm2quire.py.

use serde_json::Value as Json;

/// Fixed key order for the top level and for regions; other objects keep insertion order.
const KEY_ORDER: &[&str] = &[
    "format",
    "meta",
    "settings",
    "units",
    "styles",
    "page",
    "requires",
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
    "title",
    "expr",
    "show",
    "mode",
    "hideInput",
    "display",
    "note",
    "notePosition",
    "text",
    "src",
    "source",
    "header",
    "series",
    "grid",
    "axes",
    "render",
    "caption",
    "legacy",
    "color",
    "background",
    "border",
    "regions",
];

/// Values under these keys are always written one entry per line.
const EXPANDED: &[&str] = &["regions", "results", "meta", "settings", "styles", "page"];
const WIDTH: usize = 100;

fn rank(k: &str) -> usize {
    KEY_ORDER.iter().position(|x| *x == k).unwrap_or(usize::MAX)
}

fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("strings serialize")
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
            if indent == 0 || m.contains_key("kind") {
                items.sort_by(|a, b| rank(a.0).cmp(&rank(b.0)).then(a.0.cmp(b.0)));
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
        _ => unreachable!(),
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
    use std::path::PathBuf;

    #[test]
    fn sample_files_are_already_canonical() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../samples/beam-check.quire");
        for name in ["document.json", "results.json"] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            let v: Json = serde_json::from_str(&text).unwrap();
            assert_eq!(to_string(&v), text, "{name} is not byte-identical after a round trip");
        }
    }

    #[test]
    fn small_values_stay_inline_and_regions_expand() {
        let v: Json = serde_json::from_str(
            r#"{"regions": [{"kind": "math", "expr": "x := 1", "id": "abcdef", "at": [9, 18]}], "format": "quire/1"}"#,
        )
        .unwrap();
        assert_eq!(
            to_string(&v),
            "{\n  \"format\": \"quire/1\",\n  \"regions\": [\n    {\n      \"id\": \"abcdef\",\n      \"kind\": \"math\",\n      \"at\": [9, 18],\n      \"expr\": \"x := 1\"\n    }\n  ]\n}\n"
        );
    }
}
