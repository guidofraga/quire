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

/// Two exports side by side would slow each other down, and the app's start-up limits with them.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `quire-app --export-pdf` on the report and return what it said on stderr.
fn export(out: &Path, env: &[(&str, &str)]) -> TestResult<String> {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/report.quire");
    let mut child = Command::new(env!("CARGO_BIN_EXE_quire-app"))
        .arg("--export-pdf")
        .arg(&input)
        .arg(out)
        .envs(env.iter().copied())
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
            Err(format!("the export did not end, and the app's own watchdog did not stop it\n{said}").into())
        }
        Some(status) if !status.success() => Err(format!("quire-app exited with {status}\n{said}").into()),
        Some(_) => {
            eprintln!("APPLOG {}", said.replace('\n', "\nAPPLOG "));
            Ok(said)
        }
    }
}

fn temp_pdf(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("quire-{name}-{}.pdf", std::process::id()))
}

/// Issue #93: on Linux WebKitGTK sometimes never runs the page, and the export then starts again
/// in a new process. The first try is made to stall, so this fails (after the 60 s limit) if the
/// export does not start over.
#[test]
#[cfg(target_os = "linux")]
#[ignore = "drives the desktop app; see the module comment"]
fn export_starts_over_when_the_page_never_runs() -> TestResult {
    let out = temp_pdf("restart");
    let said = export(&out, &[("QUIRE_EXPORT_STALL_FIRST_TRY", "1")])?;
    assert!(said.contains("starting the export again"), "no restart in:\n{said}");
    assert!(Document::load(&out)?.page_iter().count() > 0);
    std::fs::remove_file(&out).ok();
    Ok(())
}

#[test]
#[ignore = "drives the desktop app; see the module comment"]
fn exported_report_has_details_bookmarks_and_links() -> TestResult {
    let out = temp_pdf("export");
    export(&out, &[])?;
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
