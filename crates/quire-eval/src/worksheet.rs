use std::rc::Rc;

use quire_ast::{Expr, parse, print};
use quire_units::{Unit, UnitRegistry};

use crate::error::{EvalError, Result, bail};
use crate::format::{DisplaySettings, DisplaySpec, format_value};
use crate::interp::{Binding, Env, Func, Interp, Scope, func_key, set_element};
use crate::value::Value;

/// One math region, already in document (reading) order.
#[derive(Debug, Clone)]
pub struct MathInput {
    pub id: String,
    pub expr: String,
    /// Render `= result` (`"show": "value"`).
    pub show: bool,
    pub display: DisplaySpec,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub id: String,
    /// Name defined by this region, if it is a definition.
    pub defines: Option<String>,
    pub value: Option<Value>,
    /// The displayed result, when the region shows one.
    pub shown: Option<String>,
    pub error: Option<String>,
    /// Plain names in this region that mean units (`2 m`), for display.
    pub units: Vec<String>,
    /// Plain names that mean built-in constants (`g`, `c`).
    pub constants: Vec<String>,
    /// Your variables here whose names are also a built-in constant.
    pub shadowing: Vec<String>,
}

impl Outcome {
    fn new(id: &str) -> Self {
        Outcome {
            id: id.to_string(),
            defines: None,
            value: None,
            shown: None,
            error: None,
            units: Vec::new(),
            constants: Vec::new(),
            shadowing: Vec::new(),
        }
    }
}

/// Every plain name in an expression (for function bodies, which run later).
fn names(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Ident(n) => out.push(n.clone()),
        Expr::Paren(x) | Expr::Unary(_, x) | Expr::Factorial(x) => names(x, out),
        Expr::Binary(_, a, b) | Expr::Range(a, b) => {
            names(a, out);
            names(b, out);
        }
        Expr::Compare(a, rest) => {
            names(a, out);
            rest.iter().for_each(|(_, x)| names(x, out));
        }
        Expr::Call(_, args) => args.iter().for_each(|x| names(x, out)),
        Expr::Index(b, args) => {
            names(b, out);
            args.iter().for_each(|x| names(x, out));
        }
        Expr::Matrix(rows) => rows.iter().flatten().for_each(|x| names(x, out)),
        Expr::Define { lhs, rhs, .. } => {
            names(lhs, out);
            names(rhs, out);
        }
        Expr::Num(_) | Expr::Unit(_) | Expr::Str(_) | Expr::Placeholder => {}
    }
}

/// `e` with each parameter name replaced by its argument (parenthesized unless atomic).
fn substitute(e: &Expr, params: &[String], args: &[Expr]) -> Expr {
    let sub = |x: &Expr| substitute(x, params, args);
    let boxed = |x: &Expr| Box::new(sub(x));
    match e {
        Expr::Ident(n) => match params.iter().position(|p| p == n) {
            Some(i) => match &args[i] {
                a @ (Expr::Ident(_) | Expr::Num(_) | Expr::Paren(_) | Expr::Call(..)) => a.clone(),
                a => Expr::Paren(Box::new(a.clone())),
            },
            None => e.clone(),
        },
        Expr::Paren(x) => Expr::Paren(boxed(x)),
        Expr::Unary(op, x) => Expr::Unary(*op, boxed(x)),
        Expr::Factorial(x) => Expr::Factorial(boxed(x)),
        Expr::Binary(op, a, b) => Expr::Binary(*op, boxed(a), boxed(b)),
        Expr::Range(a, b) => Expr::Range(boxed(a), boxed(b)),
        Expr::Compare(a, rest) => Expr::Compare(boxed(a), rest.iter().map(|(op, x)| (*op, sub(x))).collect()),
        Expr::Call(n, xs) => Expr::Call(n.clone(), xs.iter().map(sub).collect()),
        Expr::Index(b, xs) => Expr::Index(boxed(b), xs.iter().map(sub).collect()),
        Expr::Matrix(rows) => Expr::Matrix(rows.iter().map(|r| r.iter().map(sub).collect()).collect()),
        Expr::Define { lhs, rhs, global } => {
            Expr::Define { lhs: boxed(lhs), rhs: boxed(rhs), global: *global }
        }
        Expr::Num(_) | Expr::Unit(_) | Expr::Str(_) | Expr::Placeholder => e.clone(),
    }
}

pub struct Worksheet {
    used_units: std::collections::BTreeSet<String>,
    used_constants: std::collections::BTreeSet<String>,
    used_shadowing: std::collections::BTreeSet<String>,
    units: UnitRegistry,
    settings: DisplaySettings,
    globals: Rc<Env>,
}

impl Worksheet {
    pub fn new(settings: DisplaySettings) -> Self {
        Worksheet {
            used_units: Default::default(),
            used_constants: Default::default(),
            used_shadowing: Default::default(),
            units: UnitRegistry::new(),
            settings,
            globals: Rc::new(Env::new()),
        }
    }

    pub fn units(&self) -> &UnitRegistry {
        &self.units
    }

    pub fn settings(&self) -> &DisplaySettings {
        &self.settings
    }

    /// Document-level custom unit, e.g. `define_unit("tf", "1000 'kgf")`.
    pub fn define_unit(&mut self, name: &str, definition: &str) -> Result<()> {
        let expr = parse(definition)?;
        let env = Env::new();
        let q = Interp::new(&self.units).eval(&mut Scope::new(&env), &expr)?.as_num("a unit definition")?;
        self.units.define(name, Unit { factor: q.v, dim: q.dim, offset: 0.0 });
        Ok(())
    }

    /// Evaluate regions in order: `≡` definitions first, then everything top to bottom.
    pub fn run(&mut self, regions: &[MathInput]) -> Vec<Outcome> {
        let parsed: Vec<_> = regions.iter().map(|r| parse(&r.expr)).collect();
        let mut out: Vec<Option<Outcome>> = vec![None; regions.len()];
        for (i, r) in regions.iter().enumerate() {
            if let Ok(e @ Expr::Define { global: true, .. }) = &parsed[i] {
                out[i] = Some(self.step(r, e));
            }
        }
        for (i, r) in regions.iter().enumerate() {
            if out[i].is_none() {
                out[i] = Some(match &parsed[i] {
                    Ok(e) => self.step(r, e),
                    Err(err) => {
                        Outcome { error: Some(EvalError::from(err.clone()).message), ..Outcome::new(&r.id) }
                    }
                });
            }
        }
        out.into_iter().map(|o| o.expect("every region evaluated")).collect()
    }

    fn eval(&mut self, e: &Expr) -> Result<Value> {
        let mut interp = Interp::new(&self.units);
        let r = interp.eval(&mut Scope::new(&self.globals), e);
        let units = std::mem::take(&mut interp.unit_idents);
        let constants = std::mem::take(&mut interp.constant_idents);
        let shadowing = std::mem::take(&mut interp.shadowing);
        self.used_units.extend(units);
        self.used_constants.extend(constants);
        self.used_shadowing.extend(shadowing);
        r
    }

    fn bind(&mut self, key: String, b: Binding) {
        Rc::make_mut(&mut self.globals).insert(key, b);
    }

    fn step(&mut self, r: &MathInput, e: &Expr) -> Outcome {
        let mut out = Outcome::new(&r.id);
        self.used_units.clear();
        self.used_constants.clear();
        self.used_shadowing.clear();
        let result = match e {
            Expr::Define { lhs, rhs, .. } => self.define(&mut out, lhs, rhs),
            _ => self.eval(e).map(Some),
        };
        match result {
            Ok(None) => {} // function definition: nothing to display
            Ok(Some(v)) => {
                if r.show {
                    match format_value(&v, &r.display, &self.settings, &self.units) {
                        Ok(s) => out.shown = Some(s),
                        Err(err) => out.error = Some(err.message),
                    }
                }
                out.value = Some(v);
            }
            Err(err) if r.show && self.symbolic_call(&mut out, e, &err) => {}
            Err(err) => {
                if let Some(name) = &out.defines
                    && !name.contains('(')
                {
                    self.bind(name.clone(), Binding::Failed(err.message.clone()));
                }
                out.error = Some(err.message);
            }
        }
        out.units = std::mem::take(&mut self.used_units).into_iter().collect();
        out.constants = std::mem::take(&mut self.used_constants).into_iter().collect();
        out.shadowing = std::mem::take(&mut self.used_shadowing).into_iter().collect();
        out
    }

    /// `f(x) =` with no value for x shows the body in terms of x, as SMath does.
    fn symbolic_call(&self, out: &mut Outcome, e: &Expr, err: &EvalError) -> bool {
        let Expr::Call(name, args) = e else { return false };
        let Some(Binding::Func(f)) = self.globals.get(&func_key(name, args.len())) else { return false };
        let Some(missing) = err.message.strip_suffix(" is not defined") else { return false };
        let mut arg_names = Vec::new();
        args.iter().for_each(|a| names(a, &mut arg_names));
        if !arg_names.iter().any(|n| n == missing) {
            return false;
        }
        out.shown = Some(print(&substitute(&f.body, &f.params, args)));
        true
    }

    /// `Ok(None)` for function definitions, which have no value of their own.
    fn define(&mut self, out: &mut Outcome, lhs: &Expr, rhs: &Expr) -> Result<Option<Value>> {
        match lhs {
            Expr::Ident(name) => {
                out.defines = Some(name.clone());
                let v = self.eval(rhs)?;
                self.bind(name.clone(), Binding::Val(v.clone()));
                Ok(Some(v))
            }
            Expr::Call(name, params) => {
                let params = params
                    .iter()
                    .map(|p| match p {
                        Expr::Ident(n) => Ok(n.clone()),
                        _ => bail!("function parameters must be names"),
                    })
                    .collect::<Result<Vec<_>>>()?;
                out.defines = Some(format!("{name}({})", params.join(", ")));
                let key = func_key(name, params.len());
                // the body runs later; mark names that would resolve to constants or units now
                let mut body_names = Vec::new();
                names(rhs, &mut body_names);
                for n in body_names {
                    if params.contains(&n) || self.globals.contains_key(&n) {
                        continue;
                    }
                    if crate::constants::constant(&n).is_some() {
                        if !matches!(n.as_str(), "π" | "pi" | "e" | "∞") {
                            self.used_constants.insert(n);
                        }
                    } else if self.units.lookup(&n).is_some() {
                        self.used_units.insert(n);
                    }
                }
                let f = Func { name: name.clone(), params, body: rhs.clone(), env: Rc::clone(&self.globals) };
                self.bind(key, Binding::Func(Rc::new(f)));
                Ok(None)
            }
            Expr::Index(base, idx) => {
                let Expr::Ident(name) = &**base else {
                    bail!("only a named matrix can be assigned by index")
                };
                out.defines = Some(name.clone());
                let ix = idx.iter().map(|i| self.eval(i)?.as_int("an index")).collect::<Result<Vec<_>>>()?;
                let v = self.eval(rhs)?;
                let current = match self.globals.get(name) {
                    Some(Binding::Val(m)) => Some(m.clone()),
                    _ => None,
                };
                let updated = set_element(current, &ix, v.clone())?;
                self.bind(name.clone(), Binding::Val(updated));
                Ok(Some(v))
            }
            _ => bail!("the left side of := must be a name, a function f(x) or an element v[i]"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[&str]) -> Vec<Outcome> {
        let regions: Vec<MathInput> = lines
            .iter()
            .enumerate()
            .map(|(i, l)| MathInput {
                id: i.to_string(),
                expr: l.to_string(),
                show: true,
                display: DisplaySpec::default(),
            })
            .collect();
        Worksheet::new(DisplaySettings::default()).run(&regions)
    }

    fn shown(lines: &[&str]) -> Vec<String> {
        run(lines).into_iter().map(|o| o.shown.or(o.error).unwrap_or_default()).collect()
    }

    #[test]
    fn units_and_definitions() {
        assert_eq!(
            shown(&["L := 2 'm", "W := 30 'cm", "A := L*W", "A + 1"]),
            ["2 'm", "0.3 'm", "0.6 'm^2", "cannot add [m^2] and a plain number: units don't match"]
        );
    }

    #[test]
    fn plain_names_are_units_unless_defined() {
        let out =
            run(&["L := 2 m", "g := 9.81 m/s^2", "W := 30 cm", "A := L*W", "m := 3 kg", "F := m*g", "2 m"]);
        let shown: Vec<_> =
            out.iter().map(|o| o.shown.clone().or(o.error.clone()).unwrap_or_default()).collect();
        assert_eq!(shown[0], "2 'm");
        assert_eq!(shown[3], "0.6 'm^2");
        assert_eq!(shown[5], "29.43 'N");
        assert_eq!(shown[6], "6 'kg", "a defined variable shadows the unit");
        assert_eq!(out[1].units, ["m", "s"]);
        assert!(out[5].units.is_empty());
        assert_eq!(run(&["T := 20 degC"])[0].shown.as_deref(), Some("293.15 'K"));
        assert!(run(&["x + 1"])[0].error.as_deref().unwrap().contains("x is not defined"));
    }

    #[test]
    fn constants_units_and_variables_resolve_by_position() {
        let out = run(&[
            "W := 2 kg*g",
            "m := 500 g",
            "v := 100 km/h",
            "E := 3 h",
            "F := m*g",
            "g := 10",
            "F2 := m*g",
        ]);
        let shown: Vec<_> =
            out.iter().map(|o| o.shown.clone().or(o.error.clone()).unwrap_or_default()).collect();
        assert_eq!(shown[0], "19.6133 'N", "kg*g: g is gravity");
        assert_eq!(shown[1], "0.5 'kg", "500 g: grams");
        assert_eq!(shown[2], "27.7778 'm/'s", "km/h: hours, not Planck");
        assert_eq!(shown[3], "10800 's", "3 h: hours");
        assert_eq!(shown[4], "4.9033 'N");
        assert_eq!(shown[6], "5 'kg", "your g wins");
        assert_eq!(out[0].constants, ["g"]);
        assert_eq!(out[1].units, ["g"]);
        assert_eq!(out[6].shadowing, ["g"]);
        assert_eq!(run(&["c*1 s"])[0].shown.as_deref(), Some("2.9979*10^8*'m"));
        assert_eq!(run(&["2 'g"])[0].shown.as_deref(), Some("0.002 'kg"));
    }

    #[test]
    fn document_order_and_redefinition() {
        let r = shown(&["y := x + 1", "x := 1", "z := x + 1", "x := 10", "x + z"]);
        assert_eq!(r, ["x is not defined", "1", "2", "10", "12"]);
    }

    #[test]
    fn global_definitions_are_visible_above() {
        assert_eq!(shown(&["a := g*2", "g ≡ 9.81"]), ["19.62", "9.81"]);
    }

    #[test]
    fn failed_definitions_explain_themselves() {
        let r = shown(&["a := 1 'm + 1 's", "b := a*2"]);
        assert_eq!(r[1], "a has no value (its definition has an error)");
    }

    #[test]
    fn functions_capture_definition_time_values() {
        let r = shown(&[
            "k := 2",
            "f(x) := k*x",
            "k := 100",
            "f(3)",
            "fact(n) := if(n ≤ 1, 1, n*fact(n - 1))",
            "fact(5)",
        ]);
        assert_eq!(r[3], "6");
        assert_eq!(r[5], "120");
        assert!(run(&["f(x) := x"])[0].error.is_none());
    }

    #[test]
    fn calling_and_integrating_functions() {
        let r = shown(&[
            "f(x) := x^2",
            "f(5)",
            "int(f(x), x, 0, 1)",
            "f(x)",
            "f(a + 1)",
            "g(x) := x + c.1",
            "g(y)",
            "q(x) := 3 'kN/'m",
            "int(q(x), x, 0, 2 'm)",
        ]);
        assert_eq!(r[1], "25");
        assert_eq!(r[2], "0.3333");
        assert_eq!(r[3], "x^2", "an unknown argument shows the body symbolically");
        assert_eq!(r[4], "(a + 1)^2");
        assert_eq!(r[6], "y + c.1");
        assert_eq!(r[8], "6000 'N");
    }

    #[test]
    fn programming_and_calculus() {
        let r = shown(&[
            "sum(i^2, i, 1, 10)",
            "int(x^2, x, 0 'm, 3 'm)",
            "x := 2",
            "diff(x^3, x)",
            "v[3] := 7",
            "v",
            "block(s := 0, for(k, 1..4, s := s + k), s)",
            "M := [2, 0; 0, 4]",
            "M^-1",
            "det(M)",
            "[1, 2]*[3; 4]",
        ]);
        assert_eq!(r[0], "385");
        assert_eq!(r[1], "9 'm^3");
        assert_eq!(r[3], "12");
        assert_eq!(r[5], "[0; 0; 7]");
        assert_eq!(r[6], "10");
        assert_eq!(r[8], "[0.5, 0; 0, 0.25]");
        assert_eq!(r[9], "8");
        assert_eq!(r[10], "[11]");
    }

    #[test]
    fn strings_comparisons_and_conditionals() {
        let r = shown(&[
            "F := 900 'kgf",
            "if(F < 1 'tonnef, \"OK\", \"FALHA\")",
            "1 < 2 < 3",
            "3 < 2 < 4",
            "F < 2 'm",
        ]);
        assert_eq!(r[1], "\"OK\"");
        assert_eq!(r[2], "1");
        assert_eq!(r[3], "0");
        assert!(r[4].starts_with("cannot compare"));
    }

    #[test]
    fn temperature_and_custom_units() {
        let mut ws = Worksheet::new(DisplaySettings::default());
        ws.define_unit("tf", "1000 'kgf").unwrap();
        let regions = [
            MathInput {
                id: "a".into(),
                expr: "T := 20 '°C".into(),
                show: true,
                display: DisplaySpec::default(),
            },
            MathInput {
                id: "b".into(),
                expr: "2 'tf".into(),
                show: true,
                display: DisplaySpec { unit: Some("kN".into()), decimals: Some(3) },
            },
        ];
        let out = ws.run(&regions);
        assert_eq!(out[0].shown.as_deref(), Some("293.15 'K"));
        assert_eq!(out[1].shown.as_deref(), Some("19.613 'kN"));
    }
}
