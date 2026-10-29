//! Limits (`lim(f, x, a)`, `a` may be ∞ or -∞) and Taylor polynomials (`series`).
//!
//! A limit is first found by putting the point in, with ∞ followed through sums,
//! products, powers, exp, ln and atan. Indeterminate forms (0/0, ∞/∞, 0·∞, 1^∞) are
//! rewritten as a quotient and handed to L'Hôpital's rule.

use super::poly::is_zero;
use super::simplify::{simplify, together};
use super::*;

/// What an expression tends to.
#[derive(Debug, Clone)]
enum L {
    Fin(S),
    /// +1 or -1; 0 when the sign differs on the two sides (1/x at 0).
    Inf(i8),
    /// 0/0, ∞ - ∞ and the like: the form alone does not say.
    Indet,
    /// No limit at all, with the reason.
    No(&'static str),
}

#[derive(Clone)]
enum Point {
    At(S),
    Inf(i8),
}

pub(crate) fn limit(f: &S, x: &str, a: &S) -> Res<S> {
    let inf = sym("∞");
    let p = if *a == inf {
        Point::Inf(1)
    } else if *a == neg(inf.clone()) {
        Point::Inf(-1)
    } else {
        Point::At(a.clone())
    };
    match lim(f, x, &p, 0) {
        L::Fin(v) => Ok(simplify(&v)),
        L::Inf(1) => Ok(inf),
        L::Inf(-1) => Ok(neg(inf)),
        L::Inf(_) => Err("the limit from the left differs from the limit from the right (±∞)".into()),
        L::No(why) => Err(why.into()),
        L::Indet => Err(format!("cannot find the limit of {} symbolically", show(f))),
    }
}

/// Positive sample values for names, different for each so differences do not vanish.
fn sample(name: &str) -> Option<f64> {
    let h = name.chars().fold(7u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32));
    Some(1.3 + (h % 97) as f64 / 41.0)
}

fn sign_of(e: &S) -> i8 {
    match approx(e, &sample) {
        Some(v) if v > 0.0 => 1,
        Some(v) if v < 0.0 => -1,
        _ => 0,
    }
}

fn lim(f: &S, x: &str, p: &Point, depth: usize) -> L {
    if depth > 8 {
        return L::Indet;
    }
    let r = at(f, x, p);
    if !matches!(r, L::Indet) {
        return r;
    }
    // a sum term by term, when that settles it
    if let S::Add(ts) = f {
        let parts: Vec<L> = ts.iter().map(|t| lim(t, x, p, depth + 1)).collect();
        if let Some(r) = sum(parts) {
            return r;
        }
    }
    // one fraction: L'Hôpital when it is 0/0 or ∞/∞
    let (num, den) = together(f);
    if den != ONE {
        return quotient(&num, &den, x, p, depth);
    }
    // 0·∞ as a quotient: the infinite part over the reciprocal of the vanishing part
    if let S::Mul(fs) = f {
        let (zero, rest): (Vec<S>, Vec<S>) =
            fs.iter().cloned().partition(|g| matches!(at(g, x, p), L::Fin(v) if is_zero(&v)));
        if !zero.is_empty() && !rest.is_empty() {
            let (z, r) = (mul(zero), mul(rest));
            let first = quotient(&r, &pow(z.clone(), n(-1)), x, p, depth);
            if !matches!(first, L::Indet) {
                return first;
            }
            return quotient(&z, &pow(r, n(-1)), x, p, depth);
        }
    }
    // 1^∞, 0^0, ∞^0: exp(g*ln(b))
    if let S::Pow(b, g) = f
        && g.depends(x)
    {
        return match lim(&mul(vec![(**g).clone(), func("ln", vec![(**b).clone()])]), x, p, depth + 1) {
            L::Fin(v) => L::Fin(func("exp", vec![v])),
            L::Inf(1) => L::Inf(1),
            L::Inf(-1) => L::Fin(ZERO),
            other => other,
        };
    }
    L::Indet
}

fn quotient(num: &S, den: &S, x: &str, p: &Point, depth: usize) -> L {
    let (a, b) = (lim(num, x, p, depth + 1), lim(den, x, p, depth + 1));
    let zero = |l: &L| matches!(l, L::Fin(v) if is_zero(v));
    let infinite = |l: &L| matches!(l, L::Inf(_));
    if (zero(&a) && zero(&b)) || (infinite(&a) && infinite(&b)) {
        let next = simplify(&div(diff(num, x), diff(den, x)));
        return lim(&next, x, p, depth + 1);
    }
    divide(a, b, den, x, p)
}

/// `a/b` for limits `a` and `b`; `den` is what tends to `b`, for the sign near zero.
fn divide(a: L, b: L, den: &S, x: &str, p: &Point) -> L {
    match (a, b) {
        (L::No(w), _) | (_, L::No(w)) => L::No(w),
        (L::Indet, _) | (_, L::Indet) => L::Indet,
        (L::Inf(_), L::Inf(_)) => L::Indet,
        (L::Fin(_), L::Inf(_)) => L::Fin(ZERO),
        (L::Inf(s), L::Fin(v)) => L::Inf(s * sign_of(&v)),
        (L::Fin(u), L::Fin(v)) if is_zero(&v) => {
            if is_zero(&u) {
                L::Indet
            } else {
                L::Inf(sign_of(&u) * side_sign(den, x, p))
            }
        }
        (L::Fin(u), L::Fin(v)) => L::Fin(div(u, v)),
    }
}

/// The sign of `e` just beside the point, the same on both sides, or 0.
fn side_sign(e: &S, x: &str, p: &Point) -> i8 {
    let Point::At(a) = p else {
        return 1;
    };
    let Some(a) = approx(a, &sample) else { return 0 };
    let eps = 1e-6 * (1.0 + a.abs());
    let near = |v: f64| approx(e, &|n: &str| if n == x { Some(v) } else { sample(n) });
    match (near(a - eps).map(f64::signum), near(a + eps).map(f64::signum)) {
        (Some(l), Some(r)) if l == r => l as i8,
        (None, Some(r)) => r as i8,
        _ => 0,
    }
}

/// The limit of a sum from its terms' limits; None for ∞ - ∞.
fn sum(parts: Vec<L>) -> Option<L> {
    let mut finite = Vec::new();
    let mut signs: Vec<i8> = Vec::new();
    for part in parts {
        match part {
            L::Fin(v) => finite.push(v),
            L::Inf(s) => signs.push(s),
            L::Indet => return None,
            other => return Some(other),
        }
    }
    match signs.as_slice() {
        [] => Some(L::Fin(add(finite))),
        [s, rest @ ..] if *s != 0 && rest.iter().all(|r| r == s) => Some(L::Inf(*s)),
        [0] => Some(L::Inf(0)),
        _ => None,
    }
}

/// The limit by putting the point in, following ∞ where it is clear.
fn at(e: &S, x: &str, p: &Point) -> L {
    if !e.depends(x) {
        return L::Fin(e.clone());
    }
    match e {
        S::Sym(_) => match p {
            Point::At(a) => L::Fin(a.clone()),
            Point::Inf(s) => L::Inf(*s),
        },
        S::Add(ts) => sum(ts.iter().map(|t| at(t, x, p)).collect()).unwrap_or(L::Indet),
        S::Mul(fs) => {
            let mut finite = Vec::new();
            let mut sign = 1i8;
            let mut infinite = false;
            for f in fs {
                match at(f, x, p) {
                    L::Fin(v) => finite.push(v),
                    L::Inf(s) => {
                        infinite = true;
                        sign *= s;
                    }
                    other => return other,
                }
            }
            let v = mul(finite);
            if !infinite {
                return L::Fin(v);
            }
            if is_zero(&v) { L::Indet } else { L::Inf(sign * sign_of(&v)) }
        }
        S::Pow(b, k) if !k.depends(x) => {
            let kv = num_of(k);
            let even = kv.and_then(Num::integer).is_some_and(|k| k % 2 == 0);
            let odd = kv.and_then(Num::integer).is_some_and(|k| k % 2 != 0);
            match (at(b, x, p), kv) {
                (L::Fin(v), Some(k)) if is_zero(&v) => {
                    if k.f() > 0.0 {
                        L::Fin(ZERO)
                    } else if even {
                        L::Inf(1)
                    } else {
                        L::Inf(side_sign(b, x, p))
                    }
                }
                (L::Fin(v), _) => L::Fin(pow(v, (**k).clone())),
                (L::Inf(_), Some(k)) if k.f() < 0.0 => L::Fin(ZERO),
                (L::Inf(s), _) if even => L::Inf(s.abs().max(1)),
                (L::Inf(s), _) if odd => L::Inf(s),
                (L::Inf(1), _) => L::Inf(1),
                (L::Inf(_), _) => L::Indet,
                (other, _) => other,
            }
        }
        S::Pow(c, u) if !c.depends(x) => {
            let base = approx(c, &sample).unwrap_or(f64::NAN);
            match at(u, x, p) {
                L::Fin(v) => L::Fin(pow((**c).clone(), v)),
                L::Inf(s) if base > 1.0 => {
                    if s > 0 {
                        L::Inf(1)
                    } else if s < 0 {
                        L::Fin(ZERO)
                    } else {
                        L::No("the limit from the left differs from the limit from the right")
                    }
                }
                L::Inf(s) if base > 0.0 && base < 1.0 => {
                    if s < 0 {
                        L::Inf(1)
                    } else if s > 0 {
                        L::Fin(ZERO)
                    } else {
                        L::No("the limit from the left differs from the limit from the right")
                    }
                }
                L::Inf(_) => L::Indet,
                other => other,
            }
        }
        // b^g with x in both: exp(g*ln(b))
        S::Pow(b, g) => {
            at(&func("exp", vec![mul(vec![(**g).clone(), func("ln", vec![(**b).clone()])])]), x, p)
        }
        S::Fn(f, args) if args.len() == 1 => match (f.as_str(), at(args.first().unwrap_or(&ZERO), x, p)) {
            ("ln" | "log", L::Fin(v)) if is_zero(&v) => L::Inf(-1),
            (_, L::Fin(v)) => L::Fin(func(f, vec![v])),
            ("exp" | "cosh", L::Inf(1)) => L::Inf(1),
            ("exp", L::Inf(-1)) => L::Fin(ZERO),
            ("cosh", L::Inf(-1)) => L::Inf(1),
            ("ln" | "log" | "sqrt", L::Inf(1)) => L::Inf(1),
            ("sinh", L::Inf(s)) if s != 0 => L::Inf(s),
            ("atan", L::Inf(s)) if s != 0 => L::Fin(mul(vec![S::N(Num::rat(s as i128, 2)), sym("π")])),
            ("tanh", L::Inf(s)) if s != 0 => L::Fin(n(s as i128)),
            ("sin" | "cos" | "tan", L::Inf(_)) => L::No("it keeps oscillating, so there is no limit"),
            (_, L::Inf(_)) => L::Indet,
            (_, other) => other,
        },
        _ => L::Fin(match p {
            Point::At(a) => subs(e, x, a),
            Point::Inf(_) => return L::Indet,
        }),
    }
}

/// The Taylor polynomial of `f` around `x0` up to `(x - x0)^order`, lowest power first.
pub(crate) fn series(f: &S, x: &str, x0: &S, order: usize) -> Res<Vec<S>> {
    let inf = sym("∞");
    if x0.key().contains('∞') {
        return Err("a series is taken around a finite point".into());
    }
    let base = if *x0 == ZERO { sym(x) } else { add(vec![sym(x), neg(x0.clone())]) };
    let mut out = Vec::new();
    let mut d = simplify(f);
    let mut factorial = Num::int(1);
    for k in 0..=order {
        if k > 0 {
            d = simplify(&diff(&d, x));
            factorial = factorial.mul(Num::int(k as i128));
        }
        let value = limit(&d, x, x0).map_err(|e| format!("no series at {x} = {}: {e}", show(x0)))?;
        if value.key().contains(&inf.key()) {
            return Err(format!("no series at {x} = {}: the function is not finite there", show(x0)));
        }
        let c = simplify(&div(value, S::N(factorial)));
        if !is_zero(&c) {
            out.push(mul(vec![c, pow(base.clone(), n(k as i128))]));
        }
    }
    if out.is_empty() {
        out.push(ZERO);
    }
    Ok(out)
}
