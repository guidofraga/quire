//! Statistics, regression, spline interpolation and rounding to a multiple: built-ins
//! that only need their arguments' values. Names and argument orders follow Mathcad and
//! SMath (`slope(vx, vy)`, `cspline(vx, vy)` with `interp(vs, vx, vy, x)`, `Var` for the
//! sample variance next to `var` for the population one).

use quire_units::{Dim, Rational};

use crate::builtins::{arity, column, flatten};
use crate::error::{Result, bail};
use crate::format::describe_dim;
use crate::numeric;
use crate::ops::same_dim;
use crate::value::{Matrix, Quantity, Value};

/// `None` when `name` is not one of these.
pub fn call(name: &str, args: &[Value]) -> Option<Result<Value>> {
    let r = match name {
        "median" => median(args),
        "var" | "var.p" => spread(name, args, false, false),
        "Var" | "var.s" => spread(name, args, true, false),
        "stdev" | "stdev.p" => spread(name, args, false, true),
        "Stdev" | "stdev.s" => spread(name, args, true, true),
        "percentile" => percentile(args),
        "slope" => slope(args).map(|(_, m)| Value::Num(m)),
        "intercept" => slope(args).map(|(b, _)| Value::Num(b)),
        "line" => slope(args).map(|(b, m)| Value::Matrix(Matrix::column(vec![Value::Num(b), Value::Num(m)]))),
        "corr" => corr(args),
        "polyfit" => polyfit(args),
        "cspline" => spline(name, args, Ends::NotAKnot),
        "pspline" => spline(name, args, Ends::Parabolic),
        "lspline" => spline(name, args, Ends::Natural),
        "interp" => interp(args),
        "Ceil" => to_multiple(name, args, f64::ceil),
        "Floor" => to_multiple(name, args, f64::floor),
        "Round" => to_multiple(name, args, f64::round),
        "Trunc" => to_multiple(name, args, f64::trunc),
        _ => return None,
    };
    Some(r)
}

/// Every number in the arguments (matrices flattened), all in the same units.
fn samples(name: &str, args: &[Value]) -> Result<(Vec<f64>, Dim)> {
    let mut dim = None;
    let mut out = Vec::new();
    for v in flatten(args) {
        let q = v.as_num(&format!("a value for {name}"))?;
        match dim {
            None => dim = Some(q.dim),
            Some(d) => same_dim(d, q.dim, &format!("take {name} of values that mix"))?,
        }
        out.push(q.v);
    }
    if out.is_empty() {
        bail!("{name} needs at least one value");
    }
    Ok((out, dim.unwrap_or(Dim::NONE)))
}

fn median(args: &[Value]) -> Result<Value> {
    let (mut v, dim) = samples("median", args)?;
    v.sort_by(f64::total_cmp);
    let n = v.len();
    let m = if n % 2 == 1 { v[n / 2] } else { 0.5 * (v[n / 2 - 1] + v[n / 2]) };
    Ok(Value::Num(Quantity::new(m, dim)))
}

/// Variance or standard deviation; `sample` divides by n − 1 instead of n.
fn spread(name: &str, args: &[Value], sample: bool, root: bool) -> Result<Value> {
    let (v, dim) = samples(name, args)?;
    let n = v.len() as f64;
    if sample && v.len() < 2 {
        bail!("{name} (of a sample) needs at least 2 values");
    }
    let mean = v.iter().sum::<f64>() / n;
    let ss: f64 = v.iter().map(|x| (x - mean).powi(2)).sum();
    let var = ss / if sample { n - 1.0 } else { n };
    Ok(Value::Num(if root {
        Quantity::new(var.sqrt(), dim)
    } else {
        Quantity::new(var, dim.pow(Rational::int(2)))
    }))
}

/// `percentile(v, p)` with p from 0 to 1, interpolating between ranks (Excel's PERCENTILE.INC).
fn percentile(args: &[Value]) -> Result<Value> {
    arity("percentile", args, |n| n == 2, "2 arguments: percentile(v, p) with p from 0 to 1")?;
    let (mut v, dim) = samples("percentile", &args[..1])?;
    let p = args[1].as_scalar("the fraction p")?;
    if !(0.0..=1.0).contains(&p) {
        bail!("percentile needs p from 0 to 1 (0.9 for the 90th percentile), not {p}");
    }
    v.sort_by(f64::total_cmp);
    let rank = p * (v.len() - 1) as f64;
    let i = (rank.floor() as usize).min(v.len() - 1);
    let j = (i + 1).min(v.len() - 1);
    Ok(Value::Num(Quantity::new(v[i] + (rank - i as f64) * (v[j] - v[i]), dim)))
}

/// A data vector (row or column) for regression: its numbers and their common units.
fn data(name: &str, what: &str, v: &Value) -> Result<(Vec<f64>, Dim)> {
    let m = match v {
        Value::Matrix(m) if m.is_vector() => m,
        Value::Matrix(m) => bail!("{name} needs {what} as a vector, not a {}×{} matrix", m.rows, m.cols),
        other => bail!("{name} needs {what} as a vector, not {}", other.kind()),
    };
    let mut dim = None;
    let mut out = Vec::with_capacity(m.data.len());
    for x in &m.data {
        let q = x.as_num(&format!("an element of {what}"))?;
        match dim {
            None => dim = Some(q.dim),
            Some(d) if d != q.dim => {
                bail!("{what} mixes {} and {}: units don't match", describe_dim(d), describe_dim(q.dim))
            }
            _ => {}
        }
        out.push(q.v);
    }
    Ok((out, dim.unwrap_or(Dim::NONE)))
}

type Pairs = ((Vec<f64>, Dim), (Vec<f64>, Dim));

/// `(vx, vy)` of the same length, with at least `min` points.
fn pairs(name: &str, args: &[Value], min: usize) -> Result<Pairs> {
    let x = data(name, "vx", &args[0])?;
    let y = data(name, "vy", &args[1])?;
    if x.0.len() != y.0.len() {
        bail!("{name} needs vx and vy of the same length, not {} and {}", x.0.len(), y.0.len());
    }
    if x.0.len() < min {
        bail!("{name} needs at least {min} points");
    }
    Ok((x, y))
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

/// Sums of squares about the means: (Sxx, Sxy, Syy).
fn moments(x: &[f64], y: &[f64]) -> (f64, f64, f64) {
    let (mx, my) = (mean(x), mean(y));
    x.iter().zip(y).fold((0.0, 0.0, 0.0), |(sxx, sxy, syy), (a, b)| {
        let (dx, dy) = (a - mx, b - my);
        (sxx + dx * dx, sxy + dx * dy, syy + dy * dy)
    })
}

/// Least-squares line through (vx, vy): (intercept, slope).
fn slope(args: &[Value]) -> Result<(Quantity, Quantity)> {
    arity("slope", args, |n| n == 2, "2 arguments: (vx, vy)")?;
    let ((x, xd), (y, yd)) = pairs("slope", args, 2)?;
    let (sxx, sxy, _) = moments(&x, &y);
    if sxx == 0.0 {
        bail!("a line needs at least two different x values");
    }
    let m = sxy / sxx;
    let b = mean(&y) - m * mean(&x);
    Ok((Quantity::new(b, yd), Quantity::new(m, yd / xd)))
}

/// Pearson's correlation coefficient.
fn corr(args: &[Value]) -> Result<Value> {
    arity("corr", args, |n| n == 2, "2 arguments: (vx, vy)")?;
    let ((x, _), (y, _)) = pairs("corr", args, 2)?;
    let (sxx, sxy, syy) = moments(&x, &y);
    if sxx == 0.0 || syy == 0.0 {
        bail!("corr is undefined when all the x or all the y values are equal");
    }
    Ok(Value::num(sxy / (sxx * syy).sqrt()))
}

/// `polyfit(vx, vy, k)`: least-squares coefficients [a0; a1; …; ak] of a0 + a1·x + … + ak·x^k.
fn polyfit(args: &[Value]) -> Result<Value> {
    arity("polyfit", args, |n| n == 3, "3 arguments: polyfit(vx, vy, degree)")?;
    let k = args[2].as_int("the degree")?;
    if !(1..=20).contains(&k) {
        bail!("polyfit needs a degree from 1 to 20, not {k}");
    }
    let k = k as usize;
    let ((x, xd), (y, yd)) = pairs("polyfit", args, k + 1)?;
    // powers of x/s rather than x keep the columns comparable (x in mm, or in Pa)
    let s = x.iter().fold(0.0, |m: f64, v| m.max(v.abs()));
    if s == 0.0 {
        bail!("polyfit needs x values other than zero");
    }
    let a: Vec<f64> = x.iter().flat_map(|v| (0..=k).map(move |j| (v / s).powi(j as i32))).collect();
    let Some(c) = numeric::least_squares(a, y, k + 1) else {
        bail!("polyfit needs at least {} different x values for degree {k}", k + 1)
    };
    let data = c
        .iter()
        .enumerate()
        .map(|(j, c)| Value::Num(Quantity::new(c / s.powi(j as i32), yd / xd.pow(Rational::int(j as i32)))))
        .collect();
    Ok(Value::Matrix(Matrix::column(data)))
}

/// What a spline does at its first and last points (Mathcad's three kinds).
#[derive(Clone, Copy)]
enum Ends {
    /// No curvature at the ends (`lspline`: straight lines beyond the data).
    Natural,
    /// The end intervals are parabolas (`pspline`).
    Parabolic,
    /// The first two and last two intervals are each one cubic (`cspline`).
    NotAKnot,
}

/// Strictly increasing knots and their values.
fn knots(name: &str, vx: &Value, vy: &Value) -> Result<Pairs> {
    let ((x, xd), (y, yd)) = pairs(name, &[vx.clone(), vy.clone()], 2)?;
    if x.windows(2).any(|w| w[1] <= w[0]) {
        bail!("{name} needs the x values in increasing order, without repeats");
    }
    Ok(((x, xd), (y, yd)))
}

/// The second derivatives of the interpolating cubic spline at the knots.
fn spline(name: &str, args: &[Value], ends: Ends) -> Result<Value> {
    arity(name, args, |n| n == 2, "2 arguments: (vx, vy)")?;
    let ((x, xd), (y, yd)) = knots(name, &args[0], &args[1])?;
    let m = second_derivatives(&x, &y, ends);
    Ok(column(m, yd / xd.pow(Rational::int(2))))
}

fn second_derivatives(x: &[f64], y: &[f64], ends: Ends) -> Vec<f64> {
    let n = x.len();
    if n == 2 {
        return vec![0.0; 2];
    }
    let h: Vec<f64> = x.windows(2).map(|w| w[1] - w[0]).collect();
    let d: Vec<f64> = (0..n - 1).map(|i| (y[i + 1] - y[i]) / h[i]).collect();
    if n == 3 && matches!(ends, Ends::NotAKnot) {
        // one cubic through three points is the parabola through them
        let c = 2.0 * (d[1] - d[0]) / (h[0] + h[1]);
        return vec![c; 3];
    }
    // unknowns M1..M(n-2); each end condition is folded into the first or last row
    let k = n - 2;
    let mut sub: Vec<f64> = (1..=k).map(|i| h[i - 1]).collect();
    let mut diag: Vec<f64> = (1..=k).map(|i| 2.0 * (h[i - 1] + h[i])).collect();
    let mut sup: Vec<f64> = (1..=k).map(|i| h[i]).collect();
    let r: Vec<f64> = (1..=k).map(|i| 6.0 * (d[i] - d[i - 1])).collect();
    sub[0] = 0.0;
    sup[k - 1] = 0.0;
    match ends {
        Ends::Natural => {}
        Ends::Parabolic => {
            diag[0] += h[0];
            diag[k - 1] += h[n - 2];
        }
        Ends::NotAKnot => {
            // M0 = M1 + h0/h1·(M1 − M2), and the same at the far end
            let (h0, h1) = (h[0], h[1]);
            diag[0] += h0 + h0 * h0 / h1;
            sup[0] -= h0 * h0 / h1;
            let (ha, hb) = (h[n - 2], h[n - 3]);
            diag[k - 1] += ha + ha * ha / hb;
            sub[k - 1] -= ha * ha / hb;
        }
    }
    let inner = numeric::tridiagonal(&sub, &diag, &sup, &r);
    let (first, last) = match ends {
        Ends::Natural => (0.0, 0.0),
        Ends::Parabolic => (inner[0], inner[k - 1]),
        Ends::NotAKnot => (
            inner[0] + h[0] / h[1] * (inner[0] - inner[1]),
            inner[k - 1] + h[n - 2] / h[n - 3] * (inner[k - 1] - inner[k - 2]),
        ),
    };
    let mut m = Vec::with_capacity(n);
    m.push(first);
    m.extend(inner);
    m.push(last);
    m
}

/// `interp(vs, vx, vy, x)`: the spline from `cspline`/`pspline`/`lspline` at x (or at each
/// element of a vector x). Past the ends the end cubics carry on.
fn interp(args: &[Value]) -> Result<Value> {
    arity("interp", args, |n| n == 4, "4 arguments: interp(vs, vx, vy, x) with vs := cspline(vx, vy)")?;
    let ((x, xd), (y, yd)) = knots("interp", &args[1], &args[2])?;
    let (m, md) = data("interp", "vs", &args[0])?;
    if m.len() != x.len() || (md != yd / xd.pow(Rational::int(2)) && m.iter().any(|v| *v != 0.0)) {
        bail!(
            "interp's first argument must come from cspline(vx, vy) (or pspline, lspline) for the same data"
        );
    }
    let at = |q: &Value| -> Result<Value> {
        let t = q.as_num("the point to interpolate at")?;
        same_dim(xd, t.dim, "interpolate between")?;
        let i = x.partition_point(|&v| v <= t.v).clamp(1, x.len() - 1);
        let h = x[i] - x[i - 1];
        let a = (x[i] - t.v) / h;
        let b = 1.0 - a;
        let v = a * y[i - 1] + b * y[i] + ((a * a * a - a) * m[i - 1] + (b * b * b - b) * m[i]) * h * h / 6.0;
        Ok(Value::Num(Quantity::new(v, yd)))
    };
    match &args[3] {
        Value::Matrix(pts) => {
            let data = pts.data.iter().map(at).collect::<Result<Vec<_>>>()?;
            Ok(Value::Matrix(Matrix::new(pts.rows, pts.cols, data)))
        }
        q => at(q),
    }
}

/// Mathcad's `Ceil(x, y)`, `Floor`, `Round`, `Trunc`: x to a multiple of y, in x's units.
fn to_multiple(name: &str, args: &[Value], f: fn(f64) -> f64) -> Result<Value> {
    arity(name, args, |n| n == 2, "2 arguments: (x, multiple), e.g. Ceil(1.23 m, 5 cm)")?;
    let x = args[0].as_num("the value to round")?;
    let y = args[1].as_num("the multiple")?;
    same_dim(x.dim, y.dim, &format!("take {name} of"))?;
    if y.v == 0.0 {
        bail!("{name} needs a multiple other than zero");
    }
    let mut q = x.v / y.v;
    // 0.3/0.1 is 2.9999999999999996: a quotient this close to whole is whole
    if (q - q.round()).abs() <= 1e-9 * q.abs().max(1.0) {
        q = q.round();
    }
    Ok(Value::Num(Quantity::new(f(q) * y.v, x.dim)))
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::format::{DisplaySettings, DisplaySpec};
    use crate::worksheet::{MathInput, Worksheet};

    /// What each line shows (its result, or its error), with `decimals` places.
    pub(crate) fn shown_with(decimals: u32, lines: &[&str]) -> Vec<String> {
        let regions: Vec<MathInput> = lines
            .iter()
            .enumerate()
            .map(|(i, l)| MathInput {
                id: i.to_string(),
                expr: l.to_string(),
                show: true,
                display: DisplaySpec { decimals: Some(decimals), ..DisplaySpec::default() },
                table: None,
                plot: None,
                symbolic: false,
            })
            .collect();
        Worksheet::new(DisplaySettings::default())
            .run(&regions)
            .into_iter()
            .map(|o| o.shown.or(o.error).unwrap_or_default())
            .collect()
    }

    fn shown(lines: &[&str]) -> Vec<String> {
        shown_with(6, lines)
    }

    #[test]
    fn statistics_of_known_samples() {
        let r = shown(&[
            "v := [2; 4; 4; 4; 5; 5; 7; 9]",
            "median(v)",
            "median([3, 1, 2])",
            "var(v)",
            "stdev(v)",
            "Var(v)",
            "Stdev(v)",
            "stdev.p(v) - stdev(v) + var.s(v) - Var(v)",
            "percentile(v, 0.5)",
            "percentile([10, 20, 30, 40, 50], 0.9)",
            "stdev([1 'm, 2 'm, 3 'm])",
            "var([1 'm, 2 'm, 3 'm])",
            "mean(1 'kN, 3 'kN)",
            "median([1 'm, 2 's])",
            "Var(3)",
            "percentile(v, 90)",
        ]);
        assert_eq!(r[1], "4.5");
        assert_eq!(r[2], "2");
        // population: Σ(x − 5)² = 32 over 8; sample: over 7
        assert_eq!(r[3], "4");
        assert_eq!(r[4], "2");
        assert_eq!(r[5], "4.571429");
        assert_eq!(r[6], "2.13809");
        assert_eq!(r[7], "0");
        assert_eq!(r[8], "4.5");
        assert_eq!(r[9], "46");
        assert_eq!(r[10], "0.816497 'm");
        assert_eq!(r[11], "0.666667 'm^2");
        assert_eq!(r[12], "2000 'N");
        assert_eq!(
            r[13],
            "cannot take median of values that mix a length (m) and a time (s): units don't match"
        );
        assert_eq!(r[14], "Var (of a sample) needs at least 2 values");
        assert!(r[15].starts_with("percentile needs p from 0 to 1"), "{}", r[15]);
    }

    #[test]
    fn regression_on_exact_data() {
        let r = shown(&[
            "x := [1; 2; 3; 4] 'm",
            "F := [5; 7; 9; 11] 'kN",
            "slope(x, F)",
            "intercept(x, F)",
            "line(x, F)",
            "corr(x, F)",
            "corr([1, 2, 3], [3, 1, 2])",
            "p := polyfit([0; 1; 2; 3], [1; 2; 9; 28], 3)",
            "[p[1]; p[4]; abs(p[2]) + abs(p[3]) < 1e-12]",
            "c := polyfit(x, [3; 6; 11; 18] 'm^2, 2)",
            "c[3]",
            "slope([1, 2], [1, 2, 3])",
            "slope([1, 1], [1, 2])",
            "polyfit([1, 2], [1, 2], 2)",
            "slope([1 'm, 2 's], [1, 2])",
            "slope(x)",
        ]);
        assert_eq!(r[2], "2000 'N/'m"); // 2 kN/m
        assert_eq!(r[3], "3000 'N");
        assert_eq!(r[4], "[3000 'N; 2000 'N/'m]");
        assert_eq!(r[5], "1");
        assert_eq!(r[6], "-0.5");
        // y = 1 + x³
        assert_eq!(r[8], "[1; 1; 1]");
        // y = 2 m² + x² (x in m): a0 in m², a1 in m, a2 plain
        assert_eq!(r[9], "[2 'm^2; 0 'm; 1]");
        assert_eq!(r[10], "1");
        assert_eq!(r[11], "slope needs vx and vy of the same length, not 2 and 3");
        assert_eq!(r[12], "a line needs at least two different x values");
        assert_eq!(r[13], "polyfit needs at least 3 points");
        assert_eq!(r[14], "vx mixes a length (m) and a time (s): units don't match");
        assert_eq!(r[15], "slope takes 2 arguments: (vx, vy), but got 1");
    }

    #[test]
    fn splines_pass_through_their_points() {
        let r = shown(&[
            "vx := [0; 1; 2; 3; 4]",
            "vy := [0; 1; 8; 27; 64]",
            "vs := cspline(vx, vy)",
            "interp(vs, vx, vy, 2.5)",
            "interp(vs, vx, vy, 3)",
            "interp(vs, vx, vy, [0.5; 5])",
            "interp(lspline(vx, vy), vx, vy, 1)",
            "lspline([0; 1; 2], [0; 1; 0])",
            "pspline([0; 1; 2; 3], [0; 1; 4; 9])",
            "xs := [0; 1; 2] 'm",
            "ys := [0; 2; 8] 'mm",
            "cspline(xs, ys)",
            "interp(cspline(xs, ys), xs, ys, 1.5 'm)",
            "interp(cspline(xs, ys), xs, ys, 3 's)",
            "cspline([0; 2; 1], [0; 1; 2])",
            "interp([1; 2], xs, ys, 1 'm)",
        ]);
        // not-a-knot ends reproduce a cubic exactly, inside and beyond the data
        assert_eq!(r[3], "15.625");
        assert_eq!(r[4], "27");
        assert_eq!(r[5], "[0.125; 125]");
        assert_eq!(r[6], "1");
        // natural ends through (0,0), (1,1), (2,0): M1 = 6·(−2)/4
        assert_eq!(r[7], "[0; -3; 0]");
        // parabolic ends reproduce a parabola: y'' = 2 everywhere
        assert_eq!(r[8], "[2; 2; 2; 2]");
        // three points with cubic ends: the parabola y = 2x² mm (x in m)
        assert_eq!(r[11], "[0.004/'m; 0.004/'m; 0.004/'m]");
        assert_eq!(r[12], "0.0045 'm");
        assert_eq!(r[13], "cannot interpolate between a length (m) and a time (s): units don't match");
        assert_eq!(r[14], "cspline needs the x values in increasing order, without repeats");
        assert!(r[15].starts_with("interp's first argument must come from cspline"), "{}", r[15]);
    }

    #[test]
    fn rounding_to_a_multiple() {
        let r = shown(&[
            "Ceil(1.23 'm, 5 'cm)",
            "Floor(1.23 'm, 5 'cm)",
            "Round(1.23 'm, 5 'cm)",
            "Trunc(-1.23, 0.5)",
            "Floor(0.3, 0.1)",
            "Ceil(12.1 'kN, 1 'm)",
            "Ceil(1, 0)",
        ]);
        assert_eq!(r[0], "1.25 'm");
        assert_eq!(r[1], "1.2 'm");
        assert_eq!(r[2], "1.25 'm");
        assert_eq!(r[3], "-1");
        assert_eq!(r[4], "0.3");
        assert_eq!(r[5], "cannot take Ceil of a force (N) and a length (m): units don't match");
        assert_eq!(r[6], "Ceil needs a multiple other than zero");
    }
}
