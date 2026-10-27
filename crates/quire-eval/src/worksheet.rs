use std::rc::Rc;

use quire_ast::{Expr, parse, print};
use quire_units::{Unit, UnitRegistry};

use crate::error::{EvalError, Result, bail};
use crate::format::{DisplaySettings, DisplaySpec, WorkingUnit, format_value_in};
use crate::interp::{Binding, Env, Func, Interp, Scope, func_key, set_element};
use crate::sheet::{CellOutcome, TableInput, cell_label};
use crate::value::Value;

/// One math region, already in document (reading) order.
#[derive(Debug, Clone)]
pub struct MathInput {
    pub id: String,
    pub expr: String,
    /// Render `= result` (`"show": "value"`).
    pub show: bool,
    pub display: DisplaySpec,
    /// A spreadsheet table instead of an expression (`expr` is then unused).
    pub table: Option<TableInput>,
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
    /// A table's cells, row-major.
    pub cells: Vec<Vec<CellOutcome>>,
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
            cells: Vec::new(),
        }
    }
}

/// Every plain name in an expression (for function bodies, which run later).
/// The defined name closest to a mistyped one: same letters in another case, `_` for `.`,
/// or one edit away (two for longer names).
fn nearest<'a>(name: &str, defined: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let fold = |s: &str| s.to_lowercase().replace('_', ".");
    let budget = if name.chars().count() > 4 { 2 } else { 1 };
    let mut best: Option<(usize, &str)> = None;
    for d in defined {
        if d == name {
            continue;
        }
        let cost = if fold(d) == fold(name) { 0 } else { edit_distance(d, name) };
        if cost <= budget && best.is_none_or(|(c, _)| cost < c) {
            best = Some((cost, d));
        }
    }
    best.map(|(_, d)| d)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let next = (row[j + 1] + 1).min(row[j] + 1).min(prev + usize::from(ca != cb));
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// `KN` → `kN`, `mpa` → `MPa`: the unit spelled with the fewest case changes.
fn unit_in_other_case(name: &str, units: &UnitRegistry) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() > 6 || !chars.iter().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut best: Option<(u32, String)> = None;
    for mask in 1u32..(1 << chars.len()) {
        let variant: String = chars
            .iter()
            .enumerate()
            .map(|(i, c)| {
                if mask & (1 << i) == 0 {
                    *c
                } else if c.is_ascii_uppercase() {
                    c.to_ascii_lowercase()
                } else {
                    c.to_ascii_uppercase()
                }
            })
            .collect();
        if units.lookup(&variant).is_some() && best.as_ref().is_none_or(|(n, _)| mask.count_ones() < *n) {
            best = Some((mask.count_ones(), variant));
        }
    }
    best.map(|(_, v)| v)
}

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

/// Units written with a marker: `'kN`.
pub(crate) fn explicit_units(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Unit(n) => out.push(n.clone()),
        Expr::Paren(x) | Expr::Unary(_, x) | Expr::Factorial(x) => explicit_units(x, out),
        Expr::Binary(_, a, b) | Expr::Range(a, b) | Expr::Define { lhs: a, rhs: b, .. } => {
            explicit_units(a, out);
            explicit_units(b, out);
        }
        Expr::Compare(a, rest) => {
            explicit_units(a, out);
            rest.iter().for_each(|(_, x)| explicit_units(x, out));
        }
        Expr::Call(_, xs) => xs.iter().for_each(|x| explicit_units(x, out)),
        Expr::Index(b, xs) => {
            explicit_units(b, out);
            xs.iter().for_each(|x| explicit_units(x, out));
        }
        Expr::Matrix(rows) => rows.iter().flatten().for_each(|x| explicit_units(x, out)),
        Expr::Num(_) | Expr::Ident(_) | Expr::Str(_) | Expr::Placeholder => {}
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
            if let Some(t) = &r.table {
                out[i] = Some(self.step_table(r, t));
            } else if out[i].is_none() {
                out[i] = Some(match &parsed[i] {
                    Ok(e) => self.step(r, e),
                    Err(err) => {
                        Outcome { error: Some(EvalError::from(err.clone()).message), ..Outcome::new(&r.id) }
                    }
                });
            }
        }
        let mut out: Vec<Outcome> = out.into_iter().map(|o| o.expect("every region evaluated")).collect();
        self.explain_undefined(&parsed, &mut out);
        if self.settings.working_units {
            self.show_in_working_units(regions, &parsed, &mut out);
        }
        out
    }

    /// "x is not defined" says why when it can: x is defined further down the page, or
    /// a name close to it is defined above, or it is a unit written in the wrong case.
    fn explain_undefined(
        &self,
        parsed: &[std::result::Result<Expr, quire_ast::ParseError>],
        out: &mut [Outcome],
    ) {
        let mut defined: Vec<(&str, usize, bool)> = Vec::new();
        for (i, e) in parsed.iter().enumerate() {
            let Ok(Expr::Define { lhs, global, .. }) = e else { continue };
            let name = match lhs.as_ref() {
                Expr::Ident(n) | Expr::Call(n, _) => n,
                Expr::Index(b, _) => match b.as_ref() {
                    Expr::Ident(n) => n,
                    _ => continue,
                },
                _ => continue,
            };
            defined.push((name, i, *global));
        }
        for (i, o) in out.iter_mut().enumerate() {
            let Some(name) = o.error.as_deref().and_then(|m| m.strip_suffix(" is not defined")) else {
                continue;
            };
            let hint = if defined.iter().any(|&(n, j, global)| n == name && j > i && !global) {
                format!(
                    "{name} is defined further down; move that definition above this one, or make it global with ~ (≡)"
                )
            } else if let Some(near) = nearest(name, defined.iter().filter(|d| d.1 < i || d.2).map(|d| d.0)) {
                format!("{name} is not defined; did you mean {near}?")
            } else if let Some(unit) = unit_in_other_case(name, &self.units) {
                format!("{name} is not defined; did you mean the unit {unit}?")
            } else {
                continue;
            };
            o.error = Some(hint);
        }
    }

    /// Re-display results in the units the author typed: first those of the definitions
    /// the result depends on (nearest first), then the document's, most used first.
    fn show_in_working_units(
        &self,
        regions: &[MathInput],
        parsed: &[std::result::Result<Expr, quire_ast::ParseError>],
        out: &mut [Outcome],
    ) {
        // units written in each region, and the names each region reads
        let mut own: Vec<Vec<String>> = Vec::with_capacity(regions.len());
        let mut reads: Vec<Vec<String>> = Vec::with_capacity(regions.len());
        for ((e, o), r) in parsed.iter().zip(out.iter()).zip(regions) {
            let mut u = Vec::new();
            let mut n = Vec::new();
            if let Some(t) = &r.table {
                n = crate::sheet::reads(t, &self.units);
            } else if let Ok(e) = e {
                explicit_units(e, &mut u);
                match e {
                    Expr::Define { rhs, .. } => names(rhs, &mut n),
                    other => names(other, &mut n),
                }
            }
            u.extend(o.units.iter().cloned());
            own.push(u);
            reads.push(n);
        }
        let usable =
            |name: &str| self.units.lookup(name).filter(|u| u.offset == 0.0 && !u.dim.is_dimensionless());
        // document-wide preference: most used first, ties in order of appearance
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for n in own.iter().flatten() {
            match counts.iter_mut().find(|(m, _)| *m == n) {
                Some((_, c)) => *c += 1,
                None => counts.push((n, 1)),
            }
        }
        counts.sort_by_key(|c| std::cmp::Reverse(c.1));
        let mut defined: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (i, (r, o)) in regions.iter().zip(out.iter_mut()).enumerate() {
            if let Some(name) = &o.defines {
                // `f(x)` defines f; `v[i]` defines v
                let key = name.split('(').next().unwrap_or(name);
                defined.insert(key.to_string(), i);
            }
            let table = r.table.as_ref();
            if table.is_none()
                && (!r.show || r.display.unit.is_some() || o.error.is_some() || o.value.is_none())
            {
                continue;
            }
            // breadth-first through the definitions this result reads; a unit a definition
            // is shown in (`σ` in MPa) comes before the units it is written with
            let mut order: Vec<&str> = own[i].iter().map(String::as_str).collect();
            let mut seen = vec![i];
            let mut frontier: Vec<usize> = Vec::new();
            for n in &reads[i] {
                if let Some(&d) = defined.get(n.as_str())
                    && !seen.contains(&d)
                {
                    seen.push(d);
                    frontier.push(d);
                }
            }
            while !frontier.is_empty() {
                let mut next = Vec::new();
                for d in frontier {
                    order.extend(regions[d].display.unit.as_deref());
                    order.extend(own[d].iter().map(String::as_str));
                    for n in &reads[d] {
                        if let Some(&e) = defined.get(n.as_str())
                            && !seen.contains(&e)
                            && e < d
                        {
                            seen.push(e);
                            next.push(e);
                        }
                    }
                }
                frontier = next;
            }
            order.extend(counts.iter().map(|(n, _)| *n));
            let mut vocab: Vec<WorkingUnit> = Vec::new();
            for name in order {
                if vocab.iter().any(|w| w.name == name) {
                    continue;
                }
                if let Some(unit) = usable(name) {
                    vocab.push(WorkingUnit { name: name.to_string(), unit });
                }
            }
            if let Some(t) = table {
                crate::sheet::reformat(t, &mut o.cells, &self.settings, &self.units, &vocab);
            } else if let Some(v) = &o.value
                && let Ok(text) = format_value_in(v, &r.display, &self.settings, &self.units, &vocab)
            {
                o.shown = Some(text);
            }
        }
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

    fn step_table(&mut self, r: &MathInput, t: &TableInput) -> Outcome {
        let mut out = Outcome::new(&r.id);
        let globals = Rc::clone(&self.globals);
        let mut interp = Interp::new(&self.units);
        let mut scope = Scope::new(&globals);
        let (cells, value, written) = crate::sheet::evaluate(t, &mut interp, &mut scope, &self.settings);
        let mut units: std::collections::BTreeSet<String> = std::mem::take(&mut interp.unit_idents);
        units.extend(written);
        out.units = units.into_iter().collect();
        out.constants = std::mem::take(&mut interp.constant_idents).into_iter().collect();
        drop(scope);
        let errors: Vec<(String, &str)> = cells
            .iter()
            .enumerate()
            .flat_map(|(i, row)| {
                row.iter()
                    .enumerate()
                    .filter_map(move |(j, c)| c.error.as_deref().map(|e| (cell_label(i, j), e)))
            })
            .collect();
        out.error = match errors.as_slice() {
            [] => None,
            [(at, e)] => Some(format!("{at}: {e}")),
            [(at, e), rest @ ..] => {
                let more = if rest.len() == 1 {
                    "1 more cell".to_string()
                } else {
                    format!("{} more cells", rest.len())
                };
                Some(format!("{at}: {e} (and {more})"))
            }
        };
        if let Some(name) = t.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            out.defines = Some(name.to_string());
            self.bind(name.to_string(), Binding::Val(value.clone()));
        }
        out.value = Some(value);
        out.cells = cells;
        out
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
                    match crate::format::format_shown(&v, &r.display, &self.settings, &self.units) {
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
                table: None,
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
            ["2 'm", "0.3 'm", "0.6 'm^2", "cannot add an area (m^2) and a plain number: units don't match"]
        );
        assert_eq!(
            shown(&["L := 6 'm", "q := 12 'kN/'m", "L + q"])[2],
            "cannot add a length (m) and a force per length (N/m): units don't match"
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
    fn tables_read_and_define_variables() {
        let math = |id: &str, e: &str| MathInput {
            id: id.into(),
            expr: e.into(),
            show: true,
            display: DisplaySpec::default(),
            table: None,
        };
        let table = |id: &str, name: &str, rows: &[&[&str]]| MathInput {
            id: id.into(),
            expr: String::new(),
            show: false,
            display: DisplaySpec::default(),
            table: Some(TableInput {
                name: Some(name.into()),
                rows: rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect(),
                ..Default::default()
            }),
        };
        let regions = [
            math("a", "γ := 1.4"),
            table(
                "t",
                "loads",
                &[&["Dead", "12 kN", "=B1*γ"], &["Live", "8 kN", "=B2*1.5"], &["", "", "=SUM(C1:C2)"]],
            ),
            math("b", "loads[3, 3]"),
            table("u", "check", &[&["=loads!C3", "=IF(A1 < 40 kN, \"OK\", \"NO\")"]]),
            table("v", "bad", &[&["=1/0", "=A1"]]),
            MathInput {
                display: DisplaySpec { unit: Some("MPa".into()), decimals: None },
                ..math("c", "σ := 2 kN/(10 cm^2)")
            },
            table("w", "uses", &[&["=σ", "=σ*2"]]),
        ];
        let settings = DisplaySettings { working_units: true, ..Default::default() };
        let out = Worksheet::new(settings).run(&regions);
        let cell = |o: &Outcome, r: usize, c: usize| o.cells[r][c].shown.clone().unwrap_or_default();
        assert_eq!(cell(&out[1], 0, 2), "16.8 'kN");
        assert_eq!(cell(&out[1], 2, 2), "28.8 'kN");
        assert_eq!(out[1].defines.as_deref(), Some("loads"));
        assert_eq!(out[2].shown.as_deref(), Some("28.8 'kN"));
        assert_eq!(cell(&out[3], 0, 1), "\"OK\"");
        assert!(out[4].error.as_deref().unwrap().starts_with("A1: "), "{:?}", out[4].error);
        assert!(out[4].error.as_deref().unwrap().ends_with("(and 1 more cell)"));
        // a cell reading σ shows it the way σ is shown
        assert_eq!(cell(&out[6], 0, 0), "2 'MPa");
        assert_eq!(cell(&out[6], 0, 1), "4 'MPa");
    }

    #[test]
    fn undefined_names_explain_themselves() {
        let r =
            shown(&["σ.max := 2", "A_net := 3", "sigma.max + 1", "A.net", "S.max", "q := 5 KN", "y := zzz"]);
        assert_eq!(r[2], "sigma.max is not defined");
        assert_eq!(r[3], "A.net is not defined; did you mean A_net?");
        assert_eq!(r[4], "S.max is not defined; did you mean σ.max?");
        assert_eq!(r[5], "KN is not defined; did you mean the unit kN?");
        assert_eq!(r[6], "zzz is not defined");
        // a global definition below is visible, so no "further down"
        assert_eq!(shown(&["b + 1", "b ≡ 2"])[0], "3");
    }

    #[test]
    fn document_order_and_redefinition() {
        let r = shown(&["y := x + 1", "x := 1", "z := x + 1", "x := 10", "x + z"]);
        assert_eq!(
            r[0],
            "x is defined further down; move that definition above this one, or make it global with ~ (≡)"
        );
        assert_eq!(r[1..], ["1", "2", "10", "12"]);
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

    fn shown_working(lines: &[&str]) -> Vec<String> {
        let regions: Vec<MathInput> = lines
            .iter()
            .enumerate()
            .map(|(i, l)| MathInput {
                id: i.to_string(),
                expr: l.to_string(),
                show: true,
                display: DisplaySpec::default(),
                table: None,
            })
            .collect();
        let settings = DisplaySettings { working_units: true, ..Default::default() };
        Worksheet::new(settings)
            .run(&regions)
            .into_iter()
            .map(|o| o.shown.or(o.error).unwrap_or_default())
            .collect()
    }

    #[test]
    fn results_in_the_units_the_author_typed() {
        let r = shown_working(&[
            "L := 6 m",
            "q := 12 kN/m",
            "M := q*L^2/8",
            "V := q*L/2",
            "b := 20 cm",
            "h := 40 'cm",
            "A := b*h",
            "I := b*h^3/12",
            "σ := M/(b*h^2/6)",
            "f := 25 MPa",
            "σ/f",
            "T := 20 degC",
        ]);
        assert_eq!(r[2], "54 'kN*'m");
        assert_eq!(r[3], "36 'kN");
        assert_eq!(r[6], "800 'cm^2");
        assert_eq!(r[7], "1.0667*10^5*'cm^4");
        assert_eq!(r[8], "10.125 'MPa", "a single typed unit wins over a pair");
        assert_eq!(r[10], "0.405");
        assert_eq!(r[11], "293.15 'K", "offset units never become working units");
        // without the setting, coherent SI as before
        assert_eq!(shown(&["q := 12 kN/m", "q*(6 m)^2/8"])[1], "54000 'J");
    }

    #[test]
    fn solving_and_vectors() {
        let r = shown(&[
            "f(x) := x^3 - 2*x - 5",
            "root(f(x), x, 2, 3)",
            "solve(x^2 == 2, x, 0, 10)",
            "x := 1",
            "solve(cos(x) == x, x)",
            "P(d) := 10 'kN*d/(1 'm)",
            "solve(P(d) == 25 'kN, d, 0, 10 'm)",
            "A := [2, 1; 1, 3]",
            "lsolve(A, [3; 5])",
            "linterp([0; 10; 20], [0; 5; 20], 15)",
            "mean([1, 2, 3, 4])",
            "sort([3; 1; 2])",
            "norm([3 'm, 4 'm])",
            "dot([1, 2, 3], [4, 5, 6])",
            "cross([1; 0; 0], [0; 1; 0])",
            "root(x^2 + 1, x, -1, 1)",
            "solve(t^2 == 2, t)",
        ]);
        assert_eq!(r[1], "2.0946");
        assert_eq!(r[2], "1.4142");
        assert_eq!(r[4], "0.7391");
        assert_eq!(r[6], "2.5 'm");
        assert_eq!(r[8], "[0.8; 1.4]");
        assert_eq!(r[9], "12.5");
        assert_eq!(r[10], "2.5");
        assert_eq!(r[11], "[1; 2; 3]");
        assert_eq!(r[12], "5 'm");
        assert_eq!(r[13], "32");
        assert_eq!(r[14], "[0; 0; 1]");
        assert!(r[15].starts_with("no root between the limits"), "{}", r[15]);
        assert!(r[16].starts_with("give t a starting value"), "{}", r[16]);
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
                table: None,
            },
            MathInput {
                id: "b".into(),
                expr: "2 'tf".into(),
                show: true,
                display: DisplaySpec { unit: Some("kN".into()), decimals: Some(3) },
                table: None,
            },
        ];
        let out = ws.run(&regions);
        assert_eq!(out[0].shown.as_deref(), Some("293.15 'K"));
        assert_eq!(out[1].shown.as_deref(), Some("19.613 'kN"));
    }
}
