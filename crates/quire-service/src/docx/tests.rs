//! The exported Word file, unpacked and read back: its parts parse, every relationship points at
//! a part that is there, and `document.xml` holds what the page shows.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use roxmltree::{Document as Xml, Node};

use super::*;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/every-region.quire")
}

/// Every file in the package.
fn unpack(bytes: &[u8]) -> std::result::Result<BTreeMap<String, Vec<u8>>, Box<dyn std::error::Error>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut out = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;
        out.insert(f.name()?.to_string(), data);
    }
    Ok(out)
}

fn text<'a>(
    files: &'a BTreeMap<String, Vec<u8>>,
    name: &str,
) -> std::result::Result<&'a str, Box<dyn std::error::Error>> {
    Ok(std::str::from_utf8(files.get(name).ok_or(format!("{name} is missing"))?)?)
}

fn is(n: &Node, ns: &str, name: &str) -> bool {
    n.tag_name().namespace() == Some(ns) && n.tag_name().name() == name
}

fn attr<'a>(n: &Node<'a, '_>, name: &str) -> Option<&'a str> {
    n.attribute((W, name))
}

/// The words of a paragraph or cell, math included.
fn words(n: &Node) -> String {
    n.descendants().filter(|d| is(d, W, "t") || is(d, M, "t")).filter_map(|d| d.text()).collect()
}

fn export_fixture(
    pictures: bool,
) -> std::result::Result<BTreeMap<String, Vec<u8>>, Box<dyn std::error::Error>> {
    let path = fixture();
    let doc = crate::open(&path)?;
    let png = std::fs::read(path.join("assets/503d139a61f01ff8.png"))?;
    let mut opts = DocxOptions {
        file: "every-region".into(),
        date: "2026-11-13".into(),
        time: "10:00".into(),
        flat_units: true,
        ..DocxOptions::default()
    };
    if pictures {
        opts.pictures.insert("plot2d".into(), png.clone());
        opts.pictures.insert("plot3d".into(), png);
        opts.pages.insert("hdgtwo".into(), 1);
        opts.page_count = Some(3);
    }
    unpack(&crate::export_docx(&doc, &opts, Some(&path))?)
}

/// Every XML part parses, and every relationship's target is in the package.
fn check_package(files: &BTreeMap<String, Vec<u8>>) -> TestResult {
    for (name, data) in files {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let s = std::str::from_utf8(data)?;
            Xml::parse(s).map_err(|e| format!("{name}: {e}"))?;
        }
    }
    let types = text(files, "[Content_Types].xml")?;
    for (name, _) in files.iter().filter(|(n, _)| n.starts_with("word/") && n.ends_with(".xml")) {
        assert!(types.contains(&format!("PartName=\"/{name}\"")), "{name} has no content type");
    }
    for (name, data) in files.iter().filter(|(n, _)| n.ends_with(".rels")) {
        let base = name
            .replace("_rels/", "")
            .trim_end_matches(".rels")
            .rsplit_once('/')
            .map_or(String::new(), |(d, _)| format!("{d}/"));
        let xml = std::str::from_utf8(data)?;
        let doc = Xml::parse(xml)?;
        for r in doc.descendants().filter(|n| n.tag_name().name() == "Relationship") {
            if r.attribute("TargetMode") == Some("External") {
                continue;
            }
            let target = r.attribute("Target").ok_or("no target")?;
            let full = if name == "_rels/.rels" { target.to_string() } else { format!("{base}{target}") };
            assert!(files.contains_key(&full), "{name} points at {full}, which is not in the package");
        }
    }
    Ok(())
}

/// Bookmarks Word can resolve: every name valid (a letter first, then letters, digits and `_`,
/// at most 40 characters) and used once, every `w:id` once, every start ended; every `REF`,
/// `PAGEREF` and in-document link names one of them; `STYLEREF` names a heading by its level,
/// which works in any language Word runs in.
fn check_fields(files: &BTreeMap<String, Vec<u8>>) -> TestResult {
    let xml = text(files, "word/document.xml")?;
    let doc = Xml::parse(xml)?;
    let mut names: BTreeMap<String, usize> = BTreeMap::new();
    let mut ids: BTreeMap<String, usize> = BTreeMap::new();
    for b in doc.descendants().filter(|n| is(n, W, "bookmarkStart")) {
        let name = attr(&b, "name").ok_or("a bookmark without a name")?;
        let valid = name.len() <= 40
            && name.starts_with(|c: char| c.is_ascii_alphabetic())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        assert!(valid, "Word can't use the bookmark name {name:?}");
        *names.entry(name.to_string()).or_default() += 1;
        *ids.entry(attr(&b, "id").ok_or("a bookmark without an id")?.to_string()).or_default() += 1;
    }
    for (name, n) in &names {
        assert_eq!(*n, 1, "bookmark {name} is set {n} times");
    }
    for (id, n) in &ids {
        assert_eq!(*n, 1, "bookmark id {id} is used {n} times");
    }
    let ends: Vec<&str> =
        doc.descendants().filter(|n| is(n, W, "bookmarkEnd")).filter_map(|n| attr(&n, "id")).collect();
    assert_eq!(ends.len(), ids.len(), "every bookmark is ended once");
    assert!(ends.iter().all(|e| ids.contains_key(*e)));

    let mut targets = Vec::new();
    for instr in doc.descendants().filter(|n| is(n, W, "instrText")).filter_map(|n| n.text()) {
        let mut words = instr.split_whitespace();
        if let (Some("REF" | "PAGEREF"), Some(target)) = (words.next(), words.next()) {
            targets.push(target.to_string());
        }
    }
    for link in doc.descendants().filter(|n| is(n, W, "hyperlink")) {
        if let Some(anchor) = attr(&link, "anchor") {
            targets.push(anchor.to_string());
        }
    }
    assert!(!targets.is_empty());
    for t in &targets {
        assert_eq!(names.get(t), Some(&1), "{t} names no bookmark");
    }
    // the contents lists link to bookmarks of their own, never to the ones references use:
    // Word deletes the bookmarks a contents list linked to when it rebuilds the list
    for link in doc.descendants().filter(|n| is(n, W, "hyperlink")) {
        let inside_toc = link.ancestors().any(|a| {
            is(&a, W, "p")
                && a.descendants().any(|d| {
                    is(&d, W, "pStyle")
                        && attr(&d, "val").is_some_and(|s| s.starts_with("TOC") || s == "TableofFigures")
                })
        });
        if inside_toc {
            assert!(
                attr(&link, "anchor").is_some_and(|a| a.starts_with("Toc_")),
                "a contents entry links to a reference's bookmark"
            );
        }
    }
    for (name, data) in files.iter().filter(|(k, _)| k.starts_with("word/") && k.ends_with(".xml")) {
        let part = Xml::parse(std::str::from_utf8(data)?)?;
        for instr in part.descendants().filter(|n| is(n, W, "instrText")).filter_map(|n| n.text()) {
            if instr.trim_start().starts_with("STYLEREF") {
                let arg = instr.split_whitespace().nth(1).unwrap_or_default();
                assert!(
                    arg.parse::<u8>().is_ok_and(|l| (1..=9).contains(&l)),
                    "{name}: {instr:?} names a style, not a level"
                );
            }
        }
    }
    Ok(())
}

#[test]
fn every_region_kind_comes_through_as_word_content() -> TestResult {
    let files = export_fixture(true)?;
    check_package(&files)?;
    check_fields(&files)?;
    let xml = text(&files, "word/document.xml")?;
    let doc = Xml::parse(xml)?;
    let paras: Vec<Node> = doc.descendants().filter(|n| is(n, W, "p")).collect();
    let style = |p: &Node| -> Option<String> {
        p.children()
            .find(|c| is(c, W, "pPr"))?
            .children()
            .find(|c| is(c, W, "pStyle"))
            .and_then(|s| attr(&s, "val").map(str::to_string))
    };
    let numbered = |p: &Node| p.descendants().any(|d| is(&d, W, "numId") && attr(&d, "val") == Some("1"));

    // headings: Word's heading styles, numbered by Word, the title not numbered
    let headings: Vec<(String, String, bool)> = paras
        .iter()
        .filter_map(|p| {
            style(p).filter(|s| s.starts_with("Heading") || s == "Title").map(|s| (s, words(p), numbered(p)))
        })
        .collect();
    assert_eq!(
        headings,
        [
            ("Title".into(), "Every region kind".into(), false),
            ("Heading1".into(), "Text and formatting".into(), true),
            ("Heading2".into(), "Math".into(), true),
            ("Heading1".into(), "Tables and figures".into(), true),
            ("Heading1".into(), "After the page break".into(), true),
        ]
    );

    // text formatting
    let runs: Vec<Node> = doc.descendants().filter(|n| is(n, W, "r")).collect();
    let formatted = |prop: &str, word: &str| {
        runs.iter().any(|r| words(r) == word && r.descendants().any(|d| is(&d, W, prop)))
    };
    for (prop, word) in [
        ("b", "bold"),
        ("i", "italic"),
        ("u", "underlined"),
        ("strike", "struck"),
        ("strike", "deleted"),
        ("u", "inserted"),
        ("highlight", "marked"),
        ("vertAlign", "2"),
        ("color", "red"),
        ("sz", "large"),
        ("rFonts", "code"),
    ] {
        assert!(formatted(prop, word), "“{word}” has no w:{prop}");
    }
    let rels = text(&files, "word/_rels/document.xml.rels")?;
    assert!(rels.contains("Target=\"https://www.example.org/page\" TargetMode=\"External\""), "{rels}");
    assert!(doc.descendants().any(|n| is(&n, W, "hyperlink") && words(&n) == "another"));
    // bullets and numbers
    assert!(paras.iter().any(|p| words(p) == "nested item"
        && p.descendants().any(|d| is(&d, W, "ilvl") && attr(&d, "val") == Some("1"))));
    assert!(
        paras.iter().any(|p| words(p) == "one"
            && p.descendants().any(|d| is(&d, W, "numId") && attr(&d, "val") == Some("3")))
    );

    // one equation per math region, with its result and units as Quire shows them
    let equations: Vec<String> = doc.descendants().filter(|n| is(n, M, "oMath")).map(|n| words(&n)).collect();
    for expected in [
        "q≔12\u{2009}kN/m",
        "L≔6\u{2009}m",
        "M≔q·L28=54\u{2009}kN·m",
        "ddiag≔b2+h2=583.1\u{2009}mm",
        "r≔327=3",
        "K≔2−1−12=2−1−12",
        // the ∑ is the n-ary's character, not text
        "S≔i=110i2=385",
        "M≤60\u{2009}kN·m",
        "M=54\u{2009}kN·m",
    ] {
        assert!(equations.iter().any(|e| e == expected), "no equation {expected:?} in {equations:#?}");
    }
    let math_regions = crate::open(&fixture())?["regions"]
        .as_array()
        .map_or(0, |r| r.iter().filter(|r| r["kind"] == "math").count());
    let in_body: usize = paras.iter().filter(|p| p.children().any(|c| is(&c, M, "oMath"))).count();
    assert!(in_body >= math_regions, "{in_body} paragraphs with an equation for {math_regions} math regions");
    for tag in ["f", "rad", "sSup", "sSub", "m", "nary", "d"] {
        assert!(doc.descendants().any(|n| is(&n, M, tag)), "no m:{tag}");
    }
    // checks with their mark
    assert!(paras.iter().any(|p| words(p).contains("M≤60\u{2009}kN·m\u{2003}✓")));
    assert!(paras.iter().any(|p| words(p).contains("M≤40\u{2009}kN·m\u{2003}✗ fails")));
    assert!(paras.iter().any(|p| words(p) == "2 of 5 failing"));
    // an error is shown under its line
    assert!(paras.iter().any(|p| words(p).contains("undefinedname")));

    // tables: the header row repeats on each page, the caption is numbered by a SEQ field
    let tables: Vec<Node> = doc.descendants().filter(|n| is(n, W, "tbl")).collect();
    let sheet = tables.iter().find(|t| words(t).starts_with("LoadCharacteristic")).ok_or("no loads table")?;
    let first_row = sheet.children().find(|c| is(c, W, "tr")).ok_or("no rows")?;
    assert!(first_row.descendants().any(|d| is(&d, W, "tblHeader")), "the header row does not repeat");
    assert_eq!(sheet.children().filter(|c| is(c, W, "tr")).count(), 4);
    assert!(words(sheet).contains("8.1 kN/m"), "{}", words(sheet));
    let bound = tables.iter().find(|t| words(t) == "123456").ok_or("no bound table")?;
    assert!(bound.descendants().any(|d| is(&d, W, "tblHeader")));
    let instr: Vec<String> = doc
        .descendants()
        .filter(|n| is(n, W, "instrText"))
        .filter_map(|n| n.text())
        .map(|t| t.trim().to_string())
        .collect();
    for field in [
        "TOC \\o \"1-6\" \\h \\z \\u",
        "TOC \\h \\z \\c \"Figure\"",
        "SEQ Figure \\* ARABIC",
        "SEQ Table \\* ARABIC",
        "REF Ref_plot2d \\h",
        "REF Num_sheett \\h",
        "REF Ref_hdgtwo \\r \\h",
        "PAGEREF Ref_hdgtwo \\h",
        "REF Title_imagee \\h",
    ] {
        assert!(instr.iter().any(|i| i == field), "no field {field} in {instr:?}");
    }
    let captions: Vec<String> =
        paras.iter().filter(|p| style(p).as_deref() == Some("Caption")).map(words).collect();
    assert_eq!(
        captions,
        [
            "Table 1 – Loads per metre",
            "Table 2 – A bound matrix",
            "Figure 1 – Bending moment",
            "Figure 2 – A surface",
            "Figure 3 – A picture"
        ]
    );
    // the cached text of a reference reads as the page does
    assert!(
        paras.iter().any(|p| words(p).contains("See Figure 1, Table 1, table 1, Section 1.1 on page 2")),
        "{}",
        paras.iter().map(words).filter(|w| w.starts_with("See")).collect::<String>()
    );

    // plots and the image as pictures, at their size on the page
    let drawings: Vec<Node> = doc.descendants().filter(|n| is(n, W, "drawing")).collect();
    assert_eq!(drawings.len(), 3);
    let extent = drawings[0].descendants().find(|d| d.tag_name().name() == "extent").ok_or("no extent")?;
    assert_eq!(extent.attribute("cx"), Some("3048000"), "320 px is 3 048 000 EMU");
    assert!(files.keys().any(|k| k.starts_with("word/media/image")));

    // the solve block is one framed cell; the area its title
    assert!(tables.iter().any(|t| words(t).contains("Given") && words(t).contains("x+y=10\u{2003}✓")));
    assert!(paras.iter().any(|p| words(p) == "Working"));
    // regions side by side: a borderless table
    assert!(tables.iter().any(|t| words(t).starts_with("q≔12\u{2009}kN/m")
        && t.descendants().any(|d| is(&d, W, "top") && attr(&d, "val") == Some("nil"))));

    // the page break: the heading after it starts a new page
    let after = paras.iter().find(|p| words(p) == "After the page break").ok_or("no heading")?;
    assert!(after.descendants().any(|d| is(&d, W, "pageBreakBefore")));

    // the page: A4, margins, a first page without header, odd and even footers
    let sect = doc.descendants().find(|n| is(n, W, "sectPr")).ok_or("no sectPr")?;
    let pg = sect.children().find(|c| is(c, W, "pgSz")).ok_or("no pgSz")?;
    assert_eq!((attr(&pg, "w"), attr(&pg, "h")), (Some("11906"), Some("16838")));
    let mar = sect.children().find(|c| is(c, W, "pgMar")).ok_or("no pgMar")?;
    assert_eq!(attr(&mar, "top"), Some("1417"), "25 mm");
    assert!(sect.children().any(|c| is(&c, W, "titlePg")));
    let kinds: Vec<(&str, &str)> = sect
        .children()
        .filter(|c| c.tag_name().name().ends_with("Reference"))
        .filter_map(|c| Some((c.tag_name().name(), attr(&c, "type")?)))
        .collect();
    assert_eq!(kinds.len(), 6, "{kinds:?}");
    assert!(text(&files, "word/settings.xml")?.contains("<w:evenAndOddHeaders/>"));
    let footers: String = files
        .iter()
        .filter(|(k, _)| k.starts_with("word/footer"))
        .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
        .collect();
    for f in [" PAGE ", " NUMPAGES ", " DATE ", "STYLEREF 1 "] {
        assert!(footers.contains(f), "the footers have no {f} field");
    }
    assert!(footers.contains(">every-region<"), "{{file}} on even pages");
    let headers: String = files
        .iter()
        .filter(|(k, _)| k.starts_with("word/header"))
        .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
        .collect();
    assert!(headers.contains(">Example Engineering<") && headers.contains(">Every region kind<"));
    assert!(headers.contains("<w:drawing>"), "the logo in the header");
    Ok(())
}

#[test]
fn without_the_app_a_plot_is_a_framed_placeholder_of_its_size() -> TestResult {
    let files = export_fixture(false)?;
    check_package(&files)?;
    check_fields(&files)?;
    let doc = Xml::parse(text(&files, "word/document.xml")?)?;
    let drawings = doc.descendants().filter(|n| is(n, W, "drawing")).count();
    assert_eq!(drawings, 1, "only the image, which the bundle holds");
    let cells: Vec<String> = doc.descendants().filter(|n| is(n, W, "tc")).map(|n| words(&n)).collect();
    assert!(cells.iter().any(|c| c.starts_with("Plot of q*x*(L - x)/2")), "{cells:?}");
    assert!(cells.iter().any(|c| c.starts_with("3D plot of sin(x)*cos(y)")));
    Ok(())
}

#[test]
fn the_beam_template_exports_with_an_equation_for_every_math_region() -> TestResult {
    let doc = crate::templates::document(Path::new(""), "builtin:beam")?.doc;
    let files = unpack(&crate::export_docx(
        &doc,
        &DocxOptions { flat_units: true, ..DocxOptions::default() },
        None,
    )?)?;
    check_package(&files)?;
    check_fields(&files)?;
    let xml = Xml::parse(text(&files, "word/document.xml")?)?;
    let math = doc["regions"].as_array().map_or(0, |r| r.iter().filter(|r| r["kind"] == "math").count());
    let equations = xml.descendants().filter(|n| is(n, M, "oMath")).count();
    assert!(equations >= math, "{equations} equations for {math} math regions");
    let all = words(&xml.root());
    // in reading order: the data before the results that use them
    let pos = |s: &str| all.find(s).ok_or(format!("{s:?} is not in the document"));
    assert!(pos("L≔7\u{2009}m")? < pos("Design bending moment")?);
    assert!(pos("Design basis")? < pos("Ultimate limit state")?);
    // the deflection check fails on purpose
    assert!(all.contains("δtot≤δlim.tot\u{2003}✗ fails"), "{all}");
    Ok(())
}

#[test]
fn every_built_in_template_exports_with_fields_word_can_resolve() -> TestResult {
    for t in crate::templates::list(Path::new("")).into_iter().filter(|t| t.builtin) {
        let doc = crate::templates::document(Path::new(""), &t.id)?.doc;
        let files = unpack(&crate::export_docx(&doc, &DocxOptions::default(), None)?)?;
        check_package(&files).map_err(|e| format!("{}: {e}", t.id))?;
        check_fields(&files).map_err(|e| format!("{}: {e}", t.id))?;
    }
    Ok(())
}

#[test]
fn the_apps_options_read_from_json() -> TestResult {
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
    let opts = DocxOptions::from_json(&serde_json::json!({
        "pictures": { "p1": format!("data:image/png;base64,{png}"), "p2": png },
        "heights": { "a": 24.5 },
        "pages": { "a": 2 },
        "pageCount": 4,
        "file": "Report",
        "flatUnits": false
    }))?;
    assert_eq!(opts.pictures.get("p1").map(|b| &b[..4]), Some(&b"\x89PNG"[..]));
    assert_eq!(opts.pictures.get("p1"), opts.pictures.get("p2"));
    assert_eq!(opts.heights.get("a"), Some(&24.5));
    assert_eq!(opts.pages.get("a"), Some(&2));
    assert_eq!(opts.page_count, Some(4));
    assert!(!opts.flat_units);
    assert!(DocxOptions::from_json(&serde_json::json!({ "pictures": { "x": "%%%" } })).is_err());
    Ok(())
}

#[test]
fn headings_are_read_as_the_page_reads_them() {
    assert_eq!(heading_level("# A"), 1);
    assert_eq!(heading_level("### A\n\ntext"), 3);
    assert_eq!(heading_level("{.title}\n# A"), 0);
    assert_eq!(heading_level("{.center}\n## A"), 2);
    assert_eq!(heading_level("#hashtag"), 0);
    assert_eq!(pretty_value("9.80665 'm/'s^2"), "9.80665 m/s²");
    assert_eq!(pretty_value("1.5*10^-3 'm"), "1.5·10⁻³ m");
    assert_eq!(trim_label("Figure 3 –"), "Figure 3");
}
