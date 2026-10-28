//! Numeric solvers from SMath (roots, polyroots, …); the lazy entry points are in interp.rs.
//!
//! The algorithms work on plain SI magnitudes through closures, so they know nothing about
//! scopes or units: interp.rs binds the unknowns, evaluates the expressions and checks units.

use crate::error::{Result, bail};

/// Why a solver gave up without an answer (interp.rs turns it into a message with names).
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// Iterations ran out, or the residual never got small.
    NoConvergence,
    /// The Jacobian could not be inverted at this point.
    Singular,
}

/// What a solver returns: evaluation errors as `Err`, giving up as `Ok(Err(Fail))`.
pub type Solved<T> = Result<std::result::Result<T, Fail>>;

/// Scale used for step sizes and tolerances around `x` (1 SI unit near zero).
fn scale(x: f64) -> f64 {
    x.abs().max(1.0)
}

/// One root of `f` near `x0`: damped Newton with a numeric derivative, then, if that fails,
/// an outward scan from `x0` for a sign change refined by bisection.
///
/// Evaluation errors at the starting point are reported; errors elsewhere (a square root of
/// a negative number, say) just mark that point as unusable.
pub fn root_near(f: &mut dyn FnMut(f64) -> Result<f64>, x0: f64) -> Solved<f64> {
    let f0 = f(x0)?;
    if f0 == 0.0 {
        return Ok(Ok(x0));
    }
    let mut ok = |x: f64| f(x).ok().filter(|y| y.is_finite());
    if let Some(x) = newton_1d(&mut ok, x0, f0) {
        return Ok(Ok(x));
    }
    Ok(scan_1d(&mut ok, x0, f0).ok_or(Fail::NoConvergence))
}

fn newton_1d(f: &mut dyn FnMut(f64) -> Option<f64>, x0: f64, f0: f64) -> Option<f64> {
    let (mut x, mut fx) = (x0, f0);
    for _ in 0..200 {
        if fx == 0.0 {
            return Some(x);
        }
        let h = 1e-7 * scale(x);
        let (fp, fm) = (f(x + h)?, f(x - h)?);
        let d = (fp - fm) / (2.0 * h);
        if d == 0.0 || !d.is_finite() {
            return accept_1d(f, x, fx, f0);
        }
        let step = fx / d;
        // halve the step until |f| goes down
        let mut t = 1.0;
        let mut next = None;
        for _ in 0..40 {
            let xn = x - t * step;
            if let Some(fy) = f(xn)
                && fy.abs() < fx.abs()
            {
                next = Some((xn, fy));
                break;
            }
            t *= 0.5;
        }
        let Some((xn, fy)) = next else { return accept_1d(f, x, fx, f0) };
        let moved = (xn - x).abs();
        (x, fx) = (xn, fy);
        if moved <= 1e-14 * scale(x) {
            return accept_1d(f, x, fx, f0);
        }
    }
    accept_1d(f, x, fx, f0)
}

/// After the steps stall: a real root if f is tiny or changes sign right around x.
fn accept_1d(f: &mut dyn FnMut(f64) -> Option<f64>, x: f64, fx: f64, f0: f64) -> Option<f64> {
    if fx == 0.0 || fx.abs() <= 1e-12 * f0.abs() {
        return Some(x);
    }
    let h = 1e-9 * scale(x);
    match (f(x - h), f(x + h)) {
        (Some(a), Some(b)) if a.signum() != b.signum() => Some(x),
        _ => None,
    }
}

/// Look right and left of `x0` at doubling distances for a sign change, then bisect.
fn scan_1d(f: &mut dyn FnMut(f64) -> Option<f64>, x0: f64, f0: f64) -> Option<f64> {
    for dir in [1.0, -1.0] {
        let (mut a, mut fa) = (x0, f0);
        let mut h = 1e-3 * scale(x0);
        for _ in 0..80 {
            let b = x0 + dir * h;
            h *= 2.0;
            let Some(fb) = f(b) else { continue };
            if fb == 0.0 {
                return Some(b);
            }
            if fb.signum() != fa.signum() {
                return Some(bisect(f, a, fa, b));
            }
            (a, fa) = (b, fb);
        }
    }
    None
}

fn bisect(f: &mut dyn FnMut(f64) -> Option<f64>, mut a: f64, mut fa: f64, mut b: f64) -> f64 {
    for _ in 0..200 {
        let m = 0.5 * (a + b);
        if m == a || m == b {
            break;
        }
        let Some(fm) = f(m) else { break };
        if fm == 0.0 {
            return m;
        }
        if fm.signum() == fa.signum() {
            (a, fa) = (m, fm);
        } else {
            b = m;
        }
    }
    0.5 * (a + b)
}

/// A root of the square system `f(x) = 0` near `x0`: Newton with a central-difference
/// Jacobian and a backtracking line search on the residual, each equation weighed by its
/// size at the start (the equations may be in different units).
pub fn newton_system(f: &mut dyn FnMut(&[f64]) -> Result<Vec<f64>>, x0: &[f64]) -> Solved<Vec<f64>> {
    let n = x0.len();
    let mut x = x0.to_vec();
    let mut fx = f(&x)?;
    if fx.len() != n {
        bail!("{} equations but {} unknowns: roots needs as many unknowns as equations", fx.len(), n);
    }
    let mut ok = |x: &[f64]| f(x).ok().filter(|v| v.iter().all(|y| y.is_finite()));
    let Some(jac0) = jacobian(&mut ok, &x) else { return Ok(Err(Fail::NoConvergence)) };
    let weights: Vec<f64> = (0..n)
        .map(|i| {
            let s = (0..n).map(|j| jac0[i][j].abs() * scale(x[j])).fold(fx[i].abs(), f64::max);
            if s > 0.0 { 1.0 / s } else { 1.0 }
        })
        .collect();
    let merit = |v: &[f64]| v.iter().zip(&weights).map(|(y, w)| (y * w).powi(2)).sum::<f64>();
    let done = |m: f64, x: Vec<f64>| Ok(if m <= 1e-20 { Ok(x) } else { Err(Fail::NoConvergence) });
    let mut m = merit(&fx);
    let mut jac = Some(jac0);
    for _ in 0..200 {
        if m == 0.0 {
            return Ok(Ok(x));
        }
        let j = match jac.take() {
            Some(j) => j,
            None => match jacobian(&mut ok, &x) {
                Some(j) => j,
                None => return done(m, x),
            },
        };
        let neg: Vec<f64> = fx.iter().map(|y| -y).collect();
        let Some(dx) = lu_solve(j, neg) else {
            return Ok(if m <= 1e-20 { Ok(x) } else { Err(Fail::Singular) });
        };
        let mut t = 1.0;
        let mut next = None;
        for _ in 0..40 {
            let xn: Vec<f64> = x.iter().zip(&dx).map(|(a, d)| a + t * d).collect();
            if let Some(fy) = ok(&xn) {
                let mn = merit(&fy);
                if mn < m {
                    next = Some((xn, fy, mn));
                    break;
                }
            }
            t *= 0.5;
        }
        let Some((xn, fy, mn)) = next else { return done(m, x) };
        let small = xn.iter().zip(&x).all(|(a, b)| (a - b).abs() <= 1e-13 * scale(*a));
        (x, fx, m) = (xn, fy, mn);
        if small || m <= 1e-28 {
            return done(m, x);
        }
    }
    done(m, x)
}

/// Rows = equations, columns = unknowns.
fn jacobian(f: &mut dyn FnMut(&[f64]) -> Option<Vec<f64>>, x: &[f64]) -> Option<Vec<Vec<f64>>> {
    let n = x.len();
    let mut j = vec![vec![0.0; n]; n];
    let mut xp = x.to_vec();
    for c in 0..n {
        let h = 1e-6 * scale(x[c]);
        xp[c] = x[c] + h;
        let fp = f(&xp)?;
        xp[c] = x[c] - h;
        let fm = f(&xp)?;
        xp[c] = x[c];
        for (r, row) in j.iter_mut().enumerate() {
            row[c] = (fp[r] - fm[r]) / (2.0 * h);
        }
    }
    Some(j)
}

/// Gaussian elimination with partial pivoting; `None` when the matrix is singular.
fn lu_solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    let norm = a.iter().flatten().fold(0.0_f64, |m, v| m.max(v.abs()));
    if norm == 0.0 {
        return None;
    }
    for k in 0..n {
        let p = (k..n).max_by(|&i, &j| a[i][k].abs().total_cmp(&a[j][k].abs()))?;
        if a[p][k].abs() <= 1e-12 * norm {
            return None;
        }
        a.swap(k, p);
        b.swap(k, p);
        for i in k + 1..n {
            let m = a[i][k] / a[k][k];
            let (top, below) = a.split_at_mut(i);
            for (x, y) in below[0][k..n].iter_mut().zip(&top[k][k..n]) {
                *x -= m * y;
            }
            b[i] -= m * b[k];
        }
    }
    let mut x = vec![0.0; n];
    for k in (0..n).rev() {
        let s: f64 = (k + 1..n).map(|c| a[k][c] * x[c]).sum();
        x[k] = (b[k] - s) / a[k][k];
    }
    Some(x)
}

/// Real roots and complex (re, im) roots, when some roots are complex.
pub type Mixed = (Vec<f64>, Vec<(f64, f64)>);

/// Roots of `c[0] + c[1]·x + c[2]·x² + …` (ascending powers, the Mathcad/SMath order).
/// `Ok` = all real, sorted ascending (repeated roots repeated); `Err` when some are complex.
pub fn poly_roots(c: &[f64]) -> std::result::Result<Vec<f64>, Mixed> {
    let mut c: Vec<f64> = c.to_vec();
    while c.last() == Some(&0.0) {
        c.pop();
    }
    // zero roots: leading zero coefficients
    let zeros = c.iter().take_while(|v| **v == 0.0).count();
    let mut real = vec![0.0; zeros];
    let c = &c[zeros..];
    let mut complex = Vec::new();
    if c.len() > 1 {
        for z in aberth(c) {
            if z.1.abs() <= 1e-7 * z.0.abs().max(1.0) {
                real.push(polish(c, z.0));
            } else {
                complex.push(z);
            }
        }
    }
    real.sort_by(f64::total_cmp);
    complex.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.total_cmp(&a.1)));
    if complex.is_empty() { Ok(real) } else { Err((real, complex)) }
}

type C = (f64, f64);

fn cmul(a: C, b: C) -> C {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

fn cdiv(a: C, b: C) -> C {
    let d = b.0 * b.0 + b.1 * b.1;
    ((a.0 * b.0 + a.1 * b.1) / d, (a.1 * b.0 - a.0 * b.1) / d)
}

/// p(z) and p'(z) by Horner (ascending coefficients).
fn horner(c: &[f64], z: C) -> (C, C) {
    let mut p = (0.0, 0.0);
    let mut d = (0.0, 0.0);
    for &a in c.iter().rev() {
        d = cmul(d, z);
        d = (d.0 + p.0, d.1 + p.1);
        p = cmul(p, z);
        p = (p.0 + a, p.1);
    }
    (p, d)
}

/// Aberth–Ehrlich simultaneous iteration; `c` has non-zero constant and leading terms.
fn aberth(c: &[f64]) -> Vec<C> {
    let n = c.len() - 1;
    let lead = c[n];
    // start on a circle whose radius bounds the roots (Cauchy), turned off the real axis
    let r = (1.0 + c[..n].iter().fold(0.0_f64, |m, a| m.max((a / lead).abs()))).min(1e150);
    let mut z: Vec<C> = (0..n)
        .map(|k| {
            let t = std::f64::consts::TAU * k as f64 / n as f64 + 0.4;
            (r * t.cos(), r * t.sin())
        })
        .collect();
    for _ in 0..2000 {
        let mut biggest: f64 = 0.0;
        for i in 0..n {
            let (p, d) = horner(c, z[i]);
            if p == (0.0, 0.0) {
                continue;
            }
            let ratio = cdiv(p, d);
            let mut sum = (0.0, 0.0);
            for (j, zj) in z.iter().enumerate() {
                if j != i {
                    let inv = cdiv((1.0, 0.0), (z[i].0 - zj.0, z[i].1 - zj.1));
                    sum = (sum.0 + inv.0, sum.1 + inv.1);
                }
            }
            let denom = cmul(ratio, sum);
            let w = cdiv(ratio, (1.0 - denom.0, -denom.1));
            if !(w.0.is_finite() && w.1.is_finite()) {
                continue;
            }
            z[i] = (z[i].0 - w.0, z[i].1 - w.1);
            biggest = biggest.max(w.0.hypot(w.1) / z[i].0.hypot(z[i].1).max(1e-300));
        }
        if biggest < 1e-15 {
            break;
        }
    }
    z
}

/// A few real Newton steps, kept only while |p| keeps going down.
fn polish(c: &[f64], mut x: f64) -> f64 {
    let mut px = horner(c, (x, 0.0)).0.0.abs();
    for _ in 0..20 {
        let (p, d) = horner(c, (x, 0.0));
        if p.0 == 0.0 || d.0 == 0.0 {
            break;
        }
        let xn = x - p.0 / d.0;
        let pn = horner(c, (xn, 0.0)).0.0.abs();
        if pn >= px || pn.is_nan() {
            break;
        }
        (x, px) = (xn, pn);
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-9 * b.abs().max(1.0)
    }

    #[test]
    fn root_near_finds_newton_and_scanned_roots() {
        let r = root_near(&mut |x| Ok(x * x - 2.0), 1.0).unwrap().unwrap();
        assert!(close(r, 2f64.sqrt()));
        let r = root_near(&mut |x| Ok(x.cos() - x), 0.0).unwrap().unwrap();
        assert!(close(r, 0.739_085_133_215_160_6));
        // a double root: no sign change, but f reaches ~0
        let r = root_near(&mut |x| Ok((x - 3.0).powi(2)), 0.0).unwrap().unwrap();
        assert!((r - 3.0).abs() < 1e-6, "{r}");
        // flat at the start
        let r = root_near(&mut |x| Ok(x.powi(3) - 8.0), 0.0).unwrap().unwrap();
        assert!(close(r, 2.0), "{r}");
        // only defined for x > 0
        let mut ln = |x: f64| if x > 0.0 { Ok(x.ln() - 1.0) } else { Err(crate::EvalError::new("ln")) };
        let r = root_near(&mut ln, 0.5).unwrap().unwrap();
        assert!(close(r, std::f64::consts::E), "{r}");
        assert_eq!(root_near(&mut |x| Ok(x * x + 1.0), 0.0).unwrap(), Err(Fail::NoConvergence));
    }

    #[test]
    fn newton_system_solves_and_reports_singular() {
        // x² + y² = 4, x = y → (√2, √2)
        let mut f = |v: &[f64]| Ok(vec![v[0] * v[0] + v[1] * v[1] - 4.0, v[0] - v[1]]);
        let r = newton_system(&mut f, &[1.0, 0.5]).unwrap().unwrap();
        assert!(close(r[0], 2f64.sqrt()) && close(r[1], 2f64.sqrt()));
        // linear, scales a million apart
        let mut g = |v: &[f64]| Ok(vec![1e6 * v[0] + v[1] - 3e6, v[0] - 2e-6 * v[1]]);
        let r = newton_system(&mut g, &[0.0, 0.0]).unwrap().unwrap();
        assert!(close(r[0], 2.0) && close(r[1], 1e6), "{r:?}");
        let mut s = |v: &[f64]| Ok(vec![v[0] + v[1] - 1.0, 2.0 * v[0] + 2.0 * v[1] - 5.0]);
        assert_eq!(newton_system(&mut s, &[0.0, 0.0]).unwrap(), Err(Fail::Singular));
        let mut none = |v: &[f64]| Ok(vec![v[0] * v[0] + 1.0, v[1]]);
        assert!(newton_system(&mut none, &[1.0, 1.0]).unwrap().is_err());
        let mut wrong = |v: &[f64]| Ok(vec![v[0]]);
        assert!(newton_system(&mut wrong, &[1.0, 1.0]).is_err());
    }

    #[test]
    fn poly_roots_ascending_order() {
        // 2 − 3x + x² = (x − 1)(x − 2)
        let r = poly_roots(&[2.0, -3.0, 1.0]).unwrap();
        assert!(r.len() == 2 && close(r[0], 1.0) && close(r[1], 2.0), "{r:?}");
        // x(x − 1)(x − 2)(x − 3), with a trailing zero coefficient
        let r = poly_roots(&[0.0, -6.0, 11.0, -6.0, 1.0, 0.0]).unwrap();
        assert_eq!(r.len(), 4);
        for (a, b) in r.iter().zip([0.0, 1.0, 2.0, 3.0]) {
            assert!(close(*a, b), "{r:?}");
        }
        // double root (x − 1)²
        let r = poly_roots(&[1.0, -2.0, 1.0]).unwrap();
        assert!(r.len() == 2 && r.iter().all(|x| (x - 1.0).abs() < 1e-6), "{r:?}");
        // wide spread: (x − 0.001)(x − 1000)
        let r = poly_roots(&[1.0, -1000.001, 1.0]).unwrap();
        assert!(close(r[0], 0.001) && close(r[1], 1000.0), "{r:?}");
        // x³ − 1: one real, two complex
        let (real, cx) = poly_roots(&[-1.0, 0.0, 0.0, 1.0]).unwrap_err();
        assert!(real.len() == 1 && close(real[0], 1.0));
        assert_eq!(cx.len(), 2);
        assert!(close(cx[0].0, -0.5) && close(cx[0].1, 3f64.sqrt() / 2.0), "{cx:?}");
        assert_eq!(poly_roots(&[5.0]), Ok(vec![]));
    }
}
