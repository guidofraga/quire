//! 2D plots: each series is sampled where the plot sits in reading order, so it sees the
//! definitions above it, like any other region.
//!
//! A series is either a function of a variable over a range (`M(x)` for `x` in
//! `0 m..L`), or data: a vector of y values, with an optional vector of x values.
//!
//! A matrix can also style its own points, as SMath's graphics primitives do: column 3 is
//! the marker (`.`, `o`, `+`, `x`, `*`, or `""`/`-` for a line vertex), column 4 its size and
//! column 5 its colour. An animated plot (`Animate`) is drawn once per value of a list, and
//! the variables the plotted function changes keep their new values for the next frame.

use std::rc::Rc;

use quire_ast::{Expr, parse};
use quire_units::Dim;

use crate::error::{Result, bail};
use crate::format::{describe_dim, parse_unit_spec};
use crate::interp::{Binding, Env, Func, Interp, Scope, func_key};
use crate::value::{Matrix, Quantity, Value};

/// Points sampled across a function's range.
pub const SAMPLES: usize = 240;

/// Most frames an animation evaluates. SMath's example animates 108; a longer list is cut here
/// so that an edit never waits on thousands of evaluations.
pub const MAX_FRAMES: usize = 1000;

/// Frames per second when the document does not say.
pub const DEFAULT_FPS: f64 = 20.0;

/// SMath's marker size when a row gives none.
const DEFAULT_MARKER_SIZE: f64 = 10.0;

#[derive(Debug, Clone)]
pub struct PlotInput {
    pub series: Vec<SeriesInput>,
    /// Axis units (`m`, `kN*m`); otherwise the units the document works in.
    pub x_unit: Option<String>,
    pub y_unit: Option<String>,
    /// Draw the axes and their numbers (SMath's `axes`).
    pub axes: bool,
    /// Draw grid lines at the ticks.
    pub grid: bool,
    /// One unit of x is drawn as long as one unit of y (SMath's equal scales), so circles stay round.
    pub equal: bool,
    /// Draw the plot once per value of a list, as an animation.
    pub animate: Option<Animate>,
    /// A 3D plot (`plot3d`) instead: surfaces and curves in x, y and z.
    pub three: Option<crate::plot3d::Plot3Input>,
}

impl Default for PlotInput {
    fn default() -> Self {
        PlotInput {
            series: Vec::new(),
            x_unit: None,
            y_unit: None,
            axes: true,
            grid: true,
            equal: false,
            animate: None,
            three: None,
        }
    }
}

/// SMath's `animate`: the plot is evaluated once per element of the list `over`, with `var`
/// bound to that element.
#[derive(Debug, Clone, PartialEq)]
pub struct Animate {
    /// The variable the plotted expression reads (`t` in `f(path, t)`).
    pub var: String,
    /// The worksheet variable holding the list of values (`step`).
    pub over: String,
    pub fps: f64,
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

/// SMath's style for one point: a marker, its size and its colour.
#[derive(Debug, Clone, PartialEq)]
pub struct Marker {
    /// `.` (a filled disc), `o` (an open circle), `+`, `x`, `*`, or `text` for a label.
    pub shape: String,
    /// SMath's size number; the app draws it in pixels (for a label, its font size).
    pub size: f64,
    /// A CSS colour, or `None` for the series' own colour.
    pub color: Option<String>,
    /// The words of a label (`RA` in SMath's beam), drawn at the point.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SeriesOutcome {
    /// Values in the axis units; `NaN` where a point could not be computed (a gap).
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub error: Option<String>,
    /// One entry per point: its marker, or `None` for a point of the line. Empty when the
    /// matrix has no style columns, so every point is a line vertex.
    pub marks: Vec<Option<Marker>>,
    /// Whether consecutive points are joined by a line.
    pub connect: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PlotOutcome {
    pub x: Axis,
    pub y: Axis,
    /// The series as drawn: for an animation, its last frame (what prints).
    pub series: Vec<SeriesOutcome>,
    /// Every frame's series in order; empty unless the plot is animated.
    pub frames: Vec<Vec<SeriesOutcome>>,
    /// Frames per second, for an animated plot.
    pub fps: Option<f64>,
    pub axes: bool,
    pub grid: bool,
    pub equal: bool,
    /// A 3D plot's series, in its axis units (the fields above are then unused).
    pub three: Option<crate::plot3d::Plot3Outcome>,
}

/// Raw samples in SI, before the axes are chosen.
#[derive(Debug, Clone)]
pub(crate) struct Sampled {
    pub xs: Vec<Quantity>,
    pub ys: Vec<Quantity>,
    /// As in `SeriesOutcome::marks`: empty for a plain line.
    pub marks: Vec<Option<Marker>>,
}

impl Sampled {
    fn plain(xs: Vec<Quantity>, ys: Vec<Quantity>) -> Self {
        Sampled { xs, ys, marks: Vec::new() }
    }
}

/// The series of one animation frame: each one's samples, or the error that stopped it.
pub(crate) type Frame = Vec<std::result::Result<Sampled, String>>;

/// Samples of one series, one per line drawn: a function or a vector gives one, and a vector
/// of matrices (SMath's `sys` block) gives one line per element.
pub(crate) fn sample(s: &SeriesInput, interp: &mut Interp, scope: &mut Scope) -> Result<Vec<Sampled>> {
    let y = parse_part(&s.y, "the plotted expression")?;
    match s.range.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(range) => sample_range(s, range, &y, interp, scope).map(|one| vec![one]),
        None => {
            let v = interp.eval(scope, &y)?;
            from_value(s, v, interp, scope)
        }
    }
}

fn sample_range(
    s: &SeriesInput,
    range: &str,
    y: &Expr,
    interp: &mut Interp,
    scope: &mut Scope,
) -> Result<Sampled> {
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
        let v = interp.eval(scope, y).and_then(|v| v.as_num("the plotted expression"));
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
    Ok(Sampled::plain(xs, ys))
}

/// The lines of a series whose expression has been evaluated to `v`.
fn from_value(s: &SeriesInput, v: Value, interp: &mut Interp, scope: &mut Scope) -> Result<Vec<Sampled>> {
    let x_given = s.x.as_deref().map(str::trim).is_some_and(|x| !x.is_empty());
    if let Value::Matrix(m) = &v
        && !m.is_vector()
    {
        if x_given {
            bail!("a matrix has its own x values, in its first column; leave out x");
        }
        return Ok(vec![points(m)?]);
    }
    if let Value::Matrix(m) = &v
        && m.is_vector()
        && m.data.iter().any(|e| matches!(e, Value::Matrix(_)))
    {
        if x_given {
            bail!("a list of lines has its own x values; leave out x");
        }
        let mut lines = Vec::with_capacity(m.data.len());
        for e in &m.data {
            let Value::Matrix(line) = e else {
                bail!("a list plotted as lines should hold only matrices, not numbers or text");
            };
            lines.push(points(line)?);
        }
        return Ok(lines);
    }
    let ys = numbers(v, "the plotted values")?;
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
    Ok(vec![Sampled::plain(xs, ys)])
}

/// A matrix with two or more columns, drawn as a line through its rows: the first column is x,
/// the second y. Columns three to five, when the rows have them, are SMath's marker style
/// (see `marker`). A row whose x or y is not a number is a gap in the line.
fn points(m: &Matrix) -> Result<Sampled> {
    if m.cols < 2 {
        bail!("a matrix drawn as a line needs an x and a y column, but it has {}", m.cols);
    }
    let styled = m.cols >= 3 && m.data.chunks(m.cols).any(|row| matches!(row.get(2), Some(Value::Str(_))));
    let mut xs = Vec::with_capacity(m.rows);
    let mut ys = Vec::with_capacity(m.rows);
    let mut marks = Vec::with_capacity(if styled { m.rows } else { 0 });
    for row in m.data.chunks(m.cols) {
        xs.push(row.first().and_then(|v| v.as_num("the x values").ok()));
        ys.push(row.get(1).and_then(|v| v.as_num("the y values").ok()));
        if styled {
            marks.push(marker(row)?);
        }
    }
    Ok(Sampled { xs: with_gaps(xs, "the x values")?, ys: with_gaps(ys, "the y values")?, marks })
}

/// SMath's style on one row: marker (column 3), size (column 4) and colour (column 5). A row
/// with no marker is a vertex of the line through the others.
fn marker(row: &[Value]) -> Result<Option<Marker>> {
    let word = match row.get(2) {
        Some(Value::Str(s)) => s.trim(),
        _ => return Ok(None),
    };
    // anything that is not a marker is a label: SMath's beam writes its reaction names this way
    let (shape, text) = match word {
        "" | "-" => return Ok(None),
        "." | "o" | "+" | "x" | "*" => (word.to_string(), None),
        other => ("text".to_string(), Some(other.to_string())),
    };
    let size = row.get(3).and_then(|v| v.as_num("the marker size").ok()).map_or(DEFAULT_MARKER_SIZE, |q| q.v);
    let color = match row.get(4) {
        Some(Value::Str(name)) => colour_of(name),
        _ => None,
    };
    Ok(Some(Marker { shape, size: if size.is_finite() { size } else { DEFAULT_MARKER_SIZE }, color, text }))
}

/// SMath's colour names as CSS colours. Case and spaces do not matter; a name not listed
/// here gives `None`, so the point takes the series' colour.
pub fn colour_of(name: &str) -> Option<String> {
    let key: String = name.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    let css = match key.as_str() {
        "red" => "#ff0000",
        "blue" => "#0000ff",
        "lightblue" => "#add8e6",
        "darkblue" => "#00008b",
        "green" => "#008000",
        "lightgreen" => "#90ee90",
        "darkgreen" => "#006400",
        "yellow" => "#ffff00",
        "orange" => "#ffa500",
        "magenta" | "fuchsia" => "#ff00ff",
        "cyan" | "aqua" => "#00ffff",
        "purple" => "#800080",
        "pink" => "#ffc0cb",
        "brown" => "#a52a2a",
        "darkred" => "#8b0000",
        "black" => "#000000",
        "white" => "#ffffff",
        "gray" | "grey" => "#808080",
        "lightgray" | "lightgrey" => "#d3d3d3",
        _ => return None,
    };
    Some(css.to_string())
}

/// Numbers where `None` is a gap, which takes the dimension of the numbers around it.
fn with_gaps(values: Vec<Option<Quantity>>, what: &str) -> Result<Vec<Quantity>> {
    let dim = values.iter().flatten().next().map(|q| q.dim).unwrap_or(Dim::NONE);
    if values.iter().flatten().any(|q| q.dim != dim) {
        bail!("{what} mix different units");
    }
    Ok(values.into_iter().map(|q| q.unwrap_or_else(|| Quantity::new(f64::NAN, dim))).collect())
}

/// `sys(e1, …, en, rows, cols)`: SMath's system block, a column of expressions. Its value is
/// the `rows × cols` matrix of its first elements (row-major, as `mat`), so a plot of it draws
/// each element as a line.
pub(crate) fn sys(args: &[Value]) -> Result<Value> {
    if args.len() < 3 {
        bail!("sys takes the elements followed by rows and cols");
    }
    let (cells, dims) = args.split_at(args.len() - 2);
    let (rows, cols) = match dims {
        [rows, cols] => (rows, cols),
        _ => bail!("sys takes the elements followed by rows and cols"),
    };
    let r = usize::try_from(rows.as_int("the rows of sys")?).unwrap_or(0);
    let c = usize::try_from(cols.as_int("the columns of sys")?).unwrap_or(0);
    let n = r.checked_mul(c).unwrap_or(0);
    if n == 0 {
        bail!("sys needs at least one row and one column");
    }
    let Some(elements) = cells.get(..n) else {
        bail!("sys: {r}×{c} needs {n} elements, but it has {}", cells.len());
    };
    Ok(Value::Matrix(Matrix::new(r, c, elements.to_vec())))
}

/// Evaluates an animated plot once per value of `a.over` (at most `MAX_FRAMES`), with `a.var`
/// bound to that value. The variables the plotted function changes are kept for the next frame:
/// a call `f(path, t)` whose `path` is a worksheet variable gives that variable the final `path`
/// of `f`, so SMath's trail (`path := stack(path, …)`) grows by a point per frame. Every frame
/// shares the interpreter, so the step budget bounds the whole animation.
pub(crate) fn animate(p: &PlotInput, a: &Animate, interp: &mut Interp, base: &Env) -> Result<Vec<Frame>> {
    let values = {
        let mut scope = Scope::new(base);
        let v = interp.eval(&mut scope, &parse_part(&a.over, "the list that animates the plot")?)?;
        numbers(v, "the list that animates the plot")?
    };
    let mut env: Env = base.clone();
    let mut frames = Vec::with_capacity(values.len().min(MAX_FRAMES));
    for q in values.into_iter().take(MAX_FRAMES) {
        let (frame, kept) = frame(p, &a.var, q, interp, &env);
        for (name, v) in kept {
            env.insert(name, Binding::Val(v));
        }
        frames.push(frame);
    }
    Ok(frames)
}

/// One frame: every series with `var` bound to `q`, and the worksheet variables that the frame's
/// calls changed (to be kept for the next frame).
fn frame(
    p: &PlotInput,
    var: &str,
    q: Quantity,
    interp: &mut Interp,
    env: &Env,
) -> (Frame, Vec<(String, Value)>) {
    let mut scope = Scope::new(env);
    scope.bind(var, Value::Num(q));
    let mut kept = Vec::new();
    let mut lines: Frame = Vec::new();
    for s in &p.series {
        match series_frame(s, interp, &mut scope, env, &mut kept) {
            Ok(list) => lines.extend(list.into_iter().map(Ok)),
            Err(e) => lines.push(Err(e.message)),
        }
    }
    (lines, kept)
}

fn series_frame(
    s: &SeriesInput,
    interp: &mut Interp,
    scope: &mut Scope,
    env: &Env,
    kept: &mut Vec<(String, Value)>,
) -> Result<Vec<Sampled>> {
    let y = parse_part(&s.y, "the plotted expression")?;
    let is_range = s.range.as_deref().map(str::trim).is_some_and(|r| !r.is_empty());
    if !is_range && let Some((f, args)) = plotted_call(&y, scope) {
        let vals = args.iter().map(|e| interp.eval(scope, e)).collect::<Result<Vec<Value>>>()?;
        let (v, params) = call_keeping_params(interp, &f, vals)?;
        for (param, arg) in f.params.iter().zip(args) {
            if let Expr::Ident(name) = arg
                && env.contains_key(name)
                && let Some(Binding::Val(value)) = params.get(param)
            {
                kept.push((name.clone(), value.clone()));
            }
        }
        return from_value(s, v, interp, scope);
    }
    sample(s, interp, scope)
}

/// The worksheet function a series plots, when its expression is a call `f(…)` of one.
fn plotted_call<'a>(y: &'a Expr, scope: &Scope) -> Option<(Rc<Func>, &'a [Expr])> {
    let Expr::Call(name, args) = y else {
        return None;
    };
    match scope.get(&func_key(name, args.len())) {
        Some(Binding::Func(f)) => Some((Rc::clone(f), args.as_slice())),
        _ => None,
    }
}

/// Calls a worksheet function and also returns its frame: the final values of its parameters
/// (and of anything else it assigned in that frame).
fn call_keeping_params(interp: &mut Interp, f: &Rc<Func>, vals: Vec<Value>) -> Result<(Value, Env)> {
    let mut inner = Scope::new(&f.env);
    for (p, v) in f.params.iter().zip(vals) {
        inner.bind(p, v);
    }
    let v = interp.eval(&mut inner, &f.body)?;
    Ok((v, inner.into_writes()))
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
        Value::Sym(_) => bail!("{what} should be numbers, not a symbolic expression"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{DisplaySettings, DisplaySpec};
    use crate::worksheet::{MathInput, Outcome, Worksheet};

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn math(id: &str, expr: &str) -> MathInput {
        MathInput {
            id: id.into(),
            expr: expr.into(),
            show: false,
            display: DisplaySpec::default(),
            table: None,
            plot: None,
            symbolic: false,
        }
    }

    fn plot(id: &str, series: Vec<SeriesInput>) -> MathInput {
        MathInput { plot: Some(PlotInput { series, ..Default::default() }), ..math(id, "") }
    }

    fn run(regions: &[MathInput]) -> Vec<Outcome> {
        Worksheet::new(DisplaySettings::default()).run(regions)
    }

    #[test]
    fn sys_is_the_column_of_its_first_elements() -> TestResult {
        let out = run(&[math("a", "S := sys(1, 2, 3, 2, 1)"), math("b", "sys(1, 2, 3, 4, 2, 2)")]);
        let Some(Value::Matrix(m)) = &out[0].value else {
            return Err("sys should give a matrix".into());
        };
        assert_eq!((m.rows, m.cols), (2, 1));
        assert_eq!(out[0].error, None);
        let Some(Value::Matrix(m)) = &out[1].value else {
            return Err("sys should give a matrix".into());
        };
        assert_eq!((m.rows, m.cols), (2, 2));
        // the first n·1 elements only, and too few elements is an error, not a panic
        let short = run(&[math("c", "sys(1, 2, 3, 4, 1)")]);
        assert!(short[0].error.as_deref().is_some_and(|e| e.contains("needs 4 elements")));
        Ok(())
    }

    #[test]
    fn a_matrix_of_points_is_one_line() -> TestResult {
        let series = vec![SeriesInput { y: "P".into(), ..Default::default() }];
        let out = run(&[math("p", "P := [0, 0; 1, 2; 2, 4]"), plot("plot", series)]);
        let line = out[1].plot.as_ref().ok_or("no plot")?.series.first().ok_or("no series")?;
        assert_eq!((line.xs.clone(), line.ys.clone()), (vec![0.0, 1.0, 2.0], vec![0.0, 2.0, 4.0]));
        assert_eq!(out[1].error, None);
        Ok(())
    }

    #[test]
    fn a_list_of_matrices_draws_one_line_each() -> TestResult {
        let series = vec![SeriesInput { y: "S".into(), ..Default::default() }];
        let out = run(&[math("s", "S := sys([0, 0; 1, 1], [5, 5; 6, 7], 2, 1)"), plot("plot", series)]);
        let lines = &out[1].plot.as_ref().ok_or("no plot")?.series;
        assert_eq!(lines.len(), 2);
        assert_eq!(out[1].error, None);
        let second = lines.get(1).ok_or("no second line")?;
        assert_eq!((second.xs.clone(), second.ys.clone()), (vec![5.0, 6.0], vec![5.0, 7.0]));
        Ok(())
    }

    #[test]
    fn a_row_without_numbers_is_a_gap_and_columns_must_match() -> TestResult {
        let gap = vec![SeriesInput { y: "P".into(), ..Default::default() }];
        let out = run(&[math("p", "P := [0, 0; \"RA\", 1; 2, 4]"), plot("plot", gap)]);
        let line = out[1].plot.as_ref().ok_or("no plot")?.series.first().ok_or("no series")?;
        assert!(line.xs.get(1).is_some_and(|x| x.is_nan()));
        assert_eq!(line.ys.get(2).copied(), Some(4.0));
        let one_column = vec![SeriesInput { y: "[1; 2]".into(), x: Some("x".into()), range: None }];
        let bad = run(&[plot("bad", one_column)]);
        assert!(bad[0].error.is_some());
        Ok(())
    }

    fn animated(y: &str, over: &str) -> MathInput {
        MathInput {
            plot: Some(PlotInput {
                series: vec![SeriesInput { y: y.into(), ..Default::default() }],
                animate: Some(Animate { var: "t".into(), over: over.into(), fps: 20.0 }),
                ..Default::default()
            }),
            ..math("anim", "")
        }
    }

    /// The plot drawn by region `k` of a run, with its error (if any) checked first.
    fn plotted(
        out: &[Outcome],
        k: usize,
    ) -> std::result::Result<(&PlotOutcome, Option<&str>), Box<dyn std::error::Error>> {
        let o = out.get(k).ok_or("no outcome")?;
        Ok((o.plot.as_ref().ok_or("no plot")?, o.error.as_deref()))
    }

    #[test]
    fn marker_columns_style_their_rows() -> TestResult {
        let styled = "S := [0, 0, \".\", 10, \"Red\"; 1, 2, \"\", 0, \"\"; 2, 4, \"o\", 185, \"Light Blue\"]";
        let out = run(&[
            math("s", styled),
            plot("plot", vec![SeriesInput { y: "S".into(), ..Default::default() }]),
        ]);
        let (p, error) = plotted(&out, 1)?;
        assert_eq!(error, None);
        let line = p.series.first().ok_or("no series")?;
        assert_eq!(line.marks.len(), 3);
        assert_eq!(
            line.marks.first().cloned().flatten(),
            Some(Marker { shape: ".".into(), size: 10.0, color: Some("#ff0000".into()), text: None })
        );
        assert_eq!(line.marks.get(1), Some(&None), "an empty marker is a vertex of the line");
        assert_eq!(
            line.marks.get(2).cloned().flatten().map(|m| (m.shape, m.size)),
            Some(("o".to_string(), 185.0))
        );
        assert!(line.connect, "a row with no marker keeps the line");
        Ok(())
    }

    #[test]
    fn marker_rows_alone_are_not_joined() -> TestResult {
        let dots = "S := [0, 0, \"+\", 5; 1, 1, \"x\", 5]";
        let out =
            run(&[math("s", dots), plot("plot", vec![SeriesInput { y: "S".into(), ..Default::default() }])]);
        let (p, _) = plotted(&out, 1)?;
        let s = p.series.first().ok_or("no series")?;
        assert!(!s.connect);
        assert_eq!(s.marks.iter().flatten().map(|m| m.color.clone()).collect::<Vec<_>>(), vec![None, None]);
        Ok(())
    }

    #[test]
    fn other_words_in_the_marker_column_are_labels() -> TestResult {
        let out = run(&[
            math("s", "S := [0, 0, \"RA\", 10, \"Green\"; 1, 1, \".\", 5, \"Red\"]"),
            plot("plot", vec![SeriesInput { y: "S".into(), ..Default::default() }]),
        ]);
        let (p, error) = plotted(&out, 1)?;
        assert_eq!(error, None);
        let s = p.series.first().ok_or("no series")?;
        let label = s.marks.first().cloned().flatten().ok_or("no label")?;
        assert_eq!((label.shape.as_str(), label.text.as_deref()), ("text", Some("RA")));
        assert_eq!(label.color.as_deref(), Some("#008000"));
        Ok(())
    }

    #[test]
    fn an_unknown_word_in_the_marker_column_is_a_label_not_an_error() -> TestResult {
        // a row with a marker word is a label, so the only way to fail is a row that is not numbers
        let out = run(&[
            math("s", "S := [0, 0, \"q\"; 1, 1, \".\"]"),
            plot("plot", vec![SeriesInput { y: "S".into(), ..Default::default() }]),
        ]);
        let (_, error) = plotted(&out, 1)?;
        assert_eq!(error, None);
        Ok(())
    }

    #[test]
    fn smath_colour_names_map_to_css() {
        assert_eq!(colour_of("Red").as_deref(), Some("#ff0000"));
        assert_eq!(colour_of(" light  BLUE ").as_deref(), Some("#add8e6"));
        assert_eq!(colour_of("Mauve"), None);
    }

    #[test]
    fn a_plotted_function_keeps_its_trail_between_frames() -> TestResult {
        // f grows the list p by one point per call; p is a worksheet variable, so each frame
        // should see the trail the frames before it left
        let out = run(&[
            math("p", "path := [0, 0]"),
            math("f", "f(p, t) := block(p := stack(p, [t, t]), p)"),
            math("step", "step := range(1, 4)"),
            animated("f(path, t)", "step"),
        ]);
        let (plot, error) = plotted(&out, 3)?;
        assert_eq!(error, None);
        assert!(plot.frames.len() >= 3, "the range should give several frames");
        for (k, frame) in plot.frames.iter().enumerate() {
            let line = frame.first().ok_or("no series")?;
            assert_eq!(line.xs.len(), k + 2, "frame {k} should add one point to the trail");
        }
        // the drawn plot is the last frame
        assert_eq!(plot.series.first().map(|s| s.xs.len()), Some(plot.frames.len() + 1));
        assert_eq!(plot.fps, Some(20.0));
        Ok(())
    }

    #[test]
    fn a_plain_plot_has_no_frames() -> TestResult {
        let out = run(&[plot("plot", vec![SeriesInput { y: "[1; 2]".into(), ..Default::default() }])]);
        let (p, _) = plotted(&out, 0)?;
        assert!(p.frames.is_empty());
        assert_eq!(p.fps, None);
        Ok(())
    }
}
