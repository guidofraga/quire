//! Spreadsheets named by SMath's importData, read into the document's `data`
//! (file → sheet → rows from A1; numbers, strings, null). Mirrors `read_xlsx`/`read_csv`.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use serde_json::{Map, Value as Json};

/// `AB12` → (11, 27), zero-based.
fn cell_ref(r: &str) -> Option<(usize, usize)> {
    let letters: String = r.chars().take_while(char::is_ascii_alphabetic).collect();
    let row: usize = r[letters.len()..].parse().ok()?;
    let col = letters.to_ascii_uppercase().bytes().fold(0usize, |n, b| n * 26 + (b - b'A' + 1) as usize);
    (row >= 1 && col >= 1).then(|| (row - 1, col - 1))
}

/// A number when the text reads as one (whole numbers stay whole), the text otherwise.
fn cell_value(text: &str) -> Json {
    match text.trim().parse::<f64>() {
        Ok(v) if v.is_finite() => {
            if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
                Json::from(v as i64)
            } else {
                Json::from(v)
            }
        }
        _ => Json::String(text.to_string()),
    }
}

fn rows_json(cells: BTreeMap<usize, BTreeMap<usize, Json>>) -> Json {
    let Some(&last) = cells.keys().last() else { return Json::Array(Vec::new()) };
    let width = cells.values().filter_map(|r| r.keys().last()).max().map_or(0, |c| c + 1);
    Json::Array(
        (0..=last)
            .map(|r| {
                Json::Array(
                    (0..width)
                        .map(|c| cells.get(&r).and_then(|row| row.get(&c)).cloned().unwrap_or(Json::Null))
                        .collect(),
                )
            })
            .collect(),
    )
}

fn entry(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Option<String>, String> {
    let Ok(mut f) = z.by_name(name) else { return Ok(None) };
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(Some(s))
}

/// Concatenated `<t>` texts below a node (shared strings with runs, inline strings).
fn texts(n: roxmltree::Node) -> String {
    n.descendants().filter(|d| d.tag_name().name() == "t").filter_map(|d| d.text()).collect()
}

pub fn read_xlsx(path: &Path) -> Result<Json, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut shared = Vec::new();
    if let Some(xml) = entry(&mut z, "xl/sharedStrings.xml")? {
        let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
        shared = doc.root_element().children().filter(|n| n.tag_name().name() == "si").map(texts).collect();
    }
    let rels_xml = entry(&mut z, "xl/_rels/workbook.xml.rels")?.ok_or("no workbook relationships")?;
    let rels_doc = roxmltree::Document::parse(&rels_xml).map_err(|e| e.to_string())?;
    let rels: BTreeMap<String, String> = rels_doc
        .root_element()
        .children()
        .filter(|n| n.is_element())
        .filter_map(|r| {
            let target = r.attribute("Target")?.trim_start_matches('/');
            let full = if target.starts_with("xl/") { target.to_string() } else { format!("xl/{target}") };
            Some((r.attribute("Id")?.to_string(), full))
        })
        .collect();
    let wb_xml = entry(&mut z, "xl/workbook.xml")?.ok_or("no workbook")?;
    let wb = roxmltree::Document::parse(&wb_xml).map_err(|e| e.to_string())?;
    const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let mut sheets = Map::new();
    for sh in wb.descendants().filter(|n| n.tag_name().name() == "sheet") {
        let name = sh.attribute("name").unwrap_or("Sheet").to_string();
        let target = sh
            .attribute((REL, "id"))
            .and_then(|id| rels.get(id))
            .ok_or(format!("sheet {name} has no part"))?;
        let xml = entry(&mut z, target)?.ok_or(format!("sheet {name} is missing"))?;
        let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
        let mut cells: BTreeMap<usize, BTreeMap<usize, Json>> = BTreeMap::new();
        for c in doc.descendants().filter(|n| n.tag_name().name() == "c") {
            let Some((r, col)) = c.attribute("r").and_then(cell_ref) else { continue };
            let v = c.children().find(|n| n.tag_name().name() == "v").and_then(|n| n.text());
            let val = match (c.attribute("t"), v) {
                (Some("s"), Some(i)) => {
                    i.parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).map(Json::String)
                }
                (Some("inlineStr"), _) => Some(Json::String(texts(c))),
                (Some("str" | "e"), v) => v.map(|v| Json::String(v.to_string())),
                (Some("b"), Some(v)) => v.parse::<i64>().ok().map(Json::from),
                (_, Some(v)) => Some(cell_value(v)),
                _ => None,
            };
            match val {
                Some(Json::String(s)) if s.is_empty() => {}
                Some(v) => {
                    cells.entry(r).or_default().insert(col, v);
                }
                None => {}
            }
        }
        sheets.insert(name, rows_json(cells));
    }
    Ok(Json::Object(sheets))
}

/// A CSV (comma, semicolon or tab): numbers with a decimal comma or point, text otherwise.
pub fn read_csv(path: &Path) -> Result<Json, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string();
    let first = text.lines().next().unwrap_or("");
    let delim = [',', ';', '\t'].into_iter().max_by_key(|d| first.matches(*d).count()).unwrap_or(',');
    let numeric = |x: &str| {
        let t = x.trim();
        !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | 'e'))
    };
    let mut rows = Vec::new();
    for line in text.lines() {
        let mut cells = Vec::new();
        let (mut cur, mut quoted, mut chars) = (String::new(), false, line.chars().peekable());
        while let Some(ch) = chars.next() {
            match ch {
                '"' if quoted && chars.peek() == Some(&'"') => {
                    cur.push('"');
                    chars.next();
                }
                '"' => quoted = !quoted,
                c if c == delim && !quoted => cells.push(std::mem::take(&mut cur)),
                c => cur.push(c),
            }
        }
        cells.push(cur);
        rows.push(Json::Array(
            cells
                .iter()
                .map(|x| {
                    if numeric(x) {
                        cell_value(&x.replace(',', "."))
                    } else if x.is_empty() {
                        Json::Null
                    } else {
                        Json::String(x.clone())
                    }
                })
                .collect(),
        ));
    }
    let mut out = Map::new();
    out.insert("Sheet1".into(), Json::Array(rows));
    Ok(Json::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_and_csv() {
        assert_eq!(cell_ref("AB12"), Some((11, 27)));
        assert_eq!(cell_value("4.0"), Json::from(4));
        assert_eq!(cell_value("4.75"), Json::from(4.75));
        assert_eq!(cell_value("G-2130"), Json::from("G-2130"));
        let dir = std::env::temp_dir().join("quire-smath-test-csv");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.csv");
        std::fs::write(&p, "Code;WLL\nG-2130;4,75\n\"a;b\";\n").unwrap();
        let j = read_csv(&p).unwrap();
        assert_eq!(j["Sheet1"], serde_json::json!([["Code", "WLL"], ["G-2130", 4.75], ["a;b", null]]));
    }
}
