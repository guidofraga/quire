//! Library side of the `quire` CLI: evaluate a document and compare it with
//! reference results (SMath's cached values, or a previous Quire run).

use quire_ast::{Expr, parse};
use quire_doc::Results;
use quire_eval::{Env, Interp, MathInput, Outcome, Quantity, Scope, Value, Worksheet};
pub use quire_service::{Evaluated, evaluate};

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Same text as the reference.
    Exact,
    /// Different text, but equal within the reference's displayed precision.
    WithinRounding,
    Mismatch(String),
    /// Quire could not compute this region.
    Failed(String),
}

pub struct Comparison {
    pub id: String,
    pub expr: String,
    pub reference: String,
    pub ours: Option<String>,
    pub verdict: Verdict,
}

/// Replace every number literal with 1, leaving only the unit factor.
fn unit_part(e: &Expr) -> Expr {
    let b = |x: &Expr| Box::new(unit_part(x));
    match e {
        Expr::Num(_) => Expr::Num("1".into()),
        Expr::Paren(x) => Expr::Paren(b(x)),
        Expr::Unary(op, x) => Expr::Unary(*op, b(x)),
        Expr::Binary(op, x, y) => Expr::Binary(*op, b(x), b(y)),
        other => other.clone(),
    }
}

fn eval_constant(e: &Expr, ws: &Worksheet) -> Option<Value> {
    let env = Env::new();
    Interp::new(ws.units()).eval(&mut Scope::new(&env), e).ok()
}

fn judge(reference: &str, input: &MathInput, outcome: &Outcome, ws: &Worksheet) -> Verdict {
    let Some(ours) = &outcome.value else {
        return Verdict::Failed(outcome.error.clone().unwrap_or_else(|| "no value".into()));
    };
    if outcome.shown.as_deref() == Some(reference) {
        return Verdict::Exact;
    }
    let Ok(ref_expr) = parse(reference) else {
        return Verdict::Mismatch("the reference value is not valid linear syntax".into());
    };
    if has_formula(ours) {
        let same = outcome
            .shown
            .as_deref()
            .and_then(|t| parse(t).ok())
            .is_some_and(|e| same_formula(&ref_expr, &e, ws));
        return if same { Verdict::WithinRounding } else { Verdict::Mismatch("a different formula".into()) };
    }
    let Some(theirs) = eval_constant(&ref_expr, ws) else {
        return Verdict::Mismatch("the reference value could not be evaluated".into());
    };
    let decimals = input.display.decimals.unwrap_or(ws.settings().decimals);
    match (ours, &theirs) {
        (Value::Num(a), Value::Num(b)) => {
            let factor = match eval_constant(&unit_part(&ref_expr), ws) {
                Some(Value::Num(q)) if q.v != 0.0 => q.v.abs(),
                _ => 1.0,
            };
            match close(a, b, decimals, factor) {
                Ok(()) => Verdict::WithinRounding,
                Err(why) => Verdict::Mismatch(why),
            }
        }
        // a matrix: every element within the precision it is displayed with in the reference
        // (SMath shows matrix elements to significant figures: 3.7020, 274.39)
        (Value::Matrix(a), Value::Matrix(b)) if a.rows == b.rows && a.cols == b.cols => {
            let shown: Vec<Option<&Expr>> = match &ref_expr {
                Expr::Matrix(rows) => rows.iter().flatten().map(Some).collect(),
                _ => Vec::new(),
            };
            for (k, (x, y)) in a.data.iter().zip(&b.data).enumerate() {
                let same = match (x, y) {
                    (Value::Num(p), Value::Num(q)) => {
                        let wider = shown.get(k).copied().flatten().and_then(|e| literal_tolerance(e, q.v));
                        close(p, q, decimals, 1.0).is_ok()
                            || wider.is_some_and(|tol| p.dim == q.dim && (p.v - q.v).abs() <= tol)
                    }
                    (p, q) => p == q,
                };
                if !same {
                    return Verdict::Mismatch("different values".into());
                }
            }
            Verdict::WithinRounding
        }
        (a, b) if a == b => Verdict::WithinRounding,
        _ => Verdict::Mismatch("different values".into()),
    }
}

fn has_formula(v: &Value) -> bool {
    match v {
        Value::Sym(_) => true,
        Value::Matrix(m) => m.data.iter().any(has_formula),
        _ => false,
    }
}

/// Two formulas (SMath shows a result in terms of names with no value) are the same when
/// they give the same numbers for sample values of those names, whatever the order of terms:
/// `6*x[2]^2*x[1]` and `6*x[1]*x[2]^2`. An indexed name gets a vector of samples.
fn same_formula(a: &Expr, b: &Expr, ws: &Worksheet) -> bool {
    let mut names = Vec::new();
    free_names(a, &mut names);
    free_names(b, &mut names);
    (0..2).all(|set| {
        let mut env = Env::new();
        for (i, (name, indexed)) in names.iter().enumerate() {
            let at = |k: usize| 0.37 + 0.113 * i as f64 + 0.071 * k as f64 + 0.29 * f64::from(set);
            let v = if *indexed {
                Value::Matrix(quire_eval::Matrix::column((0..12).map(|k| Value::num(at(k))).collect()))
            } else {
                Value::num(at(0))
            };
            env.insert(name.clone(), quire_eval::Binding::Val(v));
        }
        let eval =
            |e: &Expr| Interp::new(ws.units()).with_marked_units(true).eval(&mut Scope::new(&env), e).ok();
        match (eval(a), eval(b)) {
            (Some(x), Some(y)) => same_numbers(&x, &y),
            _ => false,
        }
    })
}

fn same_numbers(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Num(p), Value::Num(q)) => {
            p.dim == q.dim && (p.v - q.v).abs() <= 1e-9 * p.v.abs().max(q.v.abs()).max(1.0)
        }
        (Value::Matrix(p), Value::Matrix(q)) => {
            p.rows == q.rows
                && p.cols == q.cols
                && p.data.iter().zip(&q.data).all(|(x, y)| same_numbers(x, y))
        }
        (x, y) => x == y,
    }
}

/// Names an expression reads without defining, and whether each is indexed (`x[1]`).
fn free_names(e: &Expr, out: &mut Vec<(String, bool)>) {
    let mut add = |n: &str, indexed: bool| {
        if !matches!(n, "π" | "pi" | "e" | "∞") && !out.iter().any(|(m, _)| m == n) {
            out.push((n.to_string(), indexed));
        }
    };
    match e {
        Expr::Ident(n) => add(n, false),
        Expr::Index(base, idx) => {
            match base.as_ref() {
                Expr::Ident(n) => add(n, true),
                other => free_names(other, out),
            }
            idx.iter().for_each(|i| free_names(i, out));
        }
        Expr::Paren(x) | Expr::Unary(_, x) | Expr::Factorial(x) => free_names(x, out),
        Expr::Binary(_, x, y) | Expr::Range(x, y) => {
            free_names(x, out);
            free_names(y, out);
        }
        Expr::Compare(x, rest) => {
            free_names(x, out);
            rest.iter().for_each(|(_, y)| free_names(y, out));
        }
        Expr::Call(_, args) => args.iter().for_each(|a| free_names(a, out)),
        Expr::Matrix(rows) => rows.iter().flatten().for_each(|c| free_names(c, out)),
        Expr::Num(_) | Expr::Unit(_) | Expr::Str(_) | Expr::Placeholder | Expr::Define { .. } => {}
    }
}

/// Half a unit of the last digit an element is displayed with (`3.7020 'm/'s^2` → 0.00005
/// m/s²), scaled to the element's value: `value` is the reference element in SI.
fn literal_tolerance(e: &Expr, value: f64) -> Option<f64> {
    let text = first_number(e)?;
    let mantissa: f64 = text.parse().ok().filter(|m: &f64| *m != 0.0)?;
    let decimals = text.split_once('.').map_or(0, |(_, frac)| frac.len());
    let exp = i32::try_from(decimals).ok()?;
    Some(0.5 * 10f64.powi(-exp) * (value / mantissa).abs() * (1.0 + 1e-9))
}

fn first_number(e: &Expr) -> Option<&str> {
    match e {
        Expr::Num(t) => Some(t),
        Expr::Paren(x) | Expr::Unary(_, x) => first_number(x),
        Expr::Binary(_, x, _) => first_number(x),
        _ => None,
    }
}

/// Equal within half a unit of the last displayed decimal (`factor` scales that unit to
/// the reference's display unit).
fn close(a: &Quantity, b: &Quantity, decimals: u32, factor: f64) -> Result<(), String> {
    if a.dim != b.dim {
        return Err(format!("units differ: [{}] vs [{}]", a.dim, b.dim));
    }
    let exp = i32::try_from(decimals).unwrap_or(i32::MAX);
    let tol = 0.5 * 10f64.powi(-exp) * factor * (1.0 + 1e-9) + 1e-12 * b.v.abs();
    if (a.v - b.v).abs() <= tol {
        Ok(())
    } else {
        Err(format!("differs by {:.3e} (allowed ±{:.3e})", (a.v - b.v).abs() / factor, tol / factor))
    }
}

/// Compare every region that has a reference result.
pub fn compare(results: &Results, ev: &Evaluated) -> Vec<Comparison> {
    ev.inputs
        .iter()
        .zip(&ev.outcomes)
        .filter_map(|(input, outcome)| {
            let reference = results.results.get(&input.id)?;
            Some(Comparison {
                id: input.id.clone(),
                expr: input.expr.clone(),
                reference: reference.clone(),
                ours: outcome.shown.clone(),
                verdict: judge(reference, input, outcome, &ev.worksheet),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_element_is_judged_on_its_shown_digits() -> Result<(), Box<dyn std::error::Error>> {
        // SMath shows 274.39138 m/s² as 274.39: half a hundredth either way
        let e = parse("274.39 'm/'s^2")?;
        let tol = literal_tolerance(&e, 274.39).ok_or("no tolerance")?;
        assert!((tol - 0.005).abs() < 1e-9);
        assert_eq!(
            literal_tolerance(&parse("-12.4533 'kN")?, -12453.3).map(|t| (t * 1e3).round()),
            Some(50.0)
        );
        assert_eq!(literal_tolerance(&parse("\"Mars\"")?, 1.0), None);
        Ok(())
    }

    #[test]
    fn formulas_match_whatever_the_order_of_terms() -> Result<(), Box<dyn std::error::Error>> {
        let ws = Worksheet::new(quire_eval::DisplaySettings::default());
        let same = |a: &str, b: &str| -> Result<bool, Box<dyn std::error::Error>> {
            Ok(same_formula(&parse(a)?, &parse(b)?, &ws))
        };
        assert!(same("6*x[2]^2*x[1]", "6*x[1]*x[2]^2")?);
        assert!(same("-(2*(5*x[1] + x[2]) - sin(t))", "sin(t) - 10*x[1] - 2*x[2]")?);
        assert!(same("[2*x[2]^3, 1; a*b, 0]", "[2*x[2]^3, 1; b*a, 0]")?);
        assert!(!same("6*x[2]^2*x[1]", "6*x[1]^2*x[2]")?);
        assert!(!same("sin(t)", "cos(t)")?);
        Ok(())
    }
}
