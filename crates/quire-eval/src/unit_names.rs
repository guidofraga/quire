//! Bare names that were read as units where a variable is the more usual reading
//! (`M/W` with no `W` defined): a forgotten definition would otherwise give a wrong number
//! without a word. Names where the unit is plainly meant (`5 W`, `kN*m`) are left out.

use quire_ast::{BinaryOp, Expr};

/// The names in `e` that are in `read_as_units` (what the interpreter resolved to units),
/// in a position where a variable is more usual: not right after a number or another unit.
/// Each name once, in order of appearance.
pub(crate) fn read_as_units(e: &Expr, read_as_units: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    // a definition's left side is the name being defined, not a use
    let body = match e {
        Expr::Define { rhs, .. } => rhs.as_ref(),
        _ => e,
    };
    Scan { units: read_as_units, out: &mut out }.walk(body);
    out
}

struct Scan<'a> {
    units: &'a [String],
    out: &'a mut Vec<String>,
}

impl Scan<'_> {
    fn is_unit_name(&self, n: &str) -> bool {
        self.units.iter().any(|u| u == n)
    }

    /// Made only of units: `kN`, `m/s`, `'m`, `(m)^2`.
    fn unit_expr(&self, e: &Expr) -> bool {
        match e {
            Expr::Unit(_) => true,
            Expr::Ident(n) => self.is_unit_name(n),
            Expr::Paren(x) => self.unit_expr(x),
            Expr::Binary(BinaryOp::Pow, base, _) => self.unit_expr(base),
            Expr::Binary(BinaryOp::Mul | BinaryOp::Div | BinaryOp::Juxt, a, b) => {
                self.unit_expr(a) && self.unit_expr(b)
            }
            _ => false,
        }
    }

    /// `e` ends in a number or a unit, so a name right after it is read as a unit
    /// (`2 W`, `10 kg/W`, `x*2*W`).
    fn ends_in_quantity(&self, e: &Expr) -> bool {
        match e {
            Expr::Num(_) | Expr::Unit(_) => true,
            Expr::Paren(x) => self.ends_in_quantity(x),
            Expr::Binary(BinaryOp::Mul | BinaryOp::Div | BinaryOp::Juxt, _, r) => self.ends_in_quantity(r),
            _ => self.unit_expr(e),
        }
    }

    fn walk(&mut self, e: &Expr) {
        match e {
            Expr::Ident(n) => {
                if self.is_unit_name(n) && !self.out.contains(n) {
                    self.out.push(n.clone());
                }
            }
            // implicit multiplication reads its right side as a unit
            Expr::Binary(BinaryOp::Juxt, a, b) => {
                self.walk(a);
                if !self.unit_expr(b) {
                    self.walk(b);
                }
            }
            Expr::Binary(BinaryOp::Mul | BinaryOp::Div, a, b) => {
                if self.unit_expr(a) && self.unit_expr(b) {
                    return;
                }
                self.walk(a);
                if !(self.ends_in_quantity(a) && self.unit_expr(b)) {
                    self.walk(b);
                }
            }
            Expr::Binary(_, a, b) | Expr::Range(a, b) => {
                self.walk(a);
                self.walk(b);
            }
            Expr::Paren(x) | Expr::Unary(_, x) | Expr::Factorial(x) => self.walk(x),
            Expr::Compare(a, rest) => {
                self.walk(a);
                rest.iter().for_each(|(_, x)| self.walk(x));
            }
            Expr::Call(_, args) => args.iter().for_each(|x| self.walk(x)),
            Expr::Index(b, args) => {
                self.walk(b);
                args.iter().for_each(|x| self.walk(x));
            }
            Expr::Matrix(rows) => rows.iter().flatten().for_each(|x| self.walk(x)),
            Expr::Define { rhs, .. } => self.walk(rhs),
            Expr::Num(_) | Expr::Unit(_) | Expr::Str(_) | Expr::Placeholder => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flagged(src: &str, units: &[&str]) -> Vec<String> {
        let units: Vec<String> = units.iter().map(|u| (*u).to_string()).collect();
        let parsed = quire_ast::parse(src);
        assert!(parsed.is_ok(), "{src} parses");
        parsed.map(|e| read_as_units(&e, &units)).unwrap_or_default()
    }

    #[test]
    fn a_name_where_a_variable_is_usual_is_flagged() {
        assert_eq!(flagged("z := M/W", &["W"]), ["W"]);
        assert_eq!(flagged("W", &["W"]), ["W"]);
        assert_eq!(flagged("M*W", &["W"]), ["W"]);
        assert_eq!(flagged("sin(W)", &["W"]), ["W"]);
        assert_eq!(flagged("W^2", &["W"]), ["W"]);
        assert_eq!(flagged("M/W + W", &["W"]), ["W"], "each name once");
    }

    #[test]
    fn a_unit_after_a_number_or_another_unit_is_not() {
        assert!(flagged("P := 5 W", &["W"]).is_empty());
        assert!(flagged("5*W", &["W"]).is_empty());
        assert!(flagged("kN*m", &["kN", "m"]).is_empty());
        assert!(flagged("100 km/h", &["km", "h"]).is_empty());
        assert!(flagged("10 kg/W", &["kg", "W"]).is_empty());
        assert!(flagged("x*2*W", &["W"]).is_empty());
        assert!(flagged("m/s", &["m", "s"]).is_empty());
    }

    #[test]
    fn quoted_units_and_names_not_read_as_units_are_not() {
        assert!(flagged("M/'W", &[]).is_empty());
        assert!(flagged("M/W", &[]).is_empty(), "W is a variable here");
    }
}
