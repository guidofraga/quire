//! Tables: each cell is text, a value (`12 kN`, `1.35`, `15%`) or a spreadsheet formula
//! (`=B2*C2`, `=SUM(D2:D4)`, `=IF(E5<=F5, "OK", "FAIL")`).
//!
//! Formulas follow spreadsheet conventions (A1 references, ranges, `=`/`<>` comparisons,
//! `&` joins text, `,` or `;` between arguments, function names in any case) and reach
//! into the worksheet: document variables (`=M.max`), units (`=B2 + 5 kN`), your own
//! functions and Quire's built-ins. A named table is a matrix variable for the math below
//! it, and other tables' cells are `name!B2`.

use std::collections::BTreeSet;

use quire_ast::{BinaryOp, CmpOp, Expr, parse};
use quire_units::UnitRegistry;

use crate::error::{EvalError, Result, bail};
use crate::format::{DisplaySettings, DisplaySpec, WorkingUnit, format_value_in};
use crate::interp::{Binding, Interp, Scope};
use crate::ops::{arith, compare, negate};
use crate::value::{Matrix, Quantity, Value};

/// A table region, in document order among the math regions.
#[derive(Debug, Clone, Default)]
pub struct TableInput {
    /// The variable the table defines for the math below it.
    pub name: Option<String>,
    /// Raw cell text, row-major; short rows count as blank cells.
    pub rows: Vec<Vec<String>>,
    /// Per-column display (unit, decimals); overrides `display`.
    pub columns: Vec<DisplaySpec>,
    pub display: DisplaySpec,
}

/// What one cell shows.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CellOutcome {
    /// The value in linear syntax (`16.2 'kN`, `"OK"`); `None` for text and blank cells.
    pub shown: Option<String>,
    pub error: Option<String>,
    /// The cell holds a formula (its text starts with `=`).
    pub formula: bool,
    /// The number behind `shown`, for showing it again in other units.
    pub value: Option<Value>,
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/// `B12` / `$B$12` → (row, col), 0-based.
pub fn parse_ref(s: &str) -> Option<(usize, usize)> {
    let s = s.replace('$', "");
    let letters = s.chars().take_while(|c| c.is_ascii_uppercase()).count();
    if letters == 0 || letters > 3 || letters == s.len() {
        return None;
    }
    let (col, row) = s.split_at(letters);
    if !row.chars().all(|c| c.is_ascii_digit()) || row.starts_with('0') {
        return None;
    }
    let col = col.chars().fold(0usize, |n, c| n * 26 + (c as usize - 'A' as usize + 1));
    Some((row.parse::<usize>().ok()? - 1, col - 1))
}

/// 0-based column → `A`, `B`, … `AA`.
pub fn column_name(mut c: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push((b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s.iter().rev().collect()
}

/// `B3` for row 2, column 1 (0-based).
pub fn cell_label(r: usize, c: usize) -> String {
    format!("{}{}", column_name(c), r + 1)
}

// ---------------------------------------------------------------------------
// Formula syntax
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(String),
    Str(String),
    Name(String),
    Sym(&'static str),
}

fn tokenize(src: &str) -> Result<Vec<Tok>> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    const SYMS: [&str; 18] =
        ["<>", "<=", ">=", "!=", "==", "+", "-", "*", "/", "^", "&", "%", "=", "<", ">", "(", ")", ":"];
    'outer: while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if matches!(chars.get(i), Some('e' | 'E')) {
                let mut j = i + 1;
                if matches!(chars.get(j), Some('+' | '-')) {
                    j += 1;
                }
                if chars.get(j).is_some_and(char::is_ascii_digit) {
                    i = j;
                    while chars.get(i).is_some_and(char::is_ascii_digit) {
                        i += 1;
                    }
                }
            }
            out.push(Tok::Num(chars[start..i].iter().collect()));
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' || c == '°' {
            let start = i;
            while i < chars.len() {
                let d = chars[i];
                if d.is_alphanumeric() || d == '_' || d == '$' || d == '°' {
                    i += 1;
                } else if d == '.' && chars.get(i + 1).is_some_and(|n| n.is_alphanumeric() || *n == '_') {
                    i += 2; // literal subscript: M.max
                } else {
                    break;
                }
            }
            out.push(Tok::Name(chars[start..i].iter().collect()));
            continue;
        }
        if c == '"' {
            i += 1;
            let mut s = String::new();
            loop {
                match chars.get(i) {
                    None => bail!("a text in quotes is not closed"),
                    Some('"') if chars.get(i + 1) == Some(&'"') => {
                        s.push('"');
                        i += 2;
                    }
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some(ch) => {
                        s.push(*ch);
                        i += 1;
                    }
                }
            }
            out.push(Tok::Str(s));
            continue;
        }
        if c == ',' || c == ';' {
            out.push(Tok::Sym(","));
            i += 1;
            continue;
        }
        if c == '!' && !matches!(chars.get(i + 1), Some('=')) {
            out.push(Tok::Sym("!"));
            i += 1;
            continue;
        }
        let sub = |s: &str| chars[i..].iter().take(s.chars().count()).copied().eq(s.chars());
        for s in SYMS {
            if sub(s) {
                let canon = match s {
                    "!=" => "<>",
                    "==" => "=",
                    other => other,
                };
                out.push(Tok::Sym(canon));
                i += s.chars().count();
                continue 'outer;
            }
        }
        let canon = match c {
            '≤' => "<=",
            '≥' => ">=",
            '≠' => "<>",
            '·' | '×' => "*",
            '÷' => "/",
            '−' => "-",
            _ => bail!("unexpected character '{c}' in the formula"),
        };
        out.push(Tok::Sym(canon));
        i += 1;
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum F {
    Num(f64),
    Str(String),
    Bool(bool),
    /// A worksheet expression: a variable (`M.max`) or a number with units (`5 kN`).
    Quire(Expr),
    Cell(usize, usize),
    Range((usize, usize), (usize, usize)),
    /// Another table's cell or range: `loads!B2`, `loads!B2:B4`.
    Ext(String, (usize, usize), Option<(usize, usize)>),
    /// Values already read (another table's range).
    Lit(Vec<Vec<CV>>),
    Neg(Box<F>),
    Percent(Box<F>),
    Bin(Op, Box<F>, Box<F>),
    Call(String, Vec<F>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Arith(BinaryOp),
    Cmp(CmpOp),
    Concat,
}

struct Parser<'a> {
    toks: Vec<Tok>,
    i: usize,
    /// Table size: a reference-like name inside it is a cell, outside it a variable (`F1`).
    size: (usize, usize),
    units: &'a UnitRegistry,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }

    fn sym(&self, s: &str) -> bool {
        matches!(self.peek(), Some(Tok::Sym(t)) if *t == s)
    }

    fn eat(&mut self, s: &str) -> bool {
        let hit = self.sym(s);
        if hit {
            self.i += 1;
        }
        hit
    }

    fn expect(&mut self, s: &str) -> Result<()> {
        if !self.eat(s) {
            bail!("expected '{s}' in the formula");
        }
        Ok(())
    }

    fn compare(&mut self) -> Result<F> {
        let mut a = self.concat()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Sym("=")) => CmpOp::Eq,
                Some(Tok::Sym("<>")) => CmpOp::Ne,
                Some(Tok::Sym("<")) => CmpOp::Lt,
                Some(Tok::Sym("<=")) => CmpOp::Le,
                Some(Tok::Sym(">")) => CmpOp::Gt,
                Some(Tok::Sym(">=")) => CmpOp::Ge,
                _ => return Ok(a),
            };
            self.i += 1;
            a = F::Bin(Op::Cmp(op), Box::new(a), Box::new(self.concat()?));
        }
    }

    fn concat(&mut self) -> Result<F> {
        let mut a = self.additive()?;
        while self.eat("&") {
            a = F::Bin(Op::Concat, Box::new(a), Box::new(self.additive()?));
        }
        Ok(a)
    }

    fn additive(&mut self) -> Result<F> {
        let mut a = self.term()?;
        loop {
            let op = if self.eat("+") {
                BinaryOp::Add
            } else if self.eat("-") {
                BinaryOp::Sub
            } else {
                return Ok(a);
            };
            a = F::Bin(Op::Arith(op), Box::new(a), Box::new(self.term()?));
        }
    }

    fn term(&mut self) -> Result<F> {
        let mut a = self.unary()?;
        loop {
            let op = if self.eat("*") {
                BinaryOp::Mul
            } else if self.eat("/") {
                BinaryOp::Div
            } else {
                return Ok(a);
            };
            a = F::Bin(Op::Arith(op), Box::new(a), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> Result<F> {
        if self.eat("-") {
            return Ok(F::Neg(Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return self.unary();
        }
        self.power()
    }

    fn power(&mut self) -> Result<F> {
        let base = self.postfix()?;
        if self.eat("^") {
            let exp = self.unary()?;
            return Ok(F::Bin(Op::Arith(BinaryOp::Pow), Box::new(base), Box::new(exp)));
        }
        Ok(base)
    }

    fn postfix(&mut self) -> Result<F> {
        let mut a = self.primary()?;
        while self.eat("%") {
            a = F::Percent(Box::new(a));
        }
        Ok(a)
    }

    fn cell_ref(&self, name: &str) -> Option<(usize, usize)> {
        parse_ref(name)
    }

    fn primary(&mut self) -> Result<F> {
        let Some(tok) = self.peek().cloned() else { bail!("the formula ends too early") };
        self.i += 1;
        match tok {
            Tok::Num(t) => {
                let v: f64 = t.parse().map_err(|_| EvalError::new(format!("'{t}' is not a valid number")))?;
                // `5 kN`, `9.81 m/s^2`: a number followed by units
                if let Some(Tok::Name(u)) = self.peek().cloned()
                    && !matches!(self.toks.get(self.i + 1), Some(Tok::Sym("(" | "!")))
                    && self.cell_ref(&u).is_none()
                    && self.units.lookup(&u).is_some()
                {
                    self.i += 1;
                    let mut unit = Expr::Ident(u);
                    if self.eat("^") {
                        let Some(Tok::Num(e)) = self.peek().cloned() else {
                            bail!("expected a number after ^")
                        };
                        self.i += 1;
                        unit = Expr::Binary(BinaryOp::Pow, Box::new(unit), Box::new(Expr::Num(e)));
                    }
                    return Ok(F::Quire(Expr::Binary(
                        BinaryOp::Juxt,
                        Box::new(Expr::Num(t)),
                        Box::new(unit),
                    )));
                }
                Ok(F::Num(v))
            }
            Tok::Str(s) => Ok(F::Str(s)),
            Tok::Sym("(") => {
                let e = self.compare()?;
                self.expect(")")?;
                Ok(e)
            }
            Tok::Name(name) => {
                if self.eat("(") {
                    let mut args = Vec::new();
                    if !self.eat(")") {
                        loop {
                            // an empty argument (`IF(A1, , 2)`) counts as blank
                            if self.sym(",") || self.sym(")") {
                                args.push(F::Str(String::new()));
                            } else {
                                args.push(self.compare()?);
                            }
                            if self.eat(")") {
                                break;
                            }
                            self.expect(",")?;
                        }
                    }
                    return Ok(F::Call(name, args));
                }
                if self.eat("!") {
                    let Some(Tok::Name(r)) = self.peek().cloned() else {
                        bail!("expected a cell after {name}!")
                    };
                    self.i += 1;
                    let from = parse_ref(&r).ok_or_else(|| EvalError::new(format!("{r} is not a cell")))?;
                    let to = if self.eat(":") { Some(self.range_end()?) } else { None };
                    return Ok(F::Ext(name, from, to));
                }
                match name.to_ascii_uppercase().as_str() {
                    "TRUE" => return Ok(F::Bool(true)),
                    "FALSE" => return Ok(F::Bool(false)),
                    _ => {}
                }
                if let Some(at) = self.cell_ref(&name) {
                    if self.eat(":") {
                        return Ok(F::Range(at, self.range_end()?));
                    }
                    if at.0 < self.size.0 && at.1 < self.size.1 {
                        return Ok(F::Cell(at.0, at.1));
                    }
                }
                Ok(F::Quire(Expr::Ident(name)))
            }
            Tok::Sym(s) => bail!("unexpected '{s}' in the formula"),
        }
    }

    fn range_end(&mut self) -> Result<(usize, usize)> {
        match self.peek().cloned() {
            Some(Tok::Name(r)) => {
                self.i += 1;
                parse_ref(&r).ok_or_else(|| EvalError::new(format!("{r} is not a cell")))
            }
            _ => bail!("expected a cell after ':'"),
        }
    }
}

fn parse_formula(src: &str, size: (usize, usize), units: &UnitRegistry) -> Result<F> {
    let toks = tokenize(src)?;
    if toks.is_empty() {
        bail!("the formula is empty");
    }
    let mut p = Parser { toks, i: 0, size, units };
    let f = p.compare()?;
    if p.i < p.toks.len() {
        bail!("unexpected text after the formula");
    }
    Ok(f)
}

/// Units written in a formula, for showing its result in them.
fn formula_units(f: &F, out: &mut Vec<String>) {
    match f {
        // `5 kN`: the name after the number is a unit; a lone name is a variable
        F::Quire(Expr::Binary(BinaryOp::Juxt, _, u)) => unit_names(u, out),
        F::Neg(x) | F::Percent(x) => formula_units(x, out),
        F::Bin(_, a, b) => {
            formula_units(a, out);
            formula_units(b, out);
        }
        F::Call(_, args) => args.iter().for_each(|a| formula_units(a, out)),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// A cell's value as formulas see it.
#[derive(Debug, Clone, PartialEq)]
enum CV {
    Blank,
    Bool(bool),
    V(Value),
}

impl CV {
    fn value(&self) -> Value {
        match self {
            CV::Blank => Value::num(0.0),
            CV::Bool(b) => Value::bool(*b),
            CV::V(v) => v.clone(),
        }
    }

    fn truthy(&self) -> Result<bool> {
        match self {
            CV::Blank => Ok(false),
            CV::Bool(b) => Ok(*b),
            CV::V(Value::Str(s)) => match s.to_ascii_uppercase().as_str() {
                "TRUE" => Ok(true),
                "FALSE" | "" => Ok(false),
                _ => bail!("\"{s}\" is not true or false"),
            },
            CV::V(v) => v.truthy(),
        }
    }

    fn text(&self, settings: &DisplaySettings, units: &UnitRegistry) -> String {
        match self {
            CV::Blank => String::new(),
            CV::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            CV::V(Value::Str(s)) => s.clone(),
            CV::V(v) => format_value_in(v, &DisplaySpec::default(), settings, units, &[])
                .unwrap_or_default()
                .replace('\'', "")
                .replace('*', "·"),
        }
    }
}

/// Every unit name in a value (`12 kN`, `9.81 m/s^2`).
fn unit_names(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Unit(n) | Expr::Ident(n) => out.push(n.clone()),
        Expr::Paren(x) | Expr::Unary(_, x) => unit_names(x, out),
        Expr::Binary(_, a, b) => {
            unit_names(a, out);
            unit_names(b, out);
        }
        _ => {}
    }
}

/// A plain cell that reads as a value: `12`, `-1,5`, `1.35`, `12 kN`, `9.81 m/s^2`, `15%`.
fn literal(text: &str, units: &UnitRegistry) -> Option<Expr> {
    let t = text.trim();
    if t.is_empty() || !t.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '-' | '+' | '.')) {
        return None;
    }
    // decimal comma (12,5 kN), as typed where it is the norm
    let t = match t.find(',') {
        Some(i)
            if t[..i].chars().last().is_some_and(|c| c.is_ascii_digit())
                && t[i + 1..].starts_with(|c: char| c.is_ascii_digit())
                && t.matches(',').count() == 1 =>
        {
            format!("{}.{}", &t[..i], &t[i + 1..])
        }
        _ => t.to_string(),
    };
    if let Some(p) = t.strip_suffix('%') {
        let e = parse(p.trim()).ok().filter(plain_number)?;
        return Some(Expr::Binary(BinaryOp::Div, Box::new(e), Box::new(Expr::Num("100".into()))));
    }
    let e = parse(&t).ok()?;
    quantity_literal(&e, units).then_some(e)
}

fn plain_number(e: &Expr) -> bool {
    match e {
        Expr::Num(_) => true,
        Expr::Unary(_, x) => plain_number(x),
        _ => false,
    }
}

fn quantity_literal(e: &Expr, units: &UnitRegistry) -> bool {
    fn unit_part(e: &Expr, units: &UnitRegistry) -> bool {
        match e {
            Expr::Unit(_) => true,
            Expr::Ident(n) => units.lookup(n).is_some(),
            Expr::Paren(x) => unit_part(x, units),
            Expr::Binary(BinaryOp::Mul | BinaryOp::Div | BinaryOp::Juxt, a, b) => {
                unit_part(a, units) && unit_part(b, units)
            }
            Expr::Binary(BinaryOp::Pow, a, b) => unit_part(a, units) && plain_number(b),
            _ => false,
        }
    }
    match e {
        Expr::Num(_) => true,
        Expr::Unary(_, x) => quantity_literal(x, units),
        Expr::Binary(BinaryOp::Juxt | BinaryOp::Mul | BinaryOp::Div, a, b) => {
            quantity_literal(a, units) && unit_part(b, units)
        }
        _ => false,
    }
}

enum Cell {
    Blank,
    Text(String),
    Value(Expr),
    Formula(std::result::Result<F, String>),
}

#[derive(Clone)]
enum State {
    Todo,
    Busy,
    Done(std::result::Result<CV, String>),
}

/// One table being evaluated.
pub(crate) struct Sheet<'a, 'u, 's> {
    cells: Vec<Vec<Cell>>,
    state: Vec<Vec<State>>,
    interp: &'a mut Interp<'u>,
    scope: &'a mut Scope<'s>,
    settings: &'a DisplaySettings,
}

/// Evaluate a table: per-cell outcomes, the matrix it defines and the units it is written in.
pub(crate) fn evaluate(
    t: &TableInput,
    interp: &mut Interp,
    scope: &mut Scope,
    settings: &DisplaySettings,
) -> (Vec<Vec<CellOutcome>>, Value, Vec<String>) {
    let nrows = t.rows.len();
    let ncols = t.rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut written = Vec::new();
    let cells: Vec<Vec<Cell>> = (0..nrows)
        .map(|r| {
            (0..ncols)
                .map(|c| {
                    let raw = t.rows[r].get(c).map(String::as_str).unwrap_or("");
                    let trimmed = raw.trim();
                    if let Some(f) = trimmed.strip_prefix('=') {
                        let parsed = parse_formula(f, (nrows, ncols), interp.units).map_err(|e| e.message);
                        if let Ok(f) = &parsed {
                            formula_units(f, &mut written);
                        }
                        Cell::Formula(parsed)
                    } else if trimmed.is_empty() {
                        Cell::Blank
                    } else if let Some(e) = literal(trimmed, interp.units) {
                        unit_names(&e, &mut written);
                        Cell::Value(e)
                    } else {
                        Cell::Text(raw.to_string())
                    }
                })
                .collect()
        })
        .collect();
    let mut sheet = Sheet { cells, state: vec![vec![State::Todo; ncols]; nrows], interp, scope, settings };
    let mut outcomes = Vec::with_capacity(nrows);
    let mut data = Vec::with_capacity(nrows * ncols);
    let vocab: Vec<WorkingUnit> = {
        let mut seen = BTreeSet::new();
        written
            .iter()
            .filter(|n| seen.insert(n.as_str()))
            .filter_map(|n| {
                let unit = sheet.interp.units.lookup(n)?;
                (unit.offset == 0.0 && !unit.dim.is_dimensionless())
                    .then(|| WorkingUnit { name: n.clone(), unit })
            })
            .collect()
    };
    for r in 0..nrows {
        let mut row = Vec::with_capacity(ncols);
        for c in 0..ncols {
            let formula = matches!(sheet.cells[r][c], Cell::Formula(_));
            let spec = cell_spec(t, c);
            let mut out = CellOutcome { formula, ..Default::default() };
            match sheet.cell(r, c) {
                Ok(v) => {
                    match &v {
                        CV::Blank => data.push(Value::Str(String::new())),
                        CV::Bool(b) => data.push(Value::bool(*b)),
                        CV::V(v) => data.push(v.clone()),
                    }
                    let text_cell = matches!(sheet.cells[r][c], Cell::Text(_) | Cell::Blank);
                    if !text_cell {
                        out.shown = match &v {
                            CV::Blank => None,
                            CV::Bool(b) => Some(if *b { "\"TRUE\"" } else { "\"FALSE\"" }.into()),
                            CV::V(v) => {
                                // a unit set on the column that doesn't fit (a text column, a
                                // count) is ignored rather than turning the cell into an error
                                let shown = format_value_in(v, &spec, settings, sheet.interp.units, &vocab)
                                    .or_else(|_| {
                                        let plain = DisplaySpec { unit: None, ..spec.clone() };
                                        format_value_in(v, &plain, settings, sheet.interp.units, &vocab)
                                    });
                                out.value = Some(v.clone());
                                match shown {
                                    Ok(s) => Some(s),
                                    Err(e) => {
                                        out.error = Some(e.message);
                                        None
                                    }
                                }
                            }
                        };
                    }
                }
                Err(e) => {
                    data.push(Value::Str("#ERROR".into()));
                    out.error = Some(e);
                }
            }
            row.push(out);
        }
        outcomes.push(row);
    }
    let units = written.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    (outcomes, Value::Matrix(Matrix::new(nrows, ncols, data)), units)
}

/// How column `c` is shown: its own unit and decimals, else the table's.
fn cell_spec(t: &TableInput, c: usize) -> DisplaySpec {
    DisplaySpec {
        unit: t.columns.get(c).and_then(|s| s.unit.clone()).or_else(|| t.display.unit.clone()),
        decimals: t.columns.get(c).and_then(|s| s.decimals).or(t.display.decimals),
    }
}

/// Show the numbers again with a fuller list of preferred units (the document's).
pub(crate) fn reformat(
    t: &TableInput,
    cells: &mut [Vec<CellOutcome>],
    settings: &DisplaySettings,
    units: &UnitRegistry,
    vocab: &[WorkingUnit],
) {
    for row in cells.iter_mut() {
        for (c, cell) in row.iter_mut().enumerate() {
            let spec = cell_spec(t, c);
            if spec.unit.is_some() || cell.error.is_some() {
                continue;
            }
            if let Some(v @ Value::Num(_)) = &cell.value
                && let Ok(s) = format_value_in(v, &spec, settings, units, vocab)
            {
                cell.shown = Some(s);
            }
        }
    }
}

/// The worksheet names a table's formulas read (`=M.max`, `=σ/f.y`).
pub(crate) fn reads(t: &TableInput, units: &UnitRegistry) -> Vec<String> {
    fn walk(f: &F, out: &mut Vec<String>) {
        match f {
            F::Quire(Expr::Ident(n)) => out.push(n.clone()),
            F::Ext(n, ..) => out.push(n.clone()),
            F::Neg(x) | F::Percent(x) => walk(x, out),
            F::Bin(_, a, b) => {
                walk(a, out);
                walk(b, out);
            }
            F::Call(_, args) => args.iter().for_each(|a| walk(a, out)),
            _ => {}
        }
    }
    let size = (t.rows.len(), t.rows.iter().map(Vec::len).max().unwrap_or(0));
    let mut out = Vec::new();
    for cell in t.rows.iter().flatten() {
        if let Some(src) = cell.trim().strip_prefix('=')
            && let Ok(f) = parse_formula(src, size, units)
        {
            walk(&f, &mut out);
        }
    }
    out
}

impl Sheet<'_, '_, '_> {
    fn cell(&mut self, r: usize, c: usize) -> std::result::Result<CV, String> {
        if r >= self.cells.len() || c >= self.cells.first().map_or(0, Vec::len) {
            return Ok(CV::Blank);
        }
        match &self.state[r][c] {
            State::Done(v) => return v.clone(),
            State::Busy => return Err(format!("circular reference through {}", cell_label(r, c))),
            State::Todo => {}
        }
        self.state[r][c] = State::Busy;
        let v = match &self.cells[r][c] {
            Cell::Blank => Ok(CV::Blank),
            Cell::Text(t) => Ok(CV::V(Value::Str(t.clone()))),
            Cell::Value(e) => {
                let e = e.clone();
                self.interp.eval(self.scope, &e).map(CV::V).map_err(|e| e.message)
            }
            Cell::Formula(Err(e)) => Err(e.clone()),
            Cell::Formula(Ok(f)) => {
                let f = f.clone();
                self.eval(&f).map_err(|e| e.message)
            }
        };
        self.state[r][c] = State::Done(v.clone());
        v
    }

    /// A referenced cell: its error becomes the reader's, named.
    fn get(&mut self, r: usize, c: usize) -> Result<CV> {
        self.cell(r, c).map_err(|e| {
            if e.starts_with("circular reference") {
                EvalError::new(e)
            } else {
                EvalError::new(format!("{} has an error", cell_label(r, c)))
            }
        })
    }

    fn range(&mut self, a: (usize, usize), b: (usize, usize)) -> Result<Vec<Vec<CV>>> {
        let (r0, r1) = (a.0.min(b.0), a.0.max(b.0));
        let (c0, c1) = (a.1.min(b.1), a.1.max(b.1));
        (r0..=r1).map(|r| (c0..=c1).map(|c| self.get(r, c)).collect()).collect()
    }

    fn external(&mut self, table: &str, a: (usize, usize), b: Option<(usize, usize)>) -> Result<F> {
        let m = match self.scope.get(table) {
            Some(Binding::Val(Value::Matrix(m))) => m.clone(),
            Some(Binding::Val(_)) => bail!("{table} is not a table"),
            Some(Binding::Failed(_)) => bail!("{table} has an error"),
            _ => bail!("there is no table named {table} above this one"),
        };
        let at = |r: usize, c: usize| -> CV {
            if r >= m.rows || c >= m.cols {
                return CV::Blank;
            }
            match m.get(r, c) {
                Value::Str(s) if s.is_empty() => CV::Blank,
                Value::Str(s) if s == "#ERROR" => CV::V(Value::Str(s.clone())),
                v => CV::V(v.clone()),
            }
        };
        let b = b.unwrap_or(a);
        let (r0, r1) = (a.0.min(b.0), a.0.max(b.0));
        let (c0, c1) = (a.1.min(b.1), a.1.max(b.1));
        let rows: Vec<Vec<CV>> = (r0..=r1).map(|r| (c0..=c1).map(|c| at(r, c)).collect()).collect();
        Ok(F::Lit(rows))
    }

    fn eval(&mut self, f: &F) -> Result<CV> {
        match self.eval_any(f)? {
            Got::One(v) => Ok(v),
            Got::Many(rows) => {
                if rows.len() == 1 && rows[0].len() == 1 {
                    return Ok(rows[0][0].clone());
                }
                bail!("a cell holds one value; use SUM, MAX, … to combine a range")
            }
        }
    }

    fn eval_any(&mut self, f: &F) -> Result<Got> {
        Ok(match f {
            F::Num(x) => Got::One(CV::V(Value::num(*x))),
            F::Str(s) if s.is_empty() => Got::One(CV::Blank),
            F::Str(s) => Got::One(CV::V(Value::Str(s.clone()))),
            F::Bool(b) => Got::One(CV::Bool(*b)),
            F::Quire(e) => Got::One(CV::V(self.interp.eval(self.scope, e)?)),
            F::Cell(r, c) => Got::One(self.get(*r, *c)?),
            F::Range(a, b) => Got::Many(self.range(*a, *b)?),
            F::Ext(t, a, b) => {
                let read = self.external(t, *a, *b)?;
                return self.eval_any(&read);
            }
            F::Lit(rows) => Got::Many(rows.clone()),
            F::Neg(x) => Got::One(match self.eval(x)? {
                CV::Blank => CV::Blank,
                v => CV::V(negate(&v.value())?),
            }),
            F::Percent(x) => {
                let v = self.eval(x)?.value();
                Got::One(CV::V(arith(BinaryOp::Div, &v, &Value::num(100.0))?))
            }
            F::Bin(op, a, b) => {
                let x = self.eval(a)?;
                let y = self.eval(b)?;
                Got::One(self.binary(*op, x, y)?)
            }
            F::Call(name, args) => Got::One(self.call(name, args)?),
        })
    }

    fn binary(&mut self, op: Op, x: CV, y: CV) -> Result<CV> {
        match op {
            Op::Concat => Ok(CV::V(Value::Str(
                x.text(self.settings, self.interp.units) + &y.text(self.settings, self.interp.units),
            ))),
            Op::Cmp(op) => Ok(CV::Bool(cmp(op, &x, &y)?)),
            Op::Arith(op) => {
                // a blank cell is nothing to add, and zero otherwise (with the other side's units)
                match (op, &x, &y) {
                    (BinaryOp::Add, CV::Blank, v) | (BinaryOp::Add | BinaryOp::Sub, v, CV::Blank) => {
                        return Ok(v.clone());
                    }
                    (BinaryOp::Sub, CV::Blank, v) => return Ok(CV::V(negate(&v.value())?)),
                    _ => {}
                }
                for v in [&x, &y] {
                    if let CV::V(Value::Str(s)) = v {
                        bail!("\"{s}\" is text, not a number");
                    }
                }
                Ok(CV::V(arith(op, &x.value(), &y.value())?))
            }
        }
    }
}

enum Got {
    One(CV),
    Many(Vec<Vec<CV>>),
}

fn cmp(op: CmpOp, x: &CV, y: &CV) -> Result<bool> {
    let as_text = |v: &CV| match v {
        CV::V(Value::Str(s)) => Some(s.to_lowercase()),
        CV::Blank => Some(String::new()),
        _ => None,
    };
    // text compares without regard to case; a blank equals "" and 0
    if let (Some(a), Some(b)) = (as_text(x), as_text(y))
        && (matches!(x, CV::V(Value::Str(_))) || matches!(y, CV::V(Value::Str(_))))
    {
        return Ok(match op {
            CmpOp::Eq => a == b,
            CmpOp::Ne => a != b,
            CmpOp::Lt => a < b,
            CmpOp::Le => a <= b,
            CmpOp::Gt => a > b,
            CmpOp::Ge => a >= b,
        });
    }
    let num = |v: &CV| -> Result<Value> {
        match v {
            CV::V(Value::Str(s)) => bail!("cannot compare the text \"{s}\" with a number"),
            CV::Blank => Ok(Value::num(0.0)),
            other => Ok(other.value()),
        }
    };
    let (a, b) = (num(x)?, num(y)?);
    // a blank is zero in whatever units the other side has
    let zero_like = |z: &CV, other: &Value| match (z, other) {
        (CV::Blank, Value::Num(q)) => Value::Num(Quantity::new(0.0, q.dim)),
        _ => num(z).unwrap_or(Value::num(0.0)),
    };
    let a = if matches!(x, CV::Blank) { zero_like(x, &b) } else { a };
    let b = if matches!(y, CV::Blank) { zero_like(y, &a) } else { b };
    compare(op, &a, &b)
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

fn count_error(name: &str, want: &str) -> EvalError {
    EvalError::new(format!("{name} takes {want}"))
}

impl Sheet<'_, '_, '_> {
    /// An argument as rows of values (a single value is a 1×1 range; matrices spread out).
    fn rows(&mut self, f: &F) -> Result<Vec<Vec<CV>>> {
        Ok(match self.eval_any(f)? {
            Got::Many(rows) => rows,
            Got::One(CV::V(Value::Matrix(m))) => {
                (0..m.rows).map(|r| (0..m.cols).map(|c| CV::V(m.get(r, c).clone())).collect()).collect()
            }
            Got::One(v) => vec![vec![v]],
        })
    }

    /// Every value of the arguments, flattened; `true` marks values from ranges.
    fn spread(&mut self, args: &[F]) -> Result<Vec<(CV, bool)>> {
        let mut out = Vec::new();
        for a in args {
            // values reached through references are skipped when they are text, as
            // spreadsheets do; only what is typed into the call itself must be a number
            let ranged = matches!(a, F::Range(..) | F::Ext(..) | F::Lit(_) | F::Cell(..) | F::Quire(_));
            for row in self.rows(a)? {
                for v in row {
                    out.push((v, ranged));
                }
            }
        }
        Ok(out)
    }

    /// The numbers among the arguments, as spreadsheets count them: text and blanks in
    /// ranges are skipped, true/false typed directly count as 1/0.
    fn numbers(&mut self, name: &str, args: &[F]) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        for (v, ranged) in self.spread(args)? {
            match v {
                CV::Blank => {}
                CV::Bool(b) if !ranged => out.push(Value::bool(b)),
                CV::Bool(_) => {}
                CV::V(Value::Str(s)) if ranged || s.is_empty() => {}
                CV::V(Value::Str(s)) => bail!("{name}: \"{s}\" is text, not a number"),
                CV::V(Value::Matrix(_)) => bail!("{name}: nested matrices are not supported"),
                CV::V(v) => out.push(v),
            }
        }
        Ok(out)
    }

    fn one(&mut self, name: &str, args: &[F], k: usize) -> Result<Quantity> {
        self.eval(&args[k])?.value().as_num(&format!("the argument of {name}"))
    }

    fn scalar(&mut self, name: &str, args: &[F], k: usize) -> Result<f64> {
        self.eval(&args[k])?.value().as_scalar(&format!("the argument of {name}"))
    }

    fn call(&mut self, name: &str, args: &[F]) -> Result<CV> {
        let up = name.to_ascii_uppercase();
        let n = args.len();
        let arity = |lo: usize, hi: usize, want: &str| -> Result<()> {
            if n < lo || n > hi { Err(count_error(&up, want)) } else { Ok(()) }
        };
        let num = |x: f64| Ok(CV::V(Value::num(x)));
        let with_dim = |x: f64, q: Quantity| Ok(CV::V(Value::Num(Quantity::new(x, q.dim))));
        match up.as_str() {
            // logic
            "IF" => {
                arity(2, 3, "a condition and one or two values")?;
                return if self.eval(&args[0])?.truthy()? {
                    self.eval(&args[1])
                } else if n == 3 {
                    self.eval(&args[2])
                } else {
                    Ok(CV::Bool(false))
                };
            }
            "IFS" => {
                if n == 0 || n % 2 == 1 {
                    return Err(count_error(&up, "pairs of a condition and a value"));
                }
                for pair in args.chunks(2) {
                    if self.eval(&pair[0])?.truthy()? {
                        return self.eval(&pair[1]);
                    }
                }
                bail!("IFS: no condition holds");
            }
            "IFERROR" => {
                arity(2, 2, "a value and what to show on an error")?;
                return self.eval(&args[0]).or_else(|_| self.eval(&args[1]));
            }
            "AND" | "OR" | "XOR" => {
                let mut vals = Vec::new();
                for (v, _) in self.spread(args)? {
                    if !matches!(v, CV::Blank) {
                        vals.push(v.truthy()?);
                    }
                }
                let hits = vals.iter().filter(|b| **b).count();
                return Ok(CV::Bool(match up.as_str() {
                    "AND" => hits == vals.len(),
                    "OR" => hits > 0,
                    _ => hits % 2 == 1,
                }));
            }
            "NOT" => {
                arity(1, 1, "one value")?;
                return Ok(CV::Bool(!self.eval(&args[0])?.truthy()?));
            }
            "TRUE" | "FALSE" if n == 0 => return Ok(CV::Bool(up == "TRUE")),
            "CHOOSE" => {
                if n < 2 {
                    return Err(count_error(&up, "an index and the values to choose from"));
                }
                let i = self.eval(&args[0])?.value().as_int("the index of CHOOSE")?;
                if i < 1 || i as usize >= n {
                    bail!("CHOOSE: the index {i} is not between 1 and {}", n - 1);
                }
                return self.eval(&args[i as usize]);
            }
            // aggregates
            "SUM" | "PRODUCT" | "AVERAGE" | "MIN" | "MAX" | "MEDIAN" => {
                let vals = self.numbers(&up, args)?;
                return aggregate(&up, vals).map(CV::V);
            }
            "COUNT" => return num(self.numbers(&up, args).map(|v| v.len())? as f64),
            "COUNTA" => {
                return num(self.spread(args)?.iter().filter(|(v, _)| !matches!(v, CV::Blank)).count() as f64);
            }
            "COUNTBLANK" => {
                return num(self.spread(args)?.iter().filter(|(v, _)| matches!(v, CV::Blank)).count() as f64);
            }
            "SUMPRODUCT" => {
                if n == 0 {
                    return Err(count_error(&up, "one or more ranges of the same size"));
                }
                let ranges = args.iter().map(|a| self.rows(a)).collect::<Result<Vec<_>>>()?;
                let shape = |r: &Vec<Vec<CV>>| (r.len(), r.first().map_or(0, Vec::len));
                if ranges.iter().any(|r| shape(r) != shape(&ranges[0])) {
                    bail!("SUMPRODUCT: the ranges must have the same size");
                }
                let mut total: Option<Value> = None;
                let (h, w) = shape(&ranges[0]);
                for r in 0..h {
                    for c in 0..w {
                        let mut p = Value::num(1.0);
                        for range in &ranges {
                            p = arith(BinaryOp::Mul, &p, &range[r][c].value())?;
                        }
                        total = Some(match total {
                            None => p,
                            Some(t) => arith(BinaryOp::Add, &t, &p)?,
                        });
                    }
                }
                return Ok(CV::V(total.unwrap_or(Value::num(0.0))));
            }
            "SUMIF" | "COUNTIF" | "AVERAGEIF" => {
                let (lo, hi) = if up == "COUNTIF" { (2, 2) } else { (2, 3) };
                arity(lo, hi, "a range, a criterion and optionally the range to add up")?;
                let test: Vec<CV> = self.rows(&args[0])?.into_iter().flatten().collect();
                let crit = self.eval(&args[1])?;
                let values: Vec<CV> =
                    if n == 3 { self.rows(&args[2])?.into_iter().flatten().collect() } else { test.clone() };
                let mut picked = Vec::new();
                for (i, v) in test.iter().enumerate() {
                    if criterion(&crit, v, self.interp, self.scope)? {
                        picked.push(values.get(i).cloned().unwrap_or(CV::Blank));
                    }
                }
                if up == "COUNTIF" {
                    return num(picked.len() as f64);
                }
                let vals: Vec<Value> = picked
                    .into_iter()
                    .filter_map(|v| match v {
                        CV::V(Value::Num(q)) => Some(Value::Num(q)),
                        _ => None,
                    })
                    .collect();
                return aggregate(if up == "SUMIF" { "SUM" } else { "AVERAGE" }, vals).map(CV::V);
            }
            // numbers
            "ROUND" | "ROUNDUP" | "ROUNDDOWN" => {
                arity(1, 2, "a number and the decimals to keep")?;
                let q = self.one(&up, args, 0)?;
                let d = if n == 2 { self.scalar(&up, args, 1)? as i32 } else { 0 };
                let f = 10f64.powi(d);
                let x = q.v * f;
                let r = match up.as_str() {
                    "ROUND" => x.round(),
                    "ROUNDUP" => x.abs().ceil() * x.signum(),
                    _ => x.trunc(),
                };
                return with_dim(r / f, q);
            }
            "INT" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return with_dim(q.v.floor(), q);
            }
            "TRUNC" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return with_dim(q.v.trunc(), q);
            }
            "CEILING" | "FLOOR" => {
                arity(1, 2, "a number and the step to round to")?;
                let q = self.one(&up, args, 0)?;
                let step = if n == 2 { self.one(&up, args, 1)? } else { Quantity::new(1.0, q.dim) };
                if step.dim != q.dim {
                    bail!("{up}: the step must be in the same kind of unit as the number");
                }
                if step.v == 0.0 {
                    return with_dim(0.0, q);
                }
                let k = q.v / step.v;
                // nudge away floating-point noise so 0.3/0.1 rounds to 3, not 4
                let k = if (k - k.round()).abs() < 1e-9 { k.round() } else { k };
                let k = if up == "CEILING" { k.ceil() } else { k.floor() };
                return with_dim(k * step.v, q);
            }
            "MOD" => {
                arity(2, 2, "a number and a divisor")?;
                let a = self.one(&up, args, 0)?;
                let b = self.one(&up, args, 1)?;
                if a.dim != b.dim && !b.dim.is_dimensionless() {
                    bail!("MOD: the divisor must be in the same kind of unit");
                }
                if b.v == 0.0 {
                    bail!("MOD: division by zero");
                }
                return with_dim(a.v - b.v * (a.v / b.v).floor(), a);
            }
            "POWER" => {
                arity(2, 2, "a number and an exponent")?;
                let a = self.eval(&args[0])?.value();
                let b = self.eval(&args[1])?.value();
                return arith(BinaryOp::Pow, &a, &b).map(CV::V);
            }
            "PI" if n == 0 => return num(std::f64::consts::PI),
            "RADIANS" => {
                arity(1, 1, "an angle in degrees")?;
                return num(self.scalar(&up, args, 0)?.to_radians());
            }
            "DEGREES" => {
                arity(1, 1, "an angle in radians")?;
                return num(self.scalar(&up, args, 0)?.to_degrees());
            }
            "LOG" if n == 2 => {
                let x = self.scalar(&up, args, 0)?;
                let b = self.scalar(&up, args, 1)?;
                return num(x.ln() / b.ln());
            }
            "LOG" if n == 1 => return num(self.scalar(&up, args, 0)?.log10()),
            "SIGN" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return num(if q.v == 0.0 { 0.0 } else { q.v.signum() });
            }
            // text
            "CONCAT" | "CONCATENATE" => {
                let mut s = String::new();
                for (v, _) in self.spread(args)? {
                    s += &v.text(self.settings, self.interp.units);
                }
                return Ok(CV::V(Value::Str(s)));
            }
            "LEN" | "UPPER" | "LOWER" | "TRIM" => {
                arity(1, 1, "one text")?;
                let t = self.eval(&args[0])?.text(self.settings, self.interp.units);
                return match up.as_str() {
                    "LEN" => num(t.chars().count() as f64),
                    "UPPER" => Ok(CV::V(Value::Str(t.to_uppercase()))),
                    "LOWER" => Ok(CV::V(Value::Str(t.to_lowercase()))),
                    _ => Ok(CV::V(Value::Str(t.split_whitespace().collect::<Vec<_>>().join(" ")))),
                };
            }
            "LEFT" | "RIGHT" => {
                arity(1, 2, "a text and how many characters")?;
                let t: Vec<char> =
                    self.eval(&args[0])?.text(self.settings, self.interp.units).chars().collect();
                let k = if n == 2 { self.scalar(&up, args, 1)?.max(0.0) as usize } else { 1 }.min(t.len());
                let part = if up == "LEFT" { &t[..k] } else { &t[t.len() - k..] };
                return Ok(CV::V(Value::Str(part.iter().collect())));
            }
            // lookup
            "VLOOKUP" | "HLOOKUP" => {
                arity(
                    3,
                    4,
                    "a value, a range, a column (row) number and optionally FALSE for an exact match",
                )?;
                let key = self.eval(&args[0])?;
                let mut table = self.rows(&args[1])?;
                if up == "HLOOKUP" {
                    table = transpose(table);
                }
                let k = self.eval(&args[2])?.value().as_int("the column number")?;
                let exact = n == 4 && !self.eval(&args[3])?.truthy()?;
                let width = table.first().map_or(0, Vec::len);
                if k < 1 || k as usize > width {
                    bail!("{up}: {k} is outside the range, which has {width}");
                }
                let keys: Vec<CV> = table.iter().map(|r| r[0].clone()).collect();
                let at = lookup(&keys, &key, if exact { 0 } else { 1 })?.ok_or_else(|| {
                    EvalError::new(format!(
                        "{up}: {} is not in the table",
                        key.text(self.settings, self.interp.units)
                    ))
                })?;
                return Ok(table[at][k as usize - 1].clone());
            }
            "MATCH" => {
                arity(2, 3, "a value, a row or column and optionally the match type")?;
                let key = self.eval(&args[0])?;
                let list: Vec<CV> = self.rows(&args[1])?.into_iter().flatten().collect();
                let kind = if n == 3 { self.scalar(&up, args, 2)? as i32 } else { 1 };
                let at = lookup(&list, &key, kind)?.ok_or_else(|| {
                    EvalError::new(format!(
                        "MATCH: {} is not found",
                        key.text(self.settings, self.interp.units)
                    ))
                })?;
                return num((at + 1) as f64);
            }
            "INDEX" => {
                arity(2, 3, "a range, a row and optionally a column")?;
                let table = self.rows(&args[0])?;
                let i = self.eval(&args[1])?.value().as_int("the row")?;
                let j = if n == 3 { Some(self.eval(&args[2])?.value().as_int("the column")?) } else { None };
                let (h, w) = (table.len(), table.first().map_or(0, Vec::len));
                // INDEX(row or column, k) picks along it
                let (r, c) = match j {
                    Some(j) => (i, j),
                    None if h == 1 => (1, i),
                    None => (i, 1),
                };
                if r < 1 || c < 1 || r as usize > h || c as usize > w {
                    bail!("INDEX: ({r}, {c}) is outside the range ({h} × {w})");
                }
                return Ok(table[r as usize - 1][c as usize - 1].clone());
            }
            _ => {}
        }
        self.through_worksheet(name, args)
    }

    /// Anything else: your functions (`f(x) := …`) and Quire's (`sqrt`, `linterp`, …),
    /// with spreadsheet names (`SQRT`, `ABS`, `EXP`, `LN`) mapped to Quire's.
    fn through_worksheet(&mut self, name: &str, args: &[F]) -> Result<CV> {
        let mut vals = Vec::with_capacity(args.len());
        for a in args {
            let v = match self.eval_any(a)? {
                Got::One(v) => v.value(),
                Got::Many(rows) => {
                    let (h, w) = (rows.len(), rows.first().map_or(0, Vec::len));
                    Value::Matrix(Matrix::new(h, w, rows.into_iter().flatten().map(|v| v.value()).collect()))
                }
            };
            vals.push(v);
        }
        let names: Vec<String> = (0..vals.len()).map(|i| format!("__arg{i}")).collect();
        let saved: Vec<_> = names.iter().zip(vals).map(|(n, v)| (n.clone(), self.scope.bind(n, v))).collect();
        let call =
            |f: &str| Expr::Call(f.to_string(), names.iter().map(|n| Expr::Ident(n.clone())).collect());
        let mut r = self.interp.eval(self.scope, &call(name));
        let lower = name.to_lowercase();
        if let Err(e) = &r
            && e.message.ends_with("is not a known function")
            && lower != name
        {
            r = self.interp.eval(self.scope, &call(&lower)).map_err(|e| {
                if e.message.ends_with("is not a known function") {
                    EvalError::new(format!("{name} is not a known function"))
                } else {
                    e
                }
            });
        }
        for (n, prev) in saved.into_iter().rev() {
            self.scope.restore(&n, prev);
        }
        r.map(CV::V)
    }
}

fn transpose(rows: Vec<Vec<CV>>) -> Vec<Vec<CV>> {
    let w = rows.first().map_or(0, Vec::len);
    (0..w).map(|c| rows.iter().map(|r| r[c].clone()).collect()).collect()
}

fn aggregate(name: &str, vals: Vec<Value>) -> Result<Value> {
    if vals.is_empty() {
        return match name {
            "SUM" => Ok(Value::num(0.0)),
            "PRODUCT" => Ok(Value::num(1.0)),
            _ => bail!("{name}: there are no numbers"),
        };
    }
    let fold = |op: BinaryOp| -> Result<Value> {
        let mut it = vals.iter();
        let mut acc = it.next().cloned().unwrap_or(Value::num(0.0));
        for v in it {
            acc = arith(op, &acc, v)?;
        }
        Ok(acc)
    };
    match name {
        "SUM" => fold(BinaryOp::Add),
        "PRODUCT" => fold(BinaryOp::Mul),
        "AVERAGE" => arith(BinaryOp::Div, &fold(BinaryOp::Add)?, &Value::num(vals.len() as f64)),
        "MIN" | "MAX" => {
            let mut best = vals[0].clone();
            for v in &vals[1..] {
                let better = compare(if name == "MIN" { CmpOp::Lt } else { CmpOp::Gt }, v, &best)?;
                if better {
                    best = v.clone();
                }
            }
            Ok(best)
        }
        _ => {
            // MEDIAN
            let mut sorted = vals.clone();
            for v in &sorted[1..] {
                compare(CmpOp::Lt, v, &sorted[0])?;
            }
            sorted.sort_by(|a, b| {
                let (Value::Num(x), Value::Num(y)) = (a, b) else { return std::cmp::Ordering::Equal };
                x.v.total_cmp(&y.v)
            });
            let k = sorted.len();
            if k % 2 == 1 {
                Ok(sorted[k / 2].clone())
            } else {
                arith(
                    BinaryOp::Div,
                    &arith(BinaryOp::Add, &sorted[k / 2 - 1], &sorted[k / 2])?,
                    &Value::num(2.0),
                )
            }
        }
    }
}

/// Position of `key` in `list`: kind 0 exact, 1 the last one ≤ key (sorted ascending),
/// -1 the last one ≥ key (sorted descending).
fn lookup(list: &[CV], key: &CV, kind: i32) -> Result<Option<usize>> {
    if kind == 0 {
        for (i, v) in list.iter().enumerate() {
            if !matches!(v, CV::Blank) && cmp(CmpOp::Eq, v, key).unwrap_or(false) {
                return Ok(Some(i));
            }
        }
        return Ok(None);
    }
    let mut found = None;
    for (i, v) in list.iter().enumerate() {
        if matches!(v, CV::Blank) {
            continue;
        }
        let ok = cmp(if kind > 0 { CmpOp::Le } else { CmpOp::Ge }, v, key)?;
        if ok {
            found = Some(i);
        } else {
            break;
        }
    }
    Ok(found)
}

/// SUMIF/COUNTIF criteria: a value (`5`, `"Steel"`) or text with a comparison (`">10"`,
/// `"<>0"`, `">=12 kN"`).
fn criterion(crit: &CV, v: &CV, interp: &mut Interp, scope: &mut Scope) -> Result<bool> {
    let CV::V(Value::Str(s)) = crit else { return Ok(cmp(CmpOp::Eq, v, crit).unwrap_or(false)) };
    let (op, rest) = [
        ("<=", CmpOp::Le),
        (">=", CmpOp::Ge),
        ("<>", CmpOp::Ne),
        ("<", CmpOp::Lt),
        (">", CmpOp::Gt),
        ("=", CmpOp::Eq),
    ]
    .iter()
    .find_map(|(p, op)| s.strip_prefix(p).map(|r| (*op, r.trim())))
    .unwrap_or((CmpOp::Eq, s.trim()));
    let target = match literal(rest, interp.units) {
        Some(e) => CV::V(interp.eval(scope, &e)?),
        None if rest.is_empty() => CV::Blank,
        None => CV::V(Value::Str(rest.to_string())),
    };
    if matches!(v, CV::Blank) && !matches!(target, CV::Blank) && op != CmpOp::Ne {
        return Ok(false);
    }
    Ok(cmp(op, v, &target).unwrap_or(op == CmpOp::Ne))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interp::Env;

    fn table(rows: &[&[&str]]) -> Vec<Vec<CellOutcome>> {
        let units = UnitRegistry::new();
        let env = Env::new();
        let mut interp = Interp::new(&units);
        let mut scope = Scope::new(&env);
        let t = TableInput {
            rows: rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect(),
            ..Default::default()
        };
        let settings = DisplaySettings { working_units: true, ..Default::default() };
        evaluate(&t, &mut interp, &mut scope, &settings).0
    }

    fn shown(rows: &[&[&str]]) -> Vec<Vec<String>> {
        table(rows)
            .into_iter()
            .map(|r| {
                r.into_iter()
                    .map(|c| c.error.map(|e| format!("!{e}")).or(c.shown).unwrap_or_default())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn references() {
        assert_eq!(parse_ref("A1"), Some((0, 0)));
        assert_eq!(parse_ref("$B$12"), Some((11, 1)));
        assert_eq!(parse_ref("AA3"), Some((2, 26)));
        assert_eq!(parse_ref("A0"), None);
        assert_eq!(parse_ref("a1"), None);
        assert_eq!(parse_ref("ABCD1"), None);
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
    }

    #[test]
    fn values_and_formulas() {
        let r = shown(&[
            &["Load", "Value", "Factor", "Design"],
            &["Dead", "12 kN", "1.35", "=B2*C2"],
            &["Live", "8 kN", "1,5", "=B3*C3"],
            &["Total", "=SUM(B2:B3)", "", "=sum(D2:D3)"],
            &["Check", "=IF(D4<=40 kN, \"OK\", \"FAIL\")", "=D4>B4", "=ROUND(C2*10%, 3)"],
        ]);
        assert_eq!(r[0], ["", "", "", ""], "text cells show their text, not a value");
        assert_eq!(r[1], ["", "12 'kN", "1.35", "16.2 'kN"]);
        assert_eq!(r[2][2], "1.5");
        assert_eq!(r[3][1], "20 'kN");
        assert_eq!(r[3][3], "28.2 'kN");
        assert_eq!(r[4][1], "\"OK\"");
        assert_eq!(r[4][2], "\"TRUE\"");
        assert_eq!(r[4][3], "0.135");
    }

    #[test]
    fn spreadsheet_functions() {
        let r = shown(&[
            &["1", "2", "3", "=AVERAGE(A1:C1)", "=MAX(A1:C1; 10)", "=COUNT(A1:C2)"],
            &["x", "", "4", "=COUNTA(A2:C2)", "=SUMIF(A1:C1, \">1\")", "=COUNTIF(A1:C2, \"x\")"],
            &[
                "=VLOOKUP(2, A1:C1, 1, FALSE)",
                "=INDEX(A1:C1, 3)",
                "=MATCH(3, A1:C1, 0)",
                "=AND(A1, C2>3)",
                "=IFERROR(1/0, \"n/a\")",
                "=\"a\" & 1+1",
            ],
            &[
                "=SUMPRODUCT(A1:C1, A1:C1)",
                "=MEDIAN(A1:C1, 7)",
                "=CEILING(2.1, 0.5)",
                "=MOD(7, 3)",
                "=SQRT(16)",
                "=CHOOSE(2, \"a\", \"b\")",
            ],
        ]);
        assert_eq!(r[0][3..], ["2", "10", "4"]);
        assert_eq!(r[1][3..], ["2", "5", "1"]);
        assert_eq!(r[2][0], "!VLOOKUP: 2 is not in the table");
        assert_eq!(r[2][1..], ["3", "3", "\"TRUE\"", "\"n/a\"", "\"a2\""]);
        assert_eq!(r[3], ["14", "2.5", "2.5", "1", "4", "\"b\""]);
    }

    #[test]
    fn errors() {
        let r = shown(&[&["=A1+1", "=B1", "=A2+1"], &["=SUM(", "=1+\"x\"", "=nosuch(1)"]]);
        assert_eq!(r[0][0], "!circular reference through A1");
        assert_eq!(r[0][2], "!A2 has an error");
        assert!(r[1][0].starts_with('!'));
        assert_eq!(r[1][1], "!\"x\" is text, not a number");
        assert_eq!(r[1][2], "!nosuch is not a known function");
    }
}
