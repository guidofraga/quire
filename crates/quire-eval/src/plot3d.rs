//! 3D plots (SMath's 3D graph): surfaces z(x, y) over two ranges, curves x(t), y(t), z(t)
//! over one, and data — a matrix of heights is a surface over its indices, three vectors a
//! line through points. Like 2D plots, they are sampled where they sit in reading order.

use quire_ast::{Expr, parse};
use quire_units::Dim;

use crate::error::{Result, bail};
use crate::interp::{Interp, Scope};
use crate::plot::in_unit;
use crate::value::{Quantity, Value};

/// Grid lines across each range of a surface.
pub const GRID: usize = 40;
/// Points along a curve.
pub const CURVE: usize = 240;

#[derive(Debug, Clone, Default)]
pub struct Series3Input {
    /// The height (`x^2 - y^2`, a matrix name) or, for a curve, z(t).
    pub z: String,
    /// A surface's variables (default `x`, `y`), or a curve's x(t), y(t), or data vectors.
    pub x: Option<String>,
    pub y: Option<String>,
    /// `a..b` for a surface's x and y.
    pub xrange: Option<String>,
    pub yrange: Option<String>,
    /// A curve's parameter (default `t`) and its `a..b`.
    pub t: Option<String>,
    pub range: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Plot3Input {
    pub series: Vec<Series3Input>,
    /// Axis units (`m`, `kN`); otherwise SI.
    pub units: [Option<String>; 3],
}

/// What a series came out as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Shape {
    /// `nx` × `ny` grid: xs has nx values, ys ny, zs ny·nx row by row (y outer).
    #[default]
    Surface,
    /// Points joined in order: xs, ys, zs the same length.
    Curve,
}

#[derive(Debug, Clone, Default)]
pub struct Series3Outcome {
    pub shape: Shape,
    /// In the axis units; `NaN` where a point could not be computed.
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub zs: Vec<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Plot3Outcome {
    /// The axis units (`m`, empty for plain numbers).
    pub units: [String; 3],
    pub series: Vec<Series3Outcome>,
}

/// Samples in SI before the axis units are applied.
struct Raw {
    shape: Shape,
    xs: Vec<Quantity>,
    ys: Vec<Quantity>,
    zs: Vec<Quantity>,
}

fn part(text: &str, what: &str) -> Result<Expr> {
    if text.trim().is_empty() {
        bail!("{what} is empty");
    }
    Ok(parse(text)?)
}

fn text(o: &Option<String>) -> Option<&str> {
    o.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// `a..b` evaluated: (start, end) in one unit.
fn range(interp: &mut Interp, scope: &mut Scope, src: &str, what: &str) -> Result<(Quantity, Quantity)> {
    let Expr::Range(a, b) = part(src, what)? else { bail!("write {what} as start..end, like -2..2") };
    let a = interp.eval(scope, &a)?.as_num(what)?;
    let b = interp.eval(scope, &b)?.as_num(what)?;
    if a.dim != b.dim {
        bail!("the two ends of {what} have different units");
    }
    if !(a.v.is_finite() && b.v.is_finite()) || a.v == b.v {
        bail!("{what} needs two different, finite ends");
    }
    Ok((a, b))
}

fn steps(a: Quantity, b: Quantity, n: usize) -> Vec<Quantity> {
    (0..=n).map(|k| Quantity::new(a.v + (b.v - a.v) * k as f64 / n as f64, a.dim)).collect()
}

/// Evaluate with names bound; an error at one point leaves a gap (NaN) there.
fn at(interp: &mut Interp, scope: &mut Scope, e: &Expr, binds: &[(&str, Quantity)]) -> Result<Quantity> {
    let prev: Vec<_> = binds.iter().map(|(n, v)| scope.bind(n, Value::Num(*v))).collect();
    let r = interp.eval(scope, e).and_then(|v| v.as_num("a plotted value"));
    for ((n, _), p) in binds.iter().zip(prev).rev() {
        scope.restore(n, p);
    }
    r
}

/// The points' common dimension; gaps take it too.
fn one_dim(values: &mut [Quantity], what: &str) -> Result<()> {
    let dim = values.iter().find(|q| !q.v.is_nan()).map(|q| q.dim).unwrap_or(Dim::NONE);
    for q in values.iter_mut() {
        if q.v.is_nan() {
            q.dim = dim;
        } else if q.dim != dim {
            bail!("{what} change units across the plot");
        }
    }
    Ok(())
}

/// Sample every point, keeping the first error in case nothing could be computed.
fn sample_all(
    interp: &mut Interp,
    scope: &mut Scope,
    e: &Expr,
    points: impl Iterator<Item = Vec<(String, Quantity)>>,
) -> Result<Vec<Quantity>> {
    let mut out = Vec::new();
    let mut first = None;
    for binds in points {
        interp.tick()?;
        let b: Vec<(&str, Quantity)> = binds.iter().map(|(n, q)| (n.as_str(), *q)).collect();
        match at(interp, scope, e, &b) {
            Ok(q) => out.push(q),
            Err(err) => {
                first.get_or_insert(err);
                out.push(Quantity::new(f64::NAN, Dim::NONE));
            }
        }
    }
    if out.iter().all(|q| q.v.is_nan())
        && let Some(e) = first
    {
        return Err(e);
    }
    Ok(out)
}

fn quantities(v: Value, what: &str) -> Result<(Vec<Quantity>, usize, usize)> {
    match v {
        Value::Num(q) => Ok((vec![q], 1, 1)),
        Value::Matrix(m) => {
            let qs = m.data.iter().map(|v| v.as_num(what)).collect::<Result<Vec<_>>>()?;
            Ok((qs, m.rows, m.cols))
        }
        Value::Str(_) => bail!("{what} should be numbers, not text"),
    }
}

fn sample(s: &Series3Input, interp: &mut Interp, scope: &mut Scope) -> Result<Raw> {
    let z = part(&s.z, "the plotted expression")?;
    if let (Some(xr), Some(yr)) = (text(&s.xrange), text(&s.yrange)) {
        // a surface z(x, y)
        let (xv, yv) = (text(&s.x).unwrap_or("x").to_string(), text(&s.y).unwrap_or("y").to_string());
        let (xa, xb) = range(interp, scope, xr, "the x range")?;
        let (ya, yb) = range(interp, scope, yr, "the y range")?;
        let xs = steps(xa, xb, GRID);
        let ys = steps(ya, yb, GRID);
        let grid: Vec<Vec<(String, Quantity)>> =
            ys.iter().flat_map(|y| xs.iter().map(|x| vec![(xv.clone(), *x), (yv.clone(), *y)])).collect();
        let mut zs = sample_all(interp, scope, &z, grid.into_iter())?;
        one_dim(&mut zs, "the heights")?;
        return Ok(Raw { shape: Shape::Surface, xs, ys, zs });
    }
    if let Some(tr) = text(&s.range) {
        // a curve x(t), y(t), z(t)
        let tv = text(&s.t).unwrap_or("t").to_string();
        let (Some(xe), Some(ye)) = (text(&s.x), text(&s.y)) else {
            bail!("a 3D curve needs x(t), y(t) and z(t)")
        };
        let (xe, ye) = (part(xe, "x(t)")?, part(ye, "y(t)")?);
        let (ta, tb) = range(interp, scope, tr, "the range")?;
        let ts: Vec<Vec<(String, Quantity)>> =
            steps(ta, tb, CURVE).into_iter().map(|t| vec![(tv.clone(), t)]).collect();
        let mut xs = sample_all(interp, scope, &xe, ts.clone().into_iter())?;
        let mut ys = sample_all(interp, scope, &ye, ts.clone().into_iter())?;
        let mut zs = sample_all(interp, scope, &z, ts.into_iter())?;
        one_dim(&mut xs, "the x values")?;
        one_dim(&mut ys, "the y values")?;
        one_dim(&mut zs, "the z values")?;
        return Ok(Raw { shape: Shape::Curve, xs, ys, zs });
    }
    // data: a matrix of heights, or three vectors of points
    let (zs, rows, cols) = quantities(interp.eval(scope, &z)?, "the plotted values")?;
    match (text(&s.x), text(&s.y)) {
        (Some(x), Some(y)) => {
            let (xs, ..) = quantities(interp.eval(scope, &part(x, "the x values")?)?, "the x values")?;
            let (ys, ..) = quantities(interp.eval(scope, &part(y, "the y values")?)?, "the y values")?;
            if xs.len() != zs.len() || ys.len() != zs.len() {
                bail!("{} x, {} y and {} z values: they should match", xs.len(), ys.len(), zs.len());
            }
            let (mut xs, mut ys, mut zs) = (xs, ys, zs);
            one_dim(&mut xs, "the x values")?;
            one_dim(&mut ys, "the y values")?;
            one_dim(&mut zs, "the z values")?;
            Ok(Raw { shape: Shape::Curve, xs, ys, zs })
        }
        _ if rows >= 2 && cols >= 2 => {
            // SMath: a matrix is a surface over its column (x) and row (y) numbers
            let mut zs = zs;
            one_dim(&mut zs, "the heights")?;
            let xs = (1..=cols).map(|i| Quantity::scalar(i as f64)).collect();
            let ys = (1..=rows).map(|i| Quantity::scalar(i as f64)).collect();
            Ok(Raw { shape: Shape::Surface, xs, ys, zs })
        }
        _ => bail!("plot a surface with x and y ranges, a curve with a t range, or a matrix of heights"),
    }
}

/// Sample every series and put them in the axis units (given, or SI).
pub(crate) fn plot(
    p: &Plot3Input,
    interp: &mut Interp,
    scope: &mut Scope,
    si_text: impl Fn(Dim) -> String,
) -> Plot3Outcome {
    let raws: Vec<Result<Raw>> = p.series.iter().map(|s| sample(s, interp, scope)).collect();
    let dim_of = |axis: usize| {
        raws.iter().filter_map(|r| r.as_ref().ok()).find_map(|r| {
            let v = [&r.xs, &r.ys, &r.zs][axis];
            v.iter().find(|q| !q.v.is_nan()).map(|q| q.dim)
        })
    };
    let units: [String; 3] =
        std::array::from_fn(|a| {
            p.units[a].as_deref().map(str::trim).filter(|u| !u.is_empty()).map(String::from).unwrap_or_else(
                || dim_of(a).filter(|d| !d.is_dimensionless()).map(&si_text).unwrap_or_default(),
            )
        });
    let series = raws
        .into_iter()
        .map(|r| {
            let conv = |r: Raw| -> Result<Series3Outcome> {
                Ok(Series3Outcome {
                    shape: r.shape,
                    xs: in_unit(&r.xs, &units[0], interp.units).map_err(|e| prefix("x axis", e))?,
                    ys: in_unit(&r.ys, &units[1], interp.units).map_err(|e| prefix("y axis", e))?,
                    zs: in_unit(&r.zs, &units[2], interp.units).map_err(|e| prefix("z axis", e))?,
                    error: None,
                })
            };
            r.and_then(conv)
                .unwrap_or_else(|e| Series3Outcome { error: Some(e.message), ..Default::default() })
        })
        .collect();
    Plot3Outcome { units, series }
}

fn prefix(axis: &str, e: crate::error::EvalError) -> crate::error::EvalError {
    crate::error::EvalError::new(format!("{axis}: {}", e.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interp::Env;
    use quire_units::UnitRegistry;

    fn run(series: Vec<Series3Input>, units: [Option<String>; 3]) -> Plot3Outcome {
        let reg = UnitRegistry::new();
        let env = Env::new();
        let mut interp = Interp::new(&reg);
        let mut scope = Scope::new(&env);
        plot(&Plot3Input { series, units }, &mut interp, &mut scope, |d| {
            crate::format::si_unit(d).replace('\'', "")
        })
    }

    fn s(z: &str) -> Series3Input {
        Series3Input { z: z.into(), ..Default::default() }
    }

    #[test]
    fn surfaces_curves_and_matrices() {
        let surf = Series3Input { xrange: Some("-1..1".into()), yrange: Some("0..2".into()), ..s("x^2 + y") };
        let curve = Series3Input {
            x: Some("cos(t)".into()),
            y: Some("sin(t)".into()),
            range: Some("0..2*π".into()),
            ..s("t/(2*π)")
        };
        let out = run(vec![surf, curve, s("[1, 2, 3; 4, 5, 6]")], Default::default());
        let [a, b, c] = &out.series[..] else { panic!() };
        assert_eq!(
            (a.shape, a.xs.len(), a.ys.len(), a.zs.len()),
            (Shape::Surface, GRID + 1, GRID + 1, (GRID + 1).pow(2))
        );
        assert!((a.zs[0] - 1.0).abs() < 1e-12, "z(-1, 0) = 1");
        assert!((a.zs.last().unwrap() - 3.0).abs() < 1e-12, "z(1, 2) = 3");
        assert_eq!((b.shape, b.zs.len()), (Shape::Curve, CURVE + 1));
        assert!((b.zs.last().unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(
            (c.shape, c.xs.clone(), c.ys.clone()),
            (Shape::Surface, vec![1.0, 2.0, 3.0], vec![1.0, 2.0])
        );
        assert_eq!(c.zs, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn units_gaps_and_errors() {
        let surf =
            Series3Input { xrange: Some("0 m..2 m".into()), yrange: Some("0 m..1 m".into()), ..s("x*y") };
        let out = run(vec![surf], [Some("mm".into()), None, None]);
        assert_eq!(out.units, ["mm".to_string(), "m".to_string(), "m^2".to_string()]);
        assert_eq!(*out.series[0].xs.last().unwrap(), 2000.0);
        let gaps =
            Series3Input { xrange: Some("-1..1".into()), yrange: Some("-1..1".into()), ..s("sqrt(x)") };
        let out = run(
            vec![gaps, s("[1, 2]"), Series3Input { range: Some("0..1".into()), ..s("t") }],
            Default::default(),
        );
        assert!(out.series[0].error.is_none() && out.series[0].zs[0].is_nan(), "a gap where sqrt fails");
        assert!(out.series[1].error.as_deref().unwrap().contains("matrix of heights"));
        assert!(out.series[2].error.as_deref().unwrap().contains("x(t), y(t) and z(t)"));
    }
}
