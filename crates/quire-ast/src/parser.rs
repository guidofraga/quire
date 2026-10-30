//! Recursive-descent parser. Precedence, loosest first:
//!
//! `:=`/`≡` (right) · `or` · `and` · `not` · comparison chains · `..` · `+ - ±` ·
//! `* / %` · unary `- + ±` · `^` (right) · postfix `!` `[…]` · primary.
//!
//! A number directly followed by a unit (`25.5 'm^2`) is a single primary, so it
//! binds tighter than any operator; so is a name or parentheses followed by a quoted
//! unit (`T '°C`, `(-20) '°C`).

use std::fmt;

use crate::ast::{BinaryOp, CmpOp, Expr, UnaryOp};
use crate::lexer::{Tok, Token, tokenize};

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub message: String,
    /// Character offset into the source.
    pub pos: usize,
}

impl ParseError {
    pub(crate) fn new(message: impl Into<String>, pos: usize) -> Self {
        ParseError { message: message.into(), pos }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (at character {})", self.message, self.pos + 1)
    }
}

impl std::error::Error for ParseError {}

type Result<T> = std::result::Result<T, ParseError>;

pub fn parse(src: &str) -> Result<Expr> {
    let mut p = Parser { tokens: tokenize(src)?, i: 0 };
    let e = p.define()?;
    match p.peek() {
        Tok::Eof => Ok(e),
        t => Err(p.error(format!("unexpected {}", describe(t)))),
    }
}

fn describe(t: &Tok) -> String {
    match t {
        Tok::Num(n) => format!("number {n}"),
        Tok::Ident(n) => format!("name {n}"),
        Tok::Unit(u) => format!("unit '{u}"),
        Tok::Str(_) => "string".to_string(),
        Tok::Sym(s) => format!("'{s}'"),
        Tok::Eof => "end of expression".to_string(),
    }
}

fn bin(op: BinaryOp, a: Expr, b: Expr) -> Expr {
    Expr::Binary(op, Box::new(a), Box::new(b))
}

/// Returned when the token list is exhausted. `tokenize` always ends with `Eof`,
/// so this is only a fallback that keeps the accessors total.
static EOF_TOK: Tok = Tok::Eof;

struct Parser {
    tokens: Vec<Token>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        self.tokens.get(self.i).map_or(&EOF_TOK, |t| &t.tok)
    }

    fn peek2(&self) -> &Tok {
        self.tokens.get(self.i + 1).or_else(|| self.tokens.last()).map_or(&EOF_TOK, |t| &t.tok)
    }

    /// Character offset of the current token.
    fn pos(&self) -> usize {
        self.tokens.get(self.i).map_or(0, |t| t.pos)
    }

    fn bump(&mut self) -> Tok {
        let t = self.peek().clone();
        if self.i + 1 < self.tokens.len() {
            self.i += 1;
        }
        t
    }

    fn eat(&mut self, sym: &str) -> bool {
        if matches!(self.peek(), Tok::Sym(s) if *s == sym) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, sym: &str) -> Result<()> {
        if self.eat(sym) {
            Ok(())
        } else {
            Err(self.error(format!("expected '{sym}' but found {}", describe(self.peek()))))
        }
    }

    fn error(&self, message: String) -> ParseError {
        ParseError::new(message, self.pos())
    }

    fn define(&mut self) -> Result<Expr> {
        let lhs = self.or()?;
        let global = if self.eat(":=") {
            false
        } else if self.eat("≡") {
            true
        } else {
            return Ok(lhs);
        };
        let rhs = self.define()?;
        Ok(Expr::Define { lhs: Box::new(lhs), rhs: Box::new(rhs), global })
    }

    fn or(&mut self) -> Result<Expr> {
        let mut e = self.and()?;
        while self.eat("or") {
            e = bin(BinaryOp::Or, e, self.and()?);
        }
        Ok(e)
    }

    fn and(&mut self) -> Result<Expr> {
        let mut e = self.not()?;
        while self.eat("and") {
            e = bin(BinaryOp::And, e, self.not()?);
        }
        Ok(e)
    }

    fn not(&mut self) -> Result<Expr> {
        if self.eat("not") { Ok(Expr::Unary(UnaryOp::Not, Box::new(self.not()?))) } else { self.compare() }
    }

    fn compare(&mut self) -> Result<Expr> {
        let first = self.range()?;
        let mut rest = Vec::new();
        loop {
            let op = match self.peek() {
                Tok::Sym("==") => CmpOp::Eq,
                Tok::Sym("≠") => CmpOp::Ne,
                Tok::Sym("<") => CmpOp::Lt,
                Tok::Sym("≤") => CmpOp::Le,
                Tok::Sym(">") => CmpOp::Gt,
                Tok::Sym("≥") => CmpOp::Ge,
                _ => break,
            };
            self.bump();
            rest.push((op, self.range()?));
        }
        Ok(if rest.is_empty() { first } else { Expr::Compare(Box::new(first), rest) })
    }

    fn range(&mut self) -> Result<Expr> {
        let a = self.additive()?;
        if self.eat("..") {
            let b = self.additive()?;
            return Ok(Expr::Range(Box::new(a), Box::new(b)));
        }
        Ok(a)
    }

    fn additive(&mut self) -> Result<Expr> {
        let mut e = self.term()?;
        loop {
            let op = match self.peek() {
                Tok::Sym("+") => BinaryOp::Add,
                Tok::Sym("-") => BinaryOp::Sub,
                Tok::Sym("±") => BinaryOp::PlusMinus,
                _ => return Ok(e),
            };
            self.bump();
            e = bin(op, e, self.term()?);
        }
    }

    fn term(&mut self) -> Result<Expr> {
        let mut e = self.unary()?;
        loop {
            let op = match self.peek() {
                Tok::Sym("*") => BinaryOp::Mul,
                Tok::Sym("/") => BinaryOp::Div,
                Tok::Sym("%") => BinaryOp::Mod,
                _ => return Ok(e),
            };
            self.bump();
            e = bin(op, e, self.unary()?);
        }
    }

    fn unary(&mut self) -> Result<Expr> {
        let op = match self.peek() {
            Tok::Sym("-") => UnaryOp::Neg,
            Tok::Sym("+") => UnaryOp::Pos,
            Tok::Sym("±") => UnaryOp::PlusMinus,
            _ => return self.power(),
        };
        self.bump();
        Ok(Expr::Unary(op, Box::new(self.unary()?)))
    }

    fn power(&mut self) -> Result<Expr> {
        let base = self.postfix()?;
        if self.eat("^") {
            return Ok(bin(BinaryOp::Pow, base, self.unary()?));
        }
        Ok(base)
    }

    fn postfix(&mut self) -> Result<Expr> {
        let mut e = self.primary()?;
        loop {
            if self.eat("!") {
                e = Expr::Factorial(Box::new(e));
            } else if self.eat("[") {
                e = Expr::Index(Box::new(e), self.list("]")?);
            } else {
                return Ok(e);
            }
        }
    }

    fn primary(&mut self) -> Result<Expr> {
        let pos = self.pos();
        match self.bump() {
            Tok::Num(n) => {
                let num = Expr::Num(n);
                // `2 m`, `5.1 'm`: a number followed by a unit or a plain name multiplies it
                let juxtaposed = matches!(self.peek(), Tok::Unit(_) | Tok::Ident(_));
                if juxtaposed {
                    let unit = self.unit_term()?;
                    return Ok(bin(BinaryOp::Juxt, num, unit));
                }
                Ok(num)
            }
            Tok::Ident(name) => {
                if self.eat("(") {
                    return Ok(Expr::Call(name, self.list(")")?));
                }
                self.quoted_unit_after(Expr::Ident(name))
            }
            Tok::Unit(u) => Ok(Expr::Unit(u)),
            Tok::Str(s) => Ok(Expr::Str(s)),
            Tok::Sym("(") => {
                let e = self.define()?;
                self.expect(")")?;
                self.quoted_unit_after(Expr::Paren(Box::new(e)))
            }
            Tok::Sym("[") => {
                let m = self.matrix(pos)?;
                // `[0; 1; 2] s`: a unit after a vector or matrix applies to every element
                let unit = matches!(self.peek(), Tok::Unit(_) | Tok::Ident(_))
                    && !matches!(self.peek2(), Tok::Sym("(" | "["));
                if unit {
                    let u = self.unit_term()?;
                    return Ok(bin(BinaryOp::Juxt, m, u));
                }
                Ok(m)
            }
            Tok::Sym("?") => Ok(Expr::Placeholder),
            t => Err(ParseError::new(format!("expected a value but found {}", describe(&t)), pos)),
        }
    }

    /// `x '°C`, `(-20) '°C`: a quoted unit after a name or parentheses applies to it, as after a
    /// number. Only a quoted unit: a plain name there (`x m`) would read as two variables.
    fn quoted_unit_after(&mut self, e: Expr) -> Result<Expr> {
        if matches!(self.peek(), Tok::Unit(_)) {
            let unit = self.unit_term()?;
            return Ok(bin(BinaryOp::Juxt, e, unit));
        }
        Ok(e)
    }

    fn unit_term(&mut self) -> Result<Expr> {
        let pos = self.pos();
        let unit = match self.peek() {
            // `2 sin(x)`, `3 v[i]`
            Tok::Ident(_) if matches!(self.peek2(), Tok::Sym("(" | "[")) => self.postfix()?,
            _ => match self.bump() {
                Tok::Unit(u) => Expr::Unit(u),
                Tok::Ident(n) => Expr::Ident(n),
                t => return Err(ParseError::new(format!("expected a unit but found {}", describe(&t)), pos)),
            },
        };
        if self.eat("^") {
            return Ok(bin(BinaryOp::Pow, unit, self.unary()?));
        }
        Ok(unit)
    }

    fn list(&mut self, close: &str) -> Result<Vec<Expr>> {
        let mut items = Vec::new();
        if self.eat(close) {
            return Ok(items);
        }
        loop {
            items.push(self.define()?);
            if !self.eat(",") {
                self.expect(close)?;
                return Ok(items);
            }
        }
    }

    fn matrix(&mut self, pos: usize) -> Result<Expr> {
        if self.eat("]") {
            return Err(ParseError::new("empty matrix", pos));
        }
        let mut rows: Vec<Vec<Expr>> = Vec::new();
        let mut row = Vec::new();
        loop {
            row.push(self.define()?);
            if self.eat(",") {
                continue;
            }
            if self.eat(";") {
                rows.push(std::mem::take(&mut row));
                continue;
            }
            self.expect("]")?;
            break;
        }
        rows.push(row);
        let width = rows.first().map_or(0, Vec::len);
        if rows.iter().any(|r| r.len() != width) {
            return Err(ParseError::new("matrix rows have different lengths", pos));
        }
        Ok(Expr::Matrix(rows))
    }
}
