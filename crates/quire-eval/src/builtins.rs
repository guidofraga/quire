//! Built-in functions whose arguments are evaluated first. Lazy constructs
//! (`if`, `for`, `sum`, `int`, …) live in `interp.rs`.

use quire_ast::BinaryOp;
use quire_units::{Dim, Rational};

use crate::error::{Result, bail};
use crate::format::{DisplaySettings, format_number};
use crate::ops::{self, arith, same_dim, uniform};
use crate::value::{Matrix, Quantity, Value};

pub(crate) fn arity(name: &str, args: &[Value], ok: impl Fn(usize) -> bool, expected: &str) -> Result<()> {
    if !ok(args.len()) {
        bail!("{name} takes {expected}, but got {}", args.len());
    }
    Ok(())
}

fn real(name: &str, f: fn(f64) -> f64, args: &[Value]) -> Result<Value> {
    arity(name, args, |n| n == 1, "1 argument")?;
    let x = args[0].as_scalar(&format!("the argument of {name}"))?;
    let v = f(x);
    if v.is_nan() && !x.is_nan() {
        bail!("{name}({x}) has no real result");
    }
    Ok(Value::num(v))
}

fn matrix_arg<'a>(name: &str, v: &'a Value) -> Result<&'a Matrix> {
    match v {
        Value::Matrix(m) => Ok(m),
        other => bail!("{name} needs a matrix, not {}", other.kind()),
    }
}

/// Numbers from every argument, matrices flattened.
pub(crate) fn flatten(args: &[Value]) -> Vec<&Value> {
    let mut out = Vec::new();
    for a in args {
        match a {
            Value::Matrix(m) => out.extend(m.data.iter()),
            v => out.push(v),
        }
    }
    out
}

fn extremum(name: &str, args: &[Value], pick_max: bool) -> Result<Value> {
    let items = flatten(args);
    let Some(first) = items.first() else { bail!("{name} needs at least one value") };
    let mut best = first.as_num(&format!("an argument of {name}"))?;
    for v in &items[1..] {
        let q = v.as_num(&format!("an argument of {name}"))?;
        same_dim(best.dim, q.dim, &format!("take {name} of"))?;
        if (pick_max && q.v > best.v) || (!pick_max && q.v < best.v) {
            best = q;
        }
    }
    Ok(Value::Num(best))
}

fn element(m: &Matrix, idx: &[i64]) -> Result<Value> {
    let (r, c) = match *idx {
        [i] if m.cols == 1 => (i, 1),
        [i] if m.rows == 1 => (1, i),
        [_] => bail!("a {}×{} matrix needs two indices", m.rows, m.cols),
        [i, j] => (i, j),
        _ => bail!("too many indices"),
    };
    if r < 1 || c < 1 || r as usize > m.rows || c as usize > m.cols {
        bail!("index ({r}, {c}) is outside the {}×{} matrix (indices start at 1)", m.rows, m.cols);
    }
    Ok(m.get(r as usize - 1, c as usize - 1).clone())
}

pub fn index(base: &Value, idx: &[Value]) -> Result<Value> {
    let m = matrix_arg("indexing", base)?;
    let idx = idx.iter().map(|v| v.as_int("an index")).collect::<Result<Vec<_>>>()?;
    element(m, &idx)
}

fn concat_blocks(name: &str, args: &[Value], vertical: bool) -> Result<Value> {
    let blocks: Vec<Matrix> = args
        .iter()
        .map(|v| match v {
            Value::Matrix(m) => m.clone(),
            other => Matrix::new(1, 1, vec![other.clone()]),
        })
        .collect();
    let Some(first) = blocks.first() else { bail!("{name} needs at least one argument") };
    if vertical {
        let cols = first.cols;
        if blocks.iter().any(|b| b.cols != cols) {
            bail!("{name}: all blocks need the same number of columns");
        }
        let rows = blocks.iter().map(|b| b.rows).sum();
        let data = blocks.into_iter().flat_map(|b| b.data).collect();
        return Ok(Value::Matrix(Matrix::new(rows, cols, data)));
    }
    if blocks.iter().any(|b| b.rows != first.rows) {
        bail!("{name}: all blocks need the same number of rows");
    }
    let cols = blocks.iter().map(|b| b.cols).sum();
    let mut data = Vec::with_capacity(first.rows * cols);
    for r in 0..first.rows {
        for b in &blocks {
            data.extend((0..b.cols).map(|c| b.get(r, c).clone()));
        }
    }
    Ok(Value::Matrix(Matrix::new(first.rows, cols, data)))
}

pub fn range(a: Quantity, b: Quantity, step: Option<Quantity>) -> Result<Value> {
    same_dim(a.dim, b.dim, "make a range from")?;
    let step = step.unwrap_or(Quantity::new(if b.v >= a.v { 1.0 } else { -1.0 }, a.dim));
    same_dim(a.dim, step.dim, "use a step for")?;
    if step.v == 0.0 || (b.v - a.v) * step.v < 0.0 {
        bail!("the range step never reaches the end value");
    }
    let n = ((b.v - a.v) / step.v + 1e-9).floor() as usize + 1;
    if n > 10_000_000 {
        bail!("the range has too many elements ({n})");
    }
    let data = (0..n).map(|k| Value::Num(Quantity::new(a.v + k as f64 * step.v, a.dim))).collect();
    Ok(Value::Matrix(Matrix::column(data)))
}

/// `None` when `name` is not a built-in.
pub fn call(name: &str, args: &[Value]) -> Option<Result<Value>> {
    let r = match name {
        "sqrt" => sqrt(args),
        "root" => root(args),
        "abs" => abs(args),
        "exp" => real(name, f64::exp, args),
        "ln" => real(name, f64::ln, args),
        "log10" | "lg" => real(name, f64::log10, args),
        "log" => log(args),
        "sin" => real(name, f64::sin, args),
        "cos" => real(name, f64::cos, args),
        "tan" => real(name, f64::tan, args),
        "cot" => real(name, |x| 1.0 / x.tan(), args),
        "sec" => real(name, |x| 1.0 / x.cos(), args),
        "csc" => real(name, |x| 1.0 / x.sin(), args),
        "asin" => real(name, f64::asin, args),
        "acos" => real(name, f64::acos, args),
        "atan" => real(name, f64::atan, args),
        "acot" => real(name, |x| (1.0 / x).atan(), args),
        "asec" => real(name, |x| (1.0 / x).acos(), args),
        "acsc" => real(name, |x| (1.0 / x).asin(), args),
        "sinh" => real(name, f64::sinh, args),
        "cosh" => real(name, f64::cosh, args),
        "tanh" => real(name, f64::tanh, args),
        "coth" => real(name, |x| 1.0 / x.tanh(), args),
        "asinh" => real(name, f64::asinh, args),
        "acosh" => real(name, f64::acosh, args),
        "atanh" => real(name, f64::atanh, args),
        "atan2" => atan2(args),
        "floor" => real(name, f64::floor, args),
        "ceil" => real(name, f64::ceil, args),
        "trunc" => real(name, f64::trunc, args),
        "round" => round(args),
        "sign" => sign(args),
        "mod" => mod_(args),
        "max" => extremum(name, args, true),
        "min" => extremum(name, args, false),
        "sum" if args.len() == 1 => sum_all(args),
        "mean" => mean(args),
        "sort" => sort(args),
        "norm" => norm(args),
        "dot" => dot(args),
        "cross" => cross(args),
        "lsolve" => lsolve(args),
        "linterp" => linterp(args),
        "rows" | "cols" | "length" => size(name, args),
        "el" => el(args),
        "transpose" => transpose(args),
        "det" => one_matrix(name, args).and_then(ops::det),
        "inverse" => one_matrix(name, args).and_then(ops::inverse),
        "identity" => identity(args),
        "stack" => concat_blocks(name, args, true),
        "augment" => concat_blocks(name, args, false),
        "mat" => mat(args),
        "range" => range_fn(args),
        "num2str" => num2str(args),
        "concat" => concat(args),
        "eval" => arity(name, args, |n| n == 1, "1 argument").map(|_| args[0].clone()),
        _ => return crate::stats::call(name, args),
    };
    Some(r)
}

fn sqrt(args: &[Value]) -> Result<Value> {
    arity("sqrt", args, |n| n == 1, "1 argument")?;
    let x = args[0].as_num("the argument of sqrt")?;
    if x.v < 0.0 {
        bail!("sqrt of a negative number (complex numbers are not supported yet)");
    }
    Ok(Value::Num(ops::pow(x, Quantity::scalar(0.5))?))
}

fn root(args: &[Value]) -> Result<Value> {
    arity("root", args, |n| n == 2, "2 arguments: root(x, n)")?;
    let x = args[0].as_num("the radicand")?;
    let n = args[1].as_int("the root degree")?;
    if n == 0 {
        bail!("the root degree cannot be zero");
    }
    if x.v < 0.0 && n % 2 != 0 {
        let pos = ops::pow(Quantity::new(-x.v, x.dim), Quantity::scalar(1.0 / n as f64))?;
        return Ok(Value::Num(Quantity::new(-pos.v, pos.dim)));
    }
    Ok(Value::Num(ops::pow(x, Quantity::new(1.0 / n as f64, Dim::NONE))?))
}

fn abs(args: &[Value]) -> Result<Value> {
    arity("abs", args, |n| n == 1, "1 argument")?;
    match &args[0] {
        Value::Num(q) => Ok(Value::Num(Quantity::new(q.v.abs(), q.dim))),
        Value::Matrix(m) if m.is_vector() => {
            let (vals, dim) = uniform(m, "a vector element")?;
            Ok(Value::Num(Quantity::new(vals.iter().map(|v| v * v).sum::<f64>().sqrt(), dim)))
        }
        Value::Matrix(m) => ops::det(m),
        Value::Str(_) => bail!("abs needs a number"),
    }
}

fn log(args: &[Value]) -> Result<Value> {
    arity("log", args, |n| n == 1 || n == 2, "1 or 2 arguments: log(x) or log(x, base)")?;
    let x = args[0].as_scalar("the argument of log")?;
    let base = match args.get(1) {
        Some(b) => b.as_scalar("the base of log")?,
        None => 10.0,
    };
    if x <= 0.0 || base <= 0.0 || base == 1.0 {
        bail!("log is only defined for positive x and a positive base ≠ 1");
    }
    Ok(Value::num(x.ln() / base.ln()))
}

fn atan2(args: &[Value]) -> Result<Value> {
    arity("atan2", args, |n| n == 2, "2 arguments: atan2(y, x)")?;
    let y = args[0].as_num("y")?;
    let x = args[1].as_num("x")?;
    same_dim(y.dim, x.dim, "take atan2 of")?;
    Ok(Value::num(y.v.atan2(x.v)))
}

fn round(args: &[Value]) -> Result<Value> {
    arity("round", args, |n| n == 1 || n == 2, "1 or 2 arguments")?;
    let q = args[0].as_num("the argument of round")?;
    let digits = match args.get(1) {
        Some(d) => d.as_int("the number of decimals")? as i32,
        None => 0,
    };
    let scale = 10f64.powi(digits);
    Ok(Value::Num(Quantity::new((q.v * scale).round() / scale, q.dim)))
}

fn sign(args: &[Value]) -> Result<Value> {
    arity("sign", args, |n| n == 1, "1 argument")?;
    let q = args[0].as_num("the argument of sign")?;
    Ok(Value::num(if q.v > 0.0 {
        1.0
    } else if q.v < 0.0 {
        -1.0
    } else {
        0.0
    }))
}

fn mod_(args: &[Value]) -> Result<Value> {
    arity("mod", args, |n| n == 2, "2 arguments")?;
    arith(BinaryOp::Mod, &args[0], &args[1])
}

fn sum_all(args: &[Value]) -> Result<Value> {
    let items = flatten(args);
    let mut acc = Value::num(0.0);
    for (k, v) in items.into_iter().enumerate() {
        acc = if k == 0 { v.clone() } else { arith(BinaryOp::Add, &acc, v)? };
    }
    Ok(acc)
}

fn mean(args: &[Value]) -> Result<Value> {
    let n = flatten(args).len();
    if n == 0 {
        bail!("mean needs at least one value");
    }
    arith(BinaryOp::Div, &sum_all(args)?, &Value::num(n as f64))
}

/// A vector's numbers and their common units.
pub(crate) type Vector = (Vec<f64>, Dim);

/// The numbers of a vector (row or column), all with the same units.
pub(crate) fn vector(name: &str, v: &Value) -> Result<Vector> {
    let m = matrix_arg(name, v)?;
    if m.rows != 1 && m.cols != 1 {
        bail!("{name} needs a vector, not a {}×{} matrix", m.rows, m.cols);
    }
    let mut dim = None;
    let mut out = Vec::with_capacity(m.data.len());
    for x in &m.data {
        let q = x.as_num(&format!("an element of the {name} vector"))?;
        match dim {
            None => dim = Some(q.dim),
            Some(d) => same_dim(d, q.dim, &format!("{name} a vector that mixes"))?,
        }
        out.push(q.v);
    }
    Ok((out, dim.unwrap_or(Dim::NONE)))
}

pub(crate) fn column(values: Vec<f64>, dim: Dim) -> Value {
    let n = values.len();
    Value::Matrix(Matrix::new(n, 1, values.into_iter().map(|v| Value::Num(Quantity::new(v, dim))).collect()))
}

fn sort(args: &[Value]) -> Result<Value> {
    arity("sort", args, |n| n == 1, "1 argument")?;
    let (mut v, dim) = vector("sort", &args[0])?;
    v.sort_by(f64::total_cmp);
    Ok(column(v, dim))
}

fn norm(args: &[Value]) -> Result<Value> {
    arity("norm", args, |n| n == 1, "1 argument")?;
    let (v, dim) = vector("norm", &args[0])?;
    Ok(Value::Num(Quantity::new(v.iter().map(|x| x * x).sum::<f64>().sqrt(), dim)))
}

fn two_vectors(name: &str, args: &[Value]) -> Result<(Vector, Vector)> {
    arity(name, args, |n| n == 2, "2 arguments")?;
    let a = vector(name, &args[0])?;
    let b = vector(name, &args[1])?;
    if a.0.len() != b.0.len() {
        bail!("{name} needs two vectors of the same length, not {} and {}", a.0.len(), b.0.len());
    }
    Ok((a, b))
}

fn dot(args: &[Value]) -> Result<Value> {
    let ((a, da), (b, db)) = two_vectors("dot", args)?;
    Ok(Value::Num(Quantity::new(a.iter().zip(&b).map(|(x, y)| x * y).sum(), da * db)))
}

fn cross(args: &[Value]) -> Result<Value> {
    let ((a, da), (b, db)) = two_vectors("cross", args)?;
    if a.len() != 3 {
        bail!("cross needs two vectors of 3 elements");
    }
    let c = vec![a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    Ok(column(c, da * db))
}

/// `lsolve(A, b)`: the x that makes A·x = b.
fn lsolve(args: &[Value]) -> Result<Value> {
    arity("lsolve", args, |n| n == 2, "2 arguments")?;
    let a = matrix_arg("lsolve", &args[0])?;
    if a.rows != a.cols {
        bail!("lsolve needs a square matrix, not {}×{}", a.rows, a.cols);
    }
    let rows = match &args[1] {
        Value::Matrix(m) => m.rows,
        _ => 1,
    };
    if rows != a.rows {
        bail!("lsolve: b needs {} rows to match the matrix, not {rows}", a.rows);
    }
    let inv = ops::inverse(a).map_err(|_| crate::error::EvalError::new("lsolve: the matrix is singular"))?;
    arith(BinaryOp::Mul, &inv, &args[1])
}

/// `linterp(xs, ys, x)`: straight lines between table points, extended past the ends.
fn linterp(args: &[Value]) -> Result<Value> {
    arity("linterp", args, |n| n == 3, "3 arguments")?;
    let (xs, xd) = vector("linterp", &args[0])?;
    let (ys, yd) = vector("linterp", &args[1])?;
    if xs.len() != ys.len() || xs.len() < 2 {
        bail!("linterp needs two vectors of the same length, with at least 2 points");
    }
    if xs.windows(2).any(|w| w[1] <= w[0]) {
        bail!("linterp needs the x values in increasing order");
    }
    let x = args[2].as_num("the point to interpolate at")?;
    same_dim(xd, x.dim, "interpolate between")?;
    let i = xs.partition_point(|&v| v <= x.v).clamp(1, xs.len() - 1);
    let t = (x.v - xs[i - 1]) / (xs[i] - xs[i - 1]);
    Ok(Value::Num(Quantity::new(ys[i - 1] + t * (ys[i] - ys[i - 1]), yd)))
}

fn one_matrix<'a>(name: &str, args: &'a [Value]) -> Result<&'a Matrix> {
    arity(name, args, |n| n == 1, "1 argument")?;
    matrix_arg(name, &args[0])
}

fn size(name: &str, args: &[Value]) -> Result<Value> {
    arity(name, args, |n| n == 1, "1 argument")?;
    let (r, c) = match &args[0] {
        Value::Matrix(m) => (m.rows, m.cols),
        _ => (1, 1),
    };
    Ok(Value::num(match name {
        "rows" => r,
        "cols" => c,
        _ => r * c,
    } as f64))
}

fn el(args: &[Value]) -> Result<Value> {
    arity("el", args, |n| n == 2 || n == 3, "2 or 3 arguments")?;
    index(&args[0], &args[1..])
}

fn transpose(args: &[Value]) -> Result<Value> {
    let m = one_matrix("transpose", args)?;
    let data = (0..m.cols).flat_map(|c| (0..m.rows).map(move |r| m.get(r, c).clone())).collect();
    Ok(Value::Matrix(Matrix::new(m.cols, m.rows, data)))
}

fn identity(args: &[Value]) -> Result<Value> {
    arity("identity", args, |n| n == 1, "1 argument")?;
    let n = args[0].as_int("the size")?;
    if !(1..=10_000).contains(&n) {
        bail!("identity size must be between 1 and 10000");
    }
    Ok(Value::Matrix(ops::identity(n as usize)))
}

/// SMath's `mat(a11, a12, …, rows, cols)`.
fn mat(args: &[Value]) -> Result<Value> {
    if args.len() < 3 {
        bail!("mat takes the elements followed by rows and cols");
    }
    let (cells, dims) = args.split_at(args.len() - 2);
    let r = dims[0].as_int("rows")? as usize;
    let c = dims[1].as_int("cols")? as usize;
    if r * c != cells.len() {
        bail!("mat: {r}×{c} needs {} elements, got {}", r * c, cells.len());
    }
    Ok(Value::Matrix(Matrix::new(r, c, cells.to_vec())))
}

fn range_fn(args: &[Value]) -> Result<Value> {
    arity("range", args, |n| n == 2 || n == 3, "2 or 3 arguments: range(start, end[, step])")?;
    let a = args[0].as_num("the start")?;
    let b = args[1].as_num("the end")?;
    let step = args.get(2).map(|s| s.as_num("the step")).transpose()?;
    range(a, b, step)
}

fn num2str(args: &[Value]) -> Result<Value> {
    arity("num2str", args, |n| n == 1, "1 argument")?;
    let x = args[0].as_scalar("the argument of num2str")?;
    Ok(Value::Str(format_number(x, 4, &DisplaySettings::default())))
}

fn concat(args: &[Value]) -> Result<Value> {
    let mut s = String::new();
    for a in args {
        match a {
            Value::Str(t) => s.push_str(t),
            other => bail!("concat joins strings, not {}", other.kind()),
        }
    }
    Ok(Value::Str(s))
}

/// Dimension of `x^n` for display of derivatives and integrals.
pub fn dim_pow(d: Dim, n: i32) -> Dim {
    d.pow(Rational::int(n))
}
