//! The canonical JSON writer of `tools/sm2quire.py` (docs/02-file-format.md §5): short
//! values on one line, regions and top-level sections expanded, keys in a fixed order.

use serde_json::Value as Json;

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
const WIDTH: usize = 100;
const EXPANDED: &[&str] = &["regions", "results", "meta", "settings", "styles", "page"];

fn rank(k: &str) -> usize {
    KEY_ORDER.iter().position(|x| *x == k).unwrap_or(999)
}

fn scalar(v: &Json) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// One line, keys in their order: `{ "a": 1, "b": [1, 2] }`.
fn inline(v: &Json) -> String {
    match v {
        Json::Object(m) if m.is_empty() => "{}".into(),
        Json::Object(m) => {
            format!(
                "{{ {} }}",
                m.iter()
                    .map(|(k, x)| format!("{}: {}", scalar(&Json::from(k.as_str())), inline(x)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Json::Array(a) => format!("[{}]", a.iter().map(inline).collect::<Vec<_>>().join(", ")),
        other => scalar(other),
    }
}

/// Python's `json.dumps(v, separators=(", ", ": "))`, only to measure the line.
fn compact(v: &Json) -> String {
    match v {
        Json::Object(m) => {
            format!(
                "{{{}}}",
                m.iter()
                    .map(|(k, x)| format!("{}: {}", scalar(&Json::from(k.as_str())), compact(x)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Json::Array(a) => format!("[{}]", a.iter().map(compact).collect::<Vec<_>>().join(", ")),
        other => scalar(other),
    }
}

pub fn dump(v: &Json) -> String {
    dump_at(v, 0, None)
}

fn dump_at(v: &Json, indent: usize, key: Option<&str>) -> String {
    let pad = "  ".repeat(indent);
    let line = compact(v);
    let force =
        key.is_some_and(|k| EXPANDED.contains(&k)) || v.as_object().is_some_and(|m| m.contains_key("kind"));
    let container = v.is_object() || v.is_array();
    if !container || (!force && pad.chars().count() + line.chars().count() <= WIDTH && !line.contains("\\n"))
    {
        return inline(v);
    }
    let inner = "  ".repeat(indent + 1);
    match v {
        Json::Array(a) if a.is_empty() => "[]".into(),
        Json::Object(m) if m.is_empty() => "{}".into(),
        Json::Array(a) => {
            format!(
                "[\n{}\n{pad}]",
                a.iter()
                    .map(|x| format!("{inner}{}", dump_at(x, indent + 1, None)))
                    .collect::<Vec<_>>()
                    .join(",\n")
            )
        }
        Json::Object(m) => {
            let mut items: Vec<(&String, &Json)> = m.iter().collect();
            if indent == 0 || m.contains_key("kind") {
                items.sort_by(|a, b| rank(a.0).cmp(&rank(b.0)).then(a.0.cmp(b.0)));
            }
            let lines: Vec<String> = items
                .into_iter()
                .map(|(k, x)| {
                    format!("{inner}{}: {}", scalar(&Json::from(k.as_str())), dump_at(x, indent + 1, Some(k)))
                })
                .collect();
            format!("{{\n{}\n{pad}}}", lines.join(",\n"))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_layout() {
        let doc = json!({
            "regions": [{ "expr": "x := 1", "kind": "math", "id": "a", "at": [1, 2] }],
            "format": "quire/1",
            "meta": { "title": "T" }
        });
        assert_eq!(
            dump(&doc),
            "{\n  \"format\": \"quire/1\",\n  \"meta\": {\n    \"title\": \"T\"\n  },\n  \"regions\": [\n    {\n      \"id\": \"a\",\n      \"kind\": \"math\",\n      \"at\": [1, 2],\n      \"expr\": \"x := 1\"\n    }\n  ]\n}"
        );
        assert_eq!(dump(&json!({ "a": { "b": 1 } })), "{ \"a\": { \"b\": 1 } }", "short: one line");
    }
}
