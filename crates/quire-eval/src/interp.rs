use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

use quire_ast::{BinaryOp, Expr, UnaryOp};
use quire_units::{Dim, Unit, UnitRegistry};

use crate::builtins::{self, dim_pow};
use crate::constants::constant;
use crate::error::{EvalError, Result, bail};
use crate::fn_solve;
use crate::ops::{self, arith, compare, same_dim};
use crate::value::{Matrix, Quantity, Value};

#[derive(Debug, Clone)]
pub enum Binding {
    Val(Value),
    Func(Rc<Func>),
    /// The definition exists but failed; uses report it instead of "not defined".
    Failed(String),
}

#[derive(Debug)]
pub struct Func {
    pub name: String,
    pub params: Vec<String>,
    pub body: Expr,
    /// Values visible where the function was defined (Mathcad/SMath semantics).
    pub env: Rc<Env>,
}

pub type Env = HashMap<String, Binding>;

/// Functions are keyed by name and arity, so `f(x)` and `f(x, y)` can coexist.
pub fn func_key(name: &str, arity: usize) -> String {
    format!("{name}#{arity}")
}

/// Lookup chain: local frames (innermost last), then a shared base environment.
pub struct Scope<'e> {
    base: &'e Env,
    frames: Vec<HashMap<String, Binding>>,
}

impl<'e> Scope<'e> {
    pub fn new(base: &'e Env) -> Self {
        Scope { base, frames: vec![HashMap::new()] }
    }

    pub fn get(&self, name: &str) -> Option<&Binding> {
        self.frames.iter().rev().find_map(|f| f.get(name)).or_else(|| self.base.get(name))
    }

    /// Bound in this evaluation (a function's parameter, a loop or plot variable) rather
    /// than defined in the document.
    fn is_local(&self, name: &str) -> bool {
        self.frames.iter().any(|f| f.contains_key(name))
    }

    fn set(&mut self, name: &str, b: Binding) {
        self.frames.last_mut().expect("scope has a frame").insert(name.to_string(), b);
    }

    /// Bind a loop/summation variable, returning what it shadowed in the frame.
    pub(crate) fn bind(&mut self, name: &str, v: Value) -> Option<Binding> {
        self.frames.last_mut().expect("scope has a frame").insert(name.to_string(), Binding::Val(v))
    }

    pub(crate) fn restore(&mut self, name: &str, prev: Option<Binding>) {
        let frame = self.frames.last_mut().expect("scope has a frame");
        match prev {
            Some(b) => frame.insert(name.to_string(), b),
            None => frame.remove(name),
        };
    }
}

const MAX_DEPTH: usize = 256;
const MAX_STEPS: u64 = 20_000_000;

/// `break` / `continue` met in a program (SMath's Programming palette): the enclosing
/// block stops, and the innermost loop ends or moves on to its next pass.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Flow {
    Break,
    Continue,
}

pub struct Interp<'u> {
    pub units: &'u UnitRegistry,
    depth: usize,
    steps: u64,
    flow: Option<Flow>,
    /// Plain names that resolved to units (`2 m`): the editor colours them as units.
    pub unit_idents: BTreeSet<String>,
    /// Plain names that resolved to built-in constants (`g`, `c`, `R`).
    pub constant_idents: BTreeSet<String>,
    /// Your variables whose names are also a built-in constant (they win, but it's worth saying).
    pub shadowing: BTreeSet<String>,
    /// Your variables read as a unit because they follow a number (`10 m` with `m := 25 kg`).
    pub units_over_variables: BTreeSet<String>,
}

/// `2 m`, `9.81 m/s`, `64 kgf*m`: an expression that reads as a number with units.
fn quantity_like(e: &Expr) -> bool {
    match e {
        Expr::Binary(BinaryOp::Juxt, ..) | Expr::Unit(_) => true,
        Expr::Binary(BinaryOp::Mul | BinaryOp::Div, l, _) => quantity_like(l),
        _ => false,
    }
}

fn parse_num(t: &str) -> Result<f64> {
    t.parse::<f64>().map_err(|_| EvalError::new(format!("'{t}' is not a valid number")))
}

/// A program statement rather than a value: a definition, a control construct, break/continue.
/// `line(…)` of statements is SMath's program block; `line(vx, vy)` is a line fit.
pub(crate) fn is_statement(e: &Expr) -> bool {
    match e {
        Expr::Define { .. } => true,
        Expr::Ident(n) => n == "break" || n == "continue",
        Expr::Call(n, _) => matches!(n.as_str(), "if" | "while" | "for" | "line" | "block"),
        _ => false,
    }
}

fn ident<'a>(e: &'a Expr, what: &str) -> Result<&'a str> {
    match e {
        Expr::Ident(n) => Ok(n),
        _ => bail!("{what} must be a variable name"),
    }
}

impl<'u> Interp<'u> {
    pub fn new(units: &'u UnitRegistry) -> Self {
        Interp {
            units,
            depth: 0,
            steps: 0,
            flow: None,
            unit_idents: BTreeSet::new(),
            constant_idents: BTreeSet::new(),
            shadowing: BTreeSet::new(),
            units_over_variables: BTreeSet::new(),
        }
    }

    pub(crate) fn tick(&mut self) -> Result<()> {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            bail!("evaluation stopped after {MAX_STEPS} steps (endless loop?)");
        }
        Ok(())
    }

    pub fn unit(&self, name: &str) -> Result<Unit> {
        self.units.lookup(name).ok_or_else(|| EvalError::new(format!("unknown unit '{name}")))
    }

    pub fn eval(&mut self, s: &mut Scope, e: &Expr) -> Result<Value> {
        match e {
            Expr::Num(t) => Ok(Value::num(parse_num(t)?)),
            Expr::Ident(name) if matches!(name.as_str(), "break" | "continue") && s.get(name).is_none() => {
                self.flow = Some(if name == "break" { Flow::Break } else { Flow::Continue });
                Ok(Value::num(0.0))
            }
            Expr::Ident(name) => self.lookup(s, name),
            Expr::Unit(name) => {
                let u = self.unit(name)?;
                Ok(Value::Num(Quantity::new(u.factor, u.dim)))
            }
            Expr::Str(t) => Ok(Value::Str(t.clone())),
            Expr::Placeholder => {
                bail!("the expression is incomplete: fill in the empty placeholder (?)")
            }
            Expr::Paren(x) => self.eval(s, x),
            Expr::Unary(op, x) => {
                let v = self.eval(s, x)?;
                match op {
                    UnaryOp::Neg => ops::negate(&v),
                    UnaryOp::Pos => Ok(v),
                    UnaryOp::Not => Ok(Value::bool(!v.truthy()?)),
                    UnaryOp::PlusMinus => bail!("± gives two results; this is not supported yet"),
                }
            }
            Expr::Factorial(x) => {
                let n = self.eval(s, x)?.as_int("the argument of !")?;
                if !(0..=170).contains(&n) {
                    bail!("{n}! is out of range");
                }
                Ok(Value::num((1..=n).map(|k| k as f64).product()))
            }
            Expr::Binary(op, a, b) => self.binary(s, *op, a, b),
            Expr::Compare(first, rest) => {
                let mut left = self.eval(s, first)?;
                let mut holds = true;
                for (op, x) in rest {
                    let right = self.eval(s, x)?;
                    holds &= compare(*op, &left, &right)?;
                    left = right;
                }
                Ok(Value::bool(holds))
            }
            Expr::Call(name, args) => self.call(s, name, args),
            Expr::Index(base, idx) => {
                let b = self.eval(s, base)?;
                let ix = idx.iter().map(|i| self.eval(s, i)).collect::<Result<Vec<_>>>()?;
                builtins::index(&b, &ix)
            }
            Expr::Matrix(rows) => {
                let cols = rows[0].len();
                let mut data = Vec::with_capacity(rows.len() * cols);
                for cell in rows.iter().flatten() {
                    data.push(self.eval(s, cell)?);
                }
                Ok(Value::Matrix(Matrix::new(rows.len(), cols, data)))
            }
            Expr::Range(a, b) => {
                let a = self.eval(s, a)?.as_num("the range start")?;
                let b = self.eval(s, b)?.as_num("the range end")?;
                builtins::range(a, b, None)
            }
            Expr::Define { lhs, rhs, .. } => {
                let v = self.eval(s, rhs)?;
                self.assign_local(s, lhs, v.clone())?;
                Ok(v)
            }
        }
    }

    /// Assignment inside an expression (program blocks, loops): writes the innermost frame.
    fn assign_local(&mut self, s: &mut Scope, lhs: &Expr, v: Value) -> Result<()> {
        match lhs {
            Expr::Ident(name) => s.set(name, Binding::Val(v)),
            Expr::Index(base, idx) => {
                let name = ident(base, "the indexed target")?;
                let ix =
                    idx.iter().map(|i| self.eval(s, i)?.as_int("an index")).collect::<Result<Vec<_>>>()?;
                let current = match s.get(name) {
                    Some(Binding::Val(v)) => Some(v.clone()),
                    _ => None,
                };
                s.set(name, Binding::Val(set_element(current, &ix, v)?));
            }
            _ => bail!("cannot assign to this expression"),
        }
        Ok(())
    }

    fn binary(&mut self, s: &mut Scope, op: BinaryOp, a: &Expr, b: &Expr) -> Result<Value> {
        match op {
            BinaryOp::And => {
                let left = self.eval(s, a)?.truthy()?;
                return Ok(Value::bool(left && self.eval(s, b)?.truthy()?));
            }
            BinaryOp::Or => {
                let left = self.eval(s, a)?.truthy()?;
                return Ok(Value::bool(left || self.eval(s, b)?.truthy()?));
            }
            _ => {}
        }
        // `20 '°C` / `20 degC` is an absolute temperature: apply the scale's offset.
        if let (BinaryOp::Juxt | BinaryOp::Mul, Expr::Num(t)) = (op, a) {
            let unit = match b {
                Expr::Unit(name) => Some(self.unit(name)?),
                Expr::Ident(name) if !s.is_local(name) && (op == BinaryOp::Juxt || s.get(name).is_none()) => {
                    self.units.lookup(name)
                }
                _ => None,
            };
            if let Some(u) = unit.filter(|u| u.offset != 0.0) {
                if let Expr::Ident(name) = b {
                    self.unit_idents.insert(name.clone());
                }
                return Ok(Value::Num(Quantity::new(parse_num(t)? * u.factor + u.offset, u.dim)));
            }
        }
        let x = self.eval(s, a)?;
        // right after a number or unit, a plain name is a unit: `2 g` grams, `100 km/h` hours,
        // and `10 m` metres even when you have a variable m (`10*m` multiplies by it)
        let y = if op == BinaryOp::Juxt || (op == BinaryOp::Div && quantity_like(a)) {
            self.eval_unit_position(s, b)?
        } else {
            self.eval(s, b)?
        };
        arith(op, &x, &y)
    }

    fn eval_unit_position(&mut self, s: &mut Scope, e: &Expr) -> Result<Value> {
        match e {
            // a function's own parameter stays itself: `v(t) := 9.81 t`
            Expr::Ident(name) if !s.is_local(name) => match self.units.lookup(name) {
                Some(u) => {
                    self.unit_idents.insert(name.clone());
                    if matches!(s.get(name), Some(Binding::Val(_))) {
                        self.units_over_variables.insert(name.clone());
                    }
                    Ok(Value::Num(Quantity::new(u.factor, u.dim)))
                }
                None => self.eval(s, e),
            },
            Expr::Binary(BinaryOp::Pow, base, exp) if matches!(**base, Expr::Ident(_)) => {
                let b = self.eval_unit_position(s, base)?;
                let x = self.eval(s, exp)?;
                arith(BinaryOp::Pow, &b, &x)
            }
            Expr::Paren(x) => self.eval_unit_position(s, x),
            _ => self.eval(s, e),
        }
    }

    fn call(&mut self, s: &mut Scope, name: &str, args: &[Expr]) -> Result<Value> {
        self.tick()?;
        match s.get(&func_key(name, args.len())) {
            Some(Binding::Func(f)) => {
                let f = Rc::clone(f);
                let vals = args.iter().map(|a| self.eval(s, a)).collect::<Result<Vec<_>>>()?;
                return self.apply(&f, vals);
            }
            Some(Binding::Failed(_)) => {
                bail!("{name}(…) has no value (its definition has an error)")
            }
            _ => {}
        }
        if let Some(r) = self.lazy(s, name, args) {
            return r;
        }
        let vals = args.iter().map(|a| self.eval(s, a)).collect::<Result<Vec<_>>>()?;
        match builtins::call(name, &vals) {
            Some(r) => r,
            None => bail!("{name} is not a known function"),
        }
    }

    pub(crate) fn apply(&mut self, f: &Rc<Func>, vals: Vec<Value>) -> Result<Value> {
        if self.depth >= MAX_DEPTH {
            bail!("{} calls itself too deeply", f.name);
        }
        let mut frame = HashMap::new();
        frame.insert(func_key(&f.name, f.params.len()), Binding::Func(Rc::clone(f)));
        for (p, v) in f.params.iter().zip(vals) {
            frame.insert(p.clone(), Binding::Val(v));
        }
        let mut scope = Scope { base: &f.env, frames: vec![frame] };
        self.depth += 1;
        let r = self.eval(&mut scope, &f.body);
        self.depth -= 1;
        // a `break` outside any loop ends the function's program, not its caller's loop
        self.flow = None;
        r
    }

    /// Constructs that control evaluation of their own arguments. `None` = not lazy.
    fn lazy(&mut self, s: &mut Scope, name: &str, args: &[Expr]) -> Option<Result<Value>> {
        Some(match (name, args.len()) {
            ("if", 2 | 3) => self.if_(s, args),
            // two plain expressions: Mathcad's straight-line fit line(vx, vy) (stats.rs)
            ("line", 2) if !args.iter().any(is_statement) => return None,
            ("block" | "line", _) => self.block(s, args),
            ("for", 3) => self.for_in(s, args),
            ("for", 4) => self.for_c(s, args),
            ("while", 2) => self.while_(s, args),
            ("sum", 4) => self.fold(s, args, BinaryOp::Add),
            ("prod" | "product", 4) => self.fold(s, args, BinaryOp::Mul),
            ("int", 4) => self.integrate(s, args),
            ("int", 2) => {
                Err(EvalError::new("an indefinite integral is symbolic: end the line with → instead of ="))
            }
            ("diff", 2 | 3) => self.differentiate(s, args),
            ("root" | "solve", 4) => self.solve_in(s, args),
            ("solve", 2 | 3) if Self::is_system(s, args) => self.solve_system(s, args),
            ("solve", 2 | 3) => self.solve_from(s, args),
            ("rkfixed", 5) => self.rkfixed(s, args),
            ("Rkadapt", 5) => self.rkadapt(s, args),
            ("linfit", 3) => self.linfit(s, args),
            ("rkfixed" | "Rkadapt", _) => {
                Err(EvalError::new(format!("{name} takes 5 arguments: {name}(y0, t0, t1, n, D)")))
            }
            ("linfit", _) => Err(EvalError::new("linfit takes 3 arguments: linfit(vx, vy, F)")),
            ("roots", 2 | 3) => self.roots(s, args),
            ("polyroots", 1) => self.polyroots(s, args),
            ("IsDefined", 1) => self.is_defined(s, args),
            ("lim", _) => Err(EvalError::new("a limit is symbolic: end the line with → instead of =")),
            _ => return None,
        })
    }

    /// `if(c, a, b)`; in a program `if(c, a)` without else, as in SMath (0 when c fails).
    fn if_(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let c = self.eval(s, &args[0])?.truthy()?;
        match args.get(if c { 1 } else { 2 }) {
            Some(branch) => self.eval(s, branch),
            None => Ok(Value::num(0.0)),
        }
    }

    fn block(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let mut last = Value::num(0.0);
        for a in args {
            let v = self.eval(s, a)?;
            if self.flow.is_some() {
                break;
            }
            last = v;
        }
        Ok(last)
    }

    /// After a loop's body: whether to leave the loop (`break`); `continue` just goes on.
    fn leave_loop(&mut self) -> bool {
        self.flow.take() == Some(Flow::Break)
    }

    fn for_in(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let var = ident(&args[0], "the loop variable")?;
        let items = match self.eval(s, &args[1])? {
            Value::Matrix(m) => m.data,
            v => vec![v],
        };
        let mut last = Value::num(0.0);
        for item in items {
            self.tick()?;
            s.set(var, Binding::Val(item));
            last = self.eval(s, &args[2])?;
            if self.leave_loop() {
                break;
            }
        }
        Ok(last)
    }

    fn for_c(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        self.eval(s, &args[0])?;
        let mut last = Value::num(0.0);
        while self.eval(s, &args[1])?.truthy()? {
            self.tick()?;
            last = self.eval(s, &args[3])?;
            if self.leave_loop() {
                break;
            }
            self.eval(s, &args[2])?;
        }
        Ok(last)
    }

    fn while_(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let mut last = Value::num(0.0);
        while self.eval(s, &args[0])?.truthy()? {
            self.tick()?;
            last = self.eval(s, &args[1])?;
            if self.leave_loop() {
                break;
            }
        }
        Ok(last)
    }

    /// `sum(expr, i, a, b)` / `prod(expr, i, a, b)` over whole numbers a..b.
    fn fold(&mut self, s: &mut Scope, args: &[Expr], op: BinaryOp) -> Result<Value> {
        let var = ident(&args[1], "the summation variable")?;
        let a = self.eval(s, &args[2])?.as_int("the lower limit")?;
        let b = self.eval(s, &args[3])?.as_int("the upper limit")?;
        let mut acc: Option<Value> = None;
        let prev = s.get(var).cloned();
        let mut result = Ok(());
        for k in a..=b {
            if let Err(e) = self.tick() {
                result = Err(e);
                break;
            }
            s.bind(var, Value::num(k as f64));
            match self.eval(s, &args[0]).and_then(|v| match &acc {
                None => Ok(v),
                Some(x) => arith(op, x, &v),
            }) {
                Ok(v) => acc = Some(v),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        s.restore(var, prev);
        result?;
        Ok(acc.unwrap_or_else(|| Value::num(if op == BinaryOp::Mul { 1.0 } else { 0.0 })))
    }

    fn sample(
        &mut self,
        s: &mut Scope,
        f: &Expr,
        var: &str,
        x: Quantity,
        fdim: &mut Option<Dim>,
    ) -> Result<f64> {
        s.bind(var, Value::Num(x));
        let y = self.eval(s, f)?.as_num("the integrand")?;
        match fdim {
            None => *fdim = Some(y.dim),
            Some(d) => same_dim(*d, y.dim, "integrate a function that mixes")?,
        }
        Ok(y.v)
    }

    /// Adaptive Simpson quadrature of `int(f, x, a, b)`.
    fn integrate(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let var = ident(&args[1], "the integration variable")?;
        let mut a = self.eval(s, &args[2])?.as_num("the lower limit")?;
        let mut b = self.eval(s, &args[3])?.as_num("the upper limit")?;
        // a plain 0 limit takes the other limit's units: `int(q(x), x, 0, L)`
        if a.v == 0.0 {
            a.dim = b.dim;
        } else if b.v == 0.0 {
            b.dim = a.dim;
        }
        same_dim(a.dim, b.dim, "integrate between")?;
        if !a.v.is_finite() || !b.v.is_finite() {
            bail!("integrals with infinite limits are not supported yet");
        }
        let prev = s.get(var).cloned();
        let mut fdim = None;
        let r: Result<f64> = (|| {
            let at = |t: f64| Quantity::new(t, a.dim);
            let m = 0.5 * (a.v + b.v);
            let fa = self.sample(s, &args[0], var, at(a.v), &mut fdim)?;
            let fm = self.sample(s, &args[0], var, at(m), &mut fdim)?;
            let fb = self.sample(s, &args[0], var, at(b.v), &mut fdim)?;
            let whole = (b.v - a.v) / 6.0 * (fa + 4.0 * fm + fb);
            let eps = 1e-10 * whole.abs().max(1e-300);
            self.simpson(s, &args[0], var, a.dim, (a.v, b.v), (fa, fm, fb), whole, eps, 48, &mut fdim)
        })();
        s.restore(var, prev);
        let v = r?;
        Ok(Value::Num(Quantity::new(v, fdim.unwrap_or(Dim::NONE) * a.dim)))
    }

    #[allow(clippy::too_many_arguments)]
    fn simpson(
        &mut self,
        s: &mut Scope,
        f: &Expr,
        var: &str,
        xdim: Dim,
        (a, b): (f64, f64),
        (fa, fm, fb): (f64, f64, f64),
        whole: f64,
        eps: f64,
        depth: u32,
        fdim: &mut Option<Dim>,
    ) -> Result<f64> {
        self.tick()?;
        let m = 0.5 * (a + b);
        let (lm, rm) = (0.5 * (a + m), 0.5 * (m + b));
        let flm = self.sample(s, f, var, Quantity::new(lm, xdim), fdim)?;
        let frm = self.sample(s, f, var, Quantity::new(rm, xdim), fdim)?;
        let left = (m - a) / 6.0 * (fa + 4.0 * flm + fm);
        let right = (b - m) / 6.0 * (fm + 4.0 * frm + fb);
        let delta = left + right - whole;
        if depth == 0 || delta.abs() <= 15.0 * eps {
            return Ok(left + right + delta / 15.0);
        }
        Ok(self.simpson(s, f, var, xdim, (a, m), (fa, flm, fm), left, eps / 2.0, depth - 1, fdim)?
            + self.simpson(s, f, var, xdim, (m, b), (fm, frm, fb), right, eps / 2.0, depth - 1, fdim)?)
    }

    /// `f(x)` as written, or `lhs - rhs` for an equation `lhs == rhs`.
    pub(crate) fn residual(e: &Expr) -> Expr {
        match e {
            Expr::Compare(l, rest) if rest.len() == 1 && rest[0].0 == quire_ast::CmpOp::Eq => {
                Expr::Binary(BinaryOp::Sub, l.clone(), Box::new(rest[0].1.clone()))
            }
            other => other.clone(),
        }
    }

    /// The equations of a system: a vector `[f1; f2]` or SMath's `sys(f1, f2, …, n, 1)`.
    fn system(e: &Expr) -> Option<Vec<Expr>> {
        match e {
            Expr::Matrix(rows) if rows.iter().map(Vec::len).sum::<usize>() > 1 => {
                Some(rows.iter().flatten().cloned().collect())
            }
            Expr::Call(name, items) if name == "sys" && items.len() >= 3 => {
                Some(items[..items.len() - 2].to_vec())
            }
            _ => None,
        }
    }

    /// `roots(f(x), x)` / `roots(f(x), x, guess)` (SMath): a root near the guess, or near
    /// the current value of x (0 when x has none); `roots([f1; f2], [x; y], [x0; y0])`
    /// and `roots(sys(…), …)` solve a system.
    fn roots(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        if let Some(eqs) = Self::system(&args[0]) {
            return self.roots_system(s, &eqs, args);
        }
        let var = ident(&args[1], "the unknown")?;
        let x0 = match args.get(2) {
            Some(g) => self.eval(s, g)?.as_num("the guess")?,
            None => match s.get(var) {
                Some(Binding::Val(Value::Num(q))) => *q,
                _ => Quantity::scalar(0.0),
            },
        };
        let f = Self::residual(&args[0]);
        let prev = s.get(var).cloned();
        let mut fdim = None;
        let r = fn_solve::root_near(
            &mut |t| {
                self.tick()?;
                self.sample(s, &f, var, Quantity::new(t, x0.dim), &mut fdim)
            },
            x0.v,
        );
        s.restore(var, prev);
        match r? {
            Ok(x) => Ok(Value::Num(Quantity::new(x, x0.dim))),
            Err(_) => bail!("roots found no root near the guess for {var}; try another guess"),
        }
    }

    fn roots_system(&mut self, s: &mut Scope, eqs: &[Expr], args: &[Expr]) -> Result<Value> {
        let vars: Vec<&str> = match &args[1] {
            Expr::Matrix(rows) => {
                rows.iter().flatten().map(|e| ident(e, "an unknown")).collect::<Result<_>>()?
            }
            e => vec![ident(e, "the unknown")?],
        };
        if vars.len() != eqs.len() {
            bail!("roots: {} equations but {} unknowns", eqs.len(), vars.len());
        }
        let x0: Vec<Quantity> = match args.get(2) {
            Some(g) => match self.eval(s, g)? {
                Value::Matrix(m) => m.data.iter().map(|v| v.as_num("a guess")).collect::<Result<_>>()?,
                v => vec![v.as_num("the guess")?],
            },
            None => vars
                .iter()
                .map(|v| match s.get(v) {
                    Some(Binding::Val(Value::Num(q))) => *q,
                    _ => Quantity::scalar(0.0),
                })
                .collect(),
        };
        if x0.len() != vars.len() {
            bail!("roots: {} unknowns but {} guesses", vars.len(), x0.len());
        }
        let fs: Vec<Expr> = eqs.iter().map(Self::residual).collect();
        let prevs: Vec<Option<Binding>> = vars.iter().map(|v| s.get(v).cloned()).collect();
        let start: Vec<f64> = x0.iter().map(|q| q.v).collect();
        let r = fn_solve::newton_system(
            &mut |x: &[f64]| {
                self.tick()?;
                for (k, v) in vars.iter().enumerate() {
                    s.bind(v, Value::Num(Quantity::new(x[k], x0[k].dim)));
                }
                fs.iter().map(|f| Ok(self.eval(s, f)?.as_num("an equation")?.v)).collect()
            },
            &start,
        );
        for (v, p) in vars.iter().zip(prevs).rev() {
            s.restore(v, p);
        }
        match r? {
            Ok(x) => Ok(Value::Matrix(Matrix::column(
                x.iter().zip(&x0).map(|(v, q)| Value::Num(Quantity::new(*v, q.dim))).collect(),
            ))),
            Err(fn_solve::Fail::Singular) => {
                bail!("roots: the system is singular near the guess; try another guess")
            }
            Err(fn_solve::Fail::NoConvergence) => {
                bail!("roots found no solution near the guess; try another guess")
            }
        }
    }

    /// `polyroots(v)` (SMath): the real roots of v[1] + v[2]·x + v[3]·x² + …, ascending.
    fn polyroots(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let c: Vec<f64> = match self.eval(s, &args[0])? {
            Value::Matrix(m) => m.data.iter().map(|v| v.as_scalar("a coefficient")).collect::<Result<_>>()?,
            _ => bail!("polyroots needs a vector of coefficients, constant term first"),
        };
        match fn_solve::poly_roots(&c) {
            Ok(r) => Ok(Value::Matrix(Matrix::column(r.into_iter().map(Value::num).collect()))),
            Err((real, complex)) => {
                let real: Vec<String> = real.iter().map(|x| format!("{x}")).collect();
                bail!(
                    "polyroots: {} roots are complex, which is not supported yet (real roots: {})",
                    complex.len(),
                    if real.is_empty() { "none".to_string() } else { real.join(", ") }
                )
            }
        }
    }

    /// `IsDefined(x)` (SMath): 1 when x is a variable or function defined here, else 0.
    fn is_defined(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let name = ident(&args[0], "the argument of IsDefined")?;
        let defined = |b: Option<&Binding>| matches!(b, Some(Binding::Val(_) | Binding::Func(_)));
        Ok(Value::bool(defined(s.get(name)) || (0..=16).any(|n| defined(s.get(&func_key(name, n))))))
    }

    /// `root(f(x), x, a, b)` / `solve(x^2 == 2, x, a, b)`: a root between a and b.
    /// Without a sign change at the ends, the range is scanned for one.
    fn solve_in(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let var = ident(&args[1], "the unknown")?;
        let a = self.eval(s, &args[2])?.as_num("the lower limit")?;
        let b = self.eval(s, &args[3])?.as_num("the upper limit")?;
        let dim = if a.v == 0.0 { b.dim } else { a.dim };
        same_dim(dim, if b.v == 0.0 { dim } else { b.dim }, "search between")?;
        let f = Self::residual(&args[0]);
        let prev = s.get(var).cloned();
        let mut fdim = None;
        let r: Result<f64> = (|| {
            let at = |t: f64| Quantity::new(t, dim);
            let (mut lo, mut hi) = (a.v.min(b.v), a.v.max(b.v));
            let mut flo = self.sample(s, &f, var, at(lo), &mut fdim)?;
            let fhi = self.sample(s, &f, var, at(hi), &mut fdim)?;
            if flo == 0.0 {
                return Ok(lo);
            }
            if fhi == 0.0 {
                return Ok(hi);
            }
            if flo.signum() == fhi.signum() {
                // look for the first sign change from the lower end
                const STEPS: usize = 200;
                let step = (hi - lo) / STEPS as f64;
                let mut found = None;
                let mut x0 = lo;
                for k in 1..=STEPS {
                    let x1 = lo + step * k as f64;
                    let f1 = self.sample(s, &f, var, at(x1), &mut fdim)?;
                    if f1 == 0.0 {
                        return Ok(x1);
                    }
                    if f1.signum() != flo.signum() {
                        found = Some((x0, x1));
                        break;
                    }
                    (x0, flo) = (x1, f1);
                }
                let Some((x0, x1)) = found else {
                    bail!("no root between the limits: the expression doesn't change sign there")
                };
                (lo, hi) = (x0, x1);
            }
            for _ in 0..200 {
                self.tick()?;
                let mid = 0.5 * (lo + hi);
                if mid == lo || mid == hi {
                    break;
                }
                let fm = self.sample(s, &f, var, at(mid), &mut fdim)?;
                if fm == 0.0 {
                    return Ok(mid);
                }
                if fm.signum() == flo.signum() {
                    (lo, flo) = (mid, fm);
                } else {
                    hi = mid;
                }
            }
            Ok(0.5 * (lo + hi))
        })();
        s.restore(var, prev);
        Ok(Value::Num(Quantity::new(r?, dim)))
    }

    /// `solve(f(x), x)`: a root near the current value of x (secant steps), or near a
    /// starting value given as `solve(f(x), x, x0)`.
    fn solve_from(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let var = ident(&args[1], "the unknown")?;
        let x0 = match (args.get(2), s.get(var)) {
            (Some(g), _) => self.eval(s, g)?.as_num("the starting value")?,
            (None, Some(Binding::Val(Value::Num(q)))) => *q,
            _ => bail!("give {var} a starting value first (or search a range: solve(…, {var}, a, b))"),
        };
        let f = Self::residual(&args[0]);
        let prev = s.get(var).cloned();
        let mut fdim = None;
        let r: Result<f64> = (|| {
            let at = |t: f64| Quantity::new(t, x0.dim);
            let mut a = x0.v;
            let mut b = if a == 0.0 { 1e-4 } else { a * (1.0 + 1e-4) };
            let mut fa = self.sample(s, &f, var, at(a), &mut fdim)?;
            let mut fb = self.sample(s, &f, var, at(b), &mut fdim)?;
            for _ in 0..100 {
                self.tick()?;
                if fb == 0.0 || (b - a).abs() <= 1e-14 * b.abs().max(1e-300) {
                    return Ok(b);
                }
                if fb == fa {
                    break;
                }
                let c = b - fb * (b - a) / (fb - fa);
                if !c.is_finite() {
                    break;
                }
                (a, fa) = (b, fb);
                b = c;
                fb = self.sample(s, &f, var, at(b), &mut fdim)?;
            }
            bail!("no root found near {var} = {}; try a range: solve(…, {var}, a, b)", x0.v)
        })();
        s.restore(var, prev);
        Ok(Value::Num(Quantity::new(r?, x0.dim)))
    }

    /// Numeric derivative `diff(f, x[, n])` at the current value of x.
    fn differentiate(&mut self, s: &mut Scope, args: &[Expr]) -> Result<Value> {
        let var = ident(&args[1], "the differentiation variable")?;
        let order = match args.get(2) {
            Some(n) => self.eval(s, n)?.as_int("the derivative order")?,
            None => 1,
        };
        let x0 = match s.get(var) {
            Some(Binding::Val(Value::Num(q))) => *q,
            _ => bail!(
                "{var} has no value here; give it one for a numeric derivative, or end the line with → for the derivative as a formula"
            ),
        };
        if !(1..=2).contains(&order) {
            bail!("only first and second numeric derivatives are supported");
        }
        let prev = s.get(var).cloned();
        let mut fdim = None;
        let scale = x0.v.abs().max(1.0);
        let r: Result<f64> = (|| {
            let at = |t: f64| Quantity::new(t, x0.dim);
            if order == 1 {
                let h = 6e-6 * scale;
                let fp = self.sample(s, &args[0], var, at(x0.v + h), &mut fdim)?;
                let fm = self.sample(s, &args[0], var, at(x0.v - h), &mut fdim)?;
                Ok((fp - fm) / (2.0 * h))
            } else {
                let h = 1e-4 * scale;
                let fp = self.sample(s, &args[0], var, at(x0.v + h), &mut fdim)?;
                let f0 = self.sample(s, &args[0], var, at(x0.v), &mut fdim)?;
                let fm = self.sample(s, &args[0], var, at(x0.v - h), &mut fdim)?;
                Ok((fp - 2.0 * f0 + fm) / (h * h))
            }
        })();
        s.restore(var, prev);
        let v = r?;
        Ok(Value::Num(Quantity::new(v, fdim.unwrap_or(Dim::NONE) / dim_pow(x0.dim, order as i32))))
    }
}

impl Interp<'_> {
    /// Variables first, then constants, then units: a plain `m` means metres unless
    /// a variable `m` is defined at this point (Mathcad's rule).
    fn lookup(&mut self, s: &Scope, name: &str) -> Result<Value> {
        match s.get(name) {
            Some(Binding::Val(v)) => {
                // naming a variable like a unit (m, s) is normal; hiding a constant is worth a note
                if constant(name).is_some() && !matches!(name, "π" | "pi" | "e" | "∞") {
                    self.shadowing.insert(name.to_string());
                }
                Ok(v.clone())
            }
            Some(Binding::Failed(_)) => bail!("{name} has no value (its definition has an error)"),
            Some(Binding::Func(_)) => unreachable!("functions are stored under name#arity"),
            None => {
                if let Some(c) = constant(name) {
                    if !matches!(name, "π" | "pi" | "e" | "∞") {
                        self.constant_idents.insert(name.to_string());
                    }
                    return Ok(Value::Num(Quantity::new(c.value, c.dim())));
                }
                match self.units.lookup(name) {
                    Some(u) => {
                        self.unit_idents.insert(name.to_string());
                        Ok(Value::Num(Quantity::new(u.factor, u.dim)))
                    }
                    None => bail!("{name} is not defined"),
                }
            }
        }
    }
}

/// `v[i] := x` / `M[i, j] := x`, growing the matrix (filled with 0) as needed.
pub fn set_element(current: Option<Value>, idx: &[i64], v: Value) -> Result<Value> {
    let (r, c) = match *idx {
        [i] => (i, 1),
        [i, j] => (i, j),
        _ => bail!("assignment needs one or two indices"),
    };
    if r < 1 || c < 1 || r > 100_000 || c > 100_000 {
        bail!("index ({r}, {c}) is out of range (indices start at 1)");
    }
    let (r, c) = (r as usize, c as usize);
    let mut m = match current {
        Some(Value::Matrix(m)) => m,
        Some(other) => Matrix::new(1, 1, vec![other]),
        None => Matrix::new(0, 0, vec![]),
    };
    if r > m.rows || c > m.cols {
        let (rows, cols) = (r.max(m.rows), c.max(m.cols));
        let mut data = vec![Value::num(0.0); rows * cols];
        for i in 0..m.rows {
            for j in 0..m.cols {
                data[i * cols + j] = m.get(i, j).clone();
            }
        }
        m = Matrix::new(rows, cols, data);
    }
    let cols = m.cols;
    m.data[(r - 1) * cols + (c - 1)] = v;
    Ok(Value::Matrix(m))
}
