use std::rc::Rc;

use quire_ast::{Expr, parse, print};
use quire_units::{Unit, UnitRegistry};

use crate::error::{EvalError, Result, bail};
use crate::format::{DisplaySettings, DisplaySpec, WorkingUnit, format_value_in};
use crate::interp::{Binding, Env, Func, Interp, Scope, func_key, set_element};
use crate::plot::{Axis, PlotInput, PlotOutcome, Sampled, SeriesOutcome};
use crate::sheet::{CellOutcome, TableInput, cell_label};
use crate::value::Value;

/// SI spelling of a dimension without unit markers (`N*m`).
fn si_text(dim: quire_units::Dim) -> String {
    crate::format::si_unit(dim).replace('\'', "")
}

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
    /// A 2D plot instead of an expression (`expr` is then unused).
    pub plot: Option<PlotInput>,
    /// Show the expression worked out symbolically (`→`) rather than its value.
    pub symbolic: bool,
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
    /// Your variables read as a unit here because they follow a number (`10 m`).
    pub units_over_variables: Vec<String>,
    /// A table's cells, row-major.
    pub cells: Vec<Vec<CellOutcome>>,
    /// What would fix `error`, when the engine can tell.
    pub fix: Option<Fix>,
    /// A plot's series, in its axis units.
    pub plot: Option<PlotOutcome>,
    /// A plot's samples in SI, kept until its axis units are chosen.
    samples: Vec<std::result::Result<Sampled, String>>,
}

/// A one-click repair for an error.
#[derive(Debug, Clone, PartialEq)]
pub enum Fix {
    /// Write `to` in place of the name `from` (a typo, or a unit in the wrong case).
    Rename { from: String, to: String },
    /// The name is defined further down, by the region at this index.
    DefinedBelow { index: usize },
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
            units_over_variables: Vec::new(),
            cells: Vec::new(),
            fix: None,
            plot: None,
            samples: Vec::new(),
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
    used_over_variables: std::collections::BTreeSet<String>,
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
            used_over_variables: Default::default(),
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
            } else if let Some(p) = &r.plot {
                out[i] = Some(self.step_plot(r, p));
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
            let rename = |to: &str| Fix::Rename { from: name.to_string(), to: to.to_string() };
            let (hint, fix) = if let Some(&(_, j, _)) =
                defined.iter().find(|&&(n, j, global)| n == name && j > i && !global)
            {
                (
                    format!(
                        "{name} is defined further down; move that definition above this one, or make it global with ~ (≡)"
                    ),
                    Fix::DefinedBelow { index: j },
                )
            } else if let Some(near) = nearest(name, defined.iter().filter(|d| d.1 < i || d.2).map(|d| d.0)) {
                (format!("{name} is not defined; did you mean {near}?"), rename(near))
            } else if let Some(unit) = unit_in_other_case(name, &self.units) {
                (format!("{name} is not defined; did you mean the unit {unit}?"), rename(&unit))
            } else {
                continue;
            };
            o.error = Some(hint);
            o.fix = Some(fix);
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
            } else if let Some(p) = &r.plot {
                for s in &p.series {
                    for part in [Some(&s.y), s.range.as_ref()].into_iter().flatten() {
                        if let Ok(e) = parse(part) {
                            explicit_units(&e, &mut u);
                            names(&e, &mut n);
                        }
                    }
                }
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
                && r.plot.is_none()
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
            if let Some(p) = &r.plot {
                let pick = |dim: quire_units::Dim| {
                    crate::format::working_unit(dim, &vocab).map(|(_, text)| text.replace('\'', ""))
                };
                let x = p.x_unit.clone().or_else(|| o.plot.as_ref().and_then(|q| pick(q.x.dim)));
                let y = p.y_unit.clone().or_else(|| o.plot.as_ref().and_then(|q| pick(q.y.dim)));
                self.finish_plot(o, x, y);
            } else if let Some(t) = table {
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
        let over = std::mem::take(&mut interp.units_over_variables);
        self.used_units.extend(units);
        self.used_constants.extend(constants);
        self.used_shadowing.extend(shadowing);
        self.used_over_variables.extend(over);
        r
    }

    fn step_table(&mut self, r: &MathInput, t: &TableInput) -> Outcome {
        let mut out = Outcome::new(&r.id);
        let globals = Rc::clone(&self.globals);
        let mut interp = Interp::new(&self.units);
        let mut scope = Scope::new(&globals);
        let (cells, value, written) = crate::sheet::evaluate(t, &mut interp, &mut scope, &self.settings);
        // in the order they are written: the first units in a table are its working units
        // (`4.5 kN/m` and `100 N` → kN/m, not N/m)
        let mut units = written;
        units.extend(std::mem::take(&mut interp.unit_idents));
        let mut seen = std::collections::HashSet::new();
        units.retain(|u| seen.insert(u.clone()));
        out.units = units;
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

    fn step_plot(&mut self, r: &MathInput, p: &PlotInput) -> Outcome {
        let mut out = Outcome::new(&r.id);
        let globals = Rc::clone(&self.globals);
        let mut interp = Interp::new(&self.units);
        let mut scope = Scope::new(&globals);
        out.samples = p
            .series
            .iter()
            .map(|s| crate::plot::sample(s, &mut interp, &mut scope).map_err(|e| e.message))
            .collect();
        out.units = std::mem::take(&mut interp.unit_idents).into_iter().collect();
        out.constants = std::mem::take(&mut interp.constant_idents).into_iter().collect();
        drop(scope);
        self.finish_plot(&mut out, p.x_unit.clone(), p.y_unit.clone());
        out
    }

    /// Put a plot's samples in its axis units: the ones given, or SI.
    fn finish_plot(&self, out: &mut Outcome, x_unit: Option<String>, y_unit: Option<String>) {
        let ok = || out.samples.iter().filter_map(|s| s.as_ref().ok());
        let x_dim = ok().find_map(|s| s.xs.first()).map(|q| q.dim).unwrap_or_default();
        let y_dim = ok().find_map(|s| s.ys.first()).map(|q| q.dim).unwrap_or_default();
        let axis = |unit: Option<String>, dim: quire_units::Dim| Axis {
            unit: unit
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| if dim.is_dimensionless() { String::new() } else { si_text(dim) }),
            dim,
        };
        let (x, y) = (axis(x_unit, x_dim), axis(y_unit, y_dim));
        let series: Vec<SeriesOutcome> = out
            .samples
            .iter()
            .map(|s| {
                let converted = s.as_ref().map_err(Clone::clone).and_then(|s| {
                    let xs = crate::plot::in_unit(&s.xs, &x.unit, &self.units)
                        .map_err(|e| format!("x axis: {}", e.message))?;
                    let ys = crate::plot::in_unit(&s.ys, &y.unit, &self.units).map_err(|e| e.message)?;
                    Ok((xs, ys))
                });
                match converted {
                    Ok((xs, ys)) => SeriesOutcome { xs, ys, error: None },
                    Err(e) => SeriesOutcome { error: Some(e), ..Default::default() },
                }
            })
            .collect();
        let errors: Vec<(usize, &String)> =
            series.iter().enumerate().filter_map(|(i, s)| s.error.as_ref().map(|e| (i, e))).collect();
        out.error = match errors.as_slice() {
            [] => None,
            [(_, e)] if series.len() == 1 => Some((*e).clone()),
            [(i, e), ..] => Some(format!("series {}: {e}", i + 1)),
        };
        out.plot = Some(PlotOutcome { x, y, series });
    }

    fn bind(&mut self, key: String, b: Binding) {
        Rc::make_mut(&mut self.globals).insert(key, b);
    }

    fn step(&mut self, r: &MathInput, e: &Expr) -> Outcome {
        if r.symbolic {
            return self.step_symbolic(r, e);
        }
        let mut out = Outcome::new(&r.id);
        self.used_units.clear();
        self.used_constants.clear();
        self.used_shadowing.clear();
        self.used_over_variables.clear();
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
        out.units_over_variables = std::mem::take(&mut self.used_over_variables).into_iter().collect();
        out
    }

    /// `expr →`: worked out symbolically. A definition still defines (a function as
    /// usual, a variable when its value can be computed) and shows its right-hand side.
    fn step_symbolic(&mut self, r: &MathInput, e: &Expr) -> Outcome {
        let mut out = Outcome::new(&r.id);
        let shown_of = match e {
            Expr::Define { lhs, rhs, .. } => {
                if let Expr::Call(..) = lhs.as_ref() {
                    let _ = self.define(&mut out, lhs, rhs);
                } else if let Expr::Ident(name) = lhs.as_ref() {
                    out.defines = Some(name.clone());
                    match self.eval(rhs) {
                        Ok(v) => self.bind(name.clone(), Binding::Val(v)),
                        Err(_) => self.bind(
                            name.clone(),
                            Binding::Failed(format!(
                                "{name} is symbolic (→): it has no value to compute with"
                            )),
                        ),
                    }
                }
                rhs.as_ref()
            }
            other => other,
        };
        let globals = Rc::clone(&self.globals);
        let functions = |name: &str, arity: usize| match globals.get(&func_key(name, arity)) {
            Some(Binding::Func(f)) => Some((f.params.clone(), f.body.clone())),
            _ => None,
        };
        match crate::symbolic::evaluate(shown_of, &functions) {
            Ok(text) => out.shown = Some(text),
            Err(msg) => out.error = Some(msg),
        }
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
                plot: None,
                symbolic: false,
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
    fn plain_names_are_units_unless_defined_or_after_a_number() {
        let out =
            run(&["L := 2 m", "g := 9.81 m/s^2", "W := 30 cm", "A := L*W", "m := 3 kg", "F := m*g", "2 m"]);
        let shown: Vec<_> =
            out.iter().map(|o| o.shown.clone().or(o.error.clone()).unwrap_or_default()).collect();
        assert_eq!(shown[0], "2 'm");
        assert_eq!(shown[3], "0.6 'm^2");
        assert_eq!(shown[5], "29.43 'N");
        assert_eq!(shown[6], "2 'm", "right after a number, a unit name is the unit");
        assert_eq!(out[6].units_over_variables, ["m"]);
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
            plot: None,
            symbolic: false,
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
            plot: None,
            symbolic: false,
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
    fn plots_sample_functions_and_data_in_working_units() {
        use crate::plot::{PlotInput, SAMPLES, SeriesInput};
        let math = |id: &str, e: &str| MathInput {
            id: id.into(),
            expr: e.into(),
            show: false,
            display: DisplaySpec::default(),
            table: None,
            plot: None,
            symbolic: false,
        };
        let plot = |id: &str, series: Vec<SeriesInput>, y_unit: Option<&str>| MathInput {
            id: id.into(),
            expr: String::new(),
            show: false,
            display: DisplaySpec::default(),
            table: None,
            plot: Some(PlotInput { series, x_unit: None, y_unit: y_unit.map(Into::into) }),
            symbolic: false,
        };
        let over = |y: &str, range: &str| SeriesInput { y: y.into(), x: None, range: Some(range.into()) };
        let regions = [
            math("q", "q := 10 kN/m"),
            math("L", "L := 6 m"),
            math("M", "M(x) := q*x*(L - x)/2"),
            plot("p", vec![over("M(x)", "0 m..L")], None),
            math("v", "v := [1; 4; 9]"),
            plot("d", vec![SeriesInput { y: "v".into(), ..Default::default() }], None),
            plot("bad", vec![over("M(x)", "0 m..L")], Some("MPa")),
            plot("u", vec![over("zz(x)", "0..1")], None),
        ];
        let settings = DisplaySettings { working_units: true, ..Default::default() };
        let out = Worksheet::new(settings).run(&regions);
        let p = out[3].plot.as_ref().unwrap();
        assert_eq!((p.x.unit.as_str(), p.y.unit.as_str()), ("m", "kN*m"));
        let s = &p.series[0];
        assert_eq!(s.xs.len(), SAMPLES + 1);
        assert!((s.xs[SAMPLES / 2] - 3.0).abs() < 1e-9 && (s.ys[SAMPLES / 2] - 45.0).abs() < 1e-9);
        let d = &out[5].plot.as_ref().unwrap().series[0];
        assert_eq!((d.xs.clone(), d.ys.clone()), (vec![1.0, 2.0, 3.0], vec![1.0, 4.0, 9.0]));
        assert!(out[6].error.as_deref().unwrap().ends_with("but the axis is in MPa"), "{:?}", out[6].error);
        assert!(out[7].error.is_some());
        assert_eq!(out[3].error, None);
    }

    #[test]
    fn arrows_work_symbolically_with_the_documents_functions() {
        let line = |id: &str, e: &str, symbolic: bool| MathInput {
            id: id.into(),
            expr: e.into(),
            show: false,
            display: DisplaySpec::default(),
            table: None,
            plot: None,
            symbolic,
        };
        let out = Worksheet::new(DisplaySettings::default()).run(&[
            line("q", "q := 10 'kN/'m", false),
            line("M", "M(x) := q*x*(L - x)/2", false),
            line("V", "diff(M(x), x)", true),
            line("A", "int(M(x), x, 0, L)", true),
            line("y", "y := expand((a + 1)^2)", true),
            line("bad", "[1, 2]", true),
        ]);
        let shown = |i: usize| out[i].shown.clone().or(out[i].error.clone()).unwrap_or_default();
        assert_eq!(shown(2), "q*(L - 2*x)/2");
        assert_eq!(shown(3), "L^3*q/12");
        assert_eq!(shown(4), "a^2 + 2*a + 1");
        assert_eq!(out[4].defines.as_deref(), Some("y"));
        assert!(out[5].error.is_some());
    }

    #[test]
    fn a_unit_after_a_number_wins_over_a_variable() {
        let out = run(&["m := 25 'kg", "L := 10 m", "m*g", "10*m", "v(t) := 2 t", "v(3)", "100 km/h"]);
        let shown = |i: usize| out[i].shown.clone().or(out[i].error.clone()).unwrap_or_default();
        // 10 metres, not 10 × 25 kg; the editor is told so it can offer the variable
        assert_eq!(shown(1), "10 'm");
        assert_eq!(out[1].units_over_variables, ["m"]);
        // anywhere else the variable still wins
        assert_eq!(shown(2), "245.1662 'N");
        assert_eq!(shown(3), "250 'kg");
        assert!(out[3].units_over_variables.is_empty());
        // and a function's own parameter is never a unit: t here is not tonnes
        assert_eq!(shown(5), "6");
    }

    #[test]
    fn undefined_names_come_with_a_fix() {
        let out = run(&["A_net := 3", "A.net", "q := 5 KN", "y + 1", "y := 2", "zzz"]);
        let rename = |from: &str, to: &str| Some(Fix::Rename { from: from.into(), to: to.into() });
        assert_eq!(out[1].fix, rename("A.net", "A_net"));
        assert_eq!(out[2].fix, rename("KN", "kN"));
        assert_eq!(out[3].fix, Some(Fix::DefinedBelow { index: 4 }));
        assert_eq!(out[5].fix, None);
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
                plot: None,
                symbolic: false,
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
    fn smath_programming_line_break_continue() {
        let r = shown(&[
            "line(a := 1, while(a < 100, a := 2*a), a)",
            "line(s := 0, for(k, 1..10, line(if(k > 4, break, 0), s := s + k)), s)",
            "line(s := 0, for(k, 1..6, line(if(mod(k, 2) == 0, continue, 0), s := s + k)), s)",
            "line(s := 0, for(k := 1, k ≤ 10, k := k + 1, if(k > 3, break, s := s + k)), s)",
            "f(n) := line(i := 0, while(1, line(i := i + 1, if(i ≥ n, break, 0))), i)",
            "line(t := 0, for(j, 1..3, t := t + f(5)), t)",
        ]);
        assert_eq!(r[0], "128");
        assert_eq!(r[1], "10", "break leaves the loop");
        assert_eq!(r[2], "9", "continue skips the even k");
        assert_eq!(r[3], "6", "break in the four-part for");
        assert_eq!(r[5], "15", "a break inside f stays inside f");
        let r =
            shown(&["line(s := 0, for(k, 1..10, line(if(k > 4, break), s := s + k)), s)", "if(1 > 2, 5)"]);
        assert_eq!(r[0], "10", "if without else");
        assert_eq!(r[1], "0");
        // `line` of statements is SMath's block; `line(vx, vy)` of values is the line fit
        let r = shown(&["line([1; 2; 3], [3; 5; 7])", "line(a := 2, a + 1)"]);
        assert_eq!(r[0], "[1; 2]");
        assert_eq!(r[1], "3");
    }

    #[test]
    fn smath_functions_as_typed_in_a_worksheet() {
        let r = shown(&[
            "k := 200 'kN/'m",
            "roots(k*x == 50 'kN, x, 1 'm)",
            "roots(x^2 - 2, x, 1)",
            "roots([x + y == 3; x - y == 1], [x; y], [0; 0])",
            "roots(sys(x + y == 3, x - y == 1, 2, 1), [x; y], [0; 0])",
            "polyroots([2; -3; 1])",
            "IsDefined(k)",
            "IsDefined(zz)",
            "M := [1, 2; 3, 4]",
            "col(M, 2)",
            "submatrix(M, 2, 2, 1, 2)",
            "strlen(\"Quire\")",
            "substr(\"SMath Studio\", 6, 6)",
            "gcd(12, 18)",
            "UnitsOf(5 'kN)",
            "if(1 > 2, 0, error(\"custom stop\"))",
        ]);
        assert_eq!(r[1], "0.25 'm");
        assert_eq!(r[2], "1.4142");
        assert_eq!(r[3], "[2; 1]");
        assert_eq!(r[4], "[2; 1]", "SMath's sys(…) form");
        assert_eq!(r[5], "[1; 2]");
        assert_eq!(r[6], "1");
        assert_eq!(r[7], "0");
        assert_eq!(r[9], "[2; 4]");
        assert_eq!(r[10], "[3, 4]");
        assert_eq!(r[11], "5");
        assert_eq!(r[12], "\"Studio\"");
        assert_eq!(r[13], "6");
        assert_eq!(r[14], "1 'N");
        assert_eq!(r[15], "custom stop");
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
                plot: None,
                symbolic: false,
            },
            MathInput {
                id: "b".into(),
                expr: "2 'tf".into(),
                show: true,
                display: DisplaySpec { unit: Some("kN".into()), decimals: Some(3) },
                table: None,
                plot: None,
                symbolic: false,
            },
        ];
        let out = ws.run(&regions);
        assert_eq!(out[0].shown.as_deref(), Some("293.15 'K"));
        assert_eq!(out[1].shown.as_deref(), Some("19.613 'kN"));
    }

    #[test]
    fn table_cells_in_the_units_they_are_typed_in() {
        let rows: &[&[&str]] =
            &[&["Load", "q", "twice"], &["Dead", "4.5 kN/m", "=B2*2"], &["Point", "100 N", "=B3*3 m"]];
        let table = MathInput {
            id: "t".into(),
            expr: String::new(),
            show: true,
            display: DisplaySpec::default(),
            table: Some(crate::sheet::TableInput {
                rows: rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect(),
                ..Default::default()
            }),
            plot: None,
            symbolic: false,
        };
        let cells = |settings: DisplaySettings| -> Vec<Vec<String>> {
            Worksheet::new(settings).run(std::slice::from_ref(&table))[0]
                .cells
                .iter()
                .map(|row| row.iter().map(|c| c.shown.clone().unwrap_or_default()).collect())
                .collect()
        };
        // results in the units the table is written in, first ones first: 9 kN/m, not 9000 N/m
        let r = cells(DisplaySettings { working_units: true, ..Default::default() });
        assert_eq!(r[1][1..], ["4.5 'kN/'m", "9 'kN/'m"]);
        assert_eq!(r[2][1..], ["100 'N", "0.3 'kN*'m"]);
        // in coherent SI, values still read as typed, as definitions do; formulas are SI
        let r = cells(DisplaySettings::default());
        assert_eq!(r[1][1..], ["4.5 'kN/'m", "9000 'N/'m"]);
        assert_eq!(r[2][1..], ["100 'N", "300 'J"]);
    }
}
