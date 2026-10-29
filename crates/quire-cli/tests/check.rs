//! Worksheets whose results are known independently (`results.json`) must keep
//! reproducing them: the bundles in `tests/fixtures`, and any listed in
//! `QUIRE_CORPUS` (paths separated by `:`, e.g. a private SMath corpus).

use std::path::{Path, PathBuf};

use quire_cli::{Verdict, compare, evaluate};

fn bundles() -> Vec<PathBuf> {
    let mut roots = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")];
    if let Some(extra) = std::env::var_os("QUIRE_CORPUS") {
        roots.extend(std::env::split_paths(&extra));
    }
    let mut out = Vec::new();
    for root in roots {
        if root.join("results.json").is_file() {
            out.push(root);
        } else if let Ok(entries) = std::fs::read_dir(&root) {
            let mut found: Vec<_> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.join("results.json").is_file())
                .collect();
            found.sort();
            out.extend(found);
        }
    }
    out
}

#[test]
fn reference_results_are_reproduced() -> Result<(), Box<dyn std::error::Error>> {
    let bundles = bundles();
    assert!(!bundles.is_empty(), "no fixtures found");
    let mut failures = Vec::new();
    for path in &bundles {
        let bundle = quire_doc::load(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let results =
            bundle.results.as_ref().ok_or_else(|| format!("{}: no results.json", path.display()))?;
        let rows = compare(results, &evaluate(&bundle.document));
        assert_eq!(rows.len(), results.results.len(), "{}: a reference result has no region", path.display());
        for r in rows {
            if let Verdict::Mismatch(m) | Verdict::Failed(m) = &r.verdict {
                let ours = r.ours.as_deref().unwrap_or("—");
                failures.push(format!(
                    "{}: {}  expected {}, got {ours} ({m})",
                    path.display(),
                    r.expr,
                    r.reference
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{} result(s) changed:\n{}", failures.len(), failures.join("\n"));
    Ok(())
}
