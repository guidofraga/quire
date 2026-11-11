//! Names in stored text (docs/02-file-format.md §4.3, Units and §5).
//!
//! A plain name means the nearest definition above it, right after a number too. Before that
//! rule, a unit name right after a number or another unit (`2 T`, `100 km/h`) was always the
//! unit, even under a variable of that name. So that a stored expression means one thing
//! whichever version wrote it, with no version flag:
//!
//! - [`explicit`], on save: a product with your variable is written `2*T` (`(100 km)/h`), so
//!   stored text never has a variable in a unit's place;
//! - [`upgrade`], on open: a unit name in a unit's place that names a variable defined above is
//!   the old rule's unit, and is quoted (`2 'T`), so old documents compute as they did.
//!
//! Both work from the text alone: the variables defined above a region are the names the
//! regions before it define (and the global `≡` ones), as [`defined_names`] reads them.

use std::collections::HashSet;

use quire_ast::{BinaryOp, Expr, UnaryOp};
use quire_units::UnitRegistry;

use crate::interp::quantity_like;

/// What a plain name in one stored expression can mean.
pub struct Names<'a> {
    units: &'a UnitRegistry,
    /// Your variables defined above the expression (and the global ones).
    variables: &'a HashSet<String>,
    /// Names the expression binds itself: a function's parameters, loop and plot variables,
    /// local definitions. They are always variables there, as they were before.
    locals: HashSet<String>,
}

impl<'a> Names<'a> {
    /// For `e`, a region's expression, with `variables` defined above it. `extra` are names the
    /// region binds around it (a plot's variable).
    pub fn new(units: &'a UnitRegistry, variables: &'a HashSet<String>, e: &Expr, extra: &[String]) -> Self {
        let mut locals: HashSet<String> = extra.iter().cloned().collect();
        let body = match e {
            Expr::Define { lhs, rhs, .. } => {
                if let Expr::Call(_, params) = lhs.as_ref() {
                    params.iter().for_each(|p| collect_idents(p, &mut locals));
                }
                rhs.as_ref()
            }
            other => other,
        };
        bound(body, &mut locals);
        Names { units, variables, locals }
    }

    /// One of your variables (defined above, not bound in the expression) that is also a unit name.
    fn variable_unit(&self, n: &str) -> bool {
        !self.locals.contains(n) && self.variables.contains(n) && self.units.lookup_bare(n).is_some()
    }

    /// A unit name that is not a variable here.
    fn plain_unit(&self, n: &str) -> bool {
        !self.locals.contains(n) && !self.variables.contains(n) && self.units.lookup_bare(n).is_some()
    }

    /// `e` in a unit's place is your variable: `T`, `T^2`, `(T)`.
    fn variable_in_place(&self, e: &Expr) -> bool {
        match e {
            Expr::Ident(n) => self.variable_unit(n),
            Expr::Binary(BinaryOp::Pow, base, _) => {
                matches!(**base, Expr::Ident(_)) && self.variable_in_place(base)
            }
            Expr::Paren(x) => self.variable_in_place(x),
            _ => false,
        }
    }
}

/// The names a region's expression defines for the regions below it: the name on the left of
/// `:=` or `≡` (a function defines none), and those assigned inside it (`block`, `for`).
pub fn defined_names(e: &Expr) -> Vec<String> {
    let mut out = HashSet::new();
    let body = match e {
        Expr::Define { lhs, rhs, .. } => {
            match lhs.as_ref() {
                // a function's body runs when it is called, in a scope of its own
                Expr::Call(..) => return Vec::new(),
                target => assigned(target, &mut out),
            }
            rhs.as_ref()
        }
        other => other,
    };
    persisted(body, &mut out);
    let mut names: Vec<String> = out.into_iter().collect();
    names.sort();
    names
}

/// The constants `e` names with the marker, `G` in `#G`, each once.
pub fn marked_constants(e: &Expr) -> Vec<String> {
    fn walk(e: &Expr, out: &mut Vec<String>) {
        match e {
            Expr::Const(c) if !out.contains(c) => out.push(c.clone()),
            other => children(other).into_iter().for_each(|x| walk(x, out)),
        }
    }
    let mut out = Vec::new();
    walk(e, &mut out);
    out
}

/// `e` as the old rule read it, written so the current rule reads it the same: a variable's
/// name in a unit's place (`2 T`, `1 m/s^2` with T and s defined above) becomes the quoted
/// unit (`2 'T`, `1 m/'s^2`).
pub fn upgrade(e: &Expr, names: &Names) -> Expr {
    upgrade_at(e, names, false)
}

fn upgrade_at(e: &Expr, n: &Names, place: bool) -> Expr {
    match e {
        Expr::Ident(x) if place && n.variable_unit(x) => Expr::Unit(x.clone()),
        Expr::Binary(BinaryOp::Juxt, a, b) => {
            Expr::Binary(BinaryOp::Juxt, Box::new(upgrade_at(a, n, false)), Box::new(upgrade_at(b, n, true)))
        }
        Expr::Binary(BinaryOp::Div, a, b) => Expr::Binary(
            BinaryOp::Div,
            Box::new(upgrade_at(a, n, false)),
            Box::new(upgrade_at(b, n, quantity_like(a))),
        ),
        Expr::Binary(BinaryOp::Pow, base, exp) if place && matches!(**base, Expr::Ident(_)) => Expr::Binary(
            BinaryOp::Pow,
            Box::new(upgrade_at(base, n, true)),
            Box::new(upgrade_at(exp, n, false)),
        ),
        Expr::Paren(x) if place => Expr::Paren(Box::new(upgrade_at(x, n, true))),
        other => map_children(other, &|x| upgrade_at(x, n, false)),
    }
}

/// `e` written so that no variable stands in a unit's place: `2 T` with your variable T is
/// `2*T`, and `100 km/h` with your variable h is `(100 km)/h`. A unit that would lose its
/// place by that (`2 T/s` → `2*T/'s`) is quoted, so the meaning never changes.
pub fn explicit(e: &Expr, names: &Names) -> Expr {
    explicit_at(e, names, false)
}

fn explicit_at(e: &Expr, n: &Names, place: bool) -> Expr {
    match e {
        Expr::Binary(BinaryOp::Juxt, a, b) => {
            let a = Box::new(explicit_at(a, n, false));
            if n.variable_in_place(b) {
                Expr::Binary(BinaryOp::Mul, a, Box::new(explicit_at(b, n, false)))
            } else {
                Expr::Binary(BinaryOp::Juxt, a, Box::new(explicit_at(b, n, true)))
            }
        }
        Expr::Binary(BinaryOp::Div, a, b) => {
            let was_place = quantity_like(a);
            let mut left = explicit_at(a, n, false);
            if was_place && n.variable_in_place(b) {
                if quantity_like(&left) {
                    left = Expr::Paren(Box::new(left));
                }
                return Expr::Binary(BinaryOp::Div, Box::new(left), Box::new(explicit_at(b, n, false)));
            }
            let mut right = explicit_at(b, n, was_place);
            if was_place && !quantity_like(&left) {
                right = quote_units(&right, n);
            }
            Expr::Binary(BinaryOp::Div, Box::new(left), Box::new(right))
        }
        Expr::Binary(BinaryOp::Pow, base, exp) if place && matches!(**base, Expr::Ident(_)) => {
            Expr::Binary(BinaryOp::Pow, base.clone(), Box::new(explicit_at(exp, n, false)))
        }
        Expr::Paren(x) if place => Expr::Paren(Box::new(explicit_at(x, n, true))),
        // `-2 T` is `-2*T`, not `-(2*T)`
        Expr::Unary(op @ (UnaryOp::Neg | UnaryOp::Pos), x) => match explicit_at(x, n, false) {
            Expr::Binary(BinaryOp::Mul, a, b) if matches!(**x, Expr::Binary(BinaryOp::Juxt, ..)) => {
                Expr::Binary(BinaryOp::Mul, Box::new(Expr::Unary(*op, a)), b)
            }
            x => Expr::Unary(*op, Box::new(x)),
        },
        other => map_children(other, &|x| explicit_at(x, n, false)),
    }
}

/// The units in a unit's place in `e` quoted: `s` in `s^2` becomes `'s`.
fn quote_units(e: &Expr, n: &Names) -> Expr {
    match e {
        Expr::Ident(x) if n.plain_unit(x) => Expr::Unit(x.clone()),
        Expr::Binary(BinaryOp::Pow, base, exp) if matches!(**base, Expr::Ident(_)) => {
            Expr::Binary(BinaryOp::Pow, Box::new(quote_units(base, n)), exp.clone())
        }
        Expr::Paren(x) => Expr::Paren(Box::new(quote_units(x, n))),
        other => other.clone(),
    }
}

/// `e` with each child replaced by `f(child)`.
fn map_children(e: &Expr, f: &dyn Fn(&Expr) -> Expr) -> Expr {
    let b = |x: &Expr| Box::new(f(x));
    match e {
        Expr::Paren(x) => Expr::Paren(b(x)),
        Expr::Unary(op, x) => Expr::Unary(*op, b(x)),
        Expr::Factorial(x) => Expr::Factorial(b(x)),
        Expr::Binary(op, x, y) => Expr::Binary(*op, b(x), b(y)),
        Expr::Range(x, y) => Expr::Range(b(x), b(y)),
        Expr::Compare(x, rest) => Expr::Compare(b(x), rest.iter().map(|(op, y)| (*op, f(y))).collect()),
        Expr::Call(name, xs) => Expr::Call(name.clone(), xs.iter().map(f).collect()),
        Expr::Index(x, xs) => Expr::Index(b(x), xs.iter().map(f).collect()),
        Expr::Matrix(rows) => Expr::Matrix(rows.iter().map(|r| r.iter().map(f).collect()).collect()),
        Expr::Define { lhs, rhs, global } => Expr::Define { lhs: b(lhs), rhs: b(rhs), global: *global },
        Expr::Num(_) | Expr::Ident(_) | Expr::Unit(_) | Expr::Const(_) | Expr::Str(_) | Expr::Placeholder => {
            e.clone()
        }
    }
}

/// Every child of `e`.
fn children(e: &Expr) -> Vec<&Expr> {
    match e {
        Expr::Paren(x) | Expr::Unary(_, x) | Expr::Factorial(x) => vec![x],
        Expr::Binary(_, x, y) | Expr::Range(x, y) | Expr::Define { lhs: x, rhs: y, .. } => vec![x, y],
        Expr::Compare(x, rest) => std::iter::once(x.as_ref()).chain(rest.iter().map(|(_, y)| y)).collect(),
        Expr::Call(_, xs) => xs.iter().collect(),
        Expr::Index(x, xs) => std::iter::once(x.as_ref()).chain(xs).collect(),
        Expr::Matrix(rows) => rows.iter().flatten().collect(),
        Expr::Num(_) | Expr::Ident(_) | Expr::Unit(_) | Expr::Const(_) | Expr::Str(_) | Expr::Placeholder => {
            Vec::new()
        }
    }
}

fn collect_idents(e: &Expr, out: &mut HashSet<String>) {
    match e {
        Expr::Ident(n) => {
            out.insert(n.clone());
        }
        other => children(other).into_iter().for_each(|x| collect_idents(x, out)),
    }
}

/// The name an assignment target writes: `x`, `v` in `v[i]`.
fn assigned(target: &Expr, out: &mut HashSet<String>) {
    match target {
        Expr::Ident(n) => {
            out.insert(n.clone());
        }
        Expr::Index(base, _) => assigned(base, out),
        _ => {}
    }
}

/// The variable a construct binds: `i` in `for(i, …)` and `sum(e, i, a, b)`, `x` in
/// `int(e, x, a, b)`, `solve(e, x)`, `diff(e, x)`.
fn bound_variable(name: &str, args: &[Expr]) -> Option<&'static [usize]> {
    match (name, args.len()) {
        ("for", 3) => Some(&[0]),
        ("sum" | "prod" | "product" | "int" | "root" | "solve" | "diff" | "lim" | "series", _) => Some(&[1]),
        _ => None,
    }
}

/// Every name `e` binds while it is worked out: its assignments and the variables of its
/// loops, sums, integrals and solvers.
fn bound(e: &Expr, out: &mut HashSet<String>) {
    match e {
        Expr::Define { lhs, rhs, .. } => {
            match lhs.as_ref() {
                Expr::Call(_, params) => params.iter().for_each(|p| collect_idents(p, out)),
                target => assigned(target, out),
            }
            bound(rhs, out);
        }
        Expr::Call(name, args) => {
            for &i in bound_variable(name, args).unwrap_or_default() {
                if let Some(v) = args.get(i) {
                    collect_idents(v, out);
                }
            }
            args.iter().for_each(|a| bound(a, out));
        }
        other => children(other).into_iter().for_each(|x| bound(x, out)),
    }
}

/// The names `e` leaves defined after it is worked out at the top of a document: its
/// assignments and `for` loop variables, outside function bodies.
fn persisted(e: &Expr, out: &mut HashSet<String>) {
    match e {
        Expr::Define { lhs, rhs, .. } => {
            if matches!(lhs.as_ref(), Expr::Call(..)) {
                return;
            }
            assigned(lhs, out);
            persisted(rhs, out);
        }
        Expr::Call(name, args) if name == "for" && args.len() == 3 => {
            if let Some(v) = args.first() {
                assigned(v, out);
            }
            args.iter().for_each(|a| persisted(a, out));
        }
        other => children(other).into_iter().for_each(|x| persisted(x, out)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quire_ast::{parse, print};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn with(
        variables: &[&str],
        f: impl Fn(&Names, &Expr) -> Expr,
        src: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let units = UnitRegistry::new();
        let vars: HashSet<String> = variables.iter().map(|v| v.to_string()).collect();
        let e = parse(src)?;
        let names = Names::new(&units, &vars, &e, &[]);
        Ok(print(&f(&names, &e)))
    }

    #[test]
    fn old_units_in_a_variables_place_are_quoted() -> TestResult {
        let up = |vars: &[&str], src| with(vars, |n, e| upgrade(e, n), src);
        assert_eq!(up(&["T"], "x := 2 T")?, "x := 2 'T");
        assert_eq!(up(&["T"], "x := 2*T + T")?, "x := 2*T + T");
        assert_eq!(up(&["s"], "a := 1 m/s^2")?, "a := 1 m/'s^2");
        assert_eq!(up(&["h"], "v := 100 km/h")?, "v := 100 km/'h");
        assert_eq!(up(&["h"], "v := x/h")?, "v := x/h", "not after a quantity");
        assert_eq!(up(&["T"], "f(T) := 2 T")?, "f(T) := 2 T", "a parameter");
        assert_eq!(up(&["i"], "s := sum(2 i, i, 1, 3)")?, "s := sum(2 i, i, 1, 3)", "a summation variable");
        assert_eq!(up(&[], "x := 2 T")?, "x := 2 T", "no variable T above");
        assert_eq!(up(&["x"], "y := 2 x")?, "y := 2 x", "not a unit name");
        Ok(())
    }

    #[test]
    fn your_variables_in_a_units_place_are_multiplied() -> TestResult {
        let ex = |vars: &[&str], src| with(vars, |n, e| explicit(e, n), src);
        assert_eq!(ex(&["T"], "x := 2 T")?, "x := 2*T");
        assert_eq!(ex(&["T"], "x := -2 T^2")?, "x := -2*T^2");
        assert_eq!(ex(&["T"], "x := y/2 T")?, "x := y/(2*T)");
        assert_eq!(ex(&["h"], "v := 100 km/h")?, "v := (100 km)/h");
        assert_eq!(ex(&["T"], "x := 2 T/s")?, "x := 2*T/'s", "s keeps its place as a unit");
        assert_eq!(ex(&["T", "s"], "x := 2 T/s")?, "x := 2*T/s");
        assert_eq!(ex(&["T"], "x := [1; 2] T")?, "x := [1; 2]*T");
        assert_eq!(ex(&["T"], "f(T) := 2 T")?, "f(T) := 2 T", "a parameter");
        assert_eq!(ex(&[], "x := 2 T + 3 m/s")?, "x := 2 T + 3 m/s");
        Ok(())
    }

    #[test]
    fn what_a_region_defines_for_the_regions_below() -> TestResult {
        let d = |src| parse(src).map(|e| defined_names(&e));
        assert_eq!(d("x := 2")?, ["x"]);
        assert_eq!(d("v[2] := 1")?, ["v"]);
        assert_eq!(d("f(x) := block(y := x, y)")?, Vec::<String>::new());
        assert_eq!(d("x := block(y := 2, y)")?, ["x", "y"]);
        assert_eq!(d("for(i, 1..3, s := s + i)")?, ["i", "s"]);
        assert_eq!(d("sum(i, i, 1, 3)")?, Vec::<String>::new());
        Ok(())
    }
}
