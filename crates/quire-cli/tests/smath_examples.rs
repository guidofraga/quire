//! Ratchet over the SMath example corpus: every worksheet must import without error, evaluate
//! without panicking, and reproduce at least the number of SMath's cached results that `FLOOR`
//! records for it. The floors only go up; raise one when a fix lands.
//!
//! The corpus is not in the repository. Set `QUIRE_SMATH_EXAMPLES` to a folder of `.sm` files,
//! or put them in `<workspace>/examples`. Without a corpus the test prints a note and passes.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use quire_cli::{Verdict, compare, evaluate};
use quire_doc::{Document, Results};
use quire_smath::Imported;

type TestResult = Result<(), Box<dyn Error>>;

/// Results matched per worksheet (`quire check` counts exact and within-rounding matches).
const FLOOR: &[(&str, usize)] = &[
    ("Beam.sm", 4),
    ("ChordMethod.sm", 3),
    ("Dichotomy.sm", 3),
    ("EuclideanGCD.sm", 3),
    ("GravitationAcceleration.sm", 1),
    ("HermitePolynomials.sm", 2),
    ("Hessian.sm", 4),
    ("Jacobian.sm", 4),
    ("LaguerrePolynomials.sm", 2),
    ("LegendrePolynomials.sm", 2),
    ("MaclaurinSeries.sm", 0),
    ("Newton.sm", 2),
    ("PlanetaryGear.sm", 0),
    ("RomanNumerals.sm", 1),
    ("RungeKutta5.sm", 2),
    ("Simpson.sm", 2),
    ("SylvesterFormula.sm", 3),
    ("Thomas.sm", 7),
];

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn corpus_dir() -> PathBuf {
    match std::env::var_os("QUIRE_SMATH_EXAMPLES") {
        Some(dir) => PathBuf::from(dir),
        None => workspace_root().join("examples"),
    }
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

fn floor_for(name: &str) -> Option<usize> {
    FLOOR.iter().find(|(file, _)| *file == name).map(|(_, floor)| *floor)
}

/// Evaluates the imported document and compares it with SMath's cached results, as
/// `quire check` does for a bundle on disk. Returns (matched, total).
fn score(imported: &Imported) -> Result<(usize, usize), Box<dyn Error>> {
    let document: Document = serde_json::from_value(imported.document.clone())?;
    let reference: BTreeMap<String, String> = serde_json::from_value(imported.results.clone())?;
    let results = Results {
        format: "quire-results/1".into(),
        producer: Some("SMath Studio (imported)".into()),
        results: reference,
    };
    let rows = compare(&results, &evaluate(&document));
    let matched =
        rows.iter().filter(|r| matches!(r.verdict, Verdict::Exact | Verdict::WithinRounding)).count();
    Ok((matched, rows.len()))
}

/// Imports and scores one worksheet. The error text is the reason it failed.
fn run_one(name: &str, path: &Path) -> Result<(usize, usize), String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read the file: {e}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let imported = quire_smath::convert_file(&text, name).map_err(|e| format!("import failed: {e}"))?;
    let scored = catch_unwind(AssertUnwindSafe(|| score(&imported)));
    match scored {
        Ok(Ok(counts)) => Ok(counts),
        Ok(Err(e)) => Err(format!("evaluation failed: {e}")),
        Err(_) => Err("evaluation panicked".to_string()),
    }
}

#[test]
fn smath_examples_meet_their_floors() -> TestResult {
    let dir = corpus_dir();
    if !dir.is_dir() {
        eprintln!("note: no SMath corpus at {} (set QUIRE_SMATH_EXAMPLES); skipping", dir.display());
        return Ok(());
    }
    let files = sm_files(&dir)?;
    if files.is_empty() {
        eprintln!("note: no .sm files in {}; skipping", dir.display());
        return Ok(());
    }

    let mut counts = Vec::new();
    let mut problems = Vec::new();
    let mut table = String::new();
    for sm in &files {
        let name = sm.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Some(floor) = floor_for(&name) else {
            problems.push(format!("{name}: no floor in FLOOR; add one"));
            continue;
        };
        match run_one(&name, sm) {
            Ok((matched, total)) => {
                table.push_str(&format!("  {name:<28} {matched:>3}/{total:<3} (floor {floor})\n"));
                if matched < floor {
                    problems.push(format!("{name}: matched {matched}, below the floor of {floor}"));
                }
                counts.push((name, matched, total));
            }
            Err(reason) => problems.push(format!("{name}: {reason}")),
        }
    }

    let matched: usize = counts.iter().map(|(_, m, _)| m).sum();
    let total: usize = counts.iter().map(|(_, _, t)| t).sum();
    eprintln!(
        "SMath examples: file matched/total\n{table}  {matched}/{total} results in {} files",
        counts.len()
    );
    assert!(problems.is_empty(), "{} SMath example problem(s):\n{}", problems.len(), problems.join("\n"));
    Ok(())
}
