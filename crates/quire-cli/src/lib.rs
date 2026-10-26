//! Library side of the `quire` CLI: evaluate a document and compare it with
//! reference results (SMath's cached values, or a previous Quire run).

use quire_ast::{Expr, parse};
use quire_doc::Results;
use quire_eval::{Env, Interp, MathInput, Outcome, Scope, Value, Worksheet};
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
    let Some(theirs) = eval_constant(&ref_expr, ws) else {
        return Verdict::Mismatch("the reference value could not be evaluated".into());
    };
    match (ours, &theirs) {
        (Value::Num(a), Value::Num(b)) => {
            if a.dim != b.dim {
                return Verdict::Mismatch(format!("units differ: [{}] vs [{}]", a.dim, b.dim));
            }
            let decimals = input.display.decimals.unwrap_or(ws.settings().decimals);
            let factor = match eval_constant(&unit_part(&ref_expr), ws) {
                Some(Value::Num(q)) if q.v != 0.0 => q.v.abs(),
                _ => 1.0,
            };
            let tol = 0.5 * 10f64.powi(-(decimals as i32)) * factor * (1.0 + 1e-9) + 1e-12 * b.v.abs();
            if (a.v - b.v).abs() <= tol {
                Verdict::WithinRounding
            } else {
                Verdict::Mismatch(format!(
                    "differs by {:.3e} (allowed ±{:.3e})",
                    (a.v - b.v).abs() / factor,
                    tol / factor
                ))
            }
        }
        (a, b) if a == b => Verdict::WithinRounding,
        _ => Verdict::Mismatch("different values".into()),
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
