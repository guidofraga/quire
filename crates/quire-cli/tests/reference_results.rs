//! Regression gate: the engine must reproduce a worksheet's stored results.
//!
//! Set `QUIRE_SMATH_REFERENCE` to a `.quire` bundle imported by `quire import` to check
//! that every result SMath Studio cached in it is reproduced exactly; such reports stay
//! outside the repo.

use std::path::PathBuf;

use quire_cli::{Verdict, compare, evaluate};

fn mismatches(bundle: &quire_doc::Bundle) -> Result<(usize, Vec<String>), String> {
    let ev = evaluate(&bundle.document);
    let results = bundle.results.as_ref().ok_or("bundle has no results.json")?;
    let rows = compare(results, &ev);
    let wrong = rows
        .iter()
        .filter(|r| !matches!(r.verdict, Verdict::Exact))
        .map(|r| format!("{}: reference {} vs Quire {:?} ({:?})", r.expr, r.reference, r.ours, r.verdict))
        .collect();
    Ok((rows.len(), wrong))
}

#[test]
fn reproduces_an_smath_reference_when_given() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = std::env::var_os("QUIRE_SMATH_REFERENCE") else {
        return Ok(());
    };
    let bundle = quire_doc::load(PathBuf::from(path))?;
    let (count, wrong) = mismatches(&bundle)?;
    assert!(count > 0, "the reference has no results");
    assert!(wrong.is_empty(), "results differ from SMath:\n{}", wrong.join("\n"));
    Ok(())
}
