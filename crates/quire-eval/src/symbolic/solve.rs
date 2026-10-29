//! `solve`: polynomials (factored first, then the quadratic formula and pure powers),
//! equations with fractions (denominators cleared, roots that make one zero dropped),
//! one unknown isolated through exp, ln, sin and the like, and linear systems.

use super::poly::{coeffs, factor_in, from_coeffs, is_zero, power_of};
use super::simplify::{simplify, together};
use super::*;

/// Where solving exactly gives up: how to get a number instead.
fn numeric_hint(x: &str) -> String {
    format!("for a number, give {x} a range with = instead of →: solve(f({x}) == 0, {x}, a, b)")
}

/// For a table lookup the solver's own shapes guarantee; never caused by the input.
const INTERNAL: &str = "internal error: the equations have an unexpected shape";

/// The real solutions of `e == 0` for `x`: one value, or a column of them.
pub(crate) fn solve(e: &S, x: &str) -> Res<S> {
    let mut roots = roots(e, x)?;
    let mut seen = Vec::new();
    roots = roots
        .into_iter()
        .map(|r| simplify(&r))
        .filter(|r| {
            let k = r.key();
            let new = !seen.contains(&k);
            seen.push(k);
            new
        })
        .collect();
    // in increasing order where that is clear (names counted as 1: -a before a)
    let one = |_: &str| Some(1.0);
    if let Some(mut values) =
        roots.iter().map(|r| approx(r, &one).map(|v| (v, r.clone()))).collect::<Option<Vec<_>>>()
    {
        values.sort_by(|a, b| a.0.total_cmp(&b.0));
        roots = values.into_iter().map(|(_, r)| r).collect();
    }
    match <[S; 1]>::try_from(roots) {
        Ok([only]) => Ok(only),
        Err(roots) if roots.is_empty() => Err("no real solutions".into()),
        Err(roots) => Ok(S::Vec(roots)),
    }
}

fn roots(e: &S, x: &str) -> Res<Vec<S>> {
    if !e.depends(x) {
        return Err(format!("there is no {x} to solve for"));
    }
    let (num, den) = together(e);
    let num = expand(&num);
    let mut out = match coeffs(&num, x) {
        Some(c) => poly_roots(&c, x)?,
        None => isolate(&num, ZERO, x)?,
    };
    // a root of the numerator that makes a denominator zero is no solution
    out.retain(|r| den == ONE || !is_zero(&subs(&den, x, r)));
    Ok(out)
}

fn poly_roots(c: &[S], x: &str) -> Res<Vec<S>> {
    match c {
        [] | [_] => Err(format!("there is no {x} to solve for")),
        [c0, c1] => Ok(vec![neg(div(c0.clone(), c1.clone()))]),
        [c0, c1, c2] => Ok(quadratic(c0, c1, c2)),
        _ => {
            let factored = factor_in(&from_coeffs(c, x), x);
            let pieces = match factored {
                S::Mul(fs) => fs,
                f => vec![f],
            };
            let mut out = Vec::new();
            for piece in pieces.iter().filter(|p| p.depends(x)) {
                let base = base_exp(piece).0;
                let pc = coeffs(&base, x).ok_or_else(|| numeric_hint(x))?;
                if pc.len() <= 3 {
                    out.extend(poly_roots(&pc, x)?);
                } else if pc.get(1..pc.len() - 1).is_some_and(|mid| mid.iter().all(is_zero)) {
                    out.extend(pure_power(&pc)?);
                } else {
                    return Err(format!(
                        "solve cannot find the roots of this degree-{} equation in {x} exactly; {}",
                        pc.len() - 1,
                        numeric_hint(x)
                    ));
                }
            }
            Ok(out)
        }
    }
}

/// `a*x^2 + b*x + c`: both roots by the formula, or none when they are complex.
fn quadratic(c0: &S, c1: &S, c2: &S) -> Vec<S> {
    let disc = add(vec![pow(c1.clone(), n(2)), mul(vec![n(-4), c2.clone(), c0.clone()])]);
    if num_of(&disc).is_some_and(|d| d.f() < 0.0) {
        return vec![];
    }
    let two_a = mul(vec![n(2), c2.clone()]);
    if disc == ZERO {
        return vec![neg(div(c1.clone(), two_a))];
    }
    let root = pow(disc, S::N(Num::rat(1, 2)));
    vec![
        div(add(vec![neg(c1.clone()), neg(root.clone())]), two_a.clone()),
        div(add(vec![neg(c1.clone()), root]), two_a),
    ]
}

/// `a*x^n + b == 0`: the real n-th roots of -b/a.
fn pure_power(c: &[S]) -> Res<Vec<S>> {
    let k = c.len() as i128 - 1;
    let [first, .., last] = c else {
        return Err("solve cannot find these roots exactly".into());
    };
    let v = simplify(&neg(div(first.clone(), last.clone())));
    let none = |_: &str| None;
    let sign = approx(&v, &none).map(f64::signum);
    let root = |v: S| pow(v, S::N(Num::rat(1, k)));
    Ok(match (k % 2 == 0, sign) {
        (true, Some(s)) if s < 0.0 => vec![],
        (true, _) => vec![neg(root(v.clone())), root(v)],
        (false, Some(s)) if s < 0.0 => vec![neg(root(neg(v)))],
        (false, _) => vec![root(v)],
    })
}

/// `lhs == rhs` with `x` in one place on the left, undone step by step:
/// `exp(k*t) == 2` → `t = ln(2)/k`, `sin(x) == a` → `x = asin(a)` (principal value).
fn isolate(lhs: &S, rhs: S, x: &str) -> Res<Vec<S>> {
    if *lhs == sym(x) {
        return Ok(vec![rhs]);
    }
    let cannot = || Err(format!("solve cannot isolate {x} in this equation; {}", numeric_hint(x)));
    let none = |_: &str| None;
    let value = approx(&rhs, &none);
    let below = |limit: f64| value.is_some_and(|v| v < limit);
    let one = |f: &str, a: S| func(f, vec![a]);
    match lhs {
        S::Add(ts) => {
            let (dep, free): (Vec<S>, Vec<S>) = ts.iter().cloned().partition(|t| t.depends(x));
            match dep.as_slice() {
                [d] => isolate(d, add(vec![rhs, neg(add(free))]), x),
                _ => cannot(),
            }
        }
        S::Mul(fs) => {
            let (dep, free): (Vec<S>, Vec<S>) = fs.iter().cloned().partition(|f| f.depends(x));
            if let [d] = dep.as_slice() {
                return isolate(d, div(rhs, mul(free)), x);
            }
            if rhs != ZERO {
                return cannot();
            }
            // a product is zero when one of its factors is
            let mut out = Vec::new();
            for d in dep {
                out.extend(isolate(&d, ZERO, x)?);
            }
            Ok(out)
        }
        S::Pow(b, k) if !k.depends(x) => {
            if num_of(k).is_some_and(|k| k.f() < 0.0) && is_zero(&rhs) {
                return Ok(vec![]);
            }
            let inverse = pow(rhs.clone(), pow((**k).clone(), n(-1)));
            match num_of(k).and_then(Num::integer) {
                Some(k) if k % 2 == 0 => {
                    if below(0.0) {
                        return Ok(vec![]);
                    }
                    let mut out = isolate(b, neg(inverse.clone()), x)?;
                    out.extend(isolate(b, inverse, x)?);
                    Ok(out)
                }
                Some(_) => isolate(b, inverse, x),
                // sqrt(u) == negative has no solution
                None if below(0.0) => Ok(vec![]),
                None => isolate(b, inverse, x),
            }
        }
        S::Pow(c, u) if !c.depends(x) => {
            if below(1e-300) || is_zero(&rhs) {
                return Ok(vec![]);
            }
            isolate(u, div(one("ln", rhs), one("ln", (**c).clone())), x)
        }
        S::Fn(f, args) if args.len() == 1 => {
            // the guard above checks there is exactly one argument
            let [u] = args.as_slice() else { return cannot() };
            let out = match f.as_str() {
                "exp" if below(1e-300) || is_zero(&rhs) => return Ok(vec![]),
                "exp" => one("ln", rhs),
                "ln" => one("exp", rhs),
                "log" => pow(n(10), rhs),
                "sin" | "cos" if value.is_some_and(|v| v.abs() > 1.0) => return Ok(vec![]),
                "sin" => one("asin", rhs),
                "cos" => one("acos", rhs),
                "tan" => one("atan", rhs),
                "sinh" => one("asinh", rhs),
                "cosh" if below(1.0) => return Ok(vec![]),
                "cosh" => one("acosh", rhs),
                "tanh" => one("atanh", rhs),
                "asin" => one("sin", rhs),
                "acos" => one("cos", rhs),
                "atan" => one("tan", rhs),
                _ => return cannot(),
            };
            isolate(u, out, x)
        }
        _ => cannot(),
    }
}

/// Adds `term` to entry `i` of a row of the linear system.
fn add_into(row: &mut [S], i: usize, term: S) -> Res<()> {
    let slot = row.get_mut(i).ok_or(INTERNAL)?;
    *slot = add(vec![slot.clone(), term]);
    Ok(())
}

/// `solve([eq1; eq2], [x; y])`: linear equations in several unknowns, by elimination.
pub(crate) fn solve_system(eqs: &[S], xs: &[String]) -> Res<S> {
    if eqs.len() != xs.len() {
        return Err(format!(
            "give as many equations as unknowns ({} equations, {} unknowns)",
            eqs.len(),
            xs.len()
        ));
    }
    let size = xs.len();
    // rows of [a1 … an | b] for a1*x1 + … + an*xn = b
    let mut rows: Vec<Vec<S>> = Vec::new();
    for e in eqs {
        let (num, _) = together(e);
        let mut row = vec![ZERO; size + 1];
        for t in terms(&expand(&num)) {
            let present: Vec<usize> =
                xs.iter().enumerate().filter(|(_, x)| t.depends(x)).map(|(i, _)| i).collect();
            match present.as_slice() {
                [] => add_into(&mut row, size, neg(t))?,
                [i] => match xs.get(*i).and_then(|x| power_of(&t, x)) {
                    Some((1, rest)) => add_into(&mut row, *i, rest)?,
                    _ => return Err(not_linear(xs)),
                },
                _ => return Err(not_linear(xs)),
            }
        }
        rows.push(row);
    }
    for col in 0..size {
        let pivot = (col..size)
            .find(|&r| rows.get(r).and_then(|row| row.get(col)).is_some_and(|c| !is_zero(c)))
            .ok_or("the equations do not fix every unknown: some of them say the same thing")?;
        rows.swap(col, pivot);
        let pivot_row = rows.get(col).cloned().ok_or(INTERNAL)?;
        let pivot_val = pivot_row.get(col).cloned().ok_or(INTERNAL)?;
        for r in 0..size {
            let row = rows.get_mut(r).ok_or(INTERNAL)?;
            let here = row.get(col).ok_or(INTERNAL)?;
            if r == col || is_zero(here) {
                continue;
            }
            let f = simplify(&div(here.clone(), pivot_val.clone()));
            for (k, p) in pivot_row.iter().enumerate().skip(col) {
                let cur = row.get(k).ok_or(INTERNAL)?.clone();
                let v = add(vec![cur, neg(mul(vec![f.clone(), p.clone()]))]);
                *row.get_mut(k).ok_or(INTERNAL)? = simplify(&v);
            }
        }
    }
    let mut sol = Vec::with_capacity(size);
    for (i, row) in rows.iter().enumerate().take(size) {
        let num = row.get(size).ok_or(INTERNAL)?;
        let den = row.get(i).ok_or(INTERNAL)?;
        sol.push(simplify(&div(num.clone(), den.clone())));
    }
    Ok(S::Vec(sol))
}

fn not_linear(xs: &[String]) -> String {
    format!("solve handles systems of linear equations; these are not linear in {}", xs.join(", "))
}
