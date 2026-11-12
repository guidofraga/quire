//! End to end: `quire-app --export-pdf` on a small report, read back with lopdf.
//!
//! It drives the real app (WebKit lays out and prints the page view), so it needs the
//! built front end embedded in the binary and a logged-in desktop session (macOS or Linux):
//!
//! ```sh
//! npm --prefix app run build
//! cargo test -p quire-app --features tauri/custom-protocol -- --ignored
//! ```
#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId, decode_text_string};

type TestResult<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn text(doc: &Document, dict: &Dictionary, key: &[u8]) -> TestResult<String> {
    let (_, o) = doc.dereference(dict.get(key)?)?;
    Ok(decode_text_string(o)?)
}

fn get<'a>(doc: &'a Document, dict: &Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    doc.get_dictionary(dict.get(key).ok()?.as_reference().ok()?).ok()
}

fn page_of(doc: &Document, dest: &Object) -> TestResult<usize> {
    let pages: Vec<ObjectId> = doc.page_iter().collect();
    let page = dest.as_array()?.first().ok_or("an empty destination")?.as_reference()?;
    Ok(pages.iter().position(|&p| p == page).ok_or("the destination page is not in the document")?)
}

/// (title, page index, depth) of every bookmark, in order.
fn bookmarks(
    doc: &Document,
    first: Option<&Dictionary>,
    depth: usize,
    out: &mut Vec<(String, usize, usize)>,
) -> TestResult {
    let mut item = first;
    while let Some(d) = item {
        out.push((text(doc, d, b"Title")?, page_of(doc, d.get(b"Dest")?)?, depth));
        bookmarks(doc, get(doc, d, b"First"), depth + 1, out)?;
        item = get(doc, d, b"Next");
    }
    Ok(())
}

/// Export `input` with `quire-app --export-pdf` (`name` keeps the tests' files apart) and read it back.
fn export(input: &Path, name: &str) -> TestResult<Document> {
    let out = std::env::temp_dir().join(format!("quire-export-{name}-{}.pdf", std::process::id()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_quire-app"))
        .arg("--export-pdf")
        .arg(input)
        .arg(&out)
        .stderr(Stdio::piped())
        .spawn()?;
    // what the app says on stderr, read as it comes so a full pipe can't stall it
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let said = std::thread::spawn(move || {
        let mut text = String::new();
        stderr.read_to_string(&mut text).ok();
        text
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        // longer than the app's own limits (60 s to start, 140 s in all), so a stuck export
        // ends itself and says where it stopped before it is killed here
        if start.elapsed() > Duration::from_secs(170) {
            child.kill().ok();
            child.wait().ok();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let said = said.join().unwrap_or_default();
    match status {
        None => {
            return Err(format!(
                "the export did not end, and the app's own watchdog did not stop it\n{said}"
            )
            .into());
        }
        Some(status) if !status.success() => {
            return Err(format!("quire-app exited with {status}\n{said}").into());
        }
        Some(_) => {}
    }
    let doc = Document::load(&out)?;
    std::fs::remove_file(&out).ok();
    Ok(doc)
}

#[test]
#[ignore = "drives the desktop app; see the module comment"]
fn exported_report_has_details_bookmarks_and_links() -> TestResult {
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/report.quire");
    let doc = export(&input, "report")?;

    let info = doc.get_dictionary(doc.trailer.get(b"Info")?.as_reference()?)?;
    assert_eq!(text(&doc, info, b"Title")?, "Footbridge deck check");
    assert_eq!(text(&doc, info, b"Author")?, "A. Engineer, B. Checker");
    assert_eq!(text(&doc, info, b"Keywords")?, "steel, footbridge");
    assert_eq!(text(&doc, info, b"Company")?, "Example Structures Ltd");
    assert!(text(&doc, info, b"Creator")?.starts_with("Quire "));

    let catalog = doc.catalog()?;
    assert_eq!(text(&doc, catalog, b"Lang")?, "en-GB");
    let labels = catalog.get(b"PageLabels")?.as_dict()?.get(b"Nums")?.as_array()?;
    assert_eq!(labels[1].as_dict()?.get(b"St")?.as_i64()?, 3);

    // the title heading is neither numbered nor listed; the contents lists are on page 1
    let mut marks = Vec::new();
    let outlines = get(&doc, catalog, b"Outlines").ok_or("no outlines")?;
    bookmarks(&doc, get(&doc, outlines, b"First"), 0, &mut marks)?;
    // "2 Checks" would end page 1 with "2.1 Bending" on page 2: it moves there with it
    let expected = [("1 Loads", 1, 0), ("2 Checks", 2, 0), ("2.1 Bending", 2, 1), ("2.2 Deflection", 3, 1)];
    let expected: Vec<_> = expected.iter().map(|&(t, p, d)| (t.to_string(), p, d)).collect();
    assert_eq!(marks, expected);

    // every link either leaves for the web or jumps to a page in this file
    let mut internal = Vec::new();
    let mut web = Vec::new();
    for (k, page) in doc.page_iter().enumerate() {
        for annot in doc.get_page_annotations(page)? {
            if let Ok(dest) = annot.get(b"Dest") {
                internal.push((k, page_of(&doc, dest)?));
            } else {
                let (_, action) = doc.dereference(annot.get(b"A")?)?;
                let (_, uri) = doc.dereference(action.as_dict()?.get(b"URI")?)?;
                web.push(String::from_utf8_lossy(uri.as_str()?).into_owned());
            }
        }
    }
    // WebKit keeps web links only on macOS; WebKitGTK's PDF print writes them as plain text
    if cfg!(target_os = "macos") {
        assert_eq!(web, ["https://example.com/eurocode"]);
    }
    // six contents-list rows on page 0, then "Table 1" and "Figure 1", "1" and "Figure 1",
    // "Section 2.1" and the Summary of Checks row for the check above it
    let expected =
        [(0, 1), (0, 2), (0, 2), (0, 3), (0, 2), (0, 1), (1, 1), (1, 2), (2, 1), (2, 2), (3, 2), (3, 3)];
    assert_eq!(internal, expected);
    Ok(())
}

type Matrix = [f64; 6];

fn times(a: Matrix, b: Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn matrix(args: &[Object]) -> Option<Matrix> {
    let v: Vec<f64> = args.iter().filter_map(|o| o.as_float().ok().map(f64::from)).collect();
    (v.len() == 6).then(|| [v[0], v[1], v[2], v[3], v[4], v[5]])
}

/// The baseline height (points from the paper's foot) of every piece of text drawn by `content`
/// under `ctm`, following form XObjects.
fn text_heights(
    doc: &Document,
    content: &[u8],
    resources: Option<&Dictionary>,
    ctm: Matrix,
    out: &mut Vec<f64>,
) {
    let Ok(ops) = Content::decode(content) else { return };
    let mut stack = Vec::new();
    let (mut ctm, mut tm, mut line) = (ctm, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let mut leading = 0.0;
    for op in &ops.operations {
        let num = |i: usize| op.operands.get(i).and_then(|o| o.as_float().ok()).map(f64::from).unwrap_or(0.0);
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ctm),
            "cm" => {
                if let Some(m) = matrix(&op.operands) {
                    ctm = times(m, ctm);
                }
            }
            "BT" => (tm, line) = ([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            "Tm" => {
                if let Some(m) = matrix(&op.operands) {
                    (tm, line) = (m, m);
                }
            }
            "TL" => leading = num(0),
            "Td" | "TD" | "T*" => {
                let (tx, ty) = if op.operator == "T*" { (0.0, -leading) } else { (num(0), num(1)) };
                if op.operator == "TD" {
                    leading = -ty;
                }
                line = times([1.0, 0.0, 0.0, 1.0, tx, ty], line);
                tm = line;
            }
            "Tj" | "TJ" | "'" | "\"" => out.push(times(tm, ctm)[5]),
            "Do" => {
                let form = op
                    .operands
                    .first()
                    .and_then(|n| n.as_name().ok())
                    .and_then(|n| resources?.get(b"XObject").ok()?.as_dict().ok()?.get(n).ok())
                    .and_then(|o| o.as_reference().ok())
                    .and_then(|id| doc.get_object(id).ok()?.as_stream().ok());
                if let Some(form) = form {
                    let m = form.dict.get(b"Matrix").ok().and_then(|m| matrix(m.as_array().ok()?));
                    let inner = times(m.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]), ctm);
                    let res = form.dict.get(b"Resources").ok().and_then(|r| match r {
                        Object::Reference(id) => doc.get_dictionary(*id).ok(),
                        Object::Dictionary(d) => Some(d),
                        _ => None,
                    });
                    let bytes = form.decompressed_content().unwrap_or_else(|_| form.content.clone());
                    text_heights(doc, &bytes, res.or(resources), inner, out);
                }
            }
            _ => {}
        }
    }
}

#[test]
#[ignore = "drives the desktop app; see the module comment"]
fn the_pdf_is_printed_at_the_page_views_size() -> TestResult {
    // A4 with 20 mm margins: a line just above the bottom margin of page 1, another on page 2
    let dir = std::env::temp_dir().join(format!("quire-scale-{}", std::process::id()));
    let one = dir.join("one.quire");
    let two = dir.join("two.quire");
    for d in [&one, &two] {
        std::fs::create_dir_all(d)?;
    }
    let doc = |regions: &str| {
        format!(
            r#"{{"format":"quire/1","meta":{{"title":"Scale"}},"page":{{"view":"pages","paper":"A4"}},"regions":[{regions}]}}"#
        )
    };
    std::fs::write(one.join("document.json"), doc(r#"{"id":"a","kind":"math","at":[0,0],"expr":"a:=1"}"#))?;
    std::fs::write(
        two.join("document.json"),
        doc(concat!(
            r#"{"id":"a","kind":"math","at":[0,0],"expr":"a:=1"},"#,
            r#"{"id":"foot","kind":"math","at":[0,936],"expr":"foot:=2"},"#,
            r#"{"id":"next","kind":"math","at":[0,1100],"expr":"next:=3"}"#
        )),
    )?;
    let exported = (export(&one, "scale-one"), export(&two, "scale-two"));
    std::fs::remove_dir_all(&dir).ok();
    let (one, two) = (exported.0?, exported.1?);

    // a page of content prints as one page, two as two: no foot of a page spills over
    assert_eq!(one.get_pages().len(), 1, "a one-page document");
    let pages = two.get_pages();
    assert_eq!(pages.len(), 2, "a two-page document");

    // the line at the foot of page 1 sits inside the content area, above the 20 mm margin
    let margin = 20.0 * 72.0 / 25.4;
    let page = *pages.get(&1).ok_or("no page 1")?;
    let resources = two.get_page_resources(page)?.0;
    let mut heights = Vec::new();
    text_heights(&two, &two.get_page_content(page), resources, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], &mut heights);
    let lowest = heights.iter().copied().fold(f64::INFINITY, f64::min);
    assert!(heights.len() >= 2, "text found on page 1: {heights:?}");
    assert!(
        lowest > margin,
        "the lowest text on page 1 is {lowest:.1} pt from the foot, in the {margin:.1} pt margin"
    );
    // and no lower than the page view puts it: its line ends 20 mm + (971 - 936 - line) px up
    assert!(lowest < margin + 40.0, "the lowest text on page 1 is {lowest:.1} pt from the foot");
    Ok(())
}
