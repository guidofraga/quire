use std::fmt;
use std::ops::{Add, Mul, Neg, Sub};

/// Small exact rational used for dimension exponents. Always reduced, `d > 0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rational {
    n: i32,
    d: i32,
}

fn gcd(mut a: i32, mut b: i32) -> i32 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a.abs()
}

impl Default for Rational {
    fn default() -> Self {
        Rational::ZERO
    }
}

impl Rational {
    pub const ZERO: Rational = Rational { n: 0, d: 1 };
    pub const ONE: Rational = Rational { n: 1, d: 1 };

    pub fn new(n: i32, d: i32) -> Rational {
        assert!(d != 0, "zero denominator");
        let g = gcd(n, d).max(1);
        let s = if d < 0 { -1 } else { 1 };
        Rational { n: s * n / g, d: s * d / g }
    }

    pub const fn int(n: i32) -> Rational {
        Rational { n, d: 1 }
    }

    /// The nearest rational with denominator ≤ 12, if `x` is (numerically) one.
    pub fn approx(x: f64) -> Option<Rational> {
        if !x.is_finite() || x.abs() > 1e6 {
            return None;
        }
        (1..=12).find_map(|d| {
            let n = (x * d as f64).round();
            ((n / d as f64 - x).abs() < 1e-9).then(|| Rational::new(n as i32, d))
        })
    }

    pub fn numer(self) -> i32 {
        self.n
    }

    pub fn denom(self) -> i32 {
        self.d
    }

    pub fn is_zero(self) -> bool {
        self.n == 0
    }

    pub fn is_integer(self) -> bool {
        self.d == 1
    }

    pub fn to_f64(self) -> f64 {
        self.n as f64 / self.d as f64
    }

    pub fn abs(self) -> Rational {
        Rational { n: self.n.abs(), d: self.d }
    }
}

impl Add for Rational {
    type Output = Rational;
    fn add(self, o: Rational) -> Rational {
        Rational::new(self.n * o.d + o.n * self.d, self.d * o.d)
    }
}

impl Sub for Rational {
    type Output = Rational;
    fn sub(self, o: Rational) -> Rational {
        self + (-o)
    }
}

impl Mul for Rational {
    type Output = Rational;
    fn mul(self, o: Rational) -> Rational {
        Rational::new(self.n * o.n, self.d * o.d)
    }
}

impl Neg for Rational {
    type Output = Rational;
    fn neg(self) -> Rational {
        Rational { n: -self.n, d: self.d }
    }
}

impl fmt::Display for Rational {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.d == 1 { write!(f, "{}", self.n) } else { write!(f, "{}/{}", self.n, self.d) }
    }
}

#[cfg(test)]
mod tests {
    use super::Rational;

    #[test]
    fn arithmetic_reduces() {
        assert_eq!(Rational::new(2, 4), Rational::new(1, 2));
        assert_eq!(Rational::new(1, -2), Rational::new(-1, 2));
        assert_eq!(Rational::new(1, 2) + Rational::new(1, 3), Rational::new(5, 6));
        assert_eq!(Rational::int(2) * Rational::new(1, 2), Rational::ONE);
        assert_eq!(Rational::approx(0.5), Some(Rational::new(1, 2)));
        assert_eq!(Rational::approx(1.0 / 3.0), Some(Rational::new(1, 3)));
        assert_eq!(Rational::approx(std::f64::consts::PI), None);
    }
}
