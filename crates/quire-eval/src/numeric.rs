//! Plain floating-point linear algebra for the numeric tools. Everything here works on SI
//! magnitudes; the callers check and carry the units.
//!
//! Matrices are row-major slices. Every function returns `None` (singular, or the input
//! doesn't have the shape it claims) instead of panicking.

/// Element (i, j) of a row-major matrix with `cols` columns.
pub(crate) fn el(a: &[f64], cols: usize, i: usize, j: usize) -> Option<f64> {
    a.get(i * cols + j).copied()
}

pub(crate) fn el_mut(a: &mut [f64], cols: usize, i: usize, j: usize) -> Option<&mut f64> {
    a.get_mut(i * cols + j)
}

/// Column `j` of a row-major matrix with `cols` columns, rows `from..`.
fn column(a: &[f64], cols: usize, from: usize, j: usize) -> Option<Vec<f64>> {
    (from..a.len().checked_div(cols)?).map(|i| el(a, cols, i, j)).collect()
}

/// Rows and columns rescaled to a largest entry of 1, so a row in kN next to one in mm,
/// or an unknown in Pa next to one in m, doesn't decide the pivots. Returns the column
/// factors (x = y / factor). `cols` is at least 1.
fn equilibrate(a: &mut [f64], b: &mut [f64], cols: usize) -> Option<Vec<f64>> {
    for (row, bi) in a.chunks_exact_mut(cols).zip(b.iter_mut()) {
        let s = row.iter().map(|x| x.abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        row.iter_mut().for_each(|x| *x /= s);
        *bi /= s;
    }
    let mut factors = Vec::with_capacity(cols);
    for j in 0..cols {
        let s = a.iter().skip(j).step_by(cols).map(|x| x.abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        a.iter_mut().skip(j).step_by(cols).for_each(|x| *x /= s);
        factors.push(s);
    }
    Some(factors)
}

/// A·x = b for a square, row-major A. `None` when A is singular (to working precision).
pub fn solve(mut a: Vec<f64>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    if a.len() != n * n {
        return None;
    }
    if n == 0 {
        return Some(Vec::new());
    }
    let factors = equilibrate(&mut a, &mut b, n)?;
    for k in 0..n {
        let p = (k..n).max_by(|&i, &j| {
            let (ai, aj) = (el(&a, n, i, k).unwrap_or(0.0), el(&a, n, j, k).unwrap_or(0.0));
            ai.abs().total_cmp(&aj.abs())
        })?;
        if el(&a, n, p, k)?.abs() < 1e-13 {
            return None;
        }
        if p != k {
            for j in 0..n {
                a.swap(p * n + j, k * n + j);
            }
            b.swap(p, k);
        }
        let pivot = el(&a, n, k, k)?;
        for i in k + 1..n {
            let f = el(&a, n, i, k)? / pivot;
            if f != 0.0 {
                for j in k..n {
                    let akj = el(&a, n, k, j)?;
                    *el_mut(&mut a, n, i, j)? -= f * akj;
                }
                let bk = *b.get(k)?;
                *b.get_mut(i)? -= f * bk;
            }
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let row = a.get(i * n + i + 1..(i + 1) * n)?;
        let s: f64 = row.iter().zip(x.get(i + 1..)?).map(|(aij, xj)| aij * xj).sum();
        *x.get_mut(i)? = (b.get(i)? - s) / el(&a, n, i, i)?;
    }
    Some(x.iter().zip(&factors).map(|(y, f)| y / f).collect())
}

/// The x minimising |A·x − b| for a tall (rows ≥ cols), row-major A, by Householder QR.
/// `None` when the columns are not independent.
pub fn least_squares(mut a: Vec<f64>, mut b: Vec<f64>, cols: usize) -> Option<Vec<f64>> {
    let rows = b.len();
    if a.len() != rows * cols || rows < cols {
        return None;
    }
    if cols == 0 {
        return Some(Vec::new());
    }
    // only columns are rescaled: scaling rows would weight the points differently
    let mut factors = Vec::with_capacity(cols);
    for j in 0..cols {
        let s = a.iter().skip(j).step_by(cols).map(|x| x.abs()).fold(0.0, f64::max);
        if s == 0.0 || !s.is_finite() {
            return None;
        }
        a.iter_mut().skip(j).step_by(cols).for_each(|x| *x /= s);
        factors.push(s);
    }
    for k in 0..cols {
        let col = column(&a, cols, k, k)?;
        let norm = col.iter().map(|x| x.powi(2)).sum::<f64>().sqrt();
        if norm < 1e-12 {
            return None;
        }
        let alpha = if el(&a, cols, k, k)? > 0.0 { -norm } else { norm };
        let mut v = col;
        *v.first_mut()? -= alpha;
        let vv: f64 = v.iter().map(|x| x * x).sum();
        if vv == 0.0 {
            continue;
        }
        for j in k..cols {
            let aj = column(&a, cols, k, j)?;
            let d: f64 = v.iter().zip(&aj).map(|(vi, aij)| vi * aij).sum::<f64>() * 2.0 / vv;
            for (t, vi) in v.iter().enumerate() {
                *el_mut(&mut a, cols, k + t, j)? -= d * vi;
            }
        }
        let d: f64 = v.iter().zip(b.get(k..)?).map(|(vi, bi)| vi * bi).sum::<f64>() * 2.0 / vv;
        for (bi, vi) in b.get_mut(k..)?.iter_mut().zip(&v) {
            *bi -= d * vi;
        }
        if el(&a, cols, k, k)?.abs() < 1e-12 {
            return None;
        }
    }
    let mut x = vec![0.0; cols];
    for i in (0..cols).rev() {
        let row = a.get(i * cols + i + 1..(i + 1) * cols)?;
        let s: f64 = row.iter().zip(x.get(i + 1..)?).map(|(aij, xj)| aij * xj).sum();
        *x.get_mut(i)? = (b.get(i)? - s) / el(&a, cols, i, i)?;
    }
    Some(x.iter().zip(&factors).map(|(y, f)| y / f).collect())
}

/// A tridiagonal system (Thomas algorithm): `sub[i]·x[i-1] + diag[i]·x[i] + sup[i]·x[i+1] = r[i]`.
/// The callers' systems are diagonally dominant, so no pivoting is needed. `None` when the
/// four slices don't have the same length.
pub fn tridiagonal(sub: &[f64], diag: &[f64], sup: &[f64], r: &[f64]) -> Option<Vec<f64>> {
    let n = diag.len();
    if [sub.len(), sup.len(), r.len()] != [n, n, n] {
        return None;
    }
    let mut c: Vec<f64> = Vec::with_capacity(n);
    let mut d: Vec<f64> = Vec::with_capacity(n);
    for (i, ((&dg, &sb), (&up, &ri))) in diag.iter().zip(sub).zip(sup.iter().zip(r)).enumerate() {
        // the first row has no sub-diagonal term
        let (lower_c, lower_d) = match (c.last(), d.last()) {
            (Some(&pc), Some(&pd)) if i > 0 => (sb * pc, sb * pd),
            _ => (0.0, 0.0),
        };
        let m = dg - lower_c;
        c.push(up / m);
        d.push((ri - lower_d) / m);
    }
    for i in (0..n.saturating_sub(1)).rev() {
        let next = *d.get(i + 1)?;
        let ci = *c.get(i)?;
        *d.get_mut(i)? -= ci * next;
    }
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn close(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() <= 1e-9 * y.abs().max(1.0))
    }

    #[test]
    fn dense_systems_ignore_scale() -> TestResult {
        // the second unknown is a million times larger than the first
        let x = solve(vec![1.0, 1e-6, 2.0, -1e-6], vec![3.0, 0.0]).ok_or("singular")?;
        assert!(close(&x, &[1.0, 2e6]), "{x:?}");
        assert!(solve(vec![1.0, 2.0, 2.0, 4.0], vec![1.0, 2.0]).is_none());
        Ok(())
    }

    #[test]
    fn least_squares_fits_a_line() -> TestResult {
        // y = 1 + 2x through four points, exactly
        let a = vec![1.0, 0.0, 1.0, 1.0, 1.0, 2.0, 1.0, 3.0];
        let x = least_squares(a, vec![1.0, 3.0, 5.0, 7.0], 2).ok_or("no fit")?;
        assert!(close(&x, &[1.0, 2.0]), "{x:?}");
        assert!(least_squares(vec![1.0, 2.0, 1.0, 2.0], vec![1.0, 1.0], 2).is_none());
        Ok(())
    }

    #[test]
    fn tridiagonal_systems() -> TestResult {
        let x = tridiagonal(&[0.0, 1.0, 1.0], &[4.0, 4.0, 4.0], &[1.0, 1.0, 0.0], &[5.0, 6.0, 5.0])
            .ok_or("bad shape")?;
        assert!(close(&x, &[1.0, 1.0, 1.0]), "{x:?}");
        assert!(tridiagonal(&[0.0], &[4.0, 4.0], &[1.0, 1.0], &[5.0, 6.0]).is_none());
        Ok(())
    }
}
