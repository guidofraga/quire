use super::*;

fn sym_eval(src: &str) -> String {
    let none = |_: &str, _: usize| None;
    match quire_ast::parse(src) {
        Ok(e) => evaluate(&e, &none).unwrap_or_else(|e| format!("error: {e}")),
        Err(e) => format!("error: {e}"),
    }
}

fn parsed(src: &str) -> Res<S> {
    let none = |_: &str, _: usize| None;
    let e = quire_ast::parse(src).map_err(|e| e.to_string())?;
    from_expr(&e, &mut Ctx::new(&none))
}

/// Values for names when results are checked by numbers.
fn values(name: &str) -> Option<f64> {
    Some(match name {
        "a" => 1.7,
        "b" => 0.6,
        "c" => -2.3,
        "k" => 0.8,
        _ => 1.3,
    })
}

fn at(e: &S, x: &str, v: f64) -> f64 {
    approx(e, &|n: &str| if n == x { Some(v) } else { values(n) }).unwrap_or(f64::NAN)
}

/// The derivative of what `int(f, x)` gives is `f` again, at a few points.
fn check_antiderivative(f: &str) -> Res<()> {
    let f = parsed(f)?;
    let big_f = integrate(&f, "x")?;
    let df = diff(&big_f, "x");
    for v in [0.3, 0.7, 1.9, 2.6] {
        let (want, got) = (at(&f, "x", v), at(&df, "x", v));
        if want.is_nan() {
            continue; // outside the domain, as for asin(x) at 1.9
        }
        assert!(
            (want - got).abs() < 1e-9 * (1.0 + want.abs()),
            "d/dx {} at {v}: {got} vs {want}",
            show(&big_f)
        );
    }
    Ok(())
}

#[test]
fn simplifies() {
    assert_eq!(sym_eval("x + x + 2*x"), "4*x");
    assert_eq!(sym_eval("x*x*y/x"), "x*y");
    assert_eq!(sym_eval("2/4 + 1/4"), "3/4");
    assert_eq!(sym_eval("(a + b) - (a - b)"), "2*b");
    assert_eq!(sym_eval("2 'm + 3 'm"), "5*'m");
    assert_eq!(sym_eval("sqrt(16)"), "4");
    assert_eq!(sym_eval("x^2*x^3"), "x^5");
}

#[test]
fn simplifies_to_short_textbook_forms() {
    // like terms collected and products multiplied out when that is shorter
    assert_eq!(sym_eval("x*(x + 1) - x^2"), "x");
    assert_eq!(sym_eval("(2*x + 2)/2"), "x + 1");
    // common factors cancelled, also between sums
    assert_eq!(sym_eval("(x^2 - 1)/(x - 1)"), "x + 1");
    assert_eq!(sym_eval("(a^2 - b^2)/(a - b)"), "a + b");
    assert_eq!(sym_eval("(a + b)^2/(a + b)"), "a + b");
    assert_eq!(sym_eval("2*a/(4*a*b)"), "1/(2*b)");
    // fractions brought together
    assert_eq!(sym_eval("1/(1/a + 1/b)"), "a*b/(a + b)");
    assert_eq!(sym_eval("x/2 + x/3"), "5*x/6");
    assert_eq!(sym_eval("x/2 - L/3"), "(3*x - 2*L)/6");
    assert_eq!(sym_eval("P*L^3/(3*E*I) + P*L^3/(6*E*I)"), "L^3*P/(2*E*I)");
    // roots of products, with names taken as positive
    assert_eq!(sym_eval("sqrt(x^2)"), "x");
    assert_eq!(sym_eval("sqrt(12)"), "2*sqrt(3)");
    assert_eq!(sym_eval("sqrt(b*h^3/12/(b*h))"), "h/(2*sqrt(3))");
    // identities and exact values
    assert_eq!(sym_eval("sin(x)^2 + cos(x)^2"), "1");
    assert_eq!(sym_eval("exp(a)*exp(b)"), "exp(a + b)");
    assert_eq!(sym_eval("cos(π) + sin(π/6)"), "-1/2");
    assert_eq!(sym_eval("cos(-x) + sin(-x)"), "cos(x) - sin(x)");
    assert_eq!(sym_eval("simplify((x^2 + 2*x + 1)/(x + 1))"), "x + 1");
    // signs read naturally
    assert_eq!(sym_eval("(1 - sqrt(5))/2"), "(1 - sqrt(5))/2");
}

#[test]
fn beam_formulas_read_like_a_textbook() {
    // simply supported beam under a uniform load q: slope and deflection shapes
    assert_eq!(sym_eval("diff(q*x/24*(L^3 - 2*L*x^2 + x^3), x)"), "q*(L^3 + 4*x^3 - 6*L*x^2)/24");
    assert_eq!(sym_eval("int(int(q*x*(L - x)/2, x), x)"), "q*x^3*(2*L - x)/24");
    assert_eq!(sym_eval("diff(q*x*(L^3 - 2*L*x^2 + x^3)/(24*E*I), x, 2)"), "q*x*(x - L)/(2*E*I)");
    assert_eq!(sym_eval("diff(q*x^2/2 - q*L*x/2, x)"), "q*(2*x - L)/2");
    assert_eq!(sym_eval("5*q*L^4/(384*E*I)"), "5*L^4*q/(384*E*I)");
    // a product with functions keeps its terms
    assert_eq!(sym_eval("diff(x^2*sin(x), x)"), "x^2*cos(x) + 2*x*sin(x)");
}

#[test]
fn expands() {
    assert_eq!(sym_eval("expand((x + 1)^2)"), "x^2 + 2*x + 1");
    assert_eq!(sym_eval("expand((a + b)*(a - b))"), "a^2 - b^2");
    assert_eq!(sym_eval("expand((a + b)^3)"), "a^3 + 3*a^2*b + 3*a*b^2 + b^3");
}

#[test]
fn factors() {
    assert_eq!(sym_eval("factor(x^2 - 5*x + 6)"), "(x - 2)*(x - 3)");
    assert_eq!(sym_eval("factor(x^3 - 6*x^2 + 11*x - 6)"), "(x - 1)*(x - 2)*(x - 3)");
    assert_eq!(sym_eval("factor(2*x^2 + 4*x + 2)"), "2*(x + 1)^2");
    assert_eq!(sym_eval("factor(6*x^2 - x - 2)"), "(2*x + 1)*(3*x - 2)");
    assert_eq!(sym_eval("factor(a^2 - b^2)"), "(a - b)*(a + b)");
    assert_eq!(sym_eval("factor(x^4 - 16)"), "(x - 2)*(x + 2)*(x^2 + 4)");
    assert_eq!(sym_eval("factor(x^4 - 5*x^2 + 6)"), "(x^2 - 2)*(x^2 - 3)");
    assert_eq!(sym_eval("factor(q*L*x - q*x^2)"), "q*x*(L - x)");
    assert_eq!(sym_eval("factor(x^2 - 2*a*x + a^2)"), "(a - x)^2");
    // nothing to split
    assert_eq!(sym_eval("factor(x^2 + 1)"), "x^2 + 1");
    assert_eq!(sym_eval("factor(x^2 - 2)"), "x^2 - 2");
}

#[test]
fn differentiates() {
    assert_eq!(sym_eval("diff(x^3, x)"), "3*x^2");
    assert_eq!(sym_eval("diff(sin(2*x), x)"), "2*cos(2*x)");
    assert_eq!(sym_eval("diff(q*x*(L - x)/2, x)"), "q*(L - 2*x)/2");
    assert_eq!(sym_eval("diff(x^4, x, 2)"), "12*x^2");
    assert_eq!(sym_eval("diff(ln(x), x)"), "1/x");
    assert_eq!(sym_eval("diff((x^2 + 1)/(x - 1), x)"), "(x^2 - 2*x - 1)/(x - 1)^2");
}

#[test]
fn integrates() {
    assert_eq!(sym_eval("int(x^2, x)"), "x^3/3");
    assert_eq!(sym_eval("int(q, x)"), "q*x");
    assert_eq!(sym_eval("int(cos(3*x), x)"), "sin(3*x)/3");
    assert_eq!(sym_eval("int(1/x, x)"), "ln(x)");
    assert_eq!(sym_eval("int(x^2, x, 0, L)"), "L^3/3");
    assert_eq!(sym_eval("int(q*x*(L - x)/2, x, 0, L)"), "L^3*q/12");
}

#[test]
fn integrates_harder_functions() -> Res<()> {
    let cases = [
        // f(a*x + b)
        ("exp(2*x + 1)", "exp(2*x + 1)/2"),
        ("sqrt(x)", "2*x^(3/2)/3"),
        // substitution: the inner derivative is a factor
        ("x*exp(x^2)", "exp(x^2)/2"),
        ("x*(x^2 + 1)^3", "(x^2 + 1)^4/8"),
        ("ln(x)/x", "ln(x)^2/2"),
        // by parts
        ("x*exp(x)", "exp(x)*(x - 1)"),
        ("x^2*exp(x)", "exp(x)*(x^2 - 2*x + 2)"),
        ("x*sin(x)", "-x*cos(x) + sin(x)"),
        ("x*ln(x)", "x^2*(2*ln(x) - 1)/4"),
        ("ln(x^2 + 1)", "x*ln(x^2 + 1) - 2*x + 2*atan(x)"),
        ("exp(x)*sin(x)", "exp(x)*(sin(x) - cos(x))/2"),
        // sines and cosines
        ("sin(x)*cos(x)", "-cos(x)^2/2"),
        ("sin(x)^2", "(2*x - sin(2*x))/4"),
        ("sin(3*x)*sin(x)", "(2*sin(2*x) - sin(4*x))/8"),
        // rational functions
        ("1/(x^2 + a^2)", "atan(x/a)/a"),
        ("1/(x^2 - 1)", "(ln(x - 1) - ln(x + 1))/2"),
        ("1/((x + 1)*(x + 2))", "ln(x + 1) - ln(x + 2)"),
        ("(x + 1)/(x^2 + 2*x + 5)", "ln(x^2 + 2*x + 5)/2"),
        ("x^3/(x^2 + 1)", "(x^2 - ln(x^2 + 1))/2"),
        ("1/(x*(x + 1)^2)", "ln(x) - ln(x + 1) + 1/(x + 1)"),
        ("1/(x^2 - 2)", "ln((x - sqrt(2))/(x + sqrt(2)))/(2*sqrt(2))"),
        ("1/(x^2 + x + 1)", "2*atan((2*x + 1)/sqrt(3))/sqrt(3)"),
        ("1/sqrt(1 - x^2)", "asin(x)"),
    ];
    for (f, want) in cases {
        assert_eq!(sym_eval(&format!("int({f}, x)")), want, "int({f}, x)");
        check_antiderivative(f)?;
    }
    Ok(())
}

#[test]
fn definite_integrals_use_limits_at_the_ends() {
    assert_eq!(sym_eval("int(1/(x^2 + 1), x, 0, 1)"), "π/4");
    assert_eq!(sym_eval("int(sin(x), x, 0, π)"), "2");
    assert_eq!(sym_eval("int(ln(x), x, 0, 1)"), "-1");
    assert_eq!(sym_eval("int(exp(-x), x, 0, ∞)"), "1");
    assert_eq!(sym_eval("int(1/x^2, x, 1, ∞)"), "1");
    assert_eq!(sym_eval("int(q*x/24*(L^3 - 2*L*x^2 + x^3), x, 0, L)"), "L^5*q/120");
    assert_eq!(sym_eval("int(1/x, x, 0, 1)"), "∞");
}

#[test]
fn says_when_it_cannot_integrate() {
    assert_eq!(sym_eval("int(exp(x^2), x)"), "error: cannot integrate exp(x^2) symbolically");
    assert_eq!(sym_eval("int(sin(x)/x, x)"), "error: cannot integrate sin(x)/x symbolically");
    assert!(sym_eval("int(1/(x^3 + x + 1), x)").starts_with("error: cannot integrate"));
}

#[test]
fn solves() {
    assert_eq!(sym_eval("solve(2*x + 4 == 0, x)"), "-2");
    assert_eq!(sym_eval("solve(a*x == b, x)"), "b/a");
    assert_eq!(sym_eval("solve(x^2 - 5*x + 6, x)"), "[2; 3]");
    assert_eq!(
        sym_eval("solve(a*x^2 + b*x + c, x)"),
        "[(-b - sqrt(b^2 - 4*a*c))/(2*a); (-b + sqrt(b^2 - 4*a*c))/(2*a)]"
    );
    assert!(sym_eval("solve(x^2 + 1, x)").contains("no real solutions"));
}

#[test]
fn solves_higher_degrees_fractions_and_functions() {
    let cases = [
        ("x^3 - 6*x^2 + 11*x - 6 == 0, x", "[1; 2; 3]"),
        ("x^4 - 5*x^2 + 4 == 0, x", "[-2; -1; 1; 2]"),
        ("2*x^3 - x^2 - 2*x + 1 == 0, x", "[-1; 1/2; 1]"),
        ("x^3 - x^2 - 2*x + 2 == 0, x", "[-sqrt(2); 1; sqrt(2)]"),
        ("x^3 == 2, x", "2^(1/3)"),
        ("x^3 == -8, x", "-2"),
        ("x^4 == 16, x", "[-2; 2]"),
        ("x^2 == a^2, x", "[-a; a]"),
        ("x^3 - a^2*x == 0, x", "[-a; 0; a]"),
        // fractions cleared; a root of a denominator is dropped
        ("1/x + 1/(x + 1) == 1, x", "[(1 - sqrt(5))/2; (sqrt(5) + 1)/2]"),
        ("x/(x - 1) == 0, x", "0"),
        ("(x^2 - 1)/(x - 1) == 0, x", "-1"),
        // one unknown isolated
        ("exp(k*t) == 2, t", "ln(2)/k"),
        ("sin(x) == a, x", "asin(a)"),
        ("ln(x) == 2, x", "exp(2)"),
        ("10^x == 1000, x", "ln(1000)/ln(10)"),
        ("sqrt(x) == 3, x", "9"),
        ("x*exp(x) == 0, x", "0"),
        // the span of a cantilever for a given tip deflection
        ("P*L^3/(3*E*I) == d, L", "(3*E*I*d/P)^(1/3)"),
    ];
    for (eq, want) in cases {
        assert_eq!(sym_eval(&format!("solve({eq})")), want, "solve({eq})");
    }
}

#[test]
fn roots_satisfy_their_equations() -> Res<()> {
    for (eq, x) in [
        ("x^3 - 6*x^2 + 11*x - 6", "x"),
        ("x^3 - x^2 - 2*x + 2", "x"),
        ("1/x + 1/(x + 1) - 1", "x"),
        ("a*x^2 + b*x + c", "x"),
        ("exp(k*x) - 2", "x"),
        ("x^4 - 5*x^2 + 4", "x"),
    ] {
        let e = parsed(eq)?;
        let roots = match solve::solve(&e, x)? {
            S::Vec(rs) => rs,
            r => vec![r],
        };
        for r in roots {
            let v = approx(&r, &values).ok_or("no numeric value")?;
            assert!(at(&e, x, v).abs() < 1e-9, "{eq} at {x} = {}", show(&r));
        }
    }
    Ok(())
}

#[test]
fn says_when_it_cannot_solve() {
    assert!(sym_eval("solve(x^3 + x + 1, x)").contains("cannot find the roots of this degree-3 equation"));
    assert!(sym_eval("solve(x^5 + x + 3, x)").contains("solve(f(x) == 0, x, a, b)"));
    assert!(sym_eval("solve(x*exp(x) == 1, x)").contains("cannot isolate x"));
    assert_eq!(sym_eval("solve(exp(x) == -1, x)"), "error: no real solutions");
    assert_eq!(sym_eval("solve(sin(x) == 2, x)"), "error: no real solutions");
    assert_eq!(sym_eval("solve(x^4 + 1, x)"), "error: no real solutions");
    assert_eq!(sym_eval("solve(a == 2, x)"), "error: there is no x to solve for");
}

#[test]
fn solves_linear_systems() {
    assert_eq!(sym_eval("solve([x + y == 3; x - y == 1], [x; y])"), "[2; 1]");
    assert_eq!(sym_eval("solve([a*x + y == 1; x - y == b], [x; y])"), "[(b + 1)/(a + 1); (1 - a*b)/(a + 1)]");
    assert_eq!(sym_eval("solve([x + y + z == 6; x - y == 0; x + 2*y + 3*z == 12], [x; y; z])"), "[2; 2; 2]");
    // reactions of a simply supported beam with a point load P at a
    assert_eq!(sym_eval("solve([A + B == P; B*L == P*a], [A; B])"), "[P*(L - a)/L; P*a/L]");
    assert!(sym_eval("solve([x + y == 1; 2*x + 2*y == 2], [x; y])").contains("say the same thing"));
    assert!(sym_eval("solve([x*y == 1; x - y == 0], [x; y])").contains("not linear"));
    assert!(sym_eval("solve([x + y == 1], [x; y])").contains("as many equations as unknowns"));
}

#[test]
fn series() {
    assert_eq!(sym_eval("series(exp(x), x, 0, 4)"), "1 + x + x^2/2 + x^3/6 + x^4/24");
    assert_eq!(sym_eval("series(ln(x), x, 1, 3)"), "(x - 1) - (x - 1)^2/2 + (x - 1)^3/3");
    assert_eq!(sym_eval("series(sin(x)/x, x, 0, 4)"), "1 - x^2/6 + x^4/120");
    assert_eq!(sym_eval("taylor(cos(a*x), x, 0, 4)"), "1 - a^2*x^2/2 + a^4*x^4/24");
    assert_eq!(sym_eval("series(sqrt(1 + x), x, 0, 2)"), "1 + x/2 - x^2/8");
    assert_eq!(sym_eval("series(x^2 + 1, x, 0, 5)"), "1 + x^2");
    assert!(sym_eval("series(ln(x), x, 0, 3)").starts_with("error: no series at x = 0"));
    assert!(sym_eval("series(exp(x), x, 0)").contains("series(f, x, x0, n)"));
    // inside other expressions the series is an ordinary sum
    assert_eq!(sym_eval("diff(series(exp(x), x, 0, 3), x)"), "(x^2 + 2*x + 2)/2");
}

#[test]
fn limits() {
    assert_eq!(sym_eval("lim(sin(x)/x, x, 0)"), "1");
    assert_eq!(sym_eval("lim((x^2 - 1)/(x - 1), x, 1)"), "2");
    assert_eq!(sym_eval("lim((1 - cos(x))/x^2, x, 0)"), "1/2");
    assert_eq!(sym_eval("lim((1 + 1/n)^n, n, ∞)"), "e");
    assert_eq!(sym_eval("lim(x*ln(x), x, 0)"), "0");
    assert_eq!(sym_eval("lim((3*x^2 + 1)/(x^2 - 5), x, ∞)"), "3");
    assert_eq!(sym_eval("lim(exp(-x), x, ∞)"), "0");
    assert_eq!(sym_eval("lim(x^2, x, -∞)"), "∞");
    assert_eq!(sym_eval("lim(exp(x)/x^2, x, ∞)"), "∞");
    assert_eq!(sym_eval("lim(atan(x), x, ∞)"), "π/2");
    assert_eq!(sym_eval("lim(1/x^2, x, 0)"), "∞");
    assert_eq!(sym_eval("lim(a*x + b, x, L)"), "L*a + b");
    assert!(sym_eval("lim(1/x, x, 0)").contains("from the left differs"));
    assert!(sym_eval("lim(sin(x), x, ∞)").contains("oscillating"));
}

#[test]
fn substitutes() {
    assert_eq!(sym_eval("subs(x^2 + y, x, a + 1)"), "(a + 1)^2 + y");
    assert_eq!(sym_eval("substitute(q*x*(L - x)/2, x, L/2)"), "L^2*q/8");
}

#[test]
fn units_stay_with_their_quantities() {
    assert_eq!(sym_eval("int(5 'kN/'m*x, x)"), "5*x^2*'kN/(2*'m)");
    assert_eq!(sym_eval("sqrt(4 'm^2)"), "2*'m");
    assert_eq!(sym_eval("solve(2 'm*x == 6 'm, x)"), "3");
    assert_eq!(sym_eval("diff(q*'kN*x^2, x)"), "2*q*x*'kN");
}
