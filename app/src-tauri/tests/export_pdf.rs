//! End to end: `quire-app --export-pdf` on a small report, read back with lopdf.
//!
//! It drives the real app (WebKit lays out and prints the page view), so it needs the
//! built front end embedded in the binary and a logged-in macOS session:
//!
//! ```sh
//! npm --prefix app run build
//! cargo test -p quire-app --features tauri/custom-protocol -- --ignored
//! ```
#![cfg(target_os = "macos")]

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use lopdf::{Dictionary, Document, Object, ObjectId, decode_text_string};

fn text(doc: &Document, dict: &Dictionary, key: &[u8]) -> String {
    let (_, o) = doc.dereference(dict.get(key).unwrap()).unwrap();
    decode_text_string(o).unwrap()
}

fn get<'a>(doc: &'a Document, dict: &Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    doc.get_dictionary(dict.get(key).ok()?.as_reference().ok()?).ok()
}

fn page_of(doc: &Document, dest: &Object) -> usize {
    let pages: Vec<ObjectId> = doc.page_iter().collect();
    let page = dest.as_array().unwrap()[0].as_reference().unwrap();
    pages.iter().position(|&p| p == page).unwrap()
}

/// (title, page index, depth) of every bookmark, in order.
fn bookmarks(
    doc: &Document,
    first: Option<&Dictionary>,
    depth: usize,
    out: &mut Vec<(String, usize, usize)>,
) {
    let mut item = first;
    while let Some(d) = item {
        out.push((text(doc, d, b"Title"), page_of(doc, d.get(b"Dest").unwrap()), depth));
        bookmarks(doc, get(doc, d, b"First"), depth + 1, out);
        item = get(doc, d, b"Next");
    }
}

#[test]
#[ignore = "drives the desktop app; see the module comment"]
fn exported_report_has_details_bookmarks_and_links() {
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/report.quire");
    let out = std::env::temp_dir().join(format!("quire-export-{}.pdf", std::process::id()));
    let mut child = Command::new(env!("CARGO_BIN_EXE_quire-app"))
        .arg("--export-pdf")
        .arg(&input)
        .arg(&out)
        .spawn()
        .expect("start quire-app");
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > Duration::from_secs(120) {
            child.kill().ok();
            panic!("the export did not finish; was the app built with --features tauri/custom-protocol?");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "quire-app exited with {status}");
    let doc = Document::load(&out).expect("a readable PDF");
    std::fs::remove_file(&out).ok();

    let info = doc.get_dictionary(doc.trailer.get(b"Info").unwrap().as_reference().unwrap()).unwrap();
    assert_eq!(text(&doc, info, b"Title"), "Footbridge deck check");
    assert_eq!(text(&doc, info, b"Author"), "A. Engineer, B. Checker");
    assert_eq!(text(&doc, info, b"Keywords"), "steel, footbridge");
    assert_eq!(text(&doc, info, b"Company"), "Example Structures Ltd");
    assert!(text(&doc, info, b"Creator").starts_with("Quire "));

    let catalog = doc.catalog().unwrap();
    assert_eq!(text(&doc, catalog, b"Lang"), "en-GB");
    let labels =
        catalog.get(b"PageLabels").unwrap().as_dict().unwrap().get(b"Nums").unwrap().as_array().unwrap();
    assert_eq!(labels[1].as_dict().unwrap().get(b"St").unwrap().as_i64().unwrap(), 3);

    // the title heading is neither numbered nor listed; the contents lists are on page 1
    let mut marks = Vec::new();
    bookmarks(&doc, get(&doc, get(&doc, catalog, b"Outlines").unwrap(), b"First"), 0, &mut marks);
    let expected = [("1 Loads", 1, 0), ("2 Checks", 1, 0), ("2.1 Bending", 2, 1), ("2.2 Deflection", 3, 1)];
    let expected: Vec<_> = expected.iter().map(|&(t, p, d)| (t.to_string(), p, d)).collect();
    assert_eq!(marks, expected);

    // every link either leaves for the web or jumps to a page in this file
    let mut internal = Vec::new();
    let mut web = Vec::new();
    for (k, page) in doc.page_iter().enumerate() {
        for annot in doc.get_page_annotations(page).unwrap() {
            if let Ok(dest) = annot.get(b"Dest") {
                internal.push((k, page_of(&doc, dest)));
            } else {
                let (_, action) = doc.dereference(annot.get(b"A").unwrap()).unwrap();
                let (_, uri) = doc.dereference(action.as_dict().unwrap().get(b"URI").unwrap()).unwrap();
                web.push(String::from_utf8_lossy(uri.as_str().unwrap()).into_owned());
            }
        }
    }
    assert_eq!(web, ["https://example.com/eurocode"]);
    // six contents-list rows on page 0, then "Table 1" and "Figure 1", "1" and "Figure 1",
    // "Section 2.1" and the Summary of Checks row for the check above it
    let expected =
        [(0, 1), (0, 1), (0, 2), (0, 3), (0, 2), (0, 1), (1, 1), (1, 2), (2, 1), (2, 2), (3, 2), (3, 3)];
    assert_eq!(internal, expected);
}
