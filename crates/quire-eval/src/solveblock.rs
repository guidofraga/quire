//! Solve blocks (docs/02-file-format.md §4.10), Mathcad's "Given … Find": constraints on
//! some unknowns, and a closing `find(x, y)` or `minerr(x, y)` that looks for values meeting
//! them, starting from the unknowns' guess values.
//!
//! Every constraint becomes residuals: `a == b` is `a − b`, `a ≤ b` is `max(0, a − b)`. They
//! are driven to zero by Levenberg–Marquardt with a numerical Jacobian. An inequality is a
//! penalty, made heavier until it is met; one still unmet then becomes an equation (its bound),
//! so a result that lies on a bound lies exactly on it.

use quire_ast::{CmpOp, Expr};
use quire_units::Dim;

use crate::error::{EvalError, Result, bail};
use crate::interp::{Interp, Scope};
use crate::numeric;
use crate::ops::same_dim;
use crate::value::{Quantity, Value};

/// How close a constraint must come to count as met: its two sides' difference against the
/// size of its terms at the guess values.
const TOL: f64 = 1e-7;
/// The penalty weights an unmet inequality is given in turn.
const PENALTIES: &[f64] = &[1.0, 10.0, 1e2, 1e3, 1e4, 1e6];
const MAX_ITERATIONS: usize = 500;
/// Roots of the equations tried for one that meets the inequalities too.
const MAX_ROOTS: usize = 6;
/// The weight of an inequality held to its bound, against an equation's 1.
const BOUND: f64 = 1e7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Values at which every constraint holds, or an error.
    Find,
    /// The values that come closest, whether or not they meet every constraint.
    Minerr,
}

/// What the block's last line assigns.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Target {
    /// `find(x, y)`: the result is only shown.
    Nothing,
    /// `s := find(x, y)`: a vector (a number for one unknown).
    Name(String),
    /// `[a; b] := find(x, y)`: one name per unknown.
    Each(Vec<String>),
}

/// The block's last line, `[x; y] := find(x, y)`, taken apart.
#[derive(Debug)]
pub(crate) struct FindLine {
    pub mode: Mode,
    pub unknowns: Vec<String>,
    pub target: Target,
}

fn strip(e: &Expr) -> &Expr {
    match e {
        Expr::Paren(x) => strip(x),
        other => other,
    }
}

const FIND_FORM: &str =
    "a solve block ends with find(x, y) or minerr(x, y), the unknowns as names: [x; y] := find(x, y)";

/// Whether `name` is a solve block's closing function.
pub(crate) fn is_find(name: &str) -> bool {
    matches!(name, "find" | "Find" | "minerr" | "Minerr")
}

pub(crate) fn find_line(e: &Expr) -> Result<FindLine> {
    let (lhs, call) = match strip(e) {
        Expr::Define { lhs, rhs, .. } => (Some(strip(lhs)), strip(rhs)),
        other => (None, other),
    };
    let Expr::Call(name, args) = call else { bail!("{FIND_FORM}") };
    let mode = match name.as_str() {
        "find" | "Find" => Mode::Find,
        "minerr" | "Minerr" => Mode::Minerr,
        _ => bail!("{FIND_FORM}"),
    };
    if args.is_empty() {
        bail!("{name} needs the unknowns it looks for: {name}(x, y)");
    }
    let mut unknowns: Vec<String> = Vec::new();
    for a in args {
        let Expr::Ident(n) = strip(a) else { bail!("{name} takes the unknowns as names, like {name}(x, y)") };
        if unknowns.contains(n) {
            bail!("{n} appears twice among the unknowns");
        }
        unknowns.push(n.clone());
    }
    let target = match lhs {
        None => Target::Nothing,
        Some(Expr::Ident(n)) => Target::Name(n.clone()),
        Some(Expr::Matrix(rows)) => {
            let cells: Vec<&Expr> = rows.iter().flatten().collect();
            if rows.len() > 1 && rows.iter().any(|r| r.len() > 1) {
                bail!("the names a solve block defines are a vector, like [x; y]");
            }
            let mut names = Vec::new();
            for c in cells {
                let Expr::Ident(n) = strip(c) else { bail!("[x; y] := … takes names only") };
                names.push(n.clone());
            }
            if names.len() != unknowns.len() {
                bail!(
                    "{} names on the left for {} unknowns: give one name to each",
                    names.len(),
                    unknowns.len()
                );
            }
            Target::Each(names)
        }
        Some(_) => bail!("the left side of := is a name, or names for each unknown, like [x; y]"),
    };
    Ok(FindLine { mode, unknowns, target })
}

/// One relation of a constraint: `lo == hi`, or `lo ≤ hi` (a strict `<` reads the same).
#[derive(Debug, Clone)]
pub(crate) struct Relation {
    /// The constraint (0-based) it comes from: a chain gives several relations.
    pub line: usize,
    pub equal: bool,
    pub lo: Expr,
    pub hi: Expr,
}

/// The relations a constraint line states.
pub(crate) fn relations(line: usize, e: &Expr) -> Result<Vec<Relation>> {
    let (first, rest) = match strip(e) {
        Expr::Compare(first, rest) => (first, rest),
        Expr::Define { .. } => {
            bail!("a constraint compares two sides, like x + y = 2; definitions (:=) go above Given")
        }
        _ => bail!("a constraint is an equation (=) or an inequality (<, ≤, >, ≥)"),
    };
    let mut out = Vec::new();
    let mut prev: &Expr = first;
    for (op, next) in rest {
        let (equal, lo, hi) = match op {
            CmpOp::Eq => (true, prev, next),
            CmpOp::Lt | CmpOp::Le => (false, prev, next),
            CmpOp::Gt | CmpOp::Ge => (false, next, prev),
            CmpOp::Ne => bail!("≠ can't be a constraint: write =, <, ≤, > or ≥"),
        };
        out.push(Relation { line, equal, lo: lo.clone(), hi: hi.clone() });
        prev = next;
    }
    Ok(out)
}

/// A constraint's text, written in the lines of a solve block: a lone `=` is the equation
/// sign there (`x + y = 2` reads as `x + y == 2`).
pub fn constraint_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 2);
    for (i, &c) in chars.iter().enumerate() {
        let before = i.checked_sub(1).and_then(|j| chars.get(j)).copied();
        let after = chars.get(i + 1).copied();
        let lone = c == '='
            && !matches!(before, Some('=' | ':' | '<' | '>' | '!'))
            && after != Some('=')
            // `::=` and `≡` never appear in a constraint; `=` at the end shows a value elsewhere
            && i + 1 < chars.len();
        out.push(c);
        if lone {
            out.push('=');
        }
    }
    out
}

/// Why a block found nothing, and which constraint (0-based) the message is about.
#[derive(Debug)]
pub(crate) struct Failure {
    pub line: Option<usize>,
    pub message: String,
}

impl Failure {
    fn on(line: usize, e: EvalError) -> Self {
        Failure { line: Some(line), message: e.message }
    }
}

/// What a block found.
#[derive(Debug)]
pub(crate) struct Solution {
    /// The unknowns' values (SI), in the order given to find.
    pub x: Vec<f64>,
    pub dims: Vec<Dim>,
    /// Per constraint line: whether it holds at `x`.
    pub holds: Vec<bool>,
    /// For find: why `x` is not a solution (it is then the closest point reached).
    pub error: Option<String>,
}

/// One residual's ingredients: the two sides (SI) and their units.
#[derive(Debug, Clone, Copy)]
struct Pair {
    lo: f64,
    hi: f64,
    dim: Dim,
}

/// A plain 0 is comparable with anything (`x == 0` for a length).
fn sides_dim(a: Quantity, b: Quantity) -> Result<Dim> {
    if a.dim == b.dim || (b.v == 0.0 && b.dim.is_dimensionless()) {
        return Ok(a.dim);
    }
    if a.v == 0.0 && a.dim.is_dimensionless() {
        return Ok(b.dim);
    }
    same_dim(a.dim, b.dim, "compare")?;
    Ok(a.dim)
}

fn elements(v: Value) -> Result<Vec<Quantity>> {
    match v {
        Value::Num(q) => Ok(vec![q]),
        Value::Matrix(m) => m.data.iter().map(|x| x.as_num("a constraint's element")).collect(),
        Value::Str(_) => bail!("a constraint compares numbers, not strings"),
        Value::Sym(_) => bail!("a constraint compares numbers, not formulas"),
    }
}

/// The problem as the solver sees it: the constraints' relations, evaluated with the unknowns
/// set to trial values in a scope of their own.
struct Problem<'a, 'i, 'e> {
    interp: &'a mut Interp<'i>,
    scope: &'a mut Scope<'e>,
    names: &'a [String],
    dims: Vec<Dim>,
    relations: &'a [Relation],
    /// Per residual: the relation it belongs to (fixed by the first evaluation).
    owner: Vec<usize>,
}

impl Problem<'_, '_, '_> {
    /// Every relation's element pairs at `x`. An error names the constraint it comes from.
    fn pairs(&mut self, x: &[f64]) -> std::result::Result<Vec<Pair>, Failure> {
        for ((n, v), d) in self.names.iter().zip(x).zip(&self.dims) {
            self.scope.bind(n, Value::Num(Quantity::new(*v, *d)));
        }
        let mut out = Vec::with_capacity(self.owner.len());
        let mut owner = Vec::with_capacity(self.owner.len());
        for (k, rel) in self.relations.iter().enumerate() {
            let at = |e| Failure::on(rel.line, e);
            let lo = elements(self.interp.eval(self.scope, &rel.lo).map_err(at)?).map_err(at)?;
            let hi = elements(self.interp.eval(self.scope, &rel.hi).map_err(at)?).map_err(at)?;
            let (lo, hi) = match (lo.len(), hi.len()) {
                (a, b) if a == b => (lo, hi),
                (_, 1) => {
                    let b = hi.first().copied().unwrap_or(Quantity::new(0.0, Dim::default()));
                    let n = lo.len();
                    (lo, vec![b; n])
                }
                (1, _) => {
                    let a = lo.first().copied().unwrap_or(Quantity::new(0.0, Dim::default()));
                    let n = hi.len();
                    (vec![a; n], hi)
                }
                (a, b) => {
                    return Err(Failure::on(
                        rel.line,
                        EvalError::new(format!("the two sides have {a} and {b} elements: they must match")),
                    ));
                }
            };
            for (a, b) in lo.into_iter().zip(hi) {
                let dim = sides_dim(a, b).map_err(at)?;
                if !a.v.is_finite() || !b.v.is_finite() {
                    return Err(Failure::on(rel.line, EvalError::new("it has no finite value here")));
                }
                out.push(Pair { lo: a.v, hi: b.v, dim });
                owner.push(k);
            }
        }
        if self.owner.is_empty() {
            self.owner = owner;
        } else if self.owner != owner {
            return Err(Failure { line: None, message: "the constraints changed size while solving".into() });
        }
        Ok(out)
    }
}

/// `|v|²`
fn sum_sq(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum()
}

/// Derivatives of `f` at `x` (`m` residuals, row-major m×n) by central differences, or
/// one-sided ones where `f` can't be worked out on one side.
fn jacobian(
    f: &mut dyn FnMut(&[f64]) -> Result<Vec<f64>>,
    x: &[f64],
    r: &[f64],
    typical: &[f64],
) -> Result<Vec<f64>> {
    let (m, n) = (r.len(), x.len());
    let mut jac = vec![0.0; m * n];
    for j in 0..n {
        let h = 1e-6 * x.get(j).map_or(1.0, |v| v.abs()).max(typical.get(j).copied().unwrap_or(1.0));
        let at = |d: f64| -> Vec<f64> {
            x.iter().enumerate().map(|(i, v)| if i == j { v + d } else { *v }).collect()
        };
        let plus = f(&at(h));
        let minus = f(&at(-h));
        let column: Vec<f64> = match (plus, minus) {
            (Ok(p), Ok(q)) => p.iter().zip(&q).map(|(a, b)| (a - b) / (2.0 * h)).collect(),
            (Ok(p), Err(_)) => p.iter().zip(r).map(|(a, b)| (a - b) / h).collect(),
            (Err(_), Ok(q)) => r.iter().zip(&q).map(|(a, b)| (a - b) / h).collect(),
            (Err(e), Err(_)) => return Err(e),
        };
        for (i, v) in column.into_iter().enumerate() {
            if let Some(slot) = numeric::el_mut(&mut jac, n, i, j) {
                *slot = v;
            }
        }
    }
    Ok(jac)
}

/// `JᵀJ` (n×n) and `Jᵀr`.
fn normal_equations(jac: &[f64], r: &[f64], n: usize) -> Result<(Vec<f64>, Vec<f64>)> {
    crate::budget::charge((r.len() as u64).saturating_mul((n * n) as u64), 64)?;
    let mut a = vec![0.0; n * n];
    let mut g = vec![0.0; n];
    for (row, ri) in jac.chunks_exact(n.max(1)).zip(r) {
        for (j, rj) in row.iter().enumerate() {
            if let Some(gj) = g.get_mut(j) {
                *gj += rj * ri;
            }
            for (k, rk) in row.iter().enumerate() {
                if let Some(slot) = numeric::el_mut(&mut a, n, j, k) {
                    *slot += rj * rk;
                }
            }
        }
    }
    Ok((a, g))
}

/// Whether nothing changes the residuals at `x`: the gradient of `|r|²` is zero there.
fn flat(jac: &[f64], r: &[f64], typical: &[f64]) -> Result<bool> {
    let n = typical.len();
    let (_, g) = normal_equations(jac, r, n)?;
    let cost = sum_sq(r);
    Ok(cost > 0.0 && g.iter().zip(typical).all(|(gj, t)| (gj * t).abs() <= 1e-12 * cost))
}

/// Levenberg–Marquardt: the `x` near `x0` that makes `|f(x)|²` least.
fn levenberg_marquardt(
    f: &mut dyn FnMut(&[f64]) -> Result<Vec<f64>>,
    x0: Vec<f64>,
    typical: &[f64],
) -> Result<Vec<f64>> {
    let n = x0.len();
    let mut x = x0;
    let mut r = f(&x)?;
    let mut cost = sum_sq(&r);
    let mut lambda = 1e-3;
    for _ in 0..MAX_ITERATIONS {
        if cost == 0.0 {
            break;
        }
        let jac = jacobian(f, &x, &r, typical)?;
        let (a, g) = normal_equations(&jac, &r, n)?;
        // stationary: no direction makes the residuals smaller
        if g.iter().zip(typical).all(|(gj, t)| (gj * t).abs() <= 1e-13 * cost) {
            break;
        }
        let top = (0..n).filter_map(|j| numeric::el(&a, n, j, j)).fold(0.0_f64, f64::max);
        let mut step = None;
        while lambda < 1e16 {
            let mut damped = a.clone();
            for j in 0..n {
                if let Some(d) = numeric::el_mut(&mut damped, n, j, j) {
                    *d += lambda * d.max(top * 1e-12).max(f64::MIN_POSITIVE);
                }
            }
            if let Some(dx) = numeric::solve(damped, g.iter().map(|v| -v).collect()) {
                let xt: Vec<f64> = x.iter().zip(&dx).map(|(a, b)| a + b).collect();
                if let Ok(rt) = f(&xt) {
                    let ct = sum_sq(&rt);
                    if ct.is_finite() && ct < cost {
                        step = Some((dx, xt, rt, ct));
                        break;
                    }
                }
            }
            lambda *= 4.0;
        }
        let Some((dx, xt, rt, ct)) = step else { break };
        lambda = (lambda / 5.0).max(1e-15);
        let tiny =
            dx.iter().zip(&xt).zip(typical).all(|((d, v), t)| d.abs() <= 1e-15 * v.abs().max(t * 1e-9));
        let stalled = cost - ct <= 1e-15 * cost;
        x = xt;
        r = rt;
        cost = ct;
        if tiny || stalled {
            break;
        }
    }
    Ok(x)
}

/// Solve the block: `line` names the unknowns and `x0` are their guess values; `relations` are its
/// constraints' relations (there are `lines` constraints). `fmt` writes an amount for a message.
pub(crate) fn solve(
    interp: &mut Interp,
    scope: &mut Scope,
    line: &FindLine,
    x0: &[Quantity],
    relations: &[Relation],
    lines: usize,
    fmt: &dyn Fn(Quantity) -> String,
) -> std::result::Result<Solution, Failure> {
    let (names, mode) = (line.unknowns.as_slice(), line.mode);
    let dims: Vec<Dim> = x0.iter().map(|q| q.dim).collect();
    let start: Vec<f64> = x0.iter().map(|q| q.v).collect();
    let typical: Vec<f64> = start.iter().map(|v| if *v != 0.0 { v.abs() } else { 1.0 }).collect();
    let mut p = Problem { interp, scope, names, dims: dims.clone(), relations, owner: Vec::new() };
    let first = p.pairs(&start)?;
    let owner = p.owner.clone();
    let equal: Vec<bool> = owner.iter().map(|k| relations.get(*k).is_some_and(|r| r.equal)).collect();
    let line_of = |i: usize| owner.get(i).and_then(|k| relations.get(*k)).map_or(0, |r| r.line);

    // each residual against the size of its terms at the guess values, so an equation in kN
    // and one in mm count alike
    let fail = |e: EvalError| Failure { line: None, message: e.message };
    let raw = |p: &mut Problem, x: &[f64]| -> Result<Vec<f64>> {
        p.pairs(x).map(|v| v.iter().map(|q| q.lo - q.hi).collect()).map_err(|f| EvalError::new(f.message))
    };
    let d0: Vec<f64> = first.iter().map(|q| q.lo - q.hi).collect();
    let jac0 = jacobian(&mut |x| raw(&mut p, x), &start, &d0, &typical).map_err(fail)?;
    let n = start.len();
    let size: Vec<f64> = first
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let slope: f64 = (0..n)
                .map(|j| {
                    numeric::el(&jac0, n, i, j).unwrap_or(0.0).abs() * typical.get(j).copied().unwrap_or(1.0)
                })
                .sum();
            let s = q.lo.abs().max(q.hi.abs()).max(slope);
            if s.is_finite() && s > 0.0 { s } else { 1.0 }
        })
        .collect();
    // minerr's best fit is the least sum of squares in SI; find only needs zero residuals,
    // and reaches them more surely when each is relative
    let weight: Vec<f64> = match mode {
        Mode::Find => size.iter().map(|s| 1.0 / s).collect(),
        Mode::Minerr => vec![1.0; size.len()],
    };
    let mut active = vec![false; first.len()];
    let residuals = |p: &mut Problem, x: &[f64], mu: f64, active: &[bool]| -> Result<Vec<f64>> {
        let d = raw(p, x)?;
        Ok(d.iter()
            .enumerate()
            .map(|(i, v)| {
                let w = weight.get(i).copied().unwrap_or(1.0);
                if equal.get(i).copied().unwrap_or(true) {
                    w * v
                } else if active.get(i).copied().unwrap_or(false) {
                    // held to its bound: heavier than any equation, so a best fit gives way to it
                    BOUND * w * v
                } else {
                    mu * w * v.max(0.0)
                }
            })
            .collect())
    };
    let met = |d: &[f64], i: usize| {
        let v = d.get(i).copied().unwrap_or(0.0);
        let s = size.get(i).copied().unwrap_or(1.0);
        if equal.get(i).copied().unwrap_or(true) { v.abs() <= TOL * s } else { v <= TOL * s }
    };

    // a guess where nothing changes the residuals gives the search no direction
    let r0 = residuals(&mut p, &start, 1.0, &active).map_err(fail)?;
    let j0 = jacobian(&mut |x| residuals(&mut p, x, 1.0, &active), &start, &r0, &typical).map_err(fail)?;
    let mut x = start.clone();
    if flat(&j0, &r0, &typical).map_err(fail)? {
        if mode == Mode::Find {
            return Err(Failure {
                line: None,
                message: "The constraints don't change near the guess values, so the search has no direction to go: try other guess values".into(),
            });
        }
    } else {
        let inequalities = equal.iter().any(|e| !e);
        let mut mu = 1.0;
        for &m in if inequalities { PENALTIES } else { &PENALTIES[..1] } {
            mu = m;
            x = levenberg_marquardt(&mut |x| residuals(&mut p, x, mu, &active), x, &typical).map_err(fail)?;
            let d = raw(&mut p, &x).map_err(fail)?;
            if (0..d.len()).all(|i| equal.get(i).copied().unwrap_or(true) || met(&d, i)) {
                break;
            }
        }
        // an inequality the penalty pushed against but couldn't quite meet: hold it to its bound
        for _ in 0..active.len() {
            let d = raw(&mut p, &x).map_err(fail)?;
            let mut more = false;
            for (i, v) in d.iter().enumerate() {
                if !equal.get(i).copied().unwrap_or(true) && !active[i] && *v > 0.0 {
                    active[i] = true;
                    more = true;
                }
            }
            if !more {
                break;
            }
            x = levenberg_marquardt(&mut |x| residuals(&mut p, x, mu, &active), x, &typical).map_err(fail)?;
        }
    }

    // find with inequalities: the penalty can stall against a bound that has the solution on
    // its far side. Then the equations' roots near the guesses are tried in turn, each root
    // found pushing the next search away from it (deflation), for one that meets the rest
    let is_equal = |i: usize| equal.get(i).copied().unwrap_or(true);
    if mode == Mode::Find && equal.iter().any(|e| !e) && equal.iter().any(|e| *e) {
        let d = raw(&mut p, &x).map_err(fail)?;
        if !(0..d.len()).all(|i| met(&d, i)) {
            let mut roots: Vec<Vec<f64>> = Vec::new();
            for _ in 0..MAX_ROOTS {
                let deflated = |p: &mut Problem, x: &[f64]| -> Result<Vec<f64>> {
                    let d = raw(p, x)?;
                    let factor: f64 = roots
                        .iter()
                        .map(|r| {
                            let gap: f64 =
                                x.iter().zip(r).zip(&typical).map(|((a, b), t)| ((a - b) / t).powi(2)).sum();
                            1.0 / gap + 1.0
                        })
                        .product();
                    Ok(d.iter()
                        .enumerate()
                        .filter(|(i, _)| is_equal(*i))
                        .map(|(i, v)| factor * weight.get(i).copied().unwrap_or(1.0) * v)
                        .collect())
                };
                let Ok(y) = levenberg_marquardt(&mut |x| deflated(&mut p, x), start.clone(), &typical) else {
                    break;
                };
                let Ok(d) = raw(&mut p, &y) else { break };
                if !(0..d.len()).all(|i| !is_equal(i) || met(&d, i)) {
                    break;
                }
                if (0..d.len()).all(|i| met(&d, i)) {
                    x = y;
                    break;
                }
                roots.push(y);
            }
        }
    }

    let pairs = p.pairs(&x)?;
    let d: Vec<f64> = pairs.iter().map(|q| q.lo - q.hi).collect();
    let mut holds = vec![true; lines];
    for i in 0..d.len() {
        if !met(&d, i)
            && let Some(h) = holds.get_mut(line_of(i))
        {
            *h = false;
        }
    }
    let error = if mode == Mode::Find && holds.iter().any(|h| !h) {
        // the constraint left furthest from holding, measured against its own terms
        let worst = (0..d.len())
            .filter(|&i| !met(&d, i))
            .max_by(|&a, &b| {
                let off = |i: usize| {
                    let v = d.get(i).copied().unwrap_or(0.0);
                    let v = if equal.get(i).copied().unwrap_or(true) { v.abs() } else { v };
                    v / size.get(i).copied().unwrap_or(1.0)
                };
                off(a).total_cmp(&off(b)).then(b.cmp(&a))
            })
            .unwrap_or(0);
        let amount = fmt(Quantity::new(
            d.get(worst).copied().unwrap_or(0.0).abs(),
            pairs.get(worst).map_or(Dim::default(), |q| q.dim),
        ));
        let what = if equal.get(worst).copied().unwrap_or(true) { "is off by" } else { "is not met by" };
        Some(format!(
            "No solution near the guess values: constraint {} {what} {amount}. Try other guess values, or minerr for the closest fit",
            line_of(worst) + 1
        ))
    } else {
        None
    };
    Ok(Solution { x, dims, holds, error })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_equals_sign_is_an_equation() {
        assert_eq!(constraint_text("x + y = 2"), "x + y == 2");
        assert_eq!(constraint_text("x == 2"), "x == 2");
        assert_eq!(constraint_text("x <= 2"), "x <= 2");
        assert_eq!(constraint_text("x >= 2"), "x >= 2");
        assert_eq!(constraint_text("x != 2"), "x != 2");
        assert_eq!(constraint_text("x := 2"), "x := 2");
    }

    #[test]
    fn find_lines_and_constraints_take_apart() -> Result<()> {
        let f = find_line(&quire_ast::parse("[a; b] := minerr(x, y)")?)?;
        assert_eq!(f.mode, Mode::Minerr);
        assert_eq!(f.unknowns, ["x", "y"]);
        assert_eq!(f.target, Target::Each(vec!["a".into(), "b".into()]));
        assert_eq!(find_line(&quire_ast::parse("find(x)")?)?.target, Target::Nothing);
        assert!(find_line(&quire_ast::parse("[a; b] := find(x)")?).is_err());
        assert!(find_line(&quire_ast::parse("x := solve(x)")?).is_err());
        let r = relations(2, &quire_ast::parse("0 < x ≤ L")?)?;
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|r| !r.equal && r.line == 2));
        let g = relations(0, &quire_ast::parse("x > 1")?)?;
        assert_eq!(
            g.first().map(|r| (&r.lo, &r.hi)),
            Some((&Expr::Num("1".into()), &Expr::Ident("x".into())))
        );
        assert!(relations(0, &quire_ast::parse("x ≠ 1")?).is_err());
        assert!(relations(0, &quire_ast::parse("x + 1")?).is_err());
        Ok(())
    }
}
