//! Polynomials in one variable whose coefficients may hold other names, and factoring:
//! common factors, rational roots, roots that are names (`x^2 - a^2`), quadratics with
//! an exact discriminant and biquadratics.

use super::simplify::{simplify, together};
use super::*;

/// A term as `rest*x^k` with `rest` free of `x`.
pub(super) fn power_of(t: &S, x: &str) -> Option<(usize, S)> {
    if !t.depends(x) {
        return Some((0, t.clone()));
    }
    let factors = match t {
        S::Mul(fs) => fs.clone(),
        f => vec![f.clone()],
    };
    let mut k = 0;
    let mut rest = Vec::new();
    for f in factors {
        if !f.depends(x) {
            rest.push(f);
            continue;
        }
        let (b, e) = base_exp(&f);
        if b != sym(x) {
            return None;
        }
        k += usize::try_from(num_of(&e)?.integer()?).ok()?;
    }
    Some((k, mul(rest)))
}

/// The coefficients of `e` as a polynomial in `x`, lowest power first.
pub(super) fn coeffs(e: &S, x: &str) -> Option<Vec<S>> {
    let mut c: Vec<S> = vec![ZERO];
    for t in terms(&expand(e)) {
        let (k, rest) = power_of(&t, x)?;
        if c.len() <= k {
            c.resize(k + 1, ZERO);
        }
        c[k] = add(vec![c[k].clone(), rest]);
    }
    while c.len() > 1 && c.last() == Some(&ZERO) {
        c.pop();
    }
    Some(c)
}

pub(super) fn from_coeffs(c: &[S], x: &str) -> S {
    add(c.iter().enumerate().map(|(k, a)| mul(vec![a.clone(), pow(sym(x), n(k as i128))])).collect())
}

/// Whether `e` is zero, once multiplied out over one denominator.
pub(super) fn is_zero(e: &S) -> bool {
    let small = |s: &S| *s == ZERO || num_of(s).is_some_and(|v| v.f().abs() < 1e-12);
    let ex = expand(e);
    if small(&ex) {
        return true;
    }
    let (num, _) = together(&ex);
    small(&expand(&num))
}

/// `a = q*b + r`, coefficient lists lowest power first; None when `b` is zero.
pub(super) fn divide(a: &[S], b: &[S]) -> Option<(Vec<S>, Vec<S>)> {
    let lead = b.last().filter(|l| !is_zero(l))?.clone();
    let mut r: Vec<S> = a.to_vec();
    if r.len() < b.len() {
        return Some((vec![ZERO], r));
    }
    let mut q = vec![ZERO; r.len() - b.len() + 1];
    for i in (0..q.len()).rev() {
        let top = r[i + b.len() - 1].clone();
        if is_zero(&top) {
            continue;
        }
        let t = simplify(&div(top, lead.clone()));
        for (j, bj) in b.iter().enumerate() {
            r[i + j] = simplify(&expand(&add(vec![r[i + j].clone(), neg(mul(vec![t.clone(), bj.clone()]))])));
        }
        r[i + b.len() - 1] = ZERO;
        q[i] = t;
    }
    r.truncate(b.len() - 1);
    while r.len() > 1 && r.last().is_some_and(is_zero) {
        r.pop();
    }
    if r.is_empty() {
        r.push(ZERO);
    }
    Some((q, r))
}

/// `factor(e)`: a product of the simplest pieces it splits into.
pub(crate) fn factor(e: &S) -> S {
    factor_by(e, None, 0)
}

/// Split only along `x`: the pieces partial fractions are built from.
pub(super) fn factor_in(e: &S, x: &str) -> S {
    factor_by(e, Some(x), 0)
}

fn factor_by(e: &S, var: Option<&str>, depth: usize) -> S {
    match e {
        S::Mul(fs) => return mul(fs.iter().map(|f| factor_by(f, var, depth)).collect()),
        S::Pow(b, k) if num_of(k).and_then(Num::integer).is_some() => {
            return pow(factor_by(b, var, depth), (**k).clone());
        }
        _ => {}
    }
    let (num, den) = together(e);
    if den != ONE {
        return mul(vec![factor_by(&num, var, depth), pow(factor_by(&den, var, depth), n(-1))]);
    }
    let p = expand(e);
    if !matches!(p, S::Add(_)) {
        return p;
    }
    let (c, prim) = content(&p);
    let mut out = vec![c];
    out.extend(split(&prim, var, depth));
    mul(out)
}

/// `e` as `content * primitive`: the numeric factor and the powers of names every term
/// shares, with the first term of what is left positive.
pub(super) fn content(e: &S) -> (S, S) {
    let ts = terms(e);
    let coefs: Vec<Num> = ts.iter().map(|t| coef(t).0).collect();
    let mut c = match coefs.iter().map(|c| c.ratio()).collect::<Option<Vec<_>>>() {
        Some(fr) if coefs.iter().all(|c| matches!(c, Num::Rat(..))) => {
            let g = fr.iter().fold(0, |g, (p, _)| gcd(g, *p));
            let l = fr.iter().try_fold(1, |l, (_, q)| lcm(l, *q)).unwrap_or(1);
            Num::rat(g, l)
        }
        _ => Num::int(1),
    };
    if coefs.first().is_some_and(|k| k.f() < 0.0) {
        c = c.neg();
    }
    // names (and functions) in every term, to their lowest power
    let powers = |t: &S| -> Vec<(S, Num)> {
        let fs = match coef(t).1 {
            S::Mul(fs) => fs,
            f => vec![f],
        };
        fs.iter()
            .filter_map(|f| {
                let (b, k) = base_exp(f);
                let k = num_of(&k)?;
                (k.f() > 0.0 && matches!(b, S::Sym(_) | S::Unit(_) | S::Fn(..))).then_some((b, k))
            })
            .collect()
    };
    let mut shared: Vec<S> = Vec::new();
    for (b, k0) in powers(&ts[0]) {
        let mut k = k0;
        let in_all = ts[1..].iter().all(|t| {
            powers(t).iter().any(|(b2, k2)| {
                if *b2 == b && k2.f() < k.f() {
                    k = *k2;
                }
                *b2 == b
            })
        });
        if in_all {
            shared.push(pow(b, S::N(k)));
        }
    }
    let mut whole = vec![S::N(c)];
    whole.extend(shared);
    let whole = mul(whole);
    let prim = add(ts.iter().map(|t| div(t.clone(), whole.clone())).collect());
    (whole, prim)
}

/// The irreducible pieces of a primitive polynomial.
fn split(p: &S, var: Option<&str>, depth: usize) -> Vec<S> {
    if depth < 12 {
        for x in variables(p, var) {
            let Some(c) = coeffs(p, &x) else { continue };
            if c.len() < 3 {
                continue;
            }
            if let Some((f, rest)) = split_once(&c, &x) {
                let (k, rest) = content(&rest);
                let mut out = vec![k];
                out.extend(split(&f, var, depth + 1));
                out.extend(split(&rest, var, depth + 1));
                return out;
            }
        }
    }
    // the sign goes in front, so x - 1 and 1 - x are the same piece
    let (k, p) = content(p);
    vec![k, p]
}

/// The names to factor along: the one given, or those of highest degree first.
fn variables(p: &S, var: Option<&str>) -> Vec<String> {
    if let Some(x) = var {
        return vec![x.to_string()];
    }
    let mut names = Vec::new();
    collect_names(p, &mut names);
    let degree = |x: &String| coeffs(p, x).map_or(0, |c| c.len());
    names.sort_by(|a, b| degree(b).cmp(&degree(a)).then_with(|| a.cmp(b)));
    names
}

pub(super) fn collect_names(e: &S, out: &mut Vec<String>) {
    match e {
        S::Sym(s) if !matches!(s.as_str(), "π" | "e" | "∞") => {
            if !out.contains(s) {
                out.push(s.clone());
            }
        }
        S::Add(xs) | S::Mul(xs) | S::Fn(_, xs) | S::Vec(xs) => xs.iter().for_each(|t| collect_names(t, out)),
        S::Pow(b, p) => {
            collect_names(b, out);
            collect_names(p, out);
        }
        _ => {}
    }
}

/// One factor of a polynomial (coefficients `c` in `x`) and what is left, if it splits.
fn split_once(c: &[S], x: &str) -> Option<(S, S)> {
    let p = from_coeffs(c, x);
    let try_factor = |f: S| -> Option<(S, S)> {
        let (num, _) = together(&f);
        let (_, f) = content(&expand(&num));
        let (q, r) = divide(c, &coeffs(&f, x)?)?;
        (r.iter().all(is_zero) && q.len() > 1).then(|| (f, from_coeffs(&q, x)))
    };
    let linear = |r: S| try_factor(add(vec![sym(x), neg(r)]));
    for r in rational_roots(c).into_iter().chain(name_roots(c, x)) {
        if is_zero(&subs(&p, x, &r))
            && let Some(found) = linear(r)
        {
            return Some(found);
        }
    }
    if c.len() == 3 {
        // a quadratic whose discriminant is a perfect square
        let disc = add(vec![pow(c[1].clone(), n(2)), mul(vec![n(-4), c[2].clone(), c[0].clone()])]);
        if num_of(&disc).is_some_and(|d| d.f() < 0.0) {
            return None;
        }
        let root = exact_sqrt(&disc)?;
        let r = simplify(&div(add(vec![neg(c[1].clone()), root]), mul(vec![n(2), c[2].clone()])));
        return linear(r);
    }
    if c.len() == 5 && is_zero(&c[1]) && is_zero(&c[3]) {
        // a quadratic in x^2
        let y = "§y";
        let q = [c[0].clone(), c[2].clone(), c[4].clone()];
        let (f, _) = split_once(&q, y)?;
        let f = subs(&f, y, &pow(sym(x), n(2)));
        return try_factor(f);
    }
    None
}

/// Rational roots of a polynomial with numeric coefficients (none if any is a name).
fn rational_roots(c: &[S]) -> Vec<S> {
    let Some(fr) = c.iter().map(|k| num_of(k).and_then(Num::ratio)).collect::<Option<Vec<_>>>() else {
        return vec![];
    };
    let Some(l) = fr.iter().try_fold(1, |l, (_, q)| lcm(l, *q)) else { return vec![] };
    let ints: Vec<i128> = fr.iter().map(|(p, q)| p * (l / q)).collect();
    let Some(k) = ints.iter().position(|a| *a != 0) else { return vec![] };
    if k > 0 {
        return vec![ZERO];
    }
    let (a0, an) = (ints[0], *ints.last().unwrap());
    let (Some(ps), Some(qs)) = (divisors(a0), divisors(an)) else { return vec![] };
    let mut out = Vec::new();
    for p in &ps {
        for q in &qs {
            for s in [1, -1] {
                let r = Num::rat(s * p, *q);
                let value = ints.iter().rev().fold(Num::int(0), |acc, a| acc.mul(r).add(Num::int(*a)));
                if value.is(0) && !out.contains(&S::N(r)) {
                    out.push(S::N(r));
                }
            }
        }
    }
    out
}

fn divisors(n: i128) -> Option<Vec<i128>> {
    let n = n.abs();
    if n > 1_000_000_000_000 {
        return None;
    }
    let mut out = Vec::new();
    let mut d = 1;
    while d * d <= n {
        if n % d == 0 {
            out.push(d);
            if d * d != n {
                out.push(n / d);
            }
        }
        d += 1;
    }
    Some(out)
}

/// Roots worth trying when the coefficients hold names: ±a, ±2a, ±a/2 for each name a.
fn name_roots(c: &[S], x: &str) -> Vec<S> {
    let mut names = Vec::new();
    c.iter().for_each(|k| collect_names(k, &mut names));
    names.retain(|s| s != x);
    let mut out = Vec::new();
    for s in names {
        for k in [Num::int(1), Num::int(-1), Num::int(2), Num::int(-2), Num::rat(1, 2), Num::rat(-1, 2)] {
            out.push(mul(vec![S::N(k), sym(&s)]));
        }
    }
    out
}

/// `sqrt(e)` when it has no root left in it: `4*a^2` → `2*a`, `(a - b)^2` → `a - b`.
pub(super) fn exact_sqrt(e: &S) -> Option<S> {
    if let Some(k) = num_of(e) {
        return k.pow(Num::rat(1, 2)).map(S::N);
    }
    let f = factor(e);
    let fs = match f {
        S::Mul(fs) => fs,
        f => vec![f],
    };
    let mut out = Vec::new();
    for g in fs {
        match g {
            S::N(k) => out.push(S::N(k.pow(Num::rat(1, 2))?)),
            g => {
                let (b, k) = base_exp(&g);
                let k = num_of(&k)?.integer()?;
                if k % 2 != 0 {
                    return None;
                }
                out.push(pow(b, n(k / 2)));
            }
        }
    }
    Some(mul(out))
}
