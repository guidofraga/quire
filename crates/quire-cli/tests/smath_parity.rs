//! Byte-for-byte parity of `quire_smath::convert_file` with the Python reference importer
//! `tools/sm2quire.py`, over the SMath corpus.
//!
//! The corpus is not in the repository. Set `QUIRE_SMATH_EXAMPLES` to a folder of `.sm`
//! files, or put them in `<workspace>/examples`. Without a corpus, or without `python3`,
//! the test prints a note and passes.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

type TestResult = Result<(), Box<dyn Error>>;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn corpus_dir() -> PathBuf {
    match std::env::var_os("QUIRE_SMATH_EXAMPLES") {
        Some(dir) => PathBuf::from(dir),
        None => workspace_root().join("examples"),
    }
}

fn python_available() -> bool {
    matches!(Command::new("python3").arg("--version").output(), Ok(out) if out.status.success())
}

fn sm_files(dir: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "sm") && path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// Files under `<out>/assets/`, keyed by their bundle path (`assets/<name>`).
fn python_assets(out: &Path) -> Result<BTreeMap<String, Vec<u8>>, Box<dyn Error>> {
    let mut map = BTreeMap::new();
    let dir = out.join("assets");
    if !dir.is_dir() {
        return Ok(map);
    }
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.is_file() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            map.insert(format!("assets/{name}"), fs::read(&path)?);
        }
    }
    Ok(map)
}

/// The first line where two texts differ, both lines shown; `None` when identical.
fn first_difference(py: &str, rs: &str) -> Option<String> {
    if py == rs {
        return None;
    }
    fn show(line: Option<&str>) -> String {
        match line {
            Some(s) => format!("{:?}", s.chars().take(160).collect::<String>()),
            None => "<end of text>".to_string(),
        }
    }
    let (mut a, mut b) = (py.split('\n'), rs.split('\n'));
    let mut n = 0usize;
    loop {
        n += 1;
        let (x, y) = (a.next(), b.next());
        if x.is_none() && y.is_none() {
            return Some("differs only in trailing bytes".to_string());
        }
        if x != y {
            return Some(format!("line {n}: python {} vs rust {}", show(x), show(y)));
        }
    }
}

/// Compare one file; returns one line per mismatch (empty when identical).
fn compare_file(sm: &Path, scratch: &Path, script: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let name = sm.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = sm.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let out = scratch.join(format!("{stem}.quire"));
    let _ = fs::remove_dir_all(&out);

    let run = Command::new("python3").arg("-I").arg(script).arg(sm).arg(&out).output()?;
    if !run.status.success() {
        let err = String::from_utf8_lossy(&run.stderr);
        return Ok(vec![format!("{name}: the Python importer failed: {}", err.trim())]);
    }

    let mut mismatches = Vec::new();
    let mut report = |output: &str, diff: String| mismatches.push(format!("{name} / {output}: {diff}"));

    // Rust side.
    let bytes = fs::read(sm)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let file_name = sm.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let imported = match quire_smath::convert_file(&text, &file_name) {
        Ok(imported) => imported,
        Err(e) => {
            report("convert", format!("the Rust importer returned an error: {e}"));
            return Ok(mismatches);
        }
    };

    // document.json: canonical::to_string already ends with exactly one newline, matching
    // Python's dump(doc) + "\n" (checked by the comparison itself).
    let rust_doc = quire_service::canonical::to_string(&imported.document);
    let py_doc = fs::read_to_string(out.join("document.json"))?;
    if let Some(d) = first_difference(&py_doc, &rust_doc) {
        report("document.json", d);
    }

    // results.json: written by Python only when there are results.
    let has_results = imported.results.as_object().is_some_and(|m| !m.is_empty());
    let rust_results = if has_results {
        let wrapped = serde_json::json!({
            "format": "quire-results/1",
            "producer": "SMath Studio (imported)",
            "results": imported.results.clone(),
        });
        Some(quire_service::canonical::to_string(&wrapped))
    } else {
        None
    };
    let py_results_path = out.join("results.json");
    let py_results =
        if py_results_path.is_file() { Some(fs::read_to_string(&py_results_path)?) } else { None };
    match (&py_results, &rust_results) {
        (None, None) => {}
        (Some(_), None) => {
            report("results.json", "Python wrote results.json, Rust produced none".to_string())
        }
        (None, Some(_)) => report("results.json", "Rust produced results, Python wrote none".to_string()),
        (Some(py), Some(rs)) => {
            if let Some(d) = first_difference(py, rs) {
                report("results.json", d);
            }
        }
    }

    // assets/: same paths, identical bytes.
    let py_assets = python_assets(&out)?;
    let mut rs_assets: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for asset in &imported.assets {
        rs_assets.insert(asset.path.clone(), asset.data.clone());
    }
    for path in py_assets.keys().filter(|p| !rs_assets.contains_key(*p)) {
        report(path, "Python wrote this asset, Rust did not".to_string());
    }
    for path in rs_assets.keys().filter(|p| !py_assets.contains_key(*p)) {
        report(path, "Rust produced this asset, Python did not".to_string());
    }
    for (path, py_bytes) in &py_assets {
        if let Some(rs_bytes) = rs_assets.get(path).filter(|rs| *rs != py_bytes) {
            let at = py_bytes.iter().zip(rs_bytes.iter()).position(|(a, b)| a != b);
            report(
                path,
                format!(
                    "bytes differ (python {} bytes, rust {} bytes, first difference at byte {:?})",
                    py_bytes.len(),
                    rs_bytes.len(),
                    at
                ),
            );
        }
    }

    let _ = fs::remove_dir_all(&out);
    Ok(mismatches)
}

#[test]
fn smath_import_matches_python_reference_byte_for_byte() -> TestResult {
    let dir = corpus_dir();
    if !dir.is_dir() {
        eprintln!("note: no SMath corpus at {} (set QUIRE_SMATH_EXAMPLES); skipping parity", dir.display());
        return Ok(());
    }
    if !python_available() {
        eprintln!("note: python3 not available; skipping SMath parity");
        return Ok(());
    }
    let files = sm_files(&dir)?;
    if files.is_empty() {
        eprintln!("note: no .sm files in {}; skipping parity", dir.display());
        return Ok(());
    }

    let script = workspace_root().join("tools").join("sm2quire.py");
    let scratch = std::env::temp_dir().join(format!("quire-smath-parity-{}", std::process::id()));
    fs::create_dir_all(&scratch)?;

    let mut report: Vec<String> = Vec::new();
    let mut identical = 0usize;
    for sm in &files {
        match compare_file(sm, &scratch, &script) {
            Ok(mismatches) if mismatches.is_empty() => identical += 1,
            Ok(mismatches) => report.extend(mismatches),
            Err(e) => {
                let name = sm.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                report.push(format!("{name}: harness error: {e}"));
            }
        }
    }
    let _ = fs::remove_dir_all(&scratch);

    eprintln!("SMath parity: {identical}/{} files identical", files.len());
    assert!(
        report.is_empty(),
        "{} mismatch(es) against tools/sm2quire.py:\n{}",
        report.len(),
        report.join("\n")
    );
    Ok(())
}
