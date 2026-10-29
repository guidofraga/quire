//! Plain floating-point linear algebra for the numeric tools. Everything here works on SI
//! magnitudes; the callers check and carry the units.

/// Rows and columns rescaled to a largest entry of 1, so a row in kN next to one in mm,
/// or an unknown in Pa next to one in m, doesn't decide the pivots. Returns the column
/// factors (x = y / factor).
fn equilibrate(a: &mut [f64], b: &mut [f64], rows: usize, cols: usize) -> Option<Vec<f64>> {
    for i in 0..rows {
        let s = (0..cols).map(|j| a[i * cols + j].abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        (0..cols).for_each(|j| a[i * cols + j] /= s);
        b[i] /= s;
    }
    let mut factors = Vec::with_capacity(cols);
    for j in 0..cols {
        let s = (0..rows).map(|i| a[i * cols + j].abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        (0..rows).for_each(|i| a[i * cols + j] /= s);
        factors.push(s);
    }
    Some(factors)
}

/// A·x = b for a square, row-major A. `None` when A is singular (to working precision).
pub fn solve(mut a: Vec<f64>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    debug_assert_eq!(a.len(), n * n);
    let factors = equilibrate(&mut a, &mut b, n, n)?;
    for k in 0..n {
        let p = (k..n).max_by(|&i, &j| a[i * n + k].abs().total_cmp(&a[j * n + k].abs()))?;
        if a[p * n + k].abs() < 1e-13 {
            return None;
        }
        if p != k {
            (0..n).for_each(|j| a.swap(p * n + j, k * n + j));
            b.swap(p, k);
        }
        for i in k + 1..n {
            let f = a[i * n + k] / a[k * n + k];
            if f != 0.0 {
                (k..n).for_each(|j| a[i * n + j] -= f * a[k * n + j]);
                b[i] -= f * b[k];
            }
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let s: f64 = (i + 1..n).map(|j| a[i * n + j] * x[j]).sum();
        x[i] = (b[i] - s) / a[i * n + i];
    }
    Some(x.iter().zip(&factors).map(|(y, f)| y / f).collect())
}

/// The x minimising |A·x − b| for a tall (rows ≥ cols), row-major A, by Householder QR.
/// `None` when the columns are not independent.
pub fn least_squares(mut a: Vec<f64>, mut b: Vec<f64>, cols: usize) -> Option<Vec<f64>> {
    let rows = b.len();
    debug_assert!(rows >= cols && a.len() == rows * cols);
    // only columns are rescaled: scaling rows would weight the points differently
    let mut factors = Vec::with_capacity(cols);
    for j in 0..cols {
        let s = (0..rows).map(|i| a[i * cols + j].abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        (0..rows).for_each(|i| a[i * cols + j] /= s);
        factors.push(s);
    }
    for k in 0..cols {
        let norm = (k..rows).map(|i| a[i * cols + k].powi(2)).sum::<f64>().sqrt();
        if norm < 1e-12 {
            return None;
        }
        let alpha = if a[k * cols + k] > 0.0 { -norm } else { norm };
        let mut v: Vec<f64> = (k..rows).map(|i| a[i * cols + k]).collect();
        v[0] -= alpha;
        let vv: f64 = v.iter().map(|x| x * x).sum();
        if vv == 0.0 {
            continue;
        }
        for j in k..cols {
            let d: f64 = (k..rows).map(|i| v[i - k] * a[i * cols + j]).sum::<f64>() * 2.0 / vv;
            (k..rows).for_each(|i| a[i * cols + j] -= d * v[i - k]);
        }
        let d: f64 = (k..rows).map(|i| v[i - k] * b[i]).sum::<f64>() * 2.0 / vv;
        (k..rows).for_each(|i| b[i] -= d * v[i - k]);
        if a[k * cols + k].abs() < 1e-12 {
            return None;
        }
    }
    let mut x = vec![0.0; cols];
    for i in (0..cols).rev() {
        let s: f64 = (i + 1..cols).map(|j| a[i * cols + j] * x[j]).sum();
        x[i] = (b[i] - s) / a[i * cols + i];
    }
    Some(x.iter().zip(&factors).map(|(y, f)| y / f).collect())
}

/// A tridiagonal system (Thomas algorithm): `sub[i]·x[i-1] + diag[i]·x[i] + sup[i]·x[i+1] = r[i]`.
/// The callers' systems are diagonally dominant, so no pivoting is needed.
pub fn tridiagonal(sub: &[f64], diag: &[f64], sup: &[f64], r: &[f64]) -> Vec<f64> {
    let n = diag.len();
    let mut c = vec![0.0; n];
    let mut d = vec![0.0; n];
    for i in 0..n {
        let m = diag[i] - if i > 0 { sub[i] * c[i - 1] } else { 0.0 };
        c[i] = sup[i] / m;
        d[i] = (r[i] - if i > 0 { sub[i] * d[i - 1] } else { 0.0 }) / m;
    }
    for i in (0..n.saturating_sub(1)).rev() {
        d[i] -= c[i] * d[i + 1];
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() <= 1e-9 * y.abs().max(1.0))
    }

    #[test]
    fn dense_systems_ignore_scale() {
        // the second unknown is a million times larger than the first
        let x = solve(vec![1.0, 1e-6, 2.0, -1e-6], vec![3.0, 0.0]).unwrap();
        assert!(close(&x, &[1.0, 2e6]), "{x:?}");
        assert!(solve(vec![1.0, 2.0, 2.0, 4.0], vec![1.0, 2.0]).is_none());
    }

    #[test]
    fn least_squares_fits_a_line() {
        // y = 1 + 2x through four points, exactly
        let a = vec![1.0, 0.0, 1.0, 1.0, 1.0, 2.0, 1.0, 3.0];
        let x = least_squares(a, vec![1.0, 3.0, 5.0, 7.0], 2).unwrap();
        assert!(close(&x, &[1.0, 2.0]), "{x:?}");
        assert!(least_squares(vec![1.0, 2.0, 1.0, 2.0], vec![1.0, 1.0], 2).is_none());
    }

    #[test]
    fn tridiagonal_systems() {
        let x = tridiagonal(&[0.0, 1.0, 1.0], &[4.0, 4.0, 4.0], &[1.0, 1.0, 0.0], &[5.0, 6.0, 5.0]);
        assert!(close(&x, &[1.0, 1.0, 1.0]), "{x:?}");
    }
}
