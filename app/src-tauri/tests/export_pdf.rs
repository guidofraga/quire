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

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

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

#[test]
#[ignore = "drives the desktop app; see the module comment"]
fn exported_report_has_details_bookmarks_and_links() -> TestResult {
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/report.quire");
    let out = std::env::temp_dir().join(format!("quire-export-{}.pdf", std::process::id()));
    let mut child =
        Command::new(env!("CARGO_BIN_EXE_quire-app")).arg("--export-pdf").arg(&input).arg(&out).spawn()?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        // longer than the app's own limits (100 s in the front end, 120 s for the print job),
        // so a stuck export reports where it stopped before it is killed here
        if start.elapsed() > Duration::from_secs(150) {
            child.kill().ok();
            return Err(
                "the export did not finish; was the app built with --features tauri/custom-protocol?".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(status.success(), "quire-app exited with {status}");
    let doc = Document::load(&out)?;
    std::fs::remove_file(&out).ok();

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
    let expected = [("1 Loads", 1, 0), ("2 Checks", 1, 0), ("2.1 Bending", 2, 1), ("2.2 Deflection", 3, 1)];
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
        [(0, 1), (0, 1), (0, 2), (0, 3), (0, 2), (0, 1), (1, 1), (1, 2), (2, 1), (2, 2), (3, 2), (3, 3)];
    assert_eq!(internal, expected);
    Ok(())
}
