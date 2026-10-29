//! Formula syntax: tokens, the parser and the formula tree it builds.

use super::*;

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
        let Some(&c) = chars.get(i) else { break };
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            while chars.get(i).is_some_and(|ch| ch.is_ascii_digit() || *ch == '.') {
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
            out.push(Tok::Num(chars.get(start..i).unwrap_or(&[]).iter().collect()));
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' || c == '°' {
            let start = i;
            while i < chars.len() {
                let Some(&d) = chars.get(i) else { break };
                if d.is_alphanumeric() || d == '_' || d == '$' || d == '°' {
                    i += 1;
                } else if d == '.' && chars.get(i + 1).is_some_and(|n| n.is_alphanumeric() || *n == '_') {
                    i += 2; // literal subscript: M.max
                } else {
                    break;
                }
            }
            out.push(Tok::Name(chars.get(start..i).unwrap_or(&[]).iter().collect()));
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
        let sub =
            |s: &str| chars.get(i..).unwrap_or(&[]).iter().take(s.chars().count()).copied().eq(s.chars());
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
pub(super) enum F {
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
pub(super) enum Op {
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

pub(super) fn parse_formula(src: &str, size: (usize, usize), units: &UnitRegistry) -> Result<F> {
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
pub(super) fn formula_units(f: &F, out: &mut Vec<String>) {
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
