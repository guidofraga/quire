//! 2D plots: each series is sampled where the plot sits in reading order, so it sees the
//! definitions above it, like any other region.
//!
//! A series is either a function of a variable over a range (`M(x)` for `x` in
//! `0 m..L`), or data: a vector of y values, with an optional vector of x values.

use quire_ast::{Expr, parse};
use quire_units::Dim;

use crate::error::{Result, bail};
use crate::format::{describe_dim, parse_unit_spec};
use crate::interp::{Interp, Scope};
use crate::value::{Quantity, Value};

/// Points sampled across a function's range.
pub const SAMPLES: usize = 240;

#[derive(Debug, Clone, Default)]
pub struct PlotInput {
    pub series: Vec<SeriesInput>,
    /// Axis units (`m`, `kN*m`); otherwise the units the document works in.
    pub x_unit: Option<String>,
    pub y_unit: Option<String>,
    /// A 3D plot (`plot3d`) instead: surfaces, curves and data in x, y and z.
    pub three: Option<crate::plot3d::Plot3Input>,
}

#[derive(Debug, Clone, Default)]
pub struct SeriesInput {
    /// What is plotted: an expression in the variable (`M(x)`), or a vector.
    pub y: String,
    /// The variable (functions; default `x`), or a vector of x values (data).
    pub x: Option<String>,
    /// `a..b`: makes the series a function of `x`.
    pub range: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Axis {
    /// The unit values are given in (`kN*m`); empty for plain numbers.
    pub unit: String,
    pub dim: Dim,
}

#[derive(Debug, Clone, Default)]
pub struct SeriesOutcome {
    /// Values in the axis units; `NaN` where a point could not be computed (a gap).
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PlotOutcome {
    pub x: Axis,
    pub y: Axis,
    pub series: Vec<SeriesOutcome>,
}

/// Raw samples in SI, before the axes are chosen.
#[derive(Debug, Clone)]
pub(crate) struct Sampled {
    pub xs: Vec<Quantity>,
    pub ys: Vec<Quantity>,
}

pub(crate) fn sample(s: &SeriesInput, interp: &mut Interp, scope: &mut Scope) -> Result<Sampled> {
    let y = parse_part(&s.y, "the plotted expression")?;
    match s.range.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(range) => {
            let var = s.x.as_deref().map(str::trim).filter(|v| !v.is_empty()).unwrap_or("x");
            if !var.chars().next().is_some_and(char::is_alphabetic) {
                bail!("the variable should be a name, like x");
            }
            let Expr::Range(a, b) = parse_part(range, "the range")? else {
                bail!("write the range as start..end, like 0 m..L");
            };
            let a = interp.eval(scope, &a)?.as_num("the start of the range")?;
            let b = interp.eval(scope, &b)?.as_num("the end of the range")?;
            if a.dim != b.dim {
                bail!("the start and end of the range have different units");
            }
            if !(a.v.is_finite() && b.v.is_finite()) || a.v == b.v {
                bail!("the range needs two different, finite ends");
            }
            let mut xs = Vec::with_capacity(SAMPLES + 1);
            let mut ys = Vec::with_capacity(SAMPLES + 1);
            let mut first_error = None;
            for k in 0..=SAMPLES {
                let x = Quantity::new(a.v + (b.v - a.v) * k as f64 / SAMPLES as f64, a.dim);
                let prev = scope.bind(var, Value::Num(x));
                let v = interp.eval(scope, &y).and_then(|v| v.as_num("the plotted expression"));
                scope.restore(var, prev);
                match v {
                    Ok(q) => {
                        xs.push(x);
                        ys.push(q);
                    }
                    Err(e) => {
                        first_error.get_or_insert(e);
                        xs.push(x);
                        ys.push(Quantity::new(f64::NAN, Dim::NONE));
                    }
                }
            }
            if ys.iter().all(|q| q.v.is_nan())
                && let Some(e) = first_error
            {
                return Err(e);
            }
            // a gap (NaN) takes the dimension of the points around it
            let dim = ys.iter().find(|q| !q.v.is_nan()).map(|q| q.dim).unwrap_or(Dim::NONE);
            for q in &mut ys {
                if q.v.is_nan() {
                    q.dim = dim;
                } else if q.dim != dim {
                    bail!("the plotted values change units across the range");
                }
            }
            Ok(Sampled { xs, ys })
        }
        None => {
            let ys = numbers(interp.eval(scope, &y)?, "the plotted values")?;
            let xs = match s.x.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
                Some(x) => {
                    let xs = numbers(interp.eval(scope, &parse_part(x, "the x values")?)?, "the x values")?;
                    if xs.len() != ys.len() {
                        bail!("{} x values for {} y values", xs.len(), ys.len());
                    }
                    xs
                }
                None => (1..=ys.len()).map(|i| Quantity::scalar(i as f64)).collect(),
            };
            Ok(Sampled { xs, ys })
        }
    }
}

fn parse_part(text: &str, what: &str) -> Result<Expr> {
    if text.trim().is_empty() {
        bail!("{what} is empty");
    }
    Ok(parse(text)?)
}

/// A vector (or a single number) as quantities of one dimension.
fn numbers(v: Value, what: &str) -> Result<Vec<Quantity>> {
    let list: Vec<Quantity> = match v {
        Value::Num(q) => vec![q],
        Value::Matrix(m) if m.is_vector() => m.data.iter().map(|v| v.as_num(what)).collect::<Result<_>>()?,
        Value::Matrix(m) => bail!("{what} should be a vector, not a {}×{} matrix", m.rows, m.cols),
        Value::Str(_) => bail!("{what} should be numbers, not text"),
    };
    if let Some(first) = list.first()
        && list.iter().any(|q| q.dim != first.dim)
    {
        bail!("{what} mix different units");
    }
    Ok(list)
}

/// Values in an axis unit: `unit` is a display unit (`kN*m`) or empty for SI/plain.
pub(crate) fn in_unit(
    values: &[Quantity],
    unit: &str,
    units: &quire_units::UnitRegistry,
) -> Result<Vec<f64>> {
    let spec = parse_unit_spec(unit, units)?;
    if let Some(q) = values.first()
        && q.dim != spec.dim
    {
        let axis = if unit.trim().is_empty() { "plain numbers".to_string() } else { unit.trim().to_string() };
        bail!("these values are {}, but the axis is in {axis}", describe_dim(q.dim));
    }
    Ok(values
        .iter()
        .map(|q| if q.v.is_nan() { f64::NAN } else { (q.v - spec.offset) / spec.factor })
        .collect())
}
