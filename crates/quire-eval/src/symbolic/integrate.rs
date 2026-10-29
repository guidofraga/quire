//! Antiderivatives: a table for f(a*x + b), substitution when the derivative of an inner
//! expression is a factor (x*exp(x^2)), integration by parts (x^n*exp(x), x*sin(x),
//! x*ln(x)), products of sines and cosines, and rational functions by partial fractions
//! (with atan and ln for quadratics).

use super::poly::{coeffs, divide, factor_in, from_coeffs, is_zero};
use super::simplify::{simplify, together};
use super::*;

/// The slope of `u` if it is `a*x + b`.
fn linear(u: &S, x: &str) -> Option<S> {
    let a = diff(u, x);
    (!a.depends(x) && a != ZERO).then_some(a)
}

pub(crate) fn integrate(e: &S, x: &str) -> Res<S> {
    int(e, x, 0).ok_or_else(|| format!("cannot integrate {} symbolically", show(e)))
}

fn int(e: &S, x: &str, depth: usize) -> Option<S> {
    if depth > 12 {
        return None;
    }
    if !e.depends(x) {
        return Some(mul(vec![e.clone(), sym(x)]));
    }
    let d = depth + 1;
    match e {
        S::Sym(_) => return Some(mul(vec![S::N(Num::rat(1, 2)), pow(sym(x), n(2))])),
        S::Add(ts) => return ts.iter().map(|t| int(t, x, d)).collect::<Option<Vec<_>>>().map(add),
        _ => {}
    }
    let fs = match e {
        S::Mul(fs) => fs.clone(),
        f => vec![f.clone()],
    };
    let (dep, constant): (Vec<S>, Vec<S>) = fs.into_iter().partition(|f| f.depends(x));
    if !constant.is_empty() {
        return int(&mul(dep), x, d).map(|f| mul([constant, vec![f]].concat()));
    }
    let found = match dep.as_slice() {
        [f] => single(f, x, d),
        _ => product(&dep, x, d),
    };
    found
        .or_else(|| rational(e, x, d))
        .or_else(|| {
            let ex = expand(e);
            (ex != *e).then(|| int(&ex, x, d)).flatten()
        })
        .or_else(|| {
            let lin = linearize(e);
            (lin != *e).then(|| int(&expand(&lin), x, d)).flatten()
        })
}

/// The antiderivative of `F(u)` with respect to `u`, for the functions in the table.
fn primitive(f: &str, u: &S) -> Option<S> {
    let one = |g: &str| func(g, vec![u.clone()]);
    let rt = |a: S| pow(a, S::N(Num::rat(1, 2)));
    Some(match f {
        "sin" => neg(one("cos")),
        "cos" => one("sin"),
        "exp" => one("exp"),
        "sinh" => one("cosh"),
        "cosh" => one("sinh"),
        "tan" => neg(func("ln", vec![one("cos")])),
        "ln" => add(vec![mul(vec![u.clone(), one("ln")]), neg(u.clone())]),
        "atan" => add(vec![
            mul(vec![u.clone(), one("atan")]),
            mul(vec![S::N(Num::rat(-1, 2)), func("ln", vec![add(vec![ONE, pow(u.clone(), n(2))])])]),
        ]),
        "asin" => add(vec![mul(vec![u.clone(), one("asin")]), rt(add(vec![ONE, neg(pow(u.clone(), n(2)))]))]),
        _ => return None,
    })
}

/// One factor that depends on `x`.
fn single(f: &S, x: &str, d: usize) -> Option<S> {
    match f {
        S::Pow(b, p) if !p.depends(x) => {
            if let Some(a) = linear(b, x) {
                if num_of(p).is_some_and(|k| k.is(-1)) {
                    return Some(div(func("ln", vec![(**b).clone()]), a));
                }
                let k1 = add(vec![(**p).clone(), ONE]);
                return Some(div(pow((**b).clone(), k1.clone()), mul(vec![a, k1])));
            }
            // sin(x)^2 and the like, through sines and cosines of multiples
            if matches!(&**b, S::Fn(g, _) if g == "sin" || g == "cos") {
                let lin = linearize(f);
                return (lin != *f).then(|| int(&lin, x, d)).flatten();
            }
            if num_of(p) == Some(Num::rat(-1, 2)) {
                return inverse_root(b, x);
            }
            None
        }
        // c^(a*x + b) = c^(…)/(a ln c)
        S::Pow(b, p) if !b.depends(x) => {
            let a = linear(p, x)?;
            Some(div(f.clone(), mul(vec![a, func("ln", vec![(**b).clone()])])))
        }
        S::Fn(g, args) if args.len() == 1 => {
            let u = &args[0];
            if let Some(a) = linear(u, x) {
                return Some(div(primitive(g, u)?, a));
            }
            // ln, atan or asin of a polynomial: by parts, against 1
            if matches!(g.as_str(), "ln" | "atan" | "asin") {
                return by_parts_inverse(&ONE, f, x, d);
            }
            None
        }
        _ => None,
    }
}

/// `1/sqrt(c + a*x^2)`: asin for a < 0, a logarithm (asinh) for a > 0.
fn inverse_root(b: &S, x: &str) -> Option<S> {
    let c = coeffs(b, x)?;
    if c.len() != 3 || !is_zero(&c[1]) {
        return None;
    }
    let half = S::N(Num::rat(1, 2));
    let rt = |a: S| simplify(&pow(a, half.clone()));
    if negative(&c[2]) {
        let a = neg(c[2].clone());
        let arg = mul(vec![rt(a.clone()), sym(x), pow(rt(c[0].clone()), n(-1))]);
        Some(div(func("asin", vec![arg]), rt(a)))
    } else {
        let arg = add(vec![mul(vec![rt(c[2].clone()), sym(x)]), pow(b.clone(), half.clone())]);
        Some(div(func("ln", vec![arg]), rt(c[2].clone())))
    }
}

/// Several factors that depend on `x`.
fn product(fs: &[S], x: &str, d: usize) -> Option<S> {
    substitution(fs, x).or_else(|| exp_trig(fs, x)).or_else(|| by_parts(fs, x, d))
}

/// `∫ g(u)·u' = G(u)`: some factor is a function or power of an inner `u` whose
/// derivative, up to a constant, is the rest of the product.
fn substitution(fs: &[S], x: &str) -> Option<S> {
    for i in 0..fs.len() {
        let mut rest = fs.to_vec();
        let f = rest.remove(i);
        let rest = mul(rest);
        let mut tries: Vec<(S, S)> = Vec::new(); // (u, antiderivative in u)
        match &f {
            S::Fn(g, args) if args.len() == 1 && linear(&args[0], x).is_none() => {
                if let Some(p) = primitive(g, &args[0]) {
                    tries.push((args[0].clone(), p));
                }
            }
            S::Pow(b, k) if !k.depends(x) && **b != sym(x) => {
                let p = if num_of(k).is_some_and(|k| k.is(-1)) {
                    func("ln", vec![(**b).clone()])
                } else {
                    let k1 = add(vec![(**k).clone(), ONE]);
                    div(pow((**b).clone(), k1.clone()), k1)
                };
                tries.push(((**b).clone(), p));
            }
            S::Pow(c, u) if !c.depends(x) => {
                tries.push(((**u).clone(), div(f.clone(), func("ln", vec![(**c).clone()]))));
            }
            _ => {}
        }
        // the factor itself as u: ln(x)/x = ln(x)*(ln x)'
        if matches!(f, S::Fn(..)) {
            tries.push((f.clone(), mul(vec![S::N(Num::rat(1, 2)), pow(f.clone(), n(2))])));
        }
        for (u, p) in tries {
            let du = diff(&u, x);
            if du == ZERO {
                continue;
            }
            let ratio = simplify(&div(rest.clone(), du));
            if !ratio.depends(x) {
                return Some(mul(vec![ratio, p]));
            }
        }
    }
    None
}

/// `exp(a*x)*sin(b*x)` and `exp(a*x)*cos(b*x)`, which by parts return to themselves.
fn exp_trig(fs: &[S], x: &str) -> Option<S> {
    let [f, g] = fs else { return None };
    let (e, t) = match (f, g) {
        (S::Fn(a, _), S::Fn(b, _)) if a == "exp" && (b == "sin" || b == "cos") => (f, g),
        (S::Fn(b, _), S::Fn(a, _)) if a == "exp" && (b == "sin" || b == "cos") => (g, f),
        _ => return None,
    };
    let (S::Fn(_, u), S::Fn(kind, v)) = (e, t) else { return None };
    let (a, b) = (linear(&u[0], x)?, linear(&v[0], x)?);
    let (sin, cos) = (func("sin", vec![v[0].clone()]), func("cos", vec![v[0].clone()]));
    let inner = if kind == "sin" {
        add(vec![mul(vec![a.clone(), sin]), neg(mul(vec![b.clone(), cos]))])
    } else {
        add(vec![mul(vec![a.clone(), cos]), mul(vec![b.clone(), sin])])
    };
    let scale = add(vec![pow(a, n(2)), pow(b, n(2))]);
    Some(div(mul(vec![e.clone(), inner]), scale))
}

/// A polynomial times exp, sin, cos, sinh, cosh (of a*x + b) or a power c^(a*x + b):
/// `∫ P·g = P·G - ∫ P'·G`; times ln, atan or asin: `∫ P·g = Q·g - ∫ Q·g'` with Q = ∫ P.
fn by_parts(fs: &[S], x: &str, d: usize) -> Option<S> {
    let is_poly = |f: &S| coeffs(f, x).is_some();
    for i in 0..fs.len() {
        let mut rest = fs.to_vec();
        let g = rest.remove(i);
        let p = mul(rest);
        if !is_poly(&p) {
            continue;
        }
        match &g {
            S::Fn(k, u) if matches!(k.as_str(), "exp" | "sin" | "cos" | "sinh" | "cosh") => {
                linear(&u[0], x)?;
                let big_g = int(&g, x, d)?;
                let rest = int(&mul(vec![diff(&p, x), big_g.clone()]), x, d)?;
                return Some(add(vec![mul(vec![p, big_g]), neg(rest)]));
            }
            S::Pow(c, u) if !c.depends(x) && linear(u, x).is_some() => {
                let big_g = int(&g, x, d)?;
                let rest = int(&mul(vec![diff(&p, x), big_g.clone()]), x, d)?;
                return Some(add(vec![mul(vec![p, big_g]), neg(rest)]));
            }
            S::Fn(k, _) if matches!(k.as_str(), "ln" | "atan" | "asin") => {
                return by_parts_inverse(&p, &g, x, d);
            }
            _ => {}
        }
    }
    None
}

fn by_parts_inverse(p: &S, g: &S, x: &str, d: usize) -> Option<S> {
    let q = int(p, x, d)?;
    let rest = int(&simplify(&mul(vec![q.clone(), diff(g, x)])), x, d)?;
    Some(add(vec![mul(vec![q, g.clone()]), neg(rest)]))
}

/// Products and whole powers of sines and cosines turned into sums:
/// `sin(a)*cos(b) = (sin(a + b) + sin(a - b))/2`, so `sin(x)^2 = 1/2 - cos(2*x)/2`.
fn linearize(e: &S) -> S {
    let fs = match e {
        S::Mul(fs) => fs.clone(),
        f => vec![f.clone()],
    };
    // a sum of (coefficient, sine or cosine or nothing)
    let mut acc: Vec<(S, Option<S>)> = vec![(ONE, None)];
    let mut others = Vec::new();
    let mut count = 0;
    for f in fs {
        let (b, k) = base_exp(&f);
        let times = num_of(&k).and_then(Num::integer).filter(|k| (1..=8).contains(k));
        match (&b, times) {
            (S::Fn(g, _), Some(k)) if g == "sin" || g == "cos" => {
                for _ in 0..k {
                    count += 1;
                    acc = acc.into_iter().flat_map(|(c, t)| times_trig(c, t, &b)).collect();
                }
            }
            _ => others.push(f),
        }
    }
    if count < 2 {
        return e.clone();
    }
    let sum = add(acc.into_iter().map(|(c, t)| mul(vec![c, t.unwrap_or(ONE)])).collect());
    mul([others, vec![sum]].concat())
}

fn times_trig(c: S, t: Option<S>, f: &S) -> Vec<(S, Option<S>)> {
    let Some(t) = t else { return vec![(c, Some(f.clone()))] };
    let (S::Fn(k1, a), S::Fn(k2, b)) = (&t, f) else {
        return vec![(mul(vec![c, t.clone(), f.clone()]), None)];
    };
    let (a, b) = (a[0].clone(), b[0].clone());
    let sum = add(vec![a.clone(), b.clone()]);
    let dif = add(vec![a, neg(b)]);
    let half = S::N(Num::rat(1, 2));
    let parts: Vec<(Num, S)> = match (k1.as_str(), k2.as_str()) {
        ("sin", "sin") => vec![(Num::int(1), func("cos", vec![dif])), (Num::int(-1), func("cos", vec![sum]))],
        ("cos", "cos") => vec![(Num::int(1), func("cos", vec![dif])), (Num::int(1), func("cos", vec![sum]))],
        ("sin", _) => vec![(Num::int(1), func("sin", vec![sum])), (Num::int(1), func("sin", vec![dif]))],
        _ => vec![(Num::int(1), func("sin", vec![sum])), (Num::int(-1), func("sin", vec![dif]))],
    };
    parts
        .into_iter()
        .map(|(s, v)| {
            // sin(0) = 0 and cos(0) = 1 leave a number; sin(-u) a minus sign
            let (k, rest) = coef(&v);
            let c = mul(vec![c.clone(), half.clone(), S::N(s.mul(k))]);
            if rest == ONE { (c, None) } else { (c, Some(rest)) }
        })
        .collect()
}

/// A ratio of polynomials in `x`: the polynomial part, then partial fractions over the
/// denominator's pieces (powers of linear ones, and quadratics that do not split).
fn rational(e: &S, x: &str, d: usize) -> Option<S> {
    let (num, den) = together(e);
    let (nc, dc) = (coeffs(&num, x)?, coeffs(&den, x)?);
    if dc.len() < 2 {
        return None;
    }
    let (q, r) = divide(&nc, &dc)?;
    let mut out = vec![int(&from_coeffs(&q, x), x, d)?];
    if r.iter().all(is_zero) {
        return Some(add(out));
    }
    // the denominator as k * Π piece^m
    let fd = factor_in(&den, x);
    let mut k = Vec::new();
    let mut pieces: Vec<(S, usize, usize)> = Vec::new(); // (piece, power, degree)
    for f in match fd {
        S::Mul(fs) => fs,
        f => vec![f],
    } {
        if !f.depends(x) {
            k.push(f);
            continue;
        }
        let (b, m) = base_exp(&f);
        let m = usize::try_from(num_of(&m)?.integer()?).ok()?;
        let deg = coeffs(&b, x)?.len() - 1;
        if deg > 2 || (deg == 2 && m > 1) {
            return None;
        }
        pieces.push((b, m, deg));
    }
    let rest = div(from_coeffs(&r, x), mul(k));
    // single irreducible quadratic: straight to the formula
    if let [(b, 1, 2)] = pieces.as_slice() {
        out.push(quadratic_term(&rest, b, x)?);
        return Some(add(out));
    }
    // unknown numerators, fixed by comparing coefficients of rest = Σ terms * Π/denominator
    let whole = mul(pieces.iter().map(|(b, m, _)| pow(b.clone(), n(*m as i128))).collect());
    let mut unknowns: Vec<String> = Vec::new();
    let mut fresh = || {
        let name = format!("§{}", unknowns.len());
        unknowns.push(name.clone());
        sym(&name)
    };
    let mut terms_: Vec<(S, S, bool)> = Vec::new(); // (numerator, denominator, quadratic)
    for (b, m, deg) in &pieces {
        for j in 1..=*m {
            let top = if *deg == 2 { add(vec![mul(vec![fresh(), sym(x)]), fresh()]) } else { fresh() };
            terms_.push((top, pow(b.clone(), n(j as i128)), *deg == 2));
        }
    }
    let lhs = expand(&simplify(&rest));
    let rhs = add(terms_
        .iter()
        .map(|(t, b, _)| mul(vec![t.clone(), whole.clone(), pow(b.clone(), n(-1))]))
        .collect());
    let diff_c = coeffs(&add(vec![expand(&rhs), neg(lhs)]), x)?;
    let eqs: Vec<S> = diff_c;
    if eqs.len() != unknowns.len() {
        return None;
    }
    let S::Vec(values) = super::solve::solve_system(&eqs, &unknowns).ok()? else { return None };
    let put = |e: &S| unknowns.iter().zip(&values).fold(e.clone(), |acc, (u, v)| subs(&acc, u, v));
    for (top, b, quadratic) in terms_ {
        let top = simplify(&put(&top));
        if is_zero(&top) {
            continue;
        }
        let term = if quadratic { quadratic_term(&top, &b, x)? } else { int(&div(top, b), x, d)? };
        out.push(term);
    }
    Some(add(out))
}

/// `∫ (B*x + C)/(a*x^2 + b*x + c)`: a logarithm for the B part, then atan when
/// 4ac - b^2 > 0 (or has names) and a logarithm of a ratio when it is negative.
fn quadratic_term(top: &S, q: &S, x: &str) -> Option<S> {
    let t = coeffs(top, x)?;
    if t.len() > 2 {
        return None;
    }
    let (bb, cc) = (t.get(1).cloned().unwrap_or(ZERO), t[0].clone());
    let qc = coeffs(q, x)?;
    let (c, b, a) = (qc[0].clone(), qc[1].clone(), qc[2].clone());
    let two_a = mul(vec![n(2), a.clone()]);
    let log_part = mul(vec![bb.clone(), pow(two_a.clone(), n(-1)), func("ln", vec![q.clone()])]);
    let k = simplify(&add(vec![cc, neg(mul(vec![bb, b.clone(), pow(two_a.clone(), n(-1))]))]));
    let delta = simplify(&add(vec![mul(vec![n(4), a, c]), neg(pow(b.clone(), n(2)))]));
    let lin = add(vec![mul(vec![two_a, sym(x)]), b]);
    let half = S::N(Num::rat(1, 2));
    let rest = if is_zero(&k) {
        ZERO
    } else if num_of(&delta).is_some_and(|v| v.f() < 0.0) {
        let s = simplify(&pow(neg(delta), half));
        let ratio = div(add(vec![lin.clone(), neg(s.clone())]), add(vec![lin, s.clone()]));
        mul(vec![k, pow(s, n(-1)), func("ln", vec![ratio])])
    } else {
        let s = simplify(&pow(delta, half));
        mul(vec![n(2), k, pow(s.clone(), n(-1)), func("atan", vec![simplify(&div(lin, s))])])
    };
    Some(add(vec![log_part, rest]))
}
