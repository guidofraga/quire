//! Symbolic math, shown with `→` (SMath's symbolic evaluation).
//!
//! Names stay symbols: `q*x*(L - x)/2 →` keeps `q` and `L`, and the document's functions
//! are expanded into their bodies. On top of simplification (like terms collected,
//! numbers folded exactly, powers combined) it knows `diff`, `int` (indefinite and
//! definite), `expand`, `simplify` and `solve` for equations of degree one and two.
//!
//! Expressions are kept in a canonical form built by the smart constructors [`add`],
//! [`mul`], [`pow`] and [`func`], so two equal expressions have equal keys.

use std::collections::HashMap;

use quire_ast::{BinaryOp, CmpOp, Expr, UnaryOp};

// ---------------------------------------------------------------------------
// Numbers: exact rationals, falling back to floats for decimals and overflow
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Num {
    Rat(i128, i128),
    Float(f64),
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a.max(1)
}

impl Num {
    fn int(n: i128) -> Num {
        Num::Rat(n, 1)
    }

    fn rat(n: i128, d: i128) -> Num {
        if d == 0 {
            return Num::Float(f64::NAN);
        }
        let g = gcd(n, d) * d.signum();
        Num::Rat(n / g, d / g)
    }

    fn f(self) -> f64 {
        match self {
            Num::Rat(n, d) => n as f64 / d as f64,
            Num::Float(x) => x,
        }
    }

    fn is(self, n: i128) -> bool {
        matches!(self, Num::Rat(a, 1) if a == n)
    }

    fn is_zero(self) -> bool {
        self.f() == 0.0
    }

    fn integer(self) -> Option<i128> {
        match self {
            Num::Rat(n, 1) => Some(n),
            _ => None,
        }
    }

    fn add(self, o: Num) -> Num {
        match (self, o) {
            (Num::Rat(a, b), Num::Rat(c, d)) => {
                match (a.checked_mul(d), c.checked_mul(b), b.checked_mul(d)) {
                    (Some(x), Some(y), Some(z)) if x.checked_add(y).is_some() => Num::rat(x + y, z),
                    _ => Num::Float(self.f() + o.f()),
                }
            }
            _ => Num::Float(self.f() + o.f()),
        }
    }

    fn mul(self, o: Num) -> Num {
        match (self, o) {
            (Num::Rat(a, b), Num::Rat(c, d)) => match (a.checked_mul(c), b.checked_mul(d)) {
                (Some(x), Some(y)) => Num::rat(x, y),
                _ => Num::Float(self.f() * o.f()),
            },
            _ => Num::Float(self.f() * o.f()),
        }
    }

    fn neg(self) -> Num {
        self.mul(Num::int(-1))
    }

    fn recip(self) -> Num {
        match self {
            Num::Rat(n, d) => Num::rat(d, n),
            Num::Float(x) => Num::Float(1.0 / x),
        }
    }

    /// `self^e`, exactly where possible (integer powers, perfect roots).
    fn pow(self, e: Num) -> Option<Num> {
        if let Some(k) = e.integer() {
            let k32 = i32::try_from(k).ok()?;
            return Some(match self {
                Num::Rat(n, d) if k32.unsigned_abs() <= 64 => {
                    let (n, d) = if k32 < 0 { (d, n) } else { (n, d) };
                    match (n.checked_pow(k32.unsigned_abs()), d.checked_pow(k32.unsigned_abs())) {
                        (Some(a), Some(b)) => Num::rat(a, b),
                        _ => Num::Float(self.f().powi(k32)),
                    }
                }
                _ => Num::Float(self.f().powi(k32)),
            });
        }
        match (self, e) {
            // perfect roots: 4^(1/2) = 2, 27^(1/3) = 3
            (Num::Rat(n, d), Num::Rat(p, q)) if n >= 0 && q > 1 && q <= 4 => {
                let root = |x: i128| {
                    let r = (x as f64).powf(1.0 / q as f64).round() as i128;
                    (r.checked_pow(q as u32) == Some(x)).then_some(r)
                };
                let (rn, rd) = (root(n)?, root(d)?);
                Num::rat(rn, rd).pow(Num::int(p))
            }
            (Num::Float(x), _) => Some(Num::Float(x.powf(e.f()))),
            (_, Num::Float(y)) => Some(Num::Float(self.f().powf(y))),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum S {
    N(Num),
    Sym(String),
    Unit(String),
    Add(Vec<S>),
    Mul(Vec<S>),
    Pow(Box<S>, Box<S>),
    Fn(String, Vec<S>),
    /// Several results (`solve` with two roots): shown as a column vector.
    Vec(Vec<S>),
}

pub(crate) type Res<T> = std::result::Result<T, String>;

const ZERO: S = S::N(Num::Rat(0, 1));
const ONE: S = S::N(Num::Rat(1, 1));

fn n(k: i128) -> S {
    S::N(Num::int(k))
}

fn num_of(s: &S) -> Option<Num> {
    match s {
        S::N(x) => Some(*x),
        _ => None,
    }
}

impl S {
    /// A canonical text key: equal expressions have equal keys.
    fn key(&self) -> String {
        match self {
            S::N(Num::Rat(a, 1)) => a.to_string(),
            S::N(Num::Rat(a, b)) => format!("{a}/{b}"),
            S::N(Num::Float(x)) => format!("{x:?}"),
            S::Sym(s) => s.clone(),
            S::Unit(u) => format!("'{u}"),
            S::Add(ts) => format!("({})", ts.iter().map(S::key).collect::<Vec<_>>().join("+")),
            S::Mul(fs) => format!("({})", fs.iter().map(S::key).collect::<Vec<_>>().join("*")),
            S::Pow(b, e) => format!("{}^{}", b.key(), e.key()),
            S::Fn(f, xs) => format!("{f}({})", xs.iter().map(S::key).collect::<Vec<_>>().join(",")),
            S::Vec(xs) => format!("[{}]", xs.iter().map(S::key).collect::<Vec<_>>().join(";")),
        }
    }

    fn depends(&self, x: &str) -> bool {
        match self {
            S::Sym(s) => s == x,
            S::N(_) | S::Unit(_) => false,
            S::Add(xs) | S::Mul(xs) | S::Fn(_, xs) | S::Vec(xs) => xs.iter().any(|t| t.depends(x)),
            S::Pow(b, e) => b.depends(x) || e.depends(x),
        }
    }

    /// Total degree, for ordering terms: x^2 before x before constants.
    fn degree(&self) -> f64 {
        match self {
            S::N(_) | S::Unit(_) => 0.0,
            S::Sym(_) | S::Fn(..) => 1.0,
            S::Pow(b, e) => b.degree() * num_of(e).map_or(1.0, Num::f),
            S::Mul(fs) => fs.iter().map(S::degree).sum(),
            S::Add(ts) => ts.iter().map(S::degree).fold(0.0, f64::max),
            S::Vec(_) => 0.0,
        }
    }
}

/// Split a term into its numeric coefficient and the rest: `3*x*y` → (3, x*y).
fn coef(t: &S) -> (Num, S) {
    match t {
        S::N(c) => (*c, ONE),
        S::Mul(fs) => match fs.first() {
            Some(S::N(c)) => {
                let rest: Vec<S> = fs[1..].to_vec();
                (*c, if rest.len() == 1 { rest[0].clone() } else { S::Mul(rest) })
            }
            _ => (Num::int(1), t.clone()),
        },
        _ => (Num::int(1), t.clone()),
    }
}

/// Split a factor into base and exponent: `x^3` → (x, 3), `y` → (y, 1).
fn base_exp(f: &S) -> (S, S) {
    match f {
        S::Pow(b, e) => ((**b).clone(), (**e).clone()),
        _ => (f.clone(), ONE),
    }
}

pub(crate) fn add(terms: Vec<S>) -> S {
    let mut flat = Vec::new();
    for t in terms {
        match t {
            S::Add(ts) => flat.extend(ts),
            // a number times a sum is spread over it, so (a + b) - (a - b) cancels
            S::Mul(fs) if fs.len() == 2 && matches!((&fs[0], &fs[1]), (S::N(_), S::Add(_))) => {
                let (S::N(c), S::Add(ts)) = (&fs[0], &fs[1]) else { unreachable!() };
                flat.extend(ts.iter().map(|t| mul(vec![S::N(*c), t.clone()])));
            }
            t => flat.push(t),
        }
    }
    let mut constant = Num::int(0);
    // like terms: rest key → (rest, summed coefficient), in order of first appearance
    let mut order: Vec<String> = Vec::new();
    let mut like: HashMap<String, (S, Num)> = HashMap::new();
    for t in flat {
        if let S::N(c) = t {
            constant = constant.add(c);
            continue;
        }
        let (c, rest) = coef(&t);
        let k = rest.key();
        match like.get_mut(&k) {
            Some((_, sum)) => *sum = sum.add(c),
            None => {
                order.push(k.clone());
                like.insert(k, (rest, c));
            }
        }
    }
    let mut out: Vec<S> = order
        .into_iter()
        .filter_map(|k| {
            let (rest, c) = like.remove(&k)?;
            (!c.is_zero()).then(|| mul(vec![S::N(c), rest]))
        })
        .collect();
    out.sort_by(term_order);
    if !constant.is_zero() {
        out.push(S::N(constant));
    }
    match out.len() {
        0 => ZERO,
        1 => out.pop().unwrap(),
        _ => S::Add(out),
    }
}

/// A term's powers of each name, if it is a monomial (`3*a^2*b` → {a: 2, b: 1}).
fn monomial(t: &S) -> Option<Vec<(String, f64)>> {
    let factors = match coef(t).1 {
        S::Mul(fs) => fs,
        S::N(_) => vec![],
        f => vec![f],
    };
    let mut out = Vec::new();
    for f in factors {
        let (b, e) = base_exp(&f);
        let name = match b {
            S::Sym(s) => s.to_lowercase(),
            S::Unit(u) => format!("~{u}"),
            _ => return None,
        };
        out.push((name, num_of(&e)?.f()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

/// The order terms are written in, as in textbooks: higher degree first; among equal
/// degrees, polynomial terms before others (-b + sqrt(…)), positive before negative
/// (b^2 - 4*a*c), then higher powers of the first name (a^3 + 3*a^2*b + 3*a*b^2 + b^3).
fn term_order(a: &S, b: &S) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let by_powers = || match (monomial(a), monomial(b)) {
        (Some(ma), Some(mb)) => {
            let mut names: Vec<&String> = ma.iter().chain(&mb).map(|(n, _)| n).collect();
            names.sort();
            names.dedup();
            let power =
                |m: &[(String, f64)], n: &String| m.iter().find(|(k, _)| k == n).map_or(0.0, |(_, e)| *e);
            names
                .into_iter()
                .map(|n| power(&mb, n).total_cmp(&power(&ma, n)))
                .find(|o| *o != Ordering::Equal)
                .unwrap_or(Ordering::Equal)
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    let sign = |t: &S| coef(t).0.f() < 0.0;
    let poly = |t: &S| monomial(t).is_none();
    b.degree()
        .total_cmp(&a.degree())
        .then_with(|| poly(a).cmp(&poly(b)))
        .then_with(|| sign(a).cmp(&sign(b)))
        .then_with(by_powers)
        .then_with(|| coef(a).1.key().to_lowercase().cmp(&coef(b).1.key().to_lowercase()))
}

pub(crate) fn mul(factors: Vec<S>) -> S {
    let mut flat = Vec::new();
    for f in factors {
        match f {
            S::Mul(fs) => flat.extend(fs),
            f => flat.push(f),
        }
    }
    let mut c = Num::int(1);
    let mut order: Vec<String> = Vec::new();
    let mut bases: HashMap<String, (S, Vec<S>)> = HashMap::new();
    for f in flat {
        if let S::N(x) = f {
            c = c.mul(x);
            continue;
        }
        let (b, e) = base_exp(&f);
        let k = b.key();
        match bases.get_mut(&k) {
            Some((_, es)) => es.push(e),
            None => {
                order.push(k.clone());
                bases.insert(k, (b, vec![e]));
            }
        }
    }
    if c.is_zero() {
        return ZERO;
    }
    let mut out: Vec<S> = Vec::new();
    for k in order {
        let (b, es) = bases.remove(&k).unwrap();
        match pow(b, add(es)) {
            S::N(x) => c = c.mul(x),
            S::Mul(fs) => {
                for f in fs {
                    match f {
                        S::N(x) => c = c.mul(x),
                        f => out.push(f),
                    }
                }
            }
            p => out.push(p),
        }
    }
    // symbols first, then functions, units last (5*x*'m reads "5 x m")
    let rank = |f: &S| match base_exp(f).0 {
        S::Unit(_) => 3,
        S::Fn(..) => 1,
        S::Add(_) => 2,
        _ => 0,
    };
    out.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| base_exp(a).0.key().cmp(&base_exp(b).0.key())));
    if !c.is(1) || out.is_empty() {
        out.insert(0, S::N(c));
    }
    if out.len() == 1 { out.pop().unwrap() } else { S::Mul(out) }
}

pub(crate) fn pow(base: S, e: S) -> S {
    if let Some(k) = num_of(&e) {
        if k.is_zero() {
            return ONE;
        }
        if k.is(1) {
            return base;
        }
        if let Some(b) = num_of(&base) {
            if b.is_zero() && k.f() > 0.0 {
                return ZERO;
            }
            if let Some(v) = b.pow(k) {
                return S::N(v);
            }
        }
    }
    if let Some(b) = num_of(&base)
        && b.is(1)
    {
        return ONE;
    }
    let int_exp = num_of(&e).and_then(Num::integer).is_some();
    match base {
        // (x^a)^b = x^(a*b) when b is a whole number
        S::Pow(b, a) if int_exp => pow(*b, mul(vec![*a, e])),
        S::Mul(fs) if int_exp => mul(fs.into_iter().map(|f| pow(f, e.clone())).collect()),
        base => S::Pow(Box::new(base), Box::new(e)),
    }
}

fn sym(name: &str) -> S {
    S::Sym(name.to_string())
}

pub(crate) fn func(name: &str, args: Vec<S>) -> S {
    let one = args.len() == 1;
    let a = args.first();
    let zero = a.is_some_and(|x| *x == ZERO);
    match name {
        "sin" | "tan" | "asin" | "atan" | "sinh" | "tanh" if one && zero => ZERO,
        "cos" | "cosh" | "exp" if one && zero => ONE,
        "ln" if one && a == Some(&ONE) => ZERO,
        "ln" if one && a == Some(&sym("e")) => ONE,
        // exp(ln(x)) = x, ln(exp(x)) = x
        "exp" if one && matches!(a, Some(S::Fn(f, _)) if f == "ln") => match a {
            Some(S::Fn(_, inner)) => inner[0].clone(),
            _ => unreachable!(),
        },
        "ln" if one && matches!(a, Some(S::Fn(f, _)) if f == "exp") => match a {
            Some(S::Fn(_, inner)) => inner[0].clone(),
            _ => unreachable!(),
        },
        "abs" if one && num_of(&args[0]).is_some() => match num_of(&args[0]).unwrap() {
            Num::Rat(p, q) => S::N(Num::rat(p.abs(), q)),
            Num::Float(f) => S::N(Num::Float(f.abs())),
        },
        _ => S::Fn(name.to_string(), args),
    }
}

fn neg(s: S) -> S {
    mul(vec![n(-1), s])
}

fn div(a: S, b: S) -> S {
    mul(vec![a, pow(b, n(-1))])
}

// ---------------------------------------------------------------------------
// From the AST, with the document's functions expanded
// ---------------------------------------------------------------------------

/// The document's functions, by name and arity: parameters and body.
pub(crate) type Functions<'a> = &'a dyn Fn(&str, usize) -> Option<(Vec<String>, Expr)>;

pub(crate) struct Ctx<'a> {
    pub functions: Functions<'a>,
    /// Parameters bound while a function body is expanded.
    bound: HashMap<String, S>,
    depth: usize,
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(functions: Functions<'a>) -> Self {
        Ctx { functions, bound: HashMap::new(), depth: 0 }
    }
}

fn parse_num(text: &str) -> S {
    if let Ok(i) = text.parse::<i128>() {
        return n(i);
    }
    S::N(Num::Float(text.parse().unwrap_or(f64::NAN)))
}

fn var_name(e: &Expr, what: &str) -> Res<String> {
    match e {
        Expr::Ident(v) => Ok(v.clone()),
        _ => Err(format!("{what} should be a name, like x")),
    }
}

pub(crate) fn from_expr(e: &Expr, cx: &mut Ctx) -> Res<S> {
    Ok(match e {
        Expr::Num(t) => parse_num(t),
        Expr::Ident(name) => match cx.bound.get(name) {
            Some(v) => v.clone(),
            None if name == "pi" => sym("π"),
            None => sym(name),
        },
        Expr::Unit(u) => S::Unit(u.clone()),
        Expr::Paren(x) => from_expr(x, cx)?,
        Expr::Unary(UnaryOp::Neg, x) => neg(from_expr(x, cx)?),
        Expr::Unary(UnaryOp::Pos, x) => from_expr(x, cx)?,
        Expr::Binary(op, a, b) => {
            let (a, b) = (from_expr(a, cx)?, from_expr(b, cx)?);
            match op {
                BinaryOp::Add => add(vec![a, b]),
                BinaryOp::Sub => add(vec![a, neg(b)]),
                BinaryOp::Mul | BinaryOp::Juxt => mul(vec![a, b]),
                BinaryOp::Div => div(a, b),
                BinaryOp::Pow => pow(a, b),
                _ => return Err(format!("→ does not handle the operator {}", op.symbol().trim())),
            }
        }
        Expr::Call(name, args) => call(name, args, cx)?,
        Expr::Compare(..) => {
            return Err("→ works on expressions; to solve an equation write solve(a == b, x)".into());
        }
        Expr::Matrix(_) | Expr::Index(..) | Expr::Range(..) => {
            return Err("→ works on single expressions, not matrices or ranges".into());
        }
        Expr::Str(_) => return Err("→ works on math, not text".into()),
        Expr::Factorial(_) | Expr::Unary(..) => return Err("→ does not handle this operator".into()),
        Expr::Placeholder => return Err("fill in the empty slot (?) first".into()),
        Expr::Define { .. } => return Err("→ shows the right-hand side of a definition".into()),
    })
}

fn call(name: &str, args: &[Expr], cx: &mut Ctx) -> Res<S> {
    let arg = |i: usize, cx: &mut Ctx| from_expr(&args[i], cx);
    match (name, args.len()) {
        ("diff", 2 | 3) => {
            let x = var_name(&args[1], "the variable of diff")?;
            let times = match args.get(2) {
                Some(Expr::Num(t)) => {
                    t.parse::<usize>().map_err(|_| "diff's order should be a whole number")?
                }
                Some(_) => return Err("diff's order should be a whole number".into()),
                None => 1,
            };
            let mut f = arg(0, cx)?;
            for _ in 0..times {
                f = diff(&f, &x);
            }
            Ok(f)
        }
        ("int", 2) => {
            let x = var_name(&args[1], "the variable of int")?;
            integrate(&arg(0, cx)?, &x)
        }
        ("int", 4) => {
            let x = var_name(&args[1], "the variable of int")?;
            let f = integrate(&arg(0, cx)?, &x)?;
            let (a, b) = (arg(2, cx)?, arg(3, cx)?);
            Ok(add(vec![subs(&f, &x, &b), neg(subs(&f, &x, &a))]))
        }
        ("expand", 1) => Ok(expand(&arg(0, cx)?)),
        ("simplify", 1) => arg(0, cx),
        ("solve", 2) => {
            let x = var_name(&args[1], "the unknown of solve")?;
            let lhs = match &args[0] {
                Expr::Compare(a, rest) if rest.len() == 1 && rest[0].0 == CmpOp::Eq => {
                    add(vec![from_expr(a, cx)?, neg(from_expr(&rest[0].1, cx)?)])
                }
                Expr::Compare(..) => {
                    return Err("solve needs an equation with ==, like solve(a*x == b, x)".into());
                }
                e => from_expr(e, cx)?,
            };
            solve(&lhs, &x)
        }
        ("sqrt", 1) => Ok(pow(arg(0, cx)?, S::N(Num::rat(1, 2)))),
        ("root", 2) => {
            let k = arg(1, cx)?;
            Ok(pow(arg(0, cx)?, pow(k, n(-1))))
        }
        ("exp", 1) if args[0] == Expr::Num("1".into()) => Ok(sym("e")),
        _ => {
            if cx.depth < 32
                && let Some((params, body)) = (cx.functions)(name, args.len())
            {
                // the document's own function: its body, with the arguments put in
                let values: Vec<S> = args.iter().map(|a| from_expr(a, cx)).collect::<Res<_>>()?;
                let saved = std::mem::take(&mut cx.bound);
                cx.bound = params.into_iter().zip(values).collect();
                cx.depth += 1;
                let out = from_expr(&body, cx);
                cx.depth -= 1;
                cx.bound = saved;
                return out;
            }
            let xs: Vec<S> = args.iter().map(|a| from_expr(a, cx)).collect::<Res<_>>()?;
            Ok(func(name, xs))
        }
    }
}

// ---------------------------------------------------------------------------
// Calculus and algebra
// ---------------------------------------------------------------------------

pub(crate) fn subs(e: &S, x: &str, v: &S) -> S {
    let s = |t: &S| subs(t, x, v);
    match e {
        S::Sym(name) if name == x => v.clone(),
        S::N(_) | S::Sym(_) | S::Unit(_) => e.clone(),
        S::Add(ts) => add(ts.iter().map(s).collect()),
        S::Mul(fs) => mul(fs.iter().map(s).collect()),
        S::Pow(b, p) => pow(s(b), s(p)),
        S::Fn(f, xs) => func(f, xs.iter().map(s).collect()),
        S::Vec(xs) => S::Vec(xs.iter().map(s).collect()),
    }
}

pub(crate) fn diff(e: &S, x: &str) -> S {
    if !e.depends(x) {
        return ZERO;
    }
    match e {
        S::Sym(_) => ONE,
        S::Add(ts) => add(ts.iter().map(|t| diff(t, x)).collect()),
        S::Mul(fs) => add((0..fs.len())
            .filter(|&i| fs[i].depends(x))
            .map(|i| {
                let mut f = fs.clone();
                f[i] = diff(&fs[i], x);
                mul(f)
            })
            .collect()),
        S::Pow(b, p) if !p.depends(x) => {
            mul(vec![(**p).clone(), pow((**b).clone(), add(vec![(**p).clone(), n(-1)])), diff(b, x)])
        }
        // a^b = exp(b*ln(a))
        S::Pow(b, p) => mul(vec![
            e.clone(),
            add(vec![
                mul(vec![diff(p, x), func("ln", vec![(**b).clone()])]),
                mul(vec![(**p).clone(), diff(b, x), pow((**b).clone(), n(-1))]),
            ]),
        ]),
        S::Fn(f, args) if args.len() == 1 => {
            let u = args[0].clone();
            let du = diff(&u, x);
            let outer = match f.as_str() {
                "sin" => func("cos", vec![u]),
                "cos" => neg(func("sin", vec![u])),
                "tan" => pow(func("cos", vec![u]), n(-2)),
                "exp" => e.clone(),
                "ln" => pow(u, n(-1)),
                "log" => pow(mul(vec![u, func("ln", vec![n(10)])]), n(-1)),
                "sinh" => func("cosh", vec![u]),
                "cosh" => func("sinh", vec![u]),
                "tanh" => pow(func("cosh", vec![u]), n(-2)),
                "asin" => pow(add(vec![ONE, neg(pow(u, n(2)))]), S::N(Num::rat(-1, 2))),
                "acos" => neg(pow(add(vec![ONE, neg(pow(u, n(2)))]), S::N(Num::rat(-1, 2)))),
                "atan" => pow(add(vec![ONE, pow(u, n(2))]), n(-1)),
                "abs" => func("sign", vec![u]),
                _ => return S::Fn("diff".into(), vec![e.clone(), sym(x)]),
            };
            mul(vec![outer, du])
        }
        _ => S::Fn("diff".into(), vec![e.clone(), sym(x)]),
    }
}

/// The slope of `u` if it is `a*x + b`.
fn linear(u: &S, x: &str) -> Option<S> {
    let a = diff(u, x);
    (!a.depends(x) && a != ZERO).then_some(a)
}

pub(crate) fn integrate(e: &S, x: &str) -> Res<S> {
    if !e.depends(x) {
        return Ok(mul(vec![e.clone(), sym(x)]));
    }
    let fail = || Err(format!("cannot integrate {} symbolically", print(&to_expr(e))));
    match e {
        S::Add(ts) => Ok(add(ts.iter().map(|t| integrate(t, x)).collect::<Res<_>>()?)),
        S::Mul(fs) => {
            let (dep, constant): (Vec<S>, Vec<S>) = fs.iter().cloned().partition(|f| f.depends(x));
            if dep.len() == 1 {
                return Ok(mul(vec![mul(constant), integrate(&dep[0], x)?]));
            }
            let expanded = expand(e);
            if expanded != *e {
                return integrate(&expanded, x);
            }
            fail()
        }
        S::Sym(_) => Ok(mul(vec![S::N(Num::rat(1, 2)), pow(sym(x), n(2))])),
        S::Pow(b, p) if !p.depends(x) => {
            let Some(a) = linear(b, x) else {
                let expanded = expand(e);
                return if expanded != *e { integrate(&expanded, x) } else { fail() };
            };
            if num_of(p).is_some_and(|k| k.is(-1)) {
                return Ok(div(func("ln", vec![(**b).clone()]), a));
            }
            let k1 = add(vec![(**p).clone(), ONE]);
            Ok(div(pow((**b).clone(), k1.clone()), mul(vec![a, k1])))
        }
        // c^(a*x + b) = c^(…)/(a ln c)
        S::Pow(b, p) if !b.depends(x) => match linear(p, x) {
            Some(a) => Ok(div(e.clone(), mul(vec![a, func("ln", vec![(**b).clone()])]))),
            None => fail(),
        },
        S::Fn(f, args) if args.len() == 1 => {
            let u = &args[0];
            let Some(a) = linear(u, x) else { return fail() };
            let primitive = match f.as_str() {
                "sin" => neg(func("cos", vec![u.clone()])),
                "cos" => func("sin", vec![u.clone()]),
                "exp" => e.clone(),
                "sinh" => func("cosh", vec![u.clone()]),
                "cosh" => func("sinh", vec![u.clone()]),
                "ln" => add(vec![mul(vec![u.clone(), func("ln", vec![u.clone()])]), neg(u.clone())]),
                "tan" => neg(func("ln", vec![func("cos", vec![u.clone()])])),
                _ => return fail(),
            };
            Ok(div(primitive, a))
        }
        _ => fail(),
    }
}

/// Products of sums multiplied out, whole powers of sums expanded.
pub(crate) fn expand(e: &S) -> S {
    match e {
        S::Add(ts) => add(ts.iter().map(expand).collect()),
        S::Mul(fs) => fs.iter().map(expand).fold(ONE, |acc, f| distribute(&acc, &f)),
        S::Pow(b, p) => {
            let b = expand(b);
            match (num_of(p).and_then(Num::integer), &b) {
                (Some(k), S::Add(_)) if (2..=12).contains(&k) => {
                    (0..k).fold(ONE, |acc, _| distribute(&acc, &b))
                }
                _ => pow(b, (**p).clone()),
            }
        }
        S::Fn(f, xs) => func(f, xs.iter().map(expand).collect()),
        _ => e.clone(),
    }
}

fn terms(e: &S) -> Vec<S> {
    match e {
        S::Add(ts) => ts.clone(),
        t => vec![t.clone()],
    }
}

fn distribute(a: &S, b: &S) -> S {
    let mut out = Vec::new();
    for x in terms(a) {
        for y in terms(b) {
            out.push(mul(vec![x.clone(), y]));
        }
    }
    add(out)
}

/// Roots of a polynomial of degree one or two in `x`.
pub(crate) fn solve(e: &S, x: &str) -> Res<S> {
    let p = expand(e);
    let mut c = [ZERO, ZERO, ZERO];
    for t in terms(&p) {
        let (k, rest) = power_of(&t, x).ok_or_else(|| {
            format!(
                "solve handles equations of degree one or two in {x}; this one is not a polynomial in {x}"
            )
        })?;
        if k > 2 {
            return Err(format!("solve handles equations of degree one or two in {x}; this one has {x}^{k}"));
        }
        c[k] = add(vec![c[k].clone(), rest]);
    }
    let [c0, c1, c2] = c;
    if c2 == ZERO {
        if c1 == ZERO {
            return Err(format!("there is no {x} to solve for"));
        }
        return Ok(neg(div(c0, c1)));
    }
    let disc = add(vec![pow(c1.clone(), n(2)), mul(vec![n(-4), c2.clone(), c0])]);
    if num_of(&disc).is_some_and(|d| d.f() < 0.0) {
        return Err("no real solutions".into());
    }
    let two_a = mul(vec![n(2), c2]);
    if disc == ZERO {
        return Ok(neg(div(c1, two_a)));
    }
    let root = pow(disc, S::N(Num::rat(1, 2)));
    Ok(S::Vec(vec![
        div(add(vec![neg(c1.clone()), neg(root.clone())]), two_a.clone()),
        div(add(vec![neg(c1), root]), two_a),
    ]))
}

/// A term as `rest*x^k` with `rest` free of `x`.
fn power_of(t: &S, x: &str) -> Option<(usize, S)> {
    if !t.depends(x) {
        return Some((0, t.clone()));
    }
    let factors = match t {
        S::Mul(fs) => fs.clone(),
        f => vec![f.clone()],
    };
    let mut k = 0;
    let mut rest = Vec::new();
    for f in factors {
        if !f.depends(x) {
            rest.push(f);
            continue;
        }
        let (b, e) = base_exp(&f);
        if b != sym(x) {
            return None;
        }
        k += usize::try_from(num_of(&e)?.integer()?).ok()?;
    }
    Some((k, mul(rest)))
}

/// Common factors pulled out of sums, for display: `q*(L - x)/2 - q*x/2` → `q*(L - 2*x)/2`.
pub(crate) fn tidy(e: &S) -> S {
    match e {
        S::Add(ts) => {
            let ts: Vec<S> = ts.iter().map(tidy).collect();
            let factors = |t: &S| match t {
                S::Mul(fs) => fs.iter().filter(|f| !matches!(f, S::N(_))).cloned().collect::<Vec<_>>(),
                S::N(_) => vec![],
                f => vec![f.clone()],
            };
            let first = factors(&ts[0]);
            let common: Vec<S> =
                first.into_iter().filter(|f| ts[1..].iter().all(|t| factors(t).contains(f))).collect();
            // a common numeric fraction, like the 1/2 in q*x/2 + q*L/2
            let coefs: Vec<Num> = ts.iter().map(|t| coef(t).0).collect();
            let shared = match coefs.first() {
                Some(Num::Rat(_, d))
                    if *d > 1 && coefs.iter().all(|c| matches!(c, Num::Rat(_, e) if e == d)) =>
                {
                    Some(Num::rat(1, *d))
                }
                _ => None,
            };
            if common.is_empty() && shared.is_none() {
                return add(ts);
            }
            let mut out = common.clone();
            let inv: Vec<S> = common.iter().map(|f| pow(f.clone(), n(-1))).collect();
            let factor = shared.unwrap_or(Num::int(1));
            let inner = add(ts
                .iter()
                .map(|t| mul([vec![t.clone(), S::N(factor.recip())], inv.clone()].concat()))
                .collect());
            out.push(S::N(factor));
            out.push(inner);
            mul(out)
        }
        S::Mul(fs) => mul(fs.iter().map(tidy).collect()),
        S::Pow(b, p) => pow(tidy(b), tidy(p)),
        S::Fn(f, xs) => func(f, xs.iter().map(tidy).collect()),
        S::Vec(xs) => S::Vec(xs.iter().map(tidy).collect()),
        _ => e.clone(),
    }
}

// ---------------------------------------------------------------------------
// Back to the AST, the way people write it
// ---------------------------------------------------------------------------

fn num_expr(x: Num) -> Expr {
    match x {
        Num::Rat(a, 1) if a < 0 => Expr::Unary(UnaryOp::Neg, Box::new(Expr::Num((-a).to_string()))),
        Num::Rat(a, 1) => Expr::Num(a.to_string()),
        Num::Rat(a, b) => {
            let frac = Expr::Binary(
                BinaryOp::Div,
                Box::new(Expr::Num(a.abs().to_string())),
                Box::new(Expr::Num(b.to_string())),
            );
            if a < 0 { Expr::Unary(UnaryOp::Neg, Box::new(frac)) } else { frac }
        }
        Num::Float(f) if f < 0.0 => Expr::Unary(UnaryOp::Neg, Box::new(Expr::Num(format_float(-f)))),
        Num::Float(f) => Expr::Num(format_float(f)),
    }
}

fn format_float(f: f64) -> String {
    let s = format!("{}", (f * 1e12).round() / 1e12);
    if s.contains('e') { format!("{f}") } else { s }
}

fn product(fs: Vec<Expr>) -> Expr {
    let mut it = fs.into_iter();
    let first = it.next().unwrap_or(Expr::Num("1".into()));
    it.fold(first, |acc, f| Expr::Binary(BinaryOp::Mul, Box::new(acc), Box::new(f)))
}

/// Is this expression negative as written (a leading minus)?
fn negative(e: &S) -> bool {
    coef(e).0.f() < 0.0
}

/// `-2*x` rather than `-(2*x)`: the minus goes on the first factor.
fn negate_leading(e: Expr) -> Expr {
    match e {
        Expr::Binary(op @ (BinaryOp::Mul | BinaryOp::Div), a, b) => {
            Expr::Binary(op, Box::new(negate_leading(*a)), b)
        }
        e => Expr::Unary(UnaryOp::Neg, Box::new(e)),
    }
}

pub(crate) fn to_expr(e: &S) -> Expr {
    match e {
        S::N(x) => num_expr(*x),
        S::Sym(s) => Expr::Ident(s.clone()),
        S::Unit(u) => Expr::Unit(u.clone()),
        S::Add(ts) => {
            let mut it = ts.iter();
            let mut out = to_expr(it.next().unwrap());
            for t in it {
                out = if negative(t) {
                    Expr::Binary(BinaryOp::Sub, Box::new(out), Box::new(to_expr(&neg(t.clone()))))
                } else {
                    Expr::Binary(BinaryOp::Add, Box::new(out), Box::new(to_expr(t)))
                };
            }
            out
        }
        S::Mul(_) => {
            let (c, rest) = coef(e);
            if c.f() < 0.0 {
                return negate_leading(to_expr(&mul(vec![S::N(c.neg()), rest])));
            }
            let factors = match rest {
                S::Mul(fs) => fs,
                f => vec![f],
            };
            let (mut top, mut bottom) = (Vec::new(), Vec::new());
            if let Num::Rat(a, b) = c {
                if a != 1 {
                    top.push(Expr::Num(a.to_string()));
                }
                if b != 1 {
                    bottom.push(Expr::Num(b.to_string()));
                }
            } else {
                top.push(num_expr(c));
            }
            for f in factors {
                let (b, p) = base_exp(&f);
                match num_of(&p) {
                    Some(k) if k.f() < 0.0 => bottom.push(to_expr(&pow(b, S::N(k.neg())))),
                    _ => top.push(to_expr(&f)),
                }
            }
            let top = product(top);
            if bottom.is_empty() {
                top
            } else {
                Expr::Binary(BinaryOp::Div, Box::new(top), Box::new(product(bottom)))
            }
        }
        S::Pow(b, p) => match num_of(p) {
            Some(Num::Rat(1, 2)) => Expr::Call("sqrt".into(), vec![to_expr(b)]),
            Some(k) if k.f() < 0.0 => Expr::Binary(
                BinaryOp::Div,
                Box::new(Expr::Num("1".into())),
                Box::new(to_expr(&pow((**b).clone(), S::N(k.neg())))),
            ),
            _ => Expr::Binary(BinaryOp::Pow, Box::new(to_expr(b)), Box::new(to_expr(p))),
        },
        S::Fn(f, xs) => Expr::Call(f.clone(), xs.iter().map(to_expr).collect()),
        S::Vec(xs) => Expr::Matrix(xs.iter().map(|x| vec![to_expr(x)]).collect()),
    }
}

fn print(e: &Expr) -> String {
    quire_ast::print(e)
}

/// `expr →`: the expression worked out symbolically, as linear text.
pub(crate) fn evaluate(e: &Expr, functions: Functions) -> Res<String> {
    let mut cx = Ctx::new(functions);
    let s = from_expr(e, &mut cx)?;
    // expand() asks for the expanded form; anything else is shown factored where it can be
    let shown = match e {
        Expr::Call(f, _) if f == "expand" => s,
        _ => tidy(&s),
    };
    Ok(print(&to_expr(&shown)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym_eval(src: &str) -> String {
        let none = |_: &str, _: usize| None;
        evaluate(&quire_ast::parse(src).unwrap(), &none).unwrap_or_else(|e| format!("error: {e}"))
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
    fn expands() {
        assert_eq!(sym_eval("expand((x + 1)^2)"), "x^2 + 2*x + 1");
        assert_eq!(sym_eval("expand((a + b)*(a - b))"), "a^2 - b^2");
        assert_eq!(sym_eval("expand((a + b)^3)"), "a^3 + 3*a^2*b + 3*a*b^2 + b^3");
    }

    #[test]
    fn differentiates() {
        assert_eq!(sym_eval("diff(x^3, x)"), "3*x^2");
        assert_eq!(sym_eval("diff(sin(2*x), x)"), "2*cos(2*x)");
        assert_eq!(sym_eval("diff(q*x*(L - x)/2, x)"), "q*(L - 2*x)/2");
        assert_eq!(sym_eval("diff(x^4, x, 2)"), "12*x^2");
        assert_eq!(sym_eval("diff(ln(x), x)"), "1/x");
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
}
