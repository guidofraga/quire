//! Names in stored documents (docs/02-file-format.md §4.3, Units): a stored `2T` is always the
//! unit, so documents written before the nearest definition won everywhere open with their
//! numbers unchanged, and saving writes `2*T` for your variable T.

use serde_json::{Value as Json, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn doc(lines: &[&str]) -> Json {
    let regions: Vec<Json> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| json!({ "id": format!("r{i:05}"), "kind": "math", "at": [0, 40 * i], "expr": l, "show": "value" }))
        .collect();
    json!({ "format": "quire/1", "meta": { "title": "Names" }, "regions": regions })
}

fn exprs(doc: &Json) -> Vec<String> {
    doc["regions"]
        .as_array()
        .map(|rs| rs.iter().filter_map(|r| r["expr"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn report(doc: &Json) -> Result<Json, Box<dyn std::error::Error>> {
    Ok(serde_json::to_value(quire_service::report(doc)?)?)
}

fn shown(report: &Json, i: usize) -> Option<&str> {
    report["regions"][i]["resultText"].as_str()
}

/// What a document opens as, read from its `document.json` bytes.
fn open(doc: &Json) -> Result<Json, Box<dyn std::error::Error>> {
    Ok(quire_service::open_bytes(serde_json::to_string(doc)?.as_bytes())?)
}

/// The `document.json` a save writes.
fn saved(doc: &Json) -> Result<String, Box<dyn std::error::Error>> {
    let bytes = quire_service::save_bytes(doc)?;
    let entries = quire_doc::read_bytes(&bytes)?;
    let (_, text) = entries.into_iter().find(|(n, _)| n == "document.json").ok_or("no document.json")?;
    Ok(String::from_utf8(text)?)
}

#[test]
fn a_document_written_with_the_old_rule_opens_with_its_numbers_unchanged() -> TestResult {
    let legacy = doc(&["T := 300", "x := 2T", "s := 3 m", "v := 1 m/s^2", "y := 2*T", "f(T) := 2 T"]);
    let opened = open(&legacy)?;
    assert_eq!(
        exprs(&opened),
        ["T := 300", "x := 2 'T", "s := 3 m", "v := 1 m/'s^2", "y := 2*T", "f(T) := 2 T"]
    );
    let r = report(&opened)?;
    assert_eq!(shown(&r, 1), Some("2 'T"));
    assert_eq!(shown(&r, 3), Some("1 'm/'s^2"));
    assert_eq!(shown(&r, 4), Some("600"));
    Ok(())
}

#[test]
fn inline_math_and_plots_open_with_their_numbers_unchanged() -> TestResult {
    let mut legacy = doc(&["T := 300"]);
    let regions = legacy["regions"].as_array_mut().ok_or("no regions")?;
    regions.push(json!({ "id": "text01", "kind": "text", "at": [0, 40], "text": "So $`y := 3 T =`, *red*{color=#c00}." }));
    regions.push(json!({ "id": "plot01", "kind": "plot2d", "at": [0, 80], "series": [{ "y": "x*2 T", "range": "0..1" }] }));
    let opened = open(&legacy)?;
    assert_eq!(opened["regions"][1]["text"], "So $`y := 3 'T =`, *red*{color=#c00}.");
    assert_eq!(opened["regions"][2]["series"][0]["y"], "x*2 'T");
    // and saved as opened
    let reopened = quire_service::open_bytes(&quire_service::save_bytes(&opened)?)?;
    assert_eq!(reopened["regions"], opened["regions"]);
    Ok(())
}

#[test]
fn saving_writes_a_product_with_your_variable_explicitly() -> TestResult {
    let typed = doc(&["T := 300", "x := 2T", "h := 2 m", "v := 100 km/h", "w := -3 T^2", "z := 2 m"]);
    let r = report(&typed)?;
    assert_eq!(shown(&r, 1), Some("600"));
    let text = saved(&typed)?;
    for expected in ["\"x := 2*T\"", "\"v := (100 km)/h\"", "\"w := -3*T^2\"", "\"z := 2 m\""] {
        assert!(text.contains(expected), "{expected} in\n{text}");
    }
    // the saved form opens as it was typed, and saves again byte for byte
    let reopened = quire_service::open_bytes(&quire_service::save_bytes(&typed)?)?;
    assert_eq!(saved(&reopened)?, text);
    let r = report(&reopened)?;
    assert_eq!(shown(&r, 1), Some("600"));
    assert_eq!(shown(&r, 3), Some("50000"));
    Ok(())
}

#[test]
fn the_constant_marker_sits_next_to_a_variable_of_the_same_name() -> TestResult {
    let d = doc(&["G := 5", "F := G*#G"]);
    let text = saved(&d)?;
    assert!(text.contains("\"F := G*#G\""), "{text}");
    let r = report(&open(&d)?)?;
    assert!(shown(&r, 1).is_some_and(|s| s.starts_with("3.3")), "{:?}", shown(&r, 1));
    Ok(())
}

#[test]
fn a_definition_says_which_built_in_it_hides() -> TestResult {
    let r = report(&doc(&["T := 300", "G := 2G", "L.span := 5", "x := 2T"]))?;
    assert_eq!(r["regions"][0]["redefines"], json!({ "name": "T", "kind": "unit", "title": "tesla" }));
    assert_eq!(
        r["regions"][1]["redefines"],
        json!({ "name": "G", "kind": "constant", "title": "gravitational constant" })
    );
    assert_eq!(r["regions"][2].get("redefines"), None);
    assert_eq!(r["regions"][3].get("redefines"), None, "a use is not a definition");
    for region in r["regions"].as_array().ok_or("no regions")? {
        assert_eq!(region.get("unitsOverVariables"), None);
    }
    Ok(())
}
