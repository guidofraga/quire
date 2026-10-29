use std::fmt;
use std::ops::{Add, Div, Mul, Sub};

use crate::Rational;

/// SI base units, in the order of [`Dim`]'s exponents: L, M, T, I, Θ, N, J.
/// Angles are dimensionless (rad = 1), as in SMath and Mathcad.
pub const BASE_UNITS: [&str; 7] = ["m", "kg", "s", "A", "K", "mol", "cd"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Dim(pub [Rational; 7]);

impl Dim {
    pub const NONE: Dim = Dim([Rational::ZERO; 7]);

    pub fn from_ints(e: [i8; 7]) -> Dim {
        Dim(e.map(|x| Rational::int(x as i32)))
    }

    pub fn is_dimensionless(&self) -> bool {
        self.0.iter().all(|r| r.is_zero())
    }

    pub fn pow(self, r: Rational) -> Dim {
        Dim(self.0.map(|e| e * r))
    }

    /// `(base unit, exponent)` for each non-zero exponent.
    pub fn parts(&self) -> Vec<(&'static str, Rational)> {
        BASE_UNITS.iter().zip(self.0).filter(|(_, e)| !e.is_zero()).map(|(n, e)| (*n, e)).collect()
    }
}

/// Combines the exponents of two dimensions component by component.
fn zip_with(a: Dim, b: Dim, f: fn(Rational, Rational) -> Rational) -> Dim {
    let mut out = a.0;
    for (x, y) in out.iter_mut().zip(b.0) {
        *x = f(*x, y);
    }
    Dim(out)
}

impl Mul for Dim {
    type Output = Dim;
    fn mul(self, o: Dim) -> Dim {
        zip_with(self, o, Add::add)
    }
}

impl Div for Dim {
    type Output = Dim;
    fn div(self, o: Dim) -> Dim {
        zip_with(self, o, Sub::sub)
    }
}

impl fmt::Display for Dim {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = format_product(&self.parts(), false);
        f.write_str(if s.is_empty() { "1 (dimensionless)" } else { &s })
    }
}

fn power(name: &str, e: Rational, quote: bool) -> String {
    let q = if quote { "'" } else { "" };
    if e == Rational::ONE {
        format!("{q}{name}")
    } else if e.is_integer() {
        format!("{q}{name}^{e}")
    } else {
        format!("{q}{name}^({e})")
    }
}

/// Product of unit powers as linear syntax: `kg*m/s^2`, `1/s`, `m/(s^2*A)`.
/// With `quote`, every unit gets its `'` marker. Empty input gives "".
pub fn format_product(parts: &[(&str, Rational)], quote: bool) -> String {
    let num: Vec<String> =
        parts.iter().filter(|(_, e)| e.numer() > 0).map(|(n, e)| power(n, *e, quote)).collect();
    let den: Vec<String> =
        parts.iter().filter(|(_, e)| e.numer() < 0).map(|(n, e)| power(n, e.abs(), quote)).collect();
    let mut s = if num.is_empty() && !den.is_empty() { "1".to_string() } else { num.join("*") };
    match den.as_slice() {
        [] => {}
        [only] => {
            s.push('/');
            s.push_str(only);
        }
        _ => {
            s.push_str("/(");
            s.push_str(&den.join("*"));
            s.push(')');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display() {
        assert_eq!(Dim::from_ints([1, 1, -2, 0, 0, 0, 0]).to_string(), "m*kg/s^2");
        assert_eq!(Dim::from_ints([0, 0, -1, 0, 0, 0, 0]).to_string(), "1/s");
        assert_eq!(Dim::from_ints([1, 0, -2, -1, 0, 0, 0]).to_string(), "m/(s^2*A)");
        assert_eq!(Dim::from_ints([2, 0, 0, 0, 0, 0, 0]).pow(Rational::new(1, 4)).to_string(), "m^(1/2)");
        assert_eq!(Dim::NONE.to_string(), "1 (dimensionless)");
    }
}
