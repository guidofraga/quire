//! What a plain name means (docs/02-file-format.md §4.3, Units): the nearest definition above
//! it, everywhere, right after a number too; units and constants are the fallback. `'m` is
//! always the unit and `#G` always the constant.

use quire_eval::{DisplaySettings, DisplaySpec, MathInput, Outcome, TableInput, Value, Worksheet};
use quire_units::Dim;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn run(lines: &[&str]) -> Vec<Outcome> {
    let regions: Vec<MathInput> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| MathInput {
            id: i.to_string(),
            expr: l.to_string(),
            show: true,
            display: DisplaySpec::default(),
            table: None,
            plot: None,
            symbolic: false,
        })
        .collect();
    Worksheet::new(DisplaySettings::default()).run(&regions)
}

/// The value of line `i`, in SI, with its dimension.
fn value(outs: &[Outcome], i: usize) -> Result<(f64, Dim), String> {
    let o = outs.get(i).ok_or("no such line")?;
    match &o.value {
        Some(Value::Num(q)) => Ok((q.v, q.dim)),
        _ => Err(format!("line {i} has no number: {:?}", o.error)),
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
}

const G: f64 = 6.674_30e-11;

#[test]
fn a_variable_right_after_a_number_is_the_variable() -> TestResult {
    for (definition, product, expected) in
        [("T := 300", "2T", 600.0), ("A := 3", "2A", 6.0), ("t := 4", "2t", 8.0), ("T := 300", "2 T", 600.0)]
    {
        let outs = run(&[definition, product]);
        assert_eq!(value(&outs, 1)?, (expected, Dim::NONE), "{definition}, then {product}");
    }
    // after another unit too: `h` is your height here, not the hour
    let outs = run(&["h := 2 m", "100 km/h"]);
    assert_eq!(value(&outs, 1)?, (50_000.0, Dim::NONE));
    Ok(())
}

#[test]
fn a_quoted_unit_is_always_the_unit() -> TestResult {
    let outs = run(&["T := 300", "2 'T", "m := 5", "3 'm"]);
    let (v, dim) = value(&outs, 1)?;
    assert!(close(v, 2.0) && dim != Dim::NONE, "2 tesla");
    assert_eq!(value(&outs, 3)?.0, 3.0);
    assert_ne!(value(&outs, 3)?.1, Dim::NONE, "3 metres");
    Ok(())
}

#[test]
fn a_definition_reads_the_constant_its_name_hides() -> TestResult {
    let outs = run(&["G := 2G", "G"]);
    assert!(close(value(&outs, 0)?.0, 2.0 * G));
    assert!(close(value(&outs, 1)?.0, 2.0 * G));
    Ok(())
}

#[test]
fn the_constant_marker_reaches_a_hidden_constant() -> TestResult {
    let outs = run(&["G := 5", "#G", "G*#G", "2 #G"]);
    assert!(close(value(&outs, 1)?.0, G), "{:?}", outs[1].error);
    assert!(close(value(&outs, 2)?.0, 5.0 * G));
    assert!(close(value(&outs, 3)?.0, 2.0 * G));
    let unknown = run(&["#x"]);
    assert!(unknown[0].error.as_deref().is_some_and(|e| e.contains("constant")), "{:?}", unknown[0].error);
    Ok(())
}

/// Tables are data entry: a unit name after a number in a cell is the unit, whatever variables
/// are defined above, in values (`10 m`) and in formulas (`=2 m + A1`).
#[test]
fn a_unit_after_a_number_in_a_table_cell_is_the_unit() -> TestResult {
    let table = TableInput {
        name: Some("tab".into()),
        rows: vec![
            vec!["10 m".into(), "=A1*2".into()],
            vec!["=2 m + A1".into(), "9.81 m/s^2".into()],
            vec!["=3 m^2".into(), "4 kN/m^2".into()],
        ],
        ..Default::default()
    };
    let math = |id: &str, expr: &str| MathInput {
        id: id.into(),
        expr: expr.into(),
        show: true,
        display: DisplaySpec::default(),
        table: None,
        plot: None,
        symbolic: false,
    };
    let regions = vec![
        math("a", "m := 25 kg"),
        math("b", "s := 2"),
        MathInput { table: Some(table), ..math("t", "") },
        math("c", "tab[2, 1]"),
    ];
    let outs = Worksheet::new(DisplaySettings::default()).run(&regions);
    let shown: Vec<Vec<Option<&str>>> =
        outs[2].cells.iter().map(|row| row.iter().map(|c| c.shown.as_deref()).collect()).collect();
    assert_eq!(
        shown,
        [
            [Some("10 'm"), Some("20 'm")],
            [Some("12 'm"), Some("9.81 'm/'s^2")],
            [Some("3 'm^2"), Some("4 'kN/'m^2")],
        ],
        "{:?}",
        outs[2].error
    );
    assert_eq!(outs[3].shown.as_deref(), Some("12 'm"));
    Ok(())
}

#[test]
fn a_function_keeps_the_meaning_of_its_own_definition() -> TestResult {
    let outs = run(&["f(x) := x*G", "G := 2", "f(1)", "g(x) := x*G", "g(1)"]);
    assert!(close(value(&outs, 2)?.0, G), "f was defined before G := 2");
    assert_eq!(value(&outs, 4)?.0, 2.0);
    Ok(())
}
