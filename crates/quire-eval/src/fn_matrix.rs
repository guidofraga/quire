//! Matrix and vector functions from SMath (col, row, submatrix, …).
//!
//! Indices start at 1, as in SMath. Results keep the units of the elements
//! they come from; functions that need one common unit say so in the error.
// Numeric kernels below index several arrays with the same counters.
#![allow(clippy::needless_range_loop)]

use quire_units::Dim;

use crate::error::{Result, bail};
use crate::ops::{self, same_dim, uniform};
use crate::value::{Matrix, Quantity, Value};

/// `None` when `name` is not one of this module's functions.
pub fn call(name: &str, args: &[Value]) -> Option<Result<Value>> {
    let r = match name {
        "col" => col(args),
        "row" => row(args),
        "submatrix" => submatrix(args),
        "last" => last(args),
        "reverse" => reverse(args),
        "product" => product(args),
        "diag" => diag(args),
        "trace" => trace(args),
        "rank" => rank(args),
        "matrix" => zeros(args),
        "invert" => one_matrix(name, args).and_then(ops::inverse),
        "norm1" | "norm2" | "normi" | "norme" => matrix_norm(name, args),
        "csort" => csort(args),
        "rsort" => rsort(args),
        "eigenvals" => eigenvals(args),
        "eigenvecs" => eigenvecs(args),
        "cinterp" => cinterp(args),
        "lookup" => lookup(args),
        "vlookup" => vhlookup(name, args, true),
        "hlookup" => vhlookup(name, args, false),
        _ => return None,
    };
    Some(r)
}

// ---------------------------------------------------------------- helpers

fn arity(name: &str, args: &[Value], ok: impl Fn(usize) -> bool, expected: &str) -> Result<()> {
    if !ok(args.len()) {
        bail!("{name} takes {expected}, but got {}", args.len());
    }
    Ok(())
}

fn matrix_arg<'a>(name: &str, v: &'a Value) -> Result<&'a Matrix> {
    match v {
        Value::Matrix(m) => Ok(m),
        other => bail!("{name} needs a matrix, not {}", other.kind()),
    }
}

fn one_matrix<'a>(name: &str, args: &'a [Value]) -> Result<&'a Matrix> {
    arity(name, args, |n| n == 1, "1 argument")?;
    matrix_arg(name, &args[0])
}

fn vector_arg<'a>(name: &str, v: &'a Value) -> Result<&'a Matrix> {
    let m = matrix_arg(name, v)?;
    if !m.is_vector() {
        bail!("{name} needs a vector, not a {}×{} matrix", m.rows, m.cols);
    }
    Ok(m)
}

fn square_arg<'a>(name: &str, args: &'a [Value]) -> Result<&'a Matrix> {
    let m = one_matrix(name, args)?;
    if m.rows != m.cols {
        bail!("{name} needs a square matrix, not {}×{}", m.rows, m.cols);
    }
    Ok(m)
}

/// A 1-based index argument → 0-based, checked against `n`.
fn index_arg(name: &str, v: &Value, n: usize, what: &str) -> Result<usize> {
    let k = v.as_int(&format!("the {what} index of {name}"))?;
    if k < 1 || k as usize > n {
        bail!("{name}: {what} {k} is outside 1…{n} (indices start at 1)");
    }
    Ok(k as usize - 1)
}

/// Numbers with one common unit (`ops::uniform` with this function's name).
fn numbers(name: &str, m: &Matrix) -> Result<(Vec<f64>, Dim)> {
    uniform(m, &format!("an element of the {name} matrix"))
}

fn grid(rows: usize, cols: usize, vals: Vec<f64>, dim: Dim) -> Value {
    let data = vals.into_iter().map(|v| Value::Num(Quantity::new(v, dim))).collect();
    Value::Matrix(Matrix::new(rows, cols, data))
}

fn column(vals: Vec<f64>, dim: Dim) -> Value {
    let n = vals.len();
    grid(n, 1, vals, dim)
}

// ------------------------------------------------------- slicing & shape

/// `col(M, j)`: column j of M, as a column vector.
fn col(args: &[Value]) -> Result<Value> {
    arity("col", args, |n| n == 2, "2 arguments")?;
    let m = matrix_arg("col", &args[0])?;
    let j = index_arg("col", &args[1], m.cols, "column")?;
    Ok(Value::Matrix(Matrix::column((0..m.rows).map(|r| m.get(r, j).clone()).collect())))
}

/// `row(M, i)`: row i of M, as a row vector.
fn row(args: &[Value]) -> Result<Value> {
    arity("row", args, |n| n == 2, "2 arguments")?;
    let m = matrix_arg("row", &args[0])?;
    let i = index_arg("row", &args[1], m.rows, "row")?;
    let data = (0..m.cols).map(|c| m.get(i, c).clone()).collect();
    Ok(Value::Matrix(Matrix::new(1, m.cols, data)))
}

/// `submatrix(M, r1, r2, c1, c2)`: rows r1…r2 and columns c1…c2 (inclusive).
fn submatrix(args: &[Value]) -> Result<Value> {
    arity("submatrix", args, |n| n == 5, "5 arguments: submatrix(M, r1, r2, c1, c2)")?;
    let m = matrix_arg("submatrix", &args[0])?;
    let r1 = index_arg("submatrix", &args[1], m.rows, "row")?;
    let r2 = index_arg("submatrix", &args[2], m.rows, "row")?;
    let c1 = index_arg("submatrix", &args[3], m.cols, "column")?;
    let c2 = index_arg("submatrix", &args[4], m.cols, "column")?;
    if r1 > r2 || c1 > c2 {
        bail!("submatrix needs r1 ≤ r2 and c1 ≤ c2");
    }
    let data = (r1..=r2).flat_map(|r| (c1..=c2).map(move |c| m.get(r, c).clone())).collect();
    Ok(Value::Matrix(Matrix::new(r2 - r1 + 1, c2 - c1 + 1, data)))
}

/// `last(v)`: index of the last element of a vector (= its length).
fn last(args: &[Value]) -> Result<Value> {
    arity("last", args, |n| n == 1, "1 argument")?;
    let v = vector_arg("last", &args[0])?;
    Ok(Value::num(v.data.len() as f64))
}

/// `reverse(v)`: a vector backwards, or the rows of a matrix in reverse order.
fn reverse(args: &[Value]) -> Result<Value> {
    let m = one_matrix("reverse", args)?;
    let data = if m.rows == 1 {
        m.data.iter().rev().cloned().collect()
    } else {
        (0..m.rows).rev().flat_map(|r| (0..m.cols).map(move |c| m.get(r, c).clone())).collect()
    };
    Ok(Value::Matrix(Matrix::new(m.rows, m.cols, data)))
}

/// `matrix(r, c)`: an r×c matrix of zeros.
fn zeros(args: &[Value]) -> Result<Value> {
    arity("matrix", args, |n| n == 2, "2 arguments: matrix(rows, cols)")?;
    let r = args[0].as_int("the number of rows")?;
    let c = args[1].as_int("the number of columns")?;
    if !(1..=10_000).contains(&r) || !(1..=10_000).contains(&c) {
        bail!("matrix: rows and cols must be between 1 and 10000");
    }
    let (r, c) = (r as usize, c as usize);
    Ok(grid(r, c, vec![0.0; r * c], Dim::NONE))
}

/// `diag(v)`: square matrix with v on the diagonal (zeros in v's units);
/// `diag(M)`: the diagonal of a square M as a column vector.
fn diag(args: &[Value]) -> Result<Value> {
    let m = one_matrix("diag", args)?;
    if m.is_vector() {
        let (vals, dim) = numbers("diag", m)?;
        let n = vals.len();
        let mut out = vec![0.0; n * n];
        for (k, v) in vals.into_iter().enumerate() {
            out[k * n + k] = v;
        }
        return Ok(grid(n, n, out, dim));
    }
    if m.rows != m.cols {
        bail!("diag needs a vector or a square matrix, not {}×{}", m.rows, m.cols);
    }
    Ok(Value::Matrix(Matrix::column((0..m.rows).map(|k| m.get(k, k).clone()).collect())))
}

// ------------------------------------------------------------ reductions

/// `product(v)`: product of all elements; units multiply.
fn product(args: &[Value]) -> Result<Value> {
    arity("product", args, |n| n == 1, "1 argument (or 4 for product(expr, i, a, b))")?;
    let items: Vec<&Value> = match &args[0] {
        Value::Matrix(m) => m.data.iter().collect(),
        v => vec![v],
    };
    let mut acc = Quantity::scalar(1.0);
    for v in items {
        let q = v.as_num("an element of product")?;
        acc = Quantity::new(acc.v * q.v, acc.dim * q.dim);
    }
    Ok(Value::Num(acc))
}

/// `trace(M)`: sum of the diagonal of a square matrix.
fn trace(args: &[Value]) -> Result<Value> {
    let m = square_arg("trace", args)?;
    let mut acc = m.get(0, 0).as_num("a diagonal element of trace")?;
    for k in 1..m.rows {
        let q = m.get(k, k).as_num("a diagonal element of trace")?;
        same_dim(acc.dim, q.dim, "add")?;
        acc.v += q.v;
    }
    Ok(Value::Num(acc))
}

/// `rank(M)`: number of independent rows (Gaussian elimination, relative tolerance).
fn rank(args: &[Value]) -> Result<Value> {
    let m = one_matrix("rank", args)?;
    // Rank does not depend on units: each element is used by its SI value.
    let mut a = Vec::with_capacity(m.data.len());
    for e in &m.data {
        a.push(e.as_num("an element of the rank matrix")?.v);
    }
    let (rows, cols) = (m.rows, m.cols);
    let max = a.iter().fold(0.0f64, |s, x| s.max(x.abs()));
    let tol = 1e-10 * max;
    let mut r = 0;
    for c in 0..cols {
        if r == rows {
            break;
        }
        let p = (r..rows).max_by(|&i, &j| a[i * cols + c].abs().total_cmp(&a[j * cols + c].abs())).unwrap();
        if a[p * cols + c].abs() <= tol {
            continue;
        }
        for k in 0..cols {
            a.swap(p * cols + k, r * cols + k);
        }
        for i in r + 1..rows {
            let f = a[i * cols + c] / a[r * cols + c];
            for k in c..cols {
                a[i * cols + k] -= f * a[r * cols + k];
            }
        }
        r += 1;
    }
    Ok(Value::num(r as f64))
}

/// `norm1` (max column sum), `norm2` (largest singular value), `normi` (max row sum),
/// `norme` (Frobenius). The result has the matrix units.
fn matrix_norm(name: &str, args: &[Value]) -> Result<Value> {
    let m = one_matrix(name, args)?;
    let (a, dim) = numbers(name, m)?;
    let (rows, cols) = (m.rows, m.cols);
    let v = match name {
        "norm1" => {
            (0..cols).map(|c| (0..rows).map(|r| a[r * cols + c].abs()).sum::<f64>()).fold(0.0, f64::max)
        }
        "normi" => {
            (0..rows).map(|r| (0..cols).map(|c| a[r * cols + c].abs()).sum::<f64>()).fold(0.0, f64::max)
        }
        "norme" => a.iter().map(|x| x * x).sum::<f64>().sqrt(),
        _ => {
            // Square root of the largest eigenvalue of MᵀM.
            let mut ata = vec![0.0; cols * cols];
            for i in 0..cols {
                for j in 0..cols {
                    ata[i * cols + j] = (0..rows).map(|r| a[r * cols + i] * a[r * cols + j]).sum();
                }
            }
            let (vals, _) = jacobi(ata, cols);
            vals.into_iter().fold(0.0, f64::max).sqrt()
        }
    };
    Ok(Value::Num(Quantity::new(v, dim)))
}

// --------------------------------------------------------------- sorting

/// `csort(M, j)`: rows of M reordered so column j increases (stable).
fn csort(args: &[Value]) -> Result<Value> {
    arity("csort", args, |n| n == 2, "2 arguments")?;
    let m = matrix_arg("csort", &args[0])?;
    let j = index_arg("csort", &args[1], m.cols, "column")?;
    let order = sort_keys("csort", (0..m.rows).map(|r| m.get(r, j)))?;
    let data = order.iter().flat_map(|&r| (0..m.cols).map(move |c| m.get(r, c).clone())).collect();
    Ok(Value::Matrix(Matrix::new(m.rows, m.cols, data)))
}

/// `rsort(M, i)`: columns of M reordered so row i increases (stable).
fn rsort(args: &[Value]) -> Result<Value> {
    arity("rsort", args, |n| n == 2, "2 arguments")?;
    let m = matrix_arg("rsort", &args[0])?;
    let i = index_arg("rsort", &args[1], m.rows, "row")?;
    let order = sort_keys("rsort", (0..m.cols).map(|c| m.get(i, c)))?;
    let data = (0..m.rows).flat_map(|r| order.iter().map(move |&c| m.get(r, c).clone())).collect();
    Ok(Value::Matrix(Matrix::new(m.rows, m.cols, data)))
}

/// Stable ascending order of the key values (numbers with one unit).
fn sort_keys<'a>(name: &str, keys: impl Iterator<Item = &'a Value>) -> Result<Vec<usize>> {
    let mut vals = Vec::new();
    let mut dim = None;
    for k in keys {
        let q = k.as_num(&format!("a sort key of {name}"))?;
        match dim {
            None => dim = Some(q.dim),
            Some(d) => same_dim(d, q.dim, &format!("{name} keys that mix"))?,
        }
        vals.push(q.v);
    }
    let mut order: Vec<usize> = (0..vals.len()).collect();
    order.sort_by(|&x, &y| vals[x].total_cmp(&vals[y]));
    Ok(order)
}

// ----------------------------------------------------------- eigenvalues

/// `eigenvals(M)`: real eigenvalues of a square matrix, ascending, with M's units.
fn eigenvals(args: &[Value]) -> Result<Value> {
    let m = square_arg("eigenvals", args)?;
    let (vals, _, dim) = eigen("eigenvals", m, false)?;
    Ok(column(vals, dim))
}

/// `eigenvecs(M)`: unit eigenvectors as columns, in the order of `eigenvals(M)`.
fn eigenvecs(args: &[Value]) -> Result<Value> {
    let m = square_arg("eigenvecs", args)?;
    let n = m.rows;
    let (_, vecs, _) = eigen("eigenvecs", m, true)?;
    let mut out = vec![0.0; n * n];
    for (c, v) in vecs.iter().enumerate() {
        for r in 0..n {
            out[r * n + c] = v[r];
        }
    }
    Ok(grid(n, n, out, Dim::NONE))
}

/// A pair (eigenvalue, eigenvector — empty until computed).
type Eigenpair = (f64, Vec<f64>);

/// Eigenvalues (ascending) and, when asked, unit eigenvectors.
/// Symmetric matrices use Jacobi rotations; others Hessenberg + shifted QR
/// for the values and inverse iteration for the vectors.
fn eigen(name: &str, m: &Matrix, want_vecs: bool) -> Result<(Vec<f64>, Vec<Vec<f64>>, Dim)> {
    let n = m.rows;
    let (a, dim) = numbers(name, m)?;
    let anorm = a.iter().fold(0.0f64, |s, x| s.max(x.abs()));
    let symmetric = (0..n).all(|i| (0..i).all(|j| (a[i * n + j] - a[j * n + i]).abs() <= 1e-12 * anorm));
    let mut pairs: Vec<Eigenpair>;
    if symmetric {
        let (vals, v) = jacobi(a.clone(), n);
        pairs =
            vals.into_iter().enumerate().map(|(k, l)| (l, (0..n).map(|r| v[r * n + k]).collect())).collect();
    } else {
        let (wr, wi) = hqr(name, &a, n)?;
        if wi.iter().any(|x| x.abs() > 1e-9 * anorm) {
            bail!("{name}: complex eigenvalues are not supported yet");
        }
        pairs = wr.into_iter().map(|l| (l, Vec::new())).collect();
    }
    pairs.sort_by(|x, y| x.0.total_cmp(&y.0));
    if want_vecs && !symmetric {
        let scale = if anorm > 0.0 { anorm } else { 1.0 };
        for k in 0..n {
            let lam = pairs[k].0;
            let same: Vec<Vec<f64>> = pairs[..k]
                .iter()
                .filter(|p| (p.0 - lam).abs() <= 1e-8 * scale)
                .map(|p| p.1.clone())
                .collect();
            pairs[k].1 = inverse_iteration(&a, n, lam, scale, &same);
        }
    }
    let vals = pairs.iter().map(|p| p.0).collect();
    let vecs = pairs
        .into_iter()
        .map(|(_, mut v)| {
            // Unit length, largest component positive.
            let len = v.iter().map(|x| x * x).sum::<f64>().sqrt();
            let big = v.iter().fold(0.0f64, |b, &x| if x.abs() > b.abs() + 1e-12 { x } else { b });
            let s = if big < 0.0 { -1.0 } else { 1.0 };
            if len > 0.0 {
                v.iter_mut().for_each(|x| *x *= s / len);
            }
            v
        })
        .collect();
    Ok((vals, vecs, dim))
}

/// Cyclic Jacobi on a symmetric n×n matrix (row-major) → (eigenvalues, V with
/// the eigenvectors as columns).
fn jacobi(mut a: Vec<f64>, n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut v: Vec<f64> = (0..n * n).map(|k| if k / n == k % n { 1.0 } else { 0.0 }).collect();
    let total: f64 = a.iter().map(|x| x * x).sum();
    for _ in 0..100 {
        let off: f64 = (0..n * n).filter(|k| k / n != k % n).map(|k| a[k] * a[k]).sum();
        if off <= 1e-30 * total {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq == 0.0 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let (akp, akq) = (a[k * n + p], a[k * n + q]);
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let (apk, aqk) = (a[p * n + k], a[q * n + k]);
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for k in 0..n {
                    let (vkp, vkq) = (v[k * n + p], v[k * n + q]);
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    ((0..n).map(|k| a[k * n + k]).collect(), v)
}

/// Eigenvalues (real parts, imaginary parts) of a general real matrix:
/// reduction to Hessenberg form by elimination, then Francis double-shift QR
/// (after Numerical Recipes `elmhes`/`hqr`). 1-based indexing internally.
// p, q, r carry over between QR sweeps as in the original; the first sweep sets them
#[allow(unused_assignments)]
fn hqr(name: &str, src: &[f64], n: usize) -> Result<(Vec<f64>, Vec<f64>)> {
    let w = n + 1;
    let mut a = vec![0.0; w * w];
    for i in 0..n {
        for j in 0..n {
            a[(i + 1) * w + j + 1] = src[i * n + j];
        }
    }
    let at = |i: i64, j: i64| (i as usize) * w + j as usize;
    let n = n as i64;

    // Hessenberg form (elmhes).
    for m in 2..n {
        let mut x: f64 = 0.0;
        let mut i = m;
        for j in m..=n {
            if a[at(j, m - 1)].abs() > x.abs() {
                x = a[at(j, m - 1)];
                i = j;
            }
        }
        if i != m {
            for j in m - 1..=n {
                a.swap(at(i, j), at(m, j));
            }
            for j in 1..=n {
                a.swap(at(j, i), at(j, m));
            }
        }
        if x != 0.0 {
            for i in m + 1..=n {
                let mut y = a[at(i, m - 1)];
                if y != 0.0 {
                    y /= x;
                    a[at(i, m - 1)] = y;
                    for j in m..=n {
                        a[at(i, j)] -= y * a[at(m, j)];
                    }
                    for j in 1..=n {
                        a[at(j, m)] += y * a[at(j, i)];
                    }
                }
            }
        }
    }
    for i in 1..=n {
        for j in 1..i - 1 {
            a[at(i, j)] = 0.0;
        }
    }

    // Shifted QR (hqr).
    let mut wr = vec![0.0; n as usize + 1];
    let mut wi = vec![0.0; n as usize + 1];
    let mut anorm = 0.0;
    for i in 1..=n {
        for j in (i - 1).max(1)..=n {
            anorm += a[at(i, j)].abs();
        }
    }
    let sign = |a: f64, b: f64| if b >= 0.0 { a.abs() } else { -a.abs() };
    let mut nn = n;
    let mut t = 0.0;
    let (mut p, mut q, mut r) = (0.0, 0.0, 0.0);
    while nn >= 1 {
        let mut its = 0;
        loop {
            let mut l = nn;
            while l >= 2 {
                let mut s = a[at(l - 1, l - 1)].abs() + a[at(l, l)].abs();
                if s == 0.0 {
                    s = anorm;
                }
                if a[at(l, l - 1)].abs() + s == s {
                    a[at(l, l - 1)] = 0.0;
                    break;
                }
                l -= 1;
            }
            let mut x = a[at(nn, nn)];
            if l == nn {
                wr[nn as usize] = x + t;
                wi[nn as usize] = 0.0;
                nn -= 1;
            } else {
                let mut y = a[at(nn - 1, nn - 1)];
                let mut ww = a[at(nn, nn - 1)] * a[at(nn - 1, nn)];
                if l == nn - 1 {
                    p = 0.5 * (y - x);
                    q = p * p + ww;
                    let mut z = q.abs().sqrt();
                    x += t;
                    let (k1, k2) = ((nn - 1) as usize, nn as usize);
                    if q >= 0.0 {
                        z = p + sign(z, p);
                        wr[k1] = x + z;
                        wr[k2] = x + z;
                        if z != 0.0 {
                            wr[k2] = x - ww / z;
                        }
                        wi[k1] = 0.0;
                        wi[k2] = 0.0;
                    } else {
                        wr[k1] = x + p;
                        wr[k2] = x + p;
                        wi[k1] = -z;
                        wi[k2] = z;
                    }
                    nn -= 2;
                } else {
                    if its == 60 {
                        bail!("{name}: the eigenvalue iteration did not converge");
                    }
                    if its == 10 || its == 20 || its == 40 {
                        // Exceptional shift.
                        t += x;
                        for i in 1..=nn {
                            a[at(i, i)] -= x;
                        }
                        let s = a[at(nn, nn - 1)].abs() + a[at(nn - 1, nn - 2)].abs();
                        x = 0.75 * s;
                        y = x;
                        ww = -0.4375 * s * s;
                    }
                    its += 1;
                    let mut m = nn - 2;
                    let mut z;
                    loop {
                        z = a[at(m, m)];
                        let r0 = x - z;
                        let s0 = y - z;
                        p = (r0 * s0 - ww) / a[at(m + 1, m)] + a[at(m, m + 1)];
                        q = a[at(m + 1, m + 1)] - z - r0 - s0;
                        r = a[at(m + 2, m + 1)];
                        let s = p.abs() + q.abs() + r.abs();
                        p /= s;
                        q /= s;
                        r /= s;
                        if m == l {
                            break;
                        }
                        let u = a[at(m, m - 1)].abs() * (q.abs() + r.abs());
                        let v = p.abs() * (a[at(m - 1, m - 1)].abs() + z.abs() + a[at(m + 1, m + 1)].abs());
                        if u + v == v {
                            break;
                        }
                        m -= 1;
                    }
                    for i in m + 2..=nn {
                        a[at(i, i - 2)] = 0.0;
                        if i != m + 2 {
                            a[at(i, i - 3)] = 0.0;
                        }
                    }
                    for k in m..nn {
                        if k != m {
                            p = a[at(k, k - 1)];
                            q = a[at(k + 1, k - 1)];
                            r = 0.0;
                            if k != nn - 1 {
                                r = a[at(k + 2, k - 1)];
                            }
                            x = p.abs() + q.abs() + r.abs();
                            if x != 0.0 {
                                p /= x;
                                q /= x;
                                r /= x;
                            }
                        }
                        let s = sign((p * p + q * q + r * r).sqrt(), p);
                        if s != 0.0 {
                            if k == m {
                                if l != m {
                                    a[at(k, k - 1)] = -a[at(k, k - 1)];
                                }
                            } else {
                                a[at(k, k - 1)] = -s * x;
                            }
                            p += s;
                            x = p / s;
                            y = q / s;
                            z = r / s;
                            q /= p;
                            r /= p;
                            for j in k..=nn {
                                p = a[at(k, j)] + q * a[at(k + 1, j)];
                                if k != nn - 1 {
                                    p += r * a[at(k + 2, j)];
                                    a[at(k + 2, j)] -= p * z;
                                }
                                a[at(k + 1, j)] -= p * y;
                                a[at(k, j)] -= p * x;
                            }
                            let mmin = nn.min(k + 3);
                            for i in l..=mmin {
                                p = x * a[at(i, k)] + y * a[at(i, k + 1)];
                                if k != nn - 1 {
                                    p += z * a[at(i, k + 2)];
                                    a[at(i, k + 2)] -= p * r;
                                }
                                a[at(i, k + 1)] -= p * q;
                                a[at(i, k)] -= p;
                            }
                        }
                    }
                }
            }
            if l >= nn - 1 {
                break;
            }
        }
    }
    Ok((wr[1..].to_vec(), wi[1..].to_vec()))
}

/// Eigenvector for the eigenvalue `lam` by inverse iteration, kept apart from
/// earlier vectors of the same eigenvalue.
fn inverse_iteration(a: &[f64], n: usize, lam: f64, scale: f64, same: &[Vec<f64>]) -> Vec<f64> {
    let mut b = a.to_vec();
    for k in 0..n {
        b[k * n + k] -= lam + 1e-10 * scale;
    }
    let project = |x: &mut Vec<f64>| {
        for v in same {
            let d: f64 = x.iter().zip(v).map(|(p, q)| p * q).sum();
            x.iter_mut().zip(v).for_each(|(p, q)| *p -= d * q);
        }
    };
    let mut x: Vec<f64> = (0..n).map(|i| 1.0 + 0.37 * i as f64).collect();
    for _ in 0..6 {
        project(&mut x);
        let len = x.iter().map(|p| p * p).sum::<f64>().sqrt();
        if len > 0.0 {
            x.iter_mut().for_each(|p| *p /= len);
        }
        x = solve(&b, n, x, 1e-14 * scale);
    }
    project(&mut x);
    x
}

/// Gaussian elimination with partial pivoting; zero pivots become `tiny`.
fn solve(m: &[f64], n: usize, mut x: Vec<f64>, tiny: f64) -> Vec<f64> {
    let mut a = m.to_vec();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i * n + c].abs().total_cmp(&a[j * n + c].abs())).unwrap();
        if p != c {
            for k in 0..n {
                a.swap(p * n + k, c * n + k);
            }
            x.swap(p, c);
        }
        if a[c * n + c].abs() < tiny {
            a[c * n + c] = tiny;
        }
        for r in c + 1..n {
            let f = a[r * n + c] / a[c * n + c];
            for k in c..n {
                a[r * n + k] -= f * a[c * n + k];
            }
            x[r] -= f * x[c];
        }
    }
    for c in (0..n).rev() {
        let s: f64 = (c + 1..n).map(|k| a[c * n + k] * x[k]).sum();
        x[c] = (x[c] - s) / a[c * n + c];
    }
    x
}

// ---------------------------------------------------------- interpolation

/// Numbers of a vector with one common unit.
fn vector(name: &str, v: &Value) -> Result<(Vec<f64>, Dim)> {
    let m = vector_arg(name, v)?;
    numbers(name, m)
}

/// `cinterp(xs, ys, x)`: natural cubic spline through the table points; past the
/// ends the end cubic is extended.
fn cinterp(args: &[Value]) -> Result<Value> {
    arity("cinterp", args, |n| n == 3, "3 arguments")?;
    let (xs, xd) = vector("cinterp", &args[0])?;
    let (ys, yd) = vector("cinterp", &args[1])?;
    let n = xs.len();
    if n != ys.len() || n < 2 {
        bail!("cinterp needs two vectors of the same length, with at least 2 points");
    }
    if xs.windows(2).any(|w| w[1] <= w[0]) {
        bail!("cinterp needs the x values in increasing order");
    }
    let x = args[2].as_num("the point to interpolate at")?;
    same_dim(xd, x.dim, "interpolate between")?;
    // Second derivatives, natural end conditions (y'' = 0 at both ends).
    let mut y2 = vec![0.0; n];
    let mut u = vec![0.0; n];
    for i in 1..n - 1 {
        let sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
        let p = sig * y2[i - 1] + 2.0;
        y2[i] = (sig - 1.0) / p;
        let d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
        u[i] = (6.0 * d / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
    }
    y2[n - 1] = 0.0;
    for k in (0..n - 1).rev() {
        y2[k] = y2[k] * y2[k + 1] + u[k];
    }
    let i = xs.partition_point(|&v| v <= x.v).clamp(1, n - 1);
    let h = xs[i] - xs[i - 1];
    let a = (xs[i] - x.v) / h;
    let b = 1.0 - a;
    let y = a * ys[i - 1] + b * ys[i] + ((a * a * a - a) * y2[i - 1] + (b * b * b - b) * y2[i]) * h * h / 6.0;
    Ok(Value::Num(Quantity::new(y, yd)))
}

// ---------------------------------------------------------------- lookup

/// Same kind and equal (numbers: same unit and equal within 1e-12); never an
/// error, so tables mixing text and numbers can be searched.
fn matches(z: &Value, e: &Value) -> bool {
    match (z, e) {
        (Value::Num(a), Value::Num(b)) => {
            a.dim == b.dim && (a.v == b.v || (a.v - b.v).abs() <= 1e-12 * a.v.abs().max(b.v.abs()))
        }
        (Value::Str(a), Value::Str(b)) => a == b,
        _ => false,
    }
}

/// `lookup(z, A, B)`: the elements of B at the positions where A equals z.
fn lookup(args: &[Value]) -> Result<Value> {
    arity("lookup", args, |n| n == 3, "3 arguments")?;
    let a = matrix_arg("lookup", &args[1])?;
    let b = matrix_arg("lookup", &args[2])?;
    if (a.rows, a.cols) != (b.rows, b.cols) {
        bail!("lookup needs A and B of the same size, not {}×{} and {}×{}", a.rows, a.cols, b.rows, b.cols);
    }
    let found: Vec<Value> =
        a.data.iter().zip(&b.data).filter(|(x, _)| matches(&args[0], x)).map(|(_, y)| y.clone()).collect();
    if found.is_empty() {
        bail!("lookup: the value was not found");
    }
    Ok(Value::Matrix(Matrix::column(found)))
}

/// `vlookup(z, M, n)`: column n of the rows whose first column equals z;
/// `hlookup(z, M, n)`: row n of the columns whose first row equals z.
fn vhlookup(name: &str, args: &[Value], vertical: bool) -> Result<Value> {
    arity(name, args, |n| n == 3, "3 arguments")?;
    let m = matrix_arg(name, &args[1])?;
    let found: Vec<Value> = if vertical {
        let c = index_arg(name, &args[2], m.cols, "column")?;
        (0..m.rows).filter(|&r| matches(&args[0], m.get(r, 0))).map(|r| m.get(r, c).clone()).collect()
    } else {
        let r = index_arg(name, &args[2], m.rows, "row")?;
        (0..m.cols).filter(|&c| matches(&args[0], m.get(0, c))).map(|c| m.get(r, c).clone()).collect()
    };
    if found.is_empty() {
        bail!("{name}: the value was not found");
    }
    Ok(Value::Matrix(Matrix::column(found)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(v: f64) -> Value {
        Value::num(v)
    }

    fn metre() -> Dim {
        Dim::from_ints([1, 0, 0, 0, 0, 0, 0])
    }

    fn meters(v: f64) -> Value {
        Value::Num(Quantity::new(v, metre()))
    }

    fn s(t: &str) -> Value {
        Value::Str(t.into())
    }

    fn m(rows: usize, cols: usize, vals: &[f64]) -> Value {
        Value::Matrix(Matrix::new(rows, cols, vals.iter().map(|&v| n(v)).collect()))
    }

    fn colv(vals: Vec<Value>) -> Value {
        Value::Matrix(Matrix::column(vals))
    }

    fn ok(name: &str, args: &[Value]) -> Value {
        call(name, args).expect("known function").expect("no error")
    }

    fn err(name: &str, args: &[Value]) -> String {
        call(name, args).expect("known function").expect_err("an error").message
    }

    fn nums(v: &Value) -> Vec<f64> {
        match v {
            Value::Matrix(m) => m.data.iter().map(|e| e.as_num("x").unwrap().v).collect(),
            Value::Num(q) => vec![q.v],
            Value::Str(_) => panic!("string"),
        }
    }

    fn shape(v: &Value) -> (usize, usize) {
        match v {
            Value::Matrix(m) => (m.rows, m.cols),
            _ => (1, 1),
        }
    }

    fn close(a: &[f64], b: &[f64]) {
        assert_eq!(a.len(), b.len(), "{a:?} vs {b:?}");
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 1e-9 * (1.0 + y.abs()), "{a:?} vs {b:?}");
        }
    }

    fn m23() -> Value {
        m(2, 3, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    }

    #[test]
    fn unknown_name() {
        assert!(call("nope", &[]).is_none());
    }

    #[test]
    fn col_row() {
        let c = ok("col", &[m23(), n(2.0)]);
        assert_eq!(shape(&c), (2, 1));
        close(&nums(&c), &[2.0, 5.0]);
        let r = ok("row", &[m23(), n(2.0)]);
        assert_eq!(shape(&r), (1, 3));
        close(&nums(&r), &[4.0, 5.0, 6.0]);
        assert!(err("col", &[m23(), n(4.0)]).contains("outside 1…3"));
        assert!(err("row", &[m23(), n(0.0)]).contains("indices start at 1"));
        assert_eq!(err("col", &[s("a"), n(1.0)]), "col needs a matrix, not a string");
        // units and strings kept as they are
        let t = Value::Matrix(Matrix::new(2, 2, vec![s("x"), meters(1.0), s("y"), meters(2.0)]));
        assert_eq!(ok("col", &[t, n(2.0)]), colv(vec![meters(1.0), meters(2.0)]));
    }

    #[test]
    fn submatrix_works() {
        let r = ok("submatrix", &[m23(), n(1.0), n(2.0), n(2.0), n(3.0)]);
        assert_eq!(shape(&r), (2, 2));
        close(&nums(&r), &[2.0, 3.0, 5.0, 6.0]);
        assert!(err("submatrix", &[m23(), n(2.0), n(1.0), n(1.0), n(1.0)]).contains("r1 ≤ r2"));
        assert!(err("submatrix", &[m23(), n(1.0)]).contains("5 arguments"));
    }

    #[test]
    fn last_reverse() {
        assert_eq!(nums(&ok("last", &[m(1, 4, &[1.0, 2.0, 3.0, 4.0])])), vec![4.0]);
        assert!(err("last", &[m23()]).contains("needs a vector"));
        close(&nums(&ok("reverse", &[m(3, 1, &[1.0, 2.0, 3.0])])), &[3.0, 2.0, 1.0]);
        let rv = ok("reverse", &[m(1, 3, &[1.0, 2.0, 3.0])]);
        assert_eq!(shape(&rv), (1, 3));
        close(&nums(&rv), &[3.0, 2.0, 1.0]);
        close(&nums(&ok("reverse", &[m23()])), &[4.0, 5.0, 6.0, 1.0, 2.0, 3.0]);
        assert!(err("reverse", &[n(1.0)]).contains("needs a matrix"));
    }

    #[test]
    fn product_units() {
        let Value::Num(q) = ok("product", &[colv(vec![meters(2.0), meters(3.0), n(4.0)])]) else { panic!() };
        assert_eq!(q.v, 24.0);
        assert_eq!(q.dim, Dim::from_ints([2, 0, 0, 0, 0, 0, 0]));
        assert!(err("product", &[colv(vec![s("x")])]).contains("must be a number"));
    }

    #[test]
    fn diag_trace() {
        let d = ok("diag", &[colv(vec![meters(1.0), meters(2.0)])]);
        assert_eq!(shape(&d), (2, 2));
        close(&nums(&d), &[1.0, 0.0, 0.0, 2.0]);
        let Value::Matrix(dm) = &d else { panic!() };
        assert!(dm.data.iter().all(|e| e.as_num("x").unwrap().dim == metre()));
        let back = ok("diag", &[m(2, 2, &[1.0, 2.0, 3.0, 4.0])]);
        assert_eq!(shape(&back), (2, 1));
        close(&nums(&back), &[1.0, 4.0]);
        assert!(err("diag", &[m23()]).contains("square"));
        close(&nums(&ok("trace", &[m(2, 2, &[1.0, 2.0, 3.0, 4.0])])), &[5.0]);
        let mixed = Value::Matrix(Matrix::new(2, 2, vec![meters(1.0), n(0.0), n(0.0), n(1.0)]));
        assert!(err("trace", &[mixed]).contains("units don't match"));
        assert!(err("trace", &[m23()]).contains("square"));
    }

    #[test]
    fn rank_matrix_invert() {
        assert_eq!(nums(&ok("rank", &[m(3, 3, &[1.0, 2.0, 3.0, 2.0, 4.0, 6.0, 1.0, 0.0, 1.0])])), vec![2.0]);
        assert_eq!(nums(&ok("rank", &[m23()])), vec![2.0]);
        assert_eq!(nums(&ok("rank", &[m(2, 2, &[0.0; 4])])), vec![0.0]);
        assert_eq!(nums(&ok("rank", &[m(3, 3, &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])])), vec![3.0]);
        let z = ok("matrix", &[n(2.0), n(3.0)]);
        assert_eq!(shape(&z), (2, 3));
        close(&nums(&z), &[0.0; 6]);
        assert!(err("matrix", &[n(0.0), n(3.0)]).contains("between 1"));
        close(&nums(&ok("invert", &[m(2, 2, &[2.0, 0.0, 0.0, 4.0])])), &[0.5, 0.0, 0.0, 0.25]);
        assert!(err("invert", &[m(2, 2, &[1.0, 2.0, 2.0, 4.0])]).contains("singular"));
    }

    #[test]
    fn norms() {
        let a = m(2, 2, &[1.0, -2.0, 3.0, 4.0]);
        close(&nums(&ok("norm1", std::slice::from_ref(&a))), &[6.0]);
        close(&nums(&ok("normi", std::slice::from_ref(&a))), &[7.0]);
        close(&nums(&ok("norme", std::slice::from_ref(&a))), &[30f64.sqrt()]);
        // MᵀM = [[10,10],[10,20]] → λmax = 15 + √125
        close(&nums(&ok("norm2", &[a])), &[(15.0 + 125f64.sqrt()).sqrt()]);
        let Value::Num(q) = ok("norm2", &[colv(vec![meters(3.0), meters(4.0)])]) else { panic!() };
        assert!((q.v - 5.0).abs() < 1e-12);
        assert_eq!(q.dim, metre());
        assert!(err("norme", &[colv(vec![meters(3.0), n(4.0)])]).contains("units don't match"));
    }

    #[test]
    fn sorting() {
        let a = m(3, 2, &[3.0, 30.0, 1.0, 10.0, 2.0, 20.0]);
        close(&nums(&ok("csort", &[a, n(1.0)])), &[1.0, 10.0, 2.0, 20.0, 3.0, 30.0]);
        let b = m(2, 3, &[3.0, 1.0, 2.0, 30.0, 10.0, 20.0]);
        close(&nums(&ok("rsort", &[b, n(1.0)])), &[1.0, 2.0, 3.0, 10.0, 20.0, 30.0]);
        let mixed = Value::Matrix(Matrix::new(2, 1, vec![meters(1.0), n(2.0)]));
        assert!(err("csort", &[mixed, n(1.0)]).contains("units don't match"));
        assert!(err("rsort", &[m23(), n(3.0)]).contains("outside"));
    }

    #[test]
    fn eigen_symmetric() {
        let a = m(2, 2, &[2.0, 1.0, 1.0, 2.0]);
        close(&nums(&ok("eigenvals", std::slice::from_ref(&a))), &[1.0, 3.0]);
        let h = 0.5f64.sqrt();
        // columns: λ=1 → (1, -1)/√2 (largest component positive), λ=3 → (1, 1)/√2
        close(&nums(&ok("eigenvecs", &[a])), &[h, h, -h, h]);
        // 3×3 symmetric: check A·v = λ·v
        let a3 = [4.0, 1.0, 2.0, 1.0, 3.0, 0.0, 2.0, 0.0, 5.0];
        let vals = nums(&ok("eigenvals", &[m(3, 3, &a3)]));
        let vecs = nums(&ok("eigenvecs", &[m(3, 3, &a3)]));
        assert!(vals.windows(2).all(|w| w[0] <= w[1]));
        check_pairs(&a3, &vals, &vecs);
        // units: eigenvalues keep the matrix units
        let ev = ok("eigenvals", &[Value::Matrix(Matrix::new(1, 1, vec![meters(5.0)]))]);
        assert_eq!(ev, colv(vec![meters(5.0)]));
    }

    fn check_pairs(a: &[f64], vals: &[f64], vecs: &[f64]) {
        let n = vals.len();
        for k in 0..n {
            let len: f64 = (0..n).map(|i| vecs[i * n + k].powi(2)).sum();
            assert!((len - 1.0).abs() < 1e-9);
            for i in 0..n {
                let av: f64 = (0..n).map(|j| a[i * n + j] * vecs[j * n + k]).sum();
                assert!((av - vals[k] * vecs[i * n + k]).abs() < 1e-8, "pair {k}");
            }
        }
    }

    #[test]
    fn eigen_general() {
        // [[4,1],[2,3]] → 2, 5
        let a = [4.0, 1.0, 2.0, 3.0];
        close(&nums(&ok("eigenvals", &[m(2, 2, &a)])), &[2.0, 5.0]);
        let v = nums(&ok("eigenvecs", &[m(2, 2, &a)]));
        // λ=2: (-1, 2)/√5 ; λ=5: (1, 1)/√2
        let r5 = 5f64.sqrt();
        close(&[v[0], v[2]], &[-1.0 / r5, 2.0 / r5]);
        close(&[v[1], v[3]], &[0.5f64.sqrt(), 0.5f64.sqrt()]);
        // 3×3 upper triangular
        let t = [1.0, 2.0, 3.0, 0.0, 4.0, 5.0, 0.0, 0.0, 6.0];
        let vals = nums(&ok("eigenvals", &[m(3, 3, &t)]));
        close(&vals, &[1.0, 4.0, 6.0]);
        check_pairs(&t, &vals, &nums(&ok("eigenvecs", &[m(3, 3, &t)])));
        // 4×4 general with real eigenvalues (companion of (x-1)(x-2)(x-3)(x-4))
        let c = [10.0, -35.0, 50.0, -24.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let vals = nums(&ok("eigenvals", &[m(4, 4, &c)]));
        close(&vals, &[1.0, 2.0, 3.0, 4.0]);
        check_pairs(&c, &vals, &nums(&ok("eigenvecs", &[m(4, 4, &c)])));
        // rotation → complex eigenvalues
        let rot = m(2, 2, &[0.0, -1.0, 1.0, 0.0]);
        assert!(
            err("eigenvals", std::slice::from_ref(&rot))
                .contains("complex eigenvalues are not supported yet")
        );
        assert!(err("eigenvecs", &[rot]).contains("complex eigenvalues are not supported yet"));
        assert!(err("eigenvals", &[m23()]).contains("square"));
    }

    #[test]
    fn cinterp_spline() {
        let xs = m(3, 1, &[0.0, 1.0, 2.0]);
        let ys = m(3, 1, &[0.0, 1.0, 0.0]);
        // natural spline: y''(1) = -3 → y(0.5) = 0.5 + (0.125 - 0.5)·(-3)/6 = 0.6875
        close(&nums(&ok("cinterp", &[xs.clone(), ys.clone(), n(0.5)])), &[0.6875]);
        close(&nums(&ok("cinterp", &[xs.clone(), ys.clone(), n(1.5)])), &[0.6875]);
        close(&nums(&ok("cinterp", &[xs, ys, n(1.0)])), &[1.0]);
        // two points → straight line; units like linterp
        let xm = colv(vec![meters(0.0), meters(2.0)]);
        let ym = colv(vec![n(10.0), n(20.0)]);
        close(&nums(&ok("cinterp", &[xm.clone(), ym.clone(), meters(0.5)])), &[12.5]);
        assert!(err("cinterp", &[xm, ym, n(0.5)]).contains("units don't match"));
        assert!(err("cinterp", &[m(2, 1, &[1.0, 0.0]), m(2, 1, &[1.0, 2.0]), n(0.5)]).contains("increasing"));
    }

    #[test]
    fn lookups() {
        let a = colv(vec![s("a"), s("b"), s("a")]);
        let b = m(3, 1, &[1.0, 2.0, 3.0]);
        close(&nums(&ok("lookup", &[s("a"), a.clone(), b.clone()])), &[1.0, 3.0]);
        assert!(err("lookup", &[s("z"), a, b]).contains("not found"));
        assert!(err("lookup", &[n(1.0), m23(), m(1, 1, &[1.0])]).contains("same size"));
        let t = Value::Matrix(Matrix::new(
            3,
            2,
            vec![meters(1.0), n(10.0), meters(2.0), n(20.0), meters(1.0), n(30.0)],
        ));
        close(&nums(&ok("vlookup", &[meters(1.0), t.clone(), n(2.0)])), &[10.0, 30.0]);
        // 1 (no unit) does not match 1 m
        assert!(err("vlookup", &[n(1.0), t.clone(), n(2.0)]).contains("not found"));
        assert!(err("vlookup", &[meters(1.0), t, n(3.0)]).contains("outside"));
        let h = m(2, 3, &[1.0, 2.0, 1.0, 10.0, 20.0, 30.0]);
        close(&nums(&ok("hlookup", &[n(1.0), h, n(2.0)])), &[10.0, 30.0]);
    }
}
