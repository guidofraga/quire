//! Regression gate: the engine must reproduce a worksheet's stored results.
//!
//! Set `QUIRE_SMATH_REFERENCE` to a `.quire` bundle imported by tools/sm2quire.py to check
//! that every result SMath Studio cached in it is reproduced exactly; such reports stay
//! outside the repo.

use std::path::PathBuf;

use quire_cli::{Verdict, compare, evaluate};

fn mismatches(bundle: &quire_doc::Bundle) -> (usize, Vec<String>) {
    let ev = evaluate(&bundle.document);
    let rows = compare(bundle.results.as_ref().expect("bundle has results.json"), &ev);
    let wrong = rows
        .iter()
        .filter(|r| !matches!(r.verdict, Verdict::Exact))
        .map(|r| format!("{}: reference {} vs Quire {:?} ({:?})", r.expr, r.reference, r.ours, r.verdict))
        .collect();
    (rows.len(), wrong)
}

#[test]
fn reproduces_an_smath_reference_when_given() {
    let Some(path) = std::env::var_os("QUIRE_SMATH_REFERENCE") else {
        return;
    };
    let bundle = quire_doc::load(PathBuf::from(path)).expect("reference loads");
    let (count, wrong) = mismatches(&bundle);
    assert!(count > 0, "the reference has no results");
    assert!(wrong.is_empty(), "results differ from SMath:\n{}", wrong.join("\n"));
}
