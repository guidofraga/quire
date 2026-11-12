//! Solve blocks (docs/02-file-format.md §4.10): guess values, constraints after Given, and a
//! closing `find` or `minerr`, worked out where the block sits in reading order.
//!
//! Every expected value was computed independently with SciPy 1.13 / NumPy 2.0
//! (`scipy.optimize.fsolve`, `numpy.linalg.lstsq`, `scipy.optimize.least_squares` with
//! bounds), or in closed form where one exists (noted at each test).

use serde_json::{Value as Json, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// A document of math lines and one solve block, in reading order: `before` above the block,
/// `after` below it, each shown with `=`.
fn document(before: &[&str], guesses: &[&str], given: &[&str], find: &str, after: &[&str]) -> Json {
    let mut regions = Vec::new();
    let mut y = 0;
    let line = |expr: &str, y: i32, regions: &mut Vec<Json>| {
        let id = format!("m{y:05}");
        regions.push(json!({ "id": id, "kind": "math", "at": [0, y], "expr": expr, "show": "value" }));
    };
    for e in before {
        line(e, y, &mut regions);
        y += 30;
    }
    regions.push(json!({
        "id": "solve1", "kind": "solve", "at": [0, y],
        "guesses": guesses, "given": given, "find": find, "show": "value"
    }));
    y += 200;
    for e in after {
        line(e, y, &mut regions);
        y += 30;
    }
    json!({ "format": "quire/1", "settings": { "display": { "decimals": 12 } }, "regions": regions })
}

/// The `document.json` a save writes.
fn saved(doc: &Json) -> Result<String, Box<dyn std::error::Error>> {
    let bytes = quire_service::save_bytes(doc)?;
    let entries = quire_doc::read_bytes(&bytes)?;
    let (_, text) = entries.into_iter().find(|(n, _)| n == "document.json").ok_or("no document.json")?;
    Ok(String::from_utf8(text)?)
}

fn report(doc: &Json) -> Result<Json, Box<dyn std::error::Error>> {
    Ok(serde_json::to_value(quire_service::report(doc)?)?)
}

/// The view of region (or block line) `id`.
fn view<'a>(report: &'a Json, id: &str) -> Option<&'a Json> {
    report["regions"].as_array()?.iter().find(|v| v["id"] == id)
}

fn error(report: &Json, id: &str) -> Option<String> {
    view(report, id).and_then(|v| v["error"].as_str()).map(str::to_string)
}

fn shown(report: &Json, id: &str) -> Option<String> {
    view(report, id).and_then(|v| v["resultText"].as_str()).map(str::to_string)
}

fn holds(report: &Json, id: &str) -> Option<bool> {
    view(report, id).and_then(|v| v["check"].as_bool())
}

/// The numbers in a shown result (`[1.5 'm; 2 'm]` → 1.5, 2), and its units.
fn numbers(text: &str) -> (Vec<f64>, String) {
    let mut nums = Vec::new();
    let mut units = String::new();
    for part in text.split([';', '[', ']']) {
        let mut words = part.split_whitespace();
        if let Some(n) = words.next().and_then(|w| w.parse::<f64>().ok()) {
            nums.push(n);
            let u: Vec<&str> = words.collect();
            if !u.is_empty() {
                if !units.is_empty() {
                    units.push(' ');
                }
                units.push_str(&u.join(" "));
            }
        }
    }
    (nums, units)
}

/// `got` is within a relative 1e-9 of `want` (1e-12 near zero).
fn close(got: &[f64], want: &[f64]) -> bool {
    got.len() == want.len() && got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 1e-9 * w.abs().max(1e-3))
}

fn assert_values(report: &Json, id: &str, want: &[f64], unit: &str) {
    let text = shown(report, id).unwrap_or_default();
    assert!(!text.is_empty(), "{id} shows nothing: {:?}", error(report, id));
    let (got, units) = numbers(&text);
    assert!(close(&got, want), "{id}: {text}, expected {want:?}");
    assert_eq!(units, unit, "{id}: {text}");
}

#[test]
fn a_nonlinear_system_of_two_equations() -> TestResult {
    // fsolve from (1, −1): x = 1.004168738475, y = −1.729637287026
    let doc = document(
        &[],
        &["x := 1", "y := -1"],
        &["x^2 + y^2 == 4", "exp(x) + y == 1"],
        "[x; y] := find(x, y)",
        &["x", "y", "x^2 + y^2"],
    );
    let r = report(&doc)?;
    assert_eq!(error(&r, "solve1:f"), None);
    assert_values(&r, "solve1:f", &[1.004168738475, -1.729637287026], "");
    // the variables it defines are the solution below it
    assert_values(&r, "m00200", &[1.004168738475], "");
    assert_values(&r, "m00230", &[-1.729637287026], "");
    assert_values(&r, "m00260", &[4.0], "");
    // each constraint holds at the solution
    assert_eq!(holds(&r, "solve1:c0"), Some(true));
    assert_eq!(holds(&r, "solve1:c1"), Some(true));
    // the lines are drawn from their parsed form
    assert!(view(&r, "solve1:g0").is_some_and(|v| v["input"].is_object()));
    assert_eq!(view(&r, "solve1:c0").and_then(|v| v["input"]["t"].as_str()), Some("Compare"));
    Ok(())
}

#[test]
fn units_on_unknowns_and_constraints() -> TestResult {
    // a thin-walled vessel: p·r/t = 150 MPa with r = 500 mm + t/2 and p = 2 MPa.
    // Closed form: t = (1000/150 mm)/(1 − 1/150) = 6.711409396 mm, r = 503.355704698 mm
    let doc = document(
        &["p := 2 MPa"],
        &["r := 400 mm", "t := 10 mm"],
        &["p*r/t == 150 MPa", "r == 500 mm + t/2"],
        "[r; t] := find(r, t)",
        &["r", "t"],
    );
    let r = report(&doc)?;
    assert_values(&r, "solve1:f", &[0.503355704698, 0.006711409396], "'m 'm");
    assert_values(&r, "m00230", &[0.503355704698], "'m");
    assert_values(&r, "m00260", &[0.006711409396], "'m");

    // F·L = 50 kN·m and F = 2 kN/m · L: F = 10 kN, L = 5 m; one vector of two kinds
    let doc = document(
        &[],
        &["F := 1 kN", "L := 1 m"],
        &["F*L == 50 kN*m", "F == 2 kN/m*L"],
        "s := find(F, L)",
        &["s[1]", "s[2]"],
    );
    let r = report(&doc)?;
    assert_values(&r, "solve1:f", &[10000.0, 5.0], "'N 'm");
    assert_values(&r, "m00200", &[10000.0], "'N");

    // a constraint that compares a length with a force is an error that says so
    let doc = document(&[], &["L := 1 m"], &["L == 5 kN"], "L := find(L)", &[]);
    let r = report(&doc)?;
    let e = error(&r, "solve1:c0").unwrap_or_default();
    assert!(e.contains("length") && e.contains("force"), "{e}");
    assert!(error(&r, "solve1:f").is_some_and(|e| e.contains("constraint 1")), "{:?}", error(&r, "solve1:f"));
    Ok(())
}

#[test]
fn an_inequality_picks_the_root() -> TestResult {
    // x² + y² = 6 and x + y = 2: (1 ∓ √2, 1 ± √2). From (0, 1) the nearer root is (1 − √2, 1 + √2)
    // (fsolve agrees); with x > 1 only (1 + √2, 1 − √2) is left.
    let (a, b) = (1.0 - 2f64.sqrt(), 1.0 + 2f64.sqrt());
    let free = document(&[], &["x := 0", "y := 1"], &["x^2 + y^2 == 6", "x + y == 2"], "find(x, y)", &[]);
    assert_values(&report(&free)?, "solve1:f", &[a, b], "");

    let limited =
        document(&[], &["x := 0", "y := 1"], &["x^2 + y^2 == 6", "x + y == 2", "x > 1"], "find(x, y)", &[]);
    let r = report(&limited)?;
    assert_values(&r, "solve1:f", &[b, a], "");
    assert_eq!(holds(&r, "solve1:c2"), Some(true));

    // a chain is one constraint per pair: 0 < x ≤ 3 with x² = 4 from −1 finds 2
    let chain = document(&[], &["x := -1"], &["x^2 == 4", "0 < x ≤ 3"], "x := find(x)", &["x"]);
    assert_values(&report(&chain)?, "m00200", &[2.0], "");

    // minerr with a bound that holds back the best fit: x = 3 and y = x with x ≤ 2 gives
    // (2, 2) (least_squares with bounds agrees); the bound is met, x = 3 is not
    let bounded = document(&[], &["x := 0", "y := 0"], &["x == 3", "y == x", "x ≤ 2"], "minerr(x, y)", &[]);
    let r = report(&bounded)?;
    assert_values(&r, "solve1:f", &[2.0, 2.0], "");
    assert_eq!(holds(&r, "solve1:c0"), Some(false));
    assert_eq!(holds(&r, "solve1:c1"), Some(true));
    assert_eq!(holds(&r, "solve1:c2"), Some(true));
    Ok(())
}

#[test]
fn no_solution_is_an_error_in_plain_words() -> TestResult {
    let doc =
        document(&[], &["x := 0", "y := 0"], &["x + y == 1", "x + y == 2"], "[x; y] := find(x, y)", &["x"]);
    let r = report(&doc)?;
    let e = error(&r, "solve1:f").unwrap_or_default();
    assert!(e.starts_with("No solution near the guess values"), "{e}");
    assert!(e.contains("minerr"), "{e}");
    // what it would define is an error below it, not the guess
    assert!(error(&r, "m00200").is_some(), "{:?}", shown(&r, "m00200"));
    // at the closest point, the constraints can't both hold
    assert!(holds(&r, "solve1:c0") == Some(false) || holds(&r, "solve1:c1") == Some(false));

    // x² + 1 = 0 has no real solution at all
    let doc = document(&[], &["x := 1"], &["x^2 + 1 == 0"], "x := find(x)", &[]);
    let e = error(&report(&doc)?, "solve1:f").unwrap_or_default();
    assert!(e.starts_with("No solution near the guess values: constraint 1 is off by 1"), "{e}");
    Ok(())
}

#[test]
fn a_poor_guess_says_so() -> TestResult {
    // x² = 4 from 0: the constraint doesn't change there, so there is no way to go
    let doc = document(&[], &["x := 0"], &["x^2 == 4"], "x := find(x)", &[]);
    let e = error(&report(&doc)?, "solve1:f").unwrap_or_default();
    assert!(e.contains("don't change near the guess values"), "{e}");
    assert!(e.contains("other guess values"), "{e}");

    // x³ − 2x + 2 = 0 has one real root, −1.769292354239 (numpy.roots). From −2 it is found;
    // from 0 the search ends in a hollow at x = √(2/3), which is not a root
    let near = document(&[], &["x := -2"], &["x^3 - 2*x + 2 == 0"], "x := find(x)", &[]);
    assert_values(&report(&near)?, "solve1:f", &[-1.769292354239], "");
    let far = document(&[], &["x := 0"], &["x^3 - 2*x + 2 == 0"], "x := find(x)", &[]);
    let e = error(&report(&far)?, "solve1:f").unwrap_or_default();
    assert!(e.starts_with("No solution near the guess values"), "{e}");
    assert!(e.contains("other guess values"), "{e}");

    // an unknown with no guess, or one the constraints never mention
    let doc = document(&[], &[], &["z == 4"], "z := find(z)", &[]);
    let e = error(&report(&doc)?, "solve1:f").unwrap_or_default();
    assert!(e.contains("give z a guess value"), "{e}");
    let doc = document(&[], &["x := 1", "y := 1"], &["x == 4"], "find(x, y)", &[]);
    let e = error(&report(&doc)?, "solve1:f").unwrap_or_default();
    assert!(e.contains("y doesn't appear in any constraint"), "{e}");
    Ok(())
}

#[test]
fn minerr_returns_the_best_fit() -> TestResult {
    // x + y = 3, x − y = 1, 2x + y = 7 has no solution; numpy.linalg.lstsq gives
    // x = 2.571428571429 (18/7), y = 1.285714285714 (9/7)
    let given = ["x + y == 3", "x - y == 1", "2*x + y == 7"];
    let doc = document(&[], &["x := 0", "y := 0"], &given, "[x; y] := minerr(x, y)", &["x"]);
    let r = report(&doc)?;
    assert_eq!(error(&r, "solve1:f"), None);
    assert_values(&r, "solve1:f", &[18.0 / 7.0, 9.0 / 7.0], "");
    assert_values(&r, "m00200", &[18.0 / 7.0], "");
    for c in ["solve1:c0", "solve1:c1", "solve1:c2"] {
        assert_eq!(holds(&r, c), Some(false), "{c}");
    }
    // the same lines with find: no exact solution
    let doc = document(&[], &["x := 0", "y := 0"], &given, "[x; y] := find(x, y)", &[]);
    assert!(error(&report(&doc)?, "solve1:f").is_some_and(|e| e.contains("minerr")));
    Ok(())
}

#[test]
fn find_outside_a_block_says_so() -> TestResult {
    let doc = json!({ "format": "quire/1", "regions": [
        { "id": "aaaaaa", "kind": "math", "at": [0, 0], "expr": "x := 1" },
        { "id": "bbbbbb", "kind": "math", "at": [0, 30], "expr": "find(x)", "show": "value" }
    ] });
    let e = error(&report(&doc)?, "bbbbbb").unwrap_or_default();
    assert!(e.contains("solve block"), "{e}");
    Ok(())
}

#[test]
fn a_solve_block_saves_canonically_and_reads_back() -> TestResult {
    // keys in any order come out in the fixed order of §5; arrays that fit stay on one line
    let doc: Json = serde_json::from_str(
        r#"{ "format": "quire/1", "regions": [ { "display": { "decimals": 3 }, "show": "value",
            "find": "[x; y] := find(x, y)", "given": ["x^2 + y^2 == 4", "exp(x) + y == 1", "x ≥ 0"],
            "guesses": ["x := 1", "y := -1"], "at": [36, 72], "kind": "solve", "id": "k3p9qa" } ] }"#,
    )?;
    let text = saved(&doc)?;
    assert_eq!(
        text,
        r#"{
  "format": "quire/1",
  "regions": [
    {
      "id": "k3p9qa",
      "kind": "solve",
      "at": [36, 72],
      "guesses": ["x := 1", "y := -1"],
      "given": ["x^2 + y^2 == 4", "exp(x) + y == 1", "x ≥ 0"],
      "find": "[x; y] := find(x, y)",
      "show": "value",
      "display": { "decimals": 3 }
    }
  ]
}
"#
    );
    // and reads back as the same document, saving to the same bytes
    let opened = quire_service::open_bytes(text.as_bytes())?;
    assert_eq!(opened, doc);
    assert_eq!(saved(&opened)?, text);

    // the lines' names are stored as math regions' are (§5, rule 8): a product with your
    // variable T is written 2*T, so a stored `2 T` stays the unit tesla
    let doc = document(&[], &["T := 300"], &["2T == 700"], "T := find(T)", &["T"]);
    let text = saved(&doc)?;
    assert!(text.contains(r#""given": ["2*T == 700"]"#), "{text}");
    assert_values(&report(&quire_service::open_bytes(text.as_bytes())?)?, "m00200", &[350.0], "");
    Ok(())
}
