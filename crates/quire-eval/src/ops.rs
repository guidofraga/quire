//! Arithmetic on values with dimension checking.

use quire_ast::{BinaryOp, CmpOp};
use quire_units::{Dim, Rational};

use crate::error::{Result, bail};
use crate::format::describe_dim;
use crate::value::{Matrix, Quantity, Value};

pub fn same_dim(a: Dim, b: Dim, verb: &str) -> Result<()> {
    if a != b {
        bail!("cannot {verb} {} and {}: units don't match", describe_dim(a), describe_dim(b));
    }
    Ok(())
}

fn check(v: f64, what: &str) -> Result<f64> {
    if v.is_nan() {
        bail!("{what} has no real result (complex numbers are not supported yet)");
    }
    Ok(v)
}

pub fn pow(x: Quantity, y: Quantity) -> Result<Quantity> {
    if !y.dim.is_dimensionless() {
        bail!("an exponent must be a plain number, but this one is {}", describe_dim(y.dim));
    }
    let dim = if x.dim.is_dimensionless() {
        Dim::NONE
    } else {
        match Rational::approx(y.v) {
            Some(r) => x.dim.pow(r),
            None => bail!("cannot raise {} to the power {}", describe_dim(x.dim), y.v),
        }
    };
    let v = if y.v.fract() == 0.0 && y.v.abs() < 1e9 { x.v.powi(y.v as i32) } else { x.v.powf(y.v) };
    Ok(Quantity::new(check(v, "this power")?, dim))
}

fn num_op(op: BinaryOp, x: Quantity, y: Quantity) -> Result<Quantity> {
    Ok(match op {
        BinaryOp::Add => {
            same_dim(x.dim, y.dim, "add")?;
            Quantity::new(x.v + y.v, x.dim)
        }
        BinaryOp::Sub => {
            same_dim(x.dim, y.dim, "subtract")?;
            Quantity::new(x.v - y.v, x.dim)
        }
        BinaryOp::Mul | BinaryOp::Juxt => Quantity::new(x.v * y.v, x.dim * y.dim),
        BinaryOp::Div => {
            if y.v == 0.0 {
                bail!("division by zero");
            }
            Quantity::new(x.v / y.v, x.dim / y.dim)
        }
        BinaryOp::Mod => {
            same_dim(x.dim, y.dim, "take the remainder of")?;
            if y.v == 0.0 {
                bail!("remainder by zero");
            }
            Quantity::new(x.v % y.v, x.dim)
        }
        BinaryOp::Pow => pow(x, y)?,
        BinaryOp::PlusMinus => bail!("± gives two results; this is not supported yet"),
        BinaryOp::And | BinaryOp::Or => unreachable!("logical operators are evaluated lazily"),
    })
}

fn map(m: &Matrix, f: impl Fn(&Value) -> Result<Value>) -> Result<Value> {
    let data = m.data.iter().map(f).collect::<Result<Vec<_>>>()?;
    Ok(Value::Matrix(Matrix::new(m.rows, m.cols, data)))
}

pub fn arith(op: BinaryOp, a: &Value, b: &Value) -> Result<Value> {
    use Value::{Matrix as M, Num};
    let op = if op == BinaryOp::Juxt { BinaryOp::Mul } else { op };
    match (a, b) {
        (Num(x), Num(y)) => Ok(Num(num_op(op, *x, *y)?)),
        (M(m), M(n)) => match op {
            BinaryOp::Add | BinaryOp::Sub => {
                if (m.rows, m.cols) != (n.rows, n.cols) {
                    bail!("cannot add a {}×{} matrix and a {}×{} matrix", m.rows, m.cols, n.rows, n.cols);
                }
                let data = m.data.iter().zip(&n.data).map(|(x, y)| arith(op, x, y)).collect::<Result<_>>()?;
                Ok(M(Matrix::new(m.rows, m.cols, data)))
            }
            BinaryOp::Mul => matmul(m, n),
            _ => bail!("'{}' is not defined between two matrices", op.symbol()),
        },
        (M(m), Num(y)) => match op {
            BinaryOp::Pow => matrix_pow(m, *y),
            _ => map(m, |e| arith(op, e, b)),
        },
        (Num(_), M(m)) => match op {
            BinaryOp::Mul | BinaryOp::Add | BinaryOp::Sub => map(m, |e| arith(op, a, e)),
            _ => bail!("'{}' is not defined for a number and a matrix", op.symbol()),
        },
        _ => bail!("'{}' cannot combine {} and {}", op.symbol(), a.kind(), b.kind()),
    }
}

pub fn negate(v: &Value) -> Result<Value> {
    match v {
        Value::Num(q) => Ok(Value::Num(Quantity::new(-q.v, q.dim))),
        Value::Matrix(m) => map(m, negate),
        Value::Str(_) => bail!("cannot negate a string"),
    }
}

pub fn compare(op: CmpOp, a: &Value, b: &Value) -> Result<bool> {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => {
            same_dim(x.dim, y.dim, "compare")?;
            let eq = x.v == y.v || (x.v - y.v).abs() <= 1e-12 * x.v.abs().max(y.v.abs());
            Ok(match op {
                CmpOp::Eq => eq,
                CmpOp::Ne => !eq,
                CmpOp::Lt => x.v < y.v && !eq,
                CmpOp::Le => x.v < y.v || eq,
                CmpOp::Gt => x.v > y.v && !eq,
                CmpOp::Ge => x.v > y.v || eq,
            })
        }
        (Value::Str(x), Value::Str(y)) => match op {
            CmpOp::Eq => Ok(x == y),
            CmpOp::Ne => Ok(x != y),
            _ => bail!("strings can only be compared with == and ≠"),
        },
        (Value::Matrix(m), Value::Matrix(n)) if matches!(op, CmpOp::Eq | CmpOp::Ne) => {
            let mut eq = (m.rows, m.cols) == (n.rows, n.cols);
            if eq {
                for (x, y) in m.data.iter().zip(&n.data) {
                    eq &= compare(CmpOp::Eq, x, y)?;
                }
            }
            Ok(eq == (op == CmpOp::Eq))
        }
        _ => bail!("cannot compare {} with {}", a.kind(), b.kind()),
    }
}

pub fn matmul(m: &Matrix, n: &Matrix) -> Result<Value> {
    if m.cols != n.rows {
        bail!("cannot multiply a {}×{} matrix by a {}×{} matrix", m.rows, m.cols, n.rows, n.cols);
    }
    let mut data = Vec::with_capacity(m.rows * n.cols);
    for i in 0..m.rows {
        for j in 0..n.cols {
            let mut acc = arith(BinaryOp::Mul, m.get(i, 0), n.get(0, j))?;
            for k in 1..m.cols {
                acc = arith(BinaryOp::Add, &acc, &arith(BinaryOp::Mul, m.get(i, k), n.get(k, j))?)?;
            }
            data.push(acc);
        }
    }
    Ok(Value::Matrix(Matrix::new(m.rows, n.cols, data)))
}

/// All elements numeric with one common dimension → (values, dim).
pub fn uniform(m: &Matrix, what: &str) -> Result<(Vec<f64>, Dim)> {
    let mut dim = None;
    let mut vals = Vec::with_capacity(m.data.len());
    for e in &m.data {
        let q = e.as_num(what)?;
        match dim {
            None => dim = Some(q.dim),
            Some(d) => same_dim(d, q.dim, "mix")?,
        }
        vals.push(q.v);
    }
    Ok((vals, dim.unwrap_or(Dim::NONE)))
}

pub fn identity(n: usize) -> Matrix {
    let data = (0..n * n).map(|k| Value::num(if k / n == k % n { 1.0 } else { 0.0 })).collect();
    Matrix::new(n, n, data)
}

/// Gaussian elimination with partial pivoting; returns (determinant, inverse?).
fn lu(m: &Matrix, want_inverse: bool) -> Result<(f64, Option<Vec<f64>>, Dim)> {
    if m.rows != m.cols {
        bail!("the matrix must be square, but is {}×{}", m.rows, m.cols);
    }
    let n = m.rows;
    let (mut a, dim) = uniform(m, "a matrix element")?;
    let mut inv: Vec<f64> = (0..n * n).map(|k| if k / n == k % n { 1.0 } else { 0.0 }).collect();
    let mut det = 1.0;
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i * n + c].abs().total_cmp(&a[j * n + c].abs())).unwrap();
        if a[p * n + c] == 0.0 {
            return Ok((0.0, None, dim));
        }
        if p != c {
            for k in 0..n {
                a.swap(p * n + k, c * n + k);
                inv.swap(p * n + k, c * n + k);
            }
            det = -det;
        }
        let piv = a[c * n + c];
        det *= piv;
        for k in 0..n {
            a[c * n + k] /= piv;
            inv[c * n + k] /= piv;
        }
        for r in 0..n {
            if r != c {
                let f = a[r * n + c];
                if f != 0.0 {
                    for k in 0..n {
                        a[r * n + k] -= f * a[c * n + k];
                        inv[r * n + k] -= f * inv[c * n + k];
                    }
                }
            }
        }
    }
    Ok((det, want_inverse.then_some(inv), dim))
}

pub fn det(m: &Matrix) -> Result<Value> {
    let (d, _, dim) = lu(m, false)?;
    Ok(Value::Num(Quantity::new(d, dim.pow(Rational::int(m.rows as i32)))))
}

pub fn inverse(m: &Matrix) -> Result<Value> {
    let (_, inv, dim) = lu(m, true)?;
    let Some(inv) = inv else { bail!("the matrix is singular and has no inverse") };
    let inv_dim = Dim::NONE / dim;
    let data = inv.into_iter().map(|v| Value::Num(Quantity::new(v, inv_dim))).collect();
    Ok(Value::Matrix(Matrix::new(m.rows, m.cols, data)))
}

fn matrix_pow(m: &Matrix, y: Quantity) -> Result<Value> {
    let k = Value::Num(y).as_int("a matrix exponent")?;
    if m.rows != m.cols {
        bail!("only square matrices can be raised to a power");
    }
    let base = if k < 0 { inverse(m)? } else { Value::Matrix(m.clone()) };
    let Value::Matrix(base) = base else { unreachable!() };
    let mut acc = Value::Matrix(identity(m.rows));
    for _ in 0..k.unsigned_abs() {
        let Value::Matrix(a) = &acc else { unreachable!() };
        acc = matmul(a, &base)?;
    }
    Ok(acc)
}
