//! Quire's math AST (`quire_ast::Expr`) → Office Math Markup (OMML), the equations Word edits.
//!
//! It follows `app/src/math.ts`, which draws the same AST as MathML on the page: a name with a
//! literal subscript (`A.net`) is a subscript, units are upright and blue, a unit after a unit is
//! a compound unit (`kN·m`), `80 km/h` stays on one line, `/` is a fraction, and SMath's program
//! constructs (`block`, `if`, `for`) stand in rows. There is no MathML in between: MathML → OMML
//! converters are XSLT that ships with Office, and no permissively licensed Rust one exists.

use quire_ast::{BinaryOp, CmpOp, Expr, UnaryOp};

use super::xml::esc;

/// Units are drawn in this blue on the page, constants in this purple (`styles.css`).
const UNIT_COLOR: &str = "1D5FA8";
const CONSTANT_COLOR: &str = "7C3AED";
pub const PASS_COLOR: &str = "1A7F37";
pub const FAIL_COLOR: &str = "C62828";
const MATH_FONT: &str = "Cambria Math";

/// What the math of one region needs besides its tree: how its names resolved, and the reader's
/// display choices.
#[derive(Debug, Clone, Default)]
pub struct MathStyle<'a> {
    /// Plain names that mean units here (`2 m`), drawn as units.
    pub units: &'a [String],
    /// Plain names that mean built-in constants here.
    pub constants: &'a [String],
    /// `80 km/h` on one line rather than as a fraction (Settings ▸ Appearance in the app).
    pub flat_units: bool,
    /// Document ▸ Results ▸ Group digits.
    pub group_digits: bool,
    /// Font size in half-points.
    pub size: u32,
}

/// How a run of math text is set.
#[derive(Clone, Copy, PartialEq)]
enum Face {
    /// Word's default: letters italic.
    Math,
    /// Upright (`m:sty p`): multi-letter names, units, function names, operators.
    Upright,
    /// Bold upright, for the comparison `=`.
    Bold,
    /// Ordinary text (`m:nor`), for strings.
    Text,
}

struct Ctx<'a> {
    style: &'a MathStyle<'a>,
    /// A string result's colour: a check that passes or fails.
    color: Option<&'a str>,
}

impl Ctx<'_> {
    fn is_unit(&self, name: &str) -> bool {
        self.style.units.iter().any(|u| u == name)
    }

    fn is_constant(&self, name: &str) -> bool {
        self.style.constants.iter().any(|c| c == name)
    }

    fn run(&self, text: &str, face: Face, color: Option<&str>) -> String {
        let mut out = String::from("<m:r>");
        match face {
            Face::Math => {}
            Face::Upright => out.push_str("<m:rPr><m:sty m:val=\"p\"/></m:rPr>"),
            Face::Bold => out.push_str("<m:rPr><m:sty m:val=\"b\"/></m:rPr>"),
            Face::Text => out.push_str("<m:rPr><m:nor/></m:rPr>"),
        }
        out.push_str("<w:rPr><w:rFonts w:ascii=\"");
        out.push_str(MATH_FONT);
        out.push_str("\" w:hAnsi=\"");
        out.push_str(MATH_FONT);
        out.push_str("\"/>");
        if face == Face::Text && color.is_some() {
            out.push_str("<w:b/>");
        }
        if let Some(c) = color {
            out.push_str("<w:color w:val=\"");
            out.push_str(c);
            out.push_str("\"/>");
        }
        out.push_str(&format!("<w:sz w:val=\"{0}\"/><w:szCs w:val=\"{0}\"/>", self.style.size));
        out.push_str("</w:rPr><m:t xml:space=\"preserve\">");
        out.push_str(&esc(text));
        out.push_str("</m:t></m:r>");
        out
    }

    fn op(&self, text: &str) -> String {
        self.run(text, Face::Upright, None)
    }

    /// A name drawn as MathML draws an `<mi>`: one letter italic, several upright.
    fn mi(&self, text: &str) -> String {
        let face = if text.chars().count() == 1 { Face::Math } else { Face::Upright };
        self.run(text, face, None)
    }

    fn unit(&self, name: &str) -> String {
        self.run(name, Face::Upright, Some(UNIT_COLOR))
    }

    fn constant(&self, name: &str) -> String {
        match ident_parts(name) {
            (base, None) => self.run(base, Face::Upright, Some(CONSTANT_COLOR)),
            (base, Some(sub)) => sub_script(
                &self.run(base, Face::Upright, Some(CONSTANT_COLOR)),
                &self.run(sub, Face::Upright, Some(CONSTANT_COLOR)),
            ),
        }
    }

    fn ident(&self, name: &str) -> String {
        if self.is_unit(name) {
            return self.unit(name);
        }
        if self.is_constant(name) {
            return self.constant(name);
        }
        match ident_parts(name) {
            (base, None) => self.mi(base),
            // a literal subscript is upright, as on the page
            (base, Some(sub)) => sub_script(&self.mi(base), &self.run(sub, Face::Upright, None)),
        }
    }

    fn is_unit_term(&self, e: &Expr) -> bool {
        let unit = |x: &Expr| match x {
            Expr::Unit(_) => true,
            Expr::Ident(n) => self.is_unit(n),
            _ => false,
        };
        unit(e) || matches!(e, Expr::Binary(BinaryOp::Pow, a, _) if unit(a))
    }

    /// Units alone: `km`, `s^2`, `kN*m`, `(kg*m)`.
    fn units_only(&self, e: &Expr) -> bool {
        match e {
            Expr::Unit(_) => true,
            Expr::Ident(n) => self.is_unit(n),
            Expr::Paren(x) => self.units_only(x),
            Expr::Binary(BinaryOp::Pow, a, b) => self.units_only(a) && matches!(**b, Expr::Num(_)),
            Expr::Binary(BinaryOp::Mul | BinaryOp::Juxt | BinaryOp::Div, a, b) => {
                self.units_only(a) && self.units_only(b)
            }
            _ => false,
        }
    }

    /// A quantity's value side: `80 km`, `5`, `kN`.
    fn quantity(&self, e: &Expr) -> bool {
        if matches!(e, Expr::Num(_)) || self.units_only(e) {
            return true;
        }
        matches!(e, Expr::Binary(BinaryOp::Mul | BinaryOp::Juxt, a, b)
            if matches!(**a, Expr::Num(_)) && self.units_only(b))
    }

    /// Units written tight, products with a dot: `(m·s)`, `s²`.
    fn unit_row(&self, e: &Expr) -> String {
        match e {
            Expr::Paren(x) => format!("{}{}{}", self.op("("), self.unit_row(x), self.op(")")),
            Expr::Binary(BinaryOp::Mul | BinaryOp::Juxt, a, b) => {
                format!("{}{}{}", self.unit_row(a), self.op("·"), self.unit_row(b))
            }
            Expr::Binary(BinaryOp::Div, a, b) => {
                format!("{}{}{}", self.unit_row(a), self.op("/"), self.unit_row(b))
            }
            _ => self.m(e),
        }
    }

    fn number(&self, n: &str) -> String {
        let text = if self.style.group_digits { group_digits(n) } else { n.to_string() };
        self.run(&text, Face::Math, None)
    }

    fn binary(&self, op: BinaryOp, a: &Expr, b: &Expr) -> String {
        match op {
            // a thin space between a number and its unit
            BinaryOp::Juxt => format!("{}{}{}", self.m(a), self.op("\u{2009}"), self.m(b)),
            BinaryOp::Mul => {
                if self.is_unit_term(b) && !matches!(a, Expr::Num(_)) && self.quantity(a) {
                    // a unit after a unit is a compound unit (54 kN·m)
                    format!("{}{}{}", self.m(a), self.op("·"), self.m(b))
                } else if self.is_unit_term(b) {
                    format!("{}{}{}", self.m(a), self.op("\u{2009}"), self.m(b))
                } else {
                    format!("{}{}{}", self.m(a), self.op("·"), self.m(b))
                }
            }
            BinaryOp::Div => {
                if self.style.flat_units && self.units_only(b) && self.quantity(a) {
                    format!("{}{}{}", self.m(a), self.op("/"), self.unit_row(b))
                } else {
                    fraction(&self.m(unparen(a)), &self.m(unparen(b)))
                }
            }
            BinaryOp::Pow => {
                let exp = self.m(unparen(b));
                if let Expr::Ident(name) = a
                    && !self.is_unit(name)
                    && !self.is_constant(name)
                    && let (base, Some(sub)) = ident_parts(name)
                {
                    return format!(
                        "<m:sSubSup><m:e>{}</m:e><m:sub>{}</m:sub><m:sup>{exp}</m:sup></m:sSubSup>",
                        self.mi(base),
                        self.run(sub, Face::Upright, None)
                    );
                }
                format!("<m:sSup><m:e>{}</m:e><m:sup>{exp}</m:sup></m:sSup>", self.m(a))
            }
            BinaryOp::Add => format!("{}{}{}", self.m(a), self.op("+"), self.m(b)),
            BinaryOp::Sub => format!("{}{}{}", self.m(a), self.op("−"), self.m(b)),
            BinaryOp::PlusMinus => format!("{}{}{}", self.m(a), self.op("±"), self.m(b)),
            BinaryOp::Mod => format!("{}{}{}", self.m(a), self.op(" mod "), self.m(b)),
            BinaryOp::And => format!("{}{}{}", self.m(a), self.op("∧"), self.m(b)),
            BinaryOp::Or => format!("{}{}{}", self.m(a), self.op("∨"), self.m(b)),
        }
    }

    /// Statements in rows, left-aligned (`m:eqArr`), with a rule down their left like the page's
    /// program blocks.
    fn rows(&self, rows: &[String], rule: bool) -> String {
        let arr: String = rows.iter().map(|r| format!("<m:e>{r}</m:e>")).collect();
        let arr = format!("<m:eqArr><m:eqArrPr><m:baseJc m:val=\"top\"/></m:eqArrPr>{arr}</m:eqArr>");
        if rule { delimited(&arr, "│", "", None) } else { arr }
    }

    fn keyword(&self, word: &str) -> String {
        self.run(word, Face::Bold, None)
    }

    fn indented(&self, body: String) -> String {
        format!("{}{body}", self.op("\u{2003}\u{2003}"))
    }

    /// A statement of a block: an `if` is drawn in rows even with plain values.
    fn stmt(&self, e: &Expr) -> String {
        match e {
            Expr::Call(name, args) if name == "if" && is_if(args) => self.if_rows(args),
            _ => self.m(e),
        }
    }

    fn if_rows(&self, args: &[Expr]) -> String {
        let mut rows = Vec::new();
        if let [c, a, rest @ ..] = args {
            rows.push(format!("{}{}{}", self.keyword("if"), self.op(" "), self.m(c)));
            rows.push(self.indented(self.stmt(a)));
            if let [b] = rest {
                rows.push(self.keyword("else"));
                rows.push(self.indented(self.stmt(b)));
            }
        }
        self.rows(&rows, false)
    }

    fn loop_rows(&self, name: &str, args: &[Expr]) -> String {
        let head = match args {
            [c, _] if name == "while" => format!("{}{}{}", self.keyword("while"), self.op(" "), self.m(c)),
            [i, range, _] => {
                format!(
                    "{}{}{}{}{}",
                    self.keyword("for"),
                    self.op(" "),
                    self.m(i),
                    self.op("∈"),
                    self.m(range)
                )
            }
            [a, b, c, _] => format!(
                "{}{}{}{}{}{}{}",
                self.keyword("for"),
                self.op(" "),
                self.m(a),
                self.op(","),
                self.m(b),
                self.op(","),
                self.m(c)
            ),
            _ => self.keyword(name),
        };
        let body = args.last().map(|b| self.indented(self.stmt(b))).unwrap_or_default();
        self.rows(&[head, body], false)
    }

    fn args(&self, args: &[Expr]) -> String {
        let items: Vec<String> = args.iter().map(|a| self.m(a)).collect();
        delimited_many(&items, "(", ")", Some(","))
    }

    fn call(&self, name: &str, args: &[Expr]) -> String {
        if name == "block" {
            let rows: Vec<String> = args.iter().map(|s| self.stmt(s)).collect();
            return self.rows(&rows, true);
        }
        if name == "sys" && args.len() >= 3 {
            let rows: Vec<String> = args.iter().take(args.len() - 2).map(|e| self.m(e)).collect();
            return delimited(&self.rows(&rows, false), "{", "", None);
        }
        if (name == "for" && (args.len() == 3 || args.len() == 4)) || (name == "while" && args.len() == 2) {
            return self.loop_rows(name, args);
        }
        if name == "if" && is_if(args) && args.iter().skip(1).any(is_program) {
            return self.if_rows(args);
        }
        let d = || self.run("d", Face::Upright, None);
        match (name, args) {
            ("sqrt", [x]) => format!(
                "<m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr><m:deg/><m:e>{}</m:e></m:rad>",
                self.m(unparen(x))
            ),
            ("root", [x, n]) => {
                format!("<m:rad><m:deg>{}</m:deg><m:e>{}</m:e></m:rad>", self.m(n), self.m(unparen(x)))
            }
            ("abs", [x]) => delimited(&self.m(unparen(x)), "|", "|", None),
            ("sum" | "prod" | "product", [x, i, from, to]) => {
                let chr = if name == "sum" { "∑" } else { "∏" };
                nary(
                    chr,
                    Some(&format!("{}{}{}", self.m(i), self.op("="), self.m(from))),
                    Some(&self.m(to)),
                    &self.m(x),
                    true,
                )
            }
            ("int", [f, x, a, b]) => nary(
                "∫",
                Some(&self.m(a)),
                Some(&self.m(b)),
                &format!("{}{}{}", self.m(f), d(), self.m(x)),
                false,
            ),
            ("int", [f, x]) => nary("∫", None, None, &format!("{}{}{}", self.m(f), d(), self.m(x)), false),
            ("diff", [f, x]) => format!("{}{}", fraction(&d(), &format!("{}{}", d(), self.m(x))), self.m(f)),
            ("diff", [f, x, n]) => {
                let num = format!("<m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup>", d(), self.m(n));
                let den =
                    format!("{}<m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup>", d(), self.m(x), self.m(n));
                format!("{}{}", fraction(&num, &den), self.m(f))
            }
            ("lim" | "limit", [f, x, a]) => format!(
                "<m:func><m:fName><m:limLow><m:e>{}</m:e><m:lim>{}{}{}</m:lim></m:limLow></m:fName><m:e>{}</m:e></m:func>",
                self.run("lim", Face::Upright, None),
                self.m(x),
                self.op("→"),
                self.m(a),
                self.m(f)
            ),
            ("series" | "taylor", [f, x, a, n]) => {
                let inner = format!(
                    "{}{}{}{}{}{}{}",
                    self.m(f),
                    self.op(";"),
                    self.m(x),
                    self.op("="),
                    self.m(a),
                    self.op(","),
                    self.m(n)
                );
                format!("{}{}", self.run(name, Face::Upright, None), delimited(&inner, "(", ")", None))
            }
            ("subs" | "substitute", [e, x, v]) => format!(
                "<m:sSub><m:e>{}</m:e><m:sub>{}{}{}</m:sub></m:sSub>",
                delimited(&self.m(unparen(e)), "", "|", None),
                self.m(x),
                self.op("="),
                self.m(v)
            ),
            _ => format!("{}{}", self.ident(name), self.args(args)),
        }
    }

    fn m(&self, e: &Expr) -> String {
        match e {
            Expr::Num(n) => self.number(n),
            Expr::Ident(name) => self.ident(name),
            Expr::Unit(name) => self.unit(name),
            Expr::Const(name) => self.constant(name),
            Expr::Str(s) => self.run(&format!("\"{s}\""), Face::Text, self.color),
            Expr::Placeholder => self.op("□"),
            Expr::Paren(x) => delimited(&self.m(x), "(", ")", None),
            Expr::Unary(op, x) => {
                let sym = match op {
                    UnaryOp::Neg => "−",
                    UnaryOp::Pos => "+",
                    UnaryOp::PlusMinus => "±",
                    UnaryOp::Not => "¬",
                };
                format!("{}{}", self.op(sym), self.m(x))
            }
            Expr::Factorial(x) => format!("{}{}", self.m(x), self.op("!")),
            Expr::Binary(op, a, b) => self.binary(*op, a, b),
            Expr::Compare(first, rest) => {
                let mut out = self.m(first);
                for (op, x) in rest {
                    let face = if *op == CmpOp::Eq { Face::Bold } else { Face::Upright };
                    out.push_str(&self.run(cmp_symbol(*op), face, None));
                    out.push_str(&self.m(x));
                }
                out
            }
            Expr::Call(name, args) => self.call(name, args),
            Expr::Index(base, idx) => {
                let items: Vec<String> = idx.iter().map(|x| self.m(x)).collect();
                sub_script(&self.m(base), &items.join(&self.op(",")))
            }
            Expr::Matrix(rows) => {
                let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
                let body: String = rows
                    .iter()
                    .map(|r| {
                        let cells: String = r.iter().map(|c| format!("<m:e>{}</m:e>", self.m(c))).collect();
                        format!("<m:mr>{cells}</m:mr>")
                    })
                    .collect();
                let m = format!(
                    "<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val=\"{cols}\"/><m:mcJc m:val=\"center\"/></m:mcPr></m:mc></m:mcs></m:mPr>{body}</m:m>"
                );
                delimited(&m, "[", "]", None)
            }
            Expr::Range(a, b) => format!("{}{}{}", self.m(a), self.op(".."), self.m(b)),
            Expr::Define { lhs, rhs, global } => {
                let op = self.op(if *global { "≡" } else { "≔" });
                format!("{}{op}{}", self.m(lhs), self.m(rhs))
            }
        }
    }
}

/// `A.net` → (`A`, `net`), SMath's literal subscript.
fn ident_parts(name: &str) -> (&str, Option<&str>) {
    match name.find('.') {
        Some(dot) if dot > 0 && dot < name.len() - 1 => (&name[..dot], Some(&name[dot + 1..])),
        _ => (name, None),
    }
}

fn unparen(e: &Expr) -> &Expr {
    match e {
        Expr::Paren(x) => x,
        _ => e,
    }
}

fn is_if(args: &[Expr]) -> bool {
    args.len() == 2 || args.len() == 3
}

/// An assignment, a block or a loop, or an `if` holding one: such a value is drawn as rows.
fn is_program(e: &Expr) -> bool {
    match e {
        Expr::Define { .. } => true,
        Expr::Call(name, args) => match name.as_str() {
            "if" => is_if(args) && args.iter().skip(1).any(is_program),
            "block" | "for" | "while" => true,
            _ => false,
        },
        _ => false,
    }
}

fn cmp_symbol(op: CmpOp) -> &'static str {
    match op {
        CmpOp::Eq => "=",
        CmpOp::Ne => "≠",
        CmpOp::Lt => "<",
        CmpOp::Le => "≤",
        CmpOp::Gt => ">",
        CmpOp::Ge => "≥",
    }
}

fn fraction(num: &str, den: &str) -> String {
    format!("<m:f><m:num>{num}</m:num><m:den>{den}</m:den></m:f>")
}

fn sub_script(base: &str, sub: &str) -> String {
    format!("<m:sSub><m:e>{base}</m:e><m:sub>{sub}</m:sub></m:sSub>")
}

fn nary(chr: &str, sub: Option<&str>, sup: Option<&str>, body: &str, under_over: bool) -> String {
    let mut pr = format!("<m:chr m:val=\"{chr}\"/>");
    pr.push_str(if under_over { "<m:limLoc m:val=\"undOvr\"/>" } else { "<m:limLoc m:val=\"subSup\"/>" });
    if sub.is_none() {
        pr.push_str("<m:subHide m:val=\"1\"/>");
    }
    if sup.is_none() {
        pr.push_str("<m:supHide m:val=\"1\"/>");
    }
    format!(
        "<m:nary><m:naryPr>{pr}</m:naryPr><m:sub>{}</m:sub><m:sup>{}</m:sup><m:e>{body}</m:e></m:nary>",
        sub.unwrap_or_default(),
        sup.unwrap_or_default()
    )
}

/// Fences around one element; an empty `beg` or `end` leaves that side open.
fn delimited(inner: &str, beg: &str, end: &str, sep: Option<&str>) -> String {
    delimited_many(&[inner.to_string()], beg, end, sep)
}

fn delimited_many(items: &[String], beg: &str, end: &str, sep: Option<&str>) -> String {
    let mut pr = String::new();
    if beg != "(" {
        pr.push_str(&format!("<m:begChr m:val=\"{}\"/>", esc(beg)));
    }
    if let Some(s) = sep {
        pr.push_str(&format!("<m:sepChr m:val=\"{}\"/>", esc(s)));
    }
    if end != ")" {
        pr.push_str(&format!("<m:endChr m:val=\"{}\"/>", esc(end)));
    }
    let pr = if pr.is_empty() { String::new() } else { format!("<m:dPr>{pr}</m:dPr>") };
    let body: String = if items.is_empty() {
        "<m:e/>".to_string()
    } else {
        items.iter().map(|i| format!("<m:e>{i}</m:e>")).collect()
    };
    format!("<m:d>{pr}{body}</m:d>")
}

/// A thin space every three digits, from five digits on, as the page groups them.
fn group_digits(n: &str) -> String {
    let (sign, rest) = n.strip_prefix('-').map_or(("", n), |r| ("-", r));
    let int_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    if int_len < 5 {
        return n.to_string();
    }
    let (int, tail) = rest.split_at(int_len);
    let mut out = String::from(sign);
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int_len - i) % 3 == 0 {
            out.push('\u{2009}');
        }
        out.push(c);
    }
    out.push_str(tail);
    out
}

/// What follows the input on a line: `= result` or `→ result`.
pub struct Shown<'a> {
    pub result: &'a Expr,
    pub symbolic: bool,
    /// A string result that reads as pass or fail is coloured so.
    pub verdict: Option<bool>,
}

/// One equation: `input`, then `= result` when there is one. Returns the contents of an
/// `m:oMath` element (the caller wraps it, so a result can share the equation).
pub fn equation(input: &Expr, shown: Option<Shown<'_>>, style: &MathStyle<'_>) -> String {
    let ctx = Ctx { style, color: None };
    let mut out = ctx.m(input);
    if let Some(s) = shown {
        let color = s.verdict.map(|pass| if pass { PASS_COLOR } else { FAIL_COLOR });
        let rctx = Ctx { style, color };
        out.push_str(&ctx.op(if s.symbolic { "→" } else { "=" }));
        out.push_str(&rctx.m(s.result));
    }
    format!("<m:oMath>{out}</m:oMath>")
}

/// A single expression (a table cell, a check in a summary) as an equation.
pub fn expression(e: &Expr, style: &MathStyle<'_>) -> String {
    equation(e, None, style)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quire_ast::parse;

    fn omml(src: &str, units: &[&str]) -> String {
        let units: Vec<String> = units.iter().map(|u| u.to_string()).collect();
        let style =
            MathStyle { units: &units, constants: &[], flat_units: true, group_digits: false, size: 20 };
        let e = parse(src).unwrap_or(Expr::Placeholder);
        expression(&e, &style)
    }

    /// The text of the runs, in order, without the markup.
    fn text(xml: &str) -> String {
        let mut out = String::new();
        let mut rest = xml;
        while let Some(i) = rest.find("<m:t xml:space=\"preserve\">") {
            let after = &rest[i + 26..];
            let end = after.find("</m:t>").unwrap_or(after.len());
            out.push_str(&after[..end]);
            rest = &after[end..];
        }
        out
    }

    #[test]
    fn a_division_is_a_fraction() {
        let x = omml("M := q*L^2/8", &[]);
        assert!(x.contains("<m:f><m:num>"), "{x}");
        assert!(x.contains("<m:sSup><m:e>"), "{x}");
        assert_eq!(text(&x), "M≔q·L28");
    }

    #[test]
    fn roots_with_and_without_a_degree() {
        let x = omml("sqrt(a+b)", &[]);
        assert!(x.contains("<m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr><m:deg/><m:e>"), "{x}");
        let y = omml("root(x, 3)", &[]);
        assert!(y.contains("<m:rad><m:deg>") && text(&y) == "3x", "{y}");
    }

    #[test]
    fn literal_subscripts_and_powers_of_them() {
        let x = omml("A.net := b*h", &[]);
        assert!(x.contains("<m:sSub><m:e>"), "{x}");
        assert!(x.contains("<m:sty m:val=\"p\"/></m:rPr><w:rPr>"), "subscript upright: {x}");
        let y = omml("W.pl^2", &[]);
        assert!(y.contains("<m:sSubSup>") && text(&y) == "Wpl2", "{y}");
        let z = omml("v[i, j]", &[]);
        assert!(z.contains("<m:sSub>") && text(&z) == "vi,j", "{z}");
    }

    #[test]
    fn matrices_are_bracketed_with_their_column_count() {
        let x = omml("[1, 2; 3, 4]", &[]);
        assert!(x.contains("<m:begChr m:val=\"[\"/><m:endChr m:val=\"]\"/>"), "{x}");
        assert!(x.contains("<m:count m:val=\"2\"/>"), "{x}");
        assert_eq!(x.matches("<m:mr>").count(), 2);
        assert_eq!(text(&x), "1234");
    }

    #[test]
    fn units_are_upright_blue_and_compound_with_a_dot() {
        let x = omml("45 kN*m", &["kN", "m"]);
        assert_eq!(text(&x), "45\u{2009}kN·m");
        assert_eq!(x.matches("w:val=\"1D5FA8\"").count(), 2, "{x}");
        // a unit over a unit stays on the line: 80 km/h
        let y = omml("80 km/h", &["km", "h"]);
        assert!(!y.contains("<m:f>"), "{y}");
        assert_eq!(text(&y), "80\u{2009}km/h");
        // quoted units are units whatever the names resolved to
        let z = omml("9.81 'm/'s^2", &[]);
        assert_eq!(text(&z), "9.81\u{2009}m/s2");
    }

    #[test]
    fn functions_keep_their_name_upright_and_their_arguments_in_parentheses() {
        let x = omml("max(a, b)", &[]);
        assert!(x.contains("<m:sepChr m:val=\",\"/>"), "{x}");
        assert!(x.contains("<m:sty m:val=\"p\"/></m:rPr><w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/><w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/></w:rPr><m:t xml:space=\"preserve\">max"), "{x}");
        let s = omml("sum(i^2, i, 1, n)", &[]);
        assert!(s.contains("<m:chr m:val=\"∑\"/><m:limLoc m:val=\"undOvr\"/>"), "{s}");
        let i = omml("int(x^2, x, 0, 1)", &[]);
        assert!(i.contains("<m:nary>") && !i.contains("subHide"), "{i}");
        let l = omml("lim(1/x, x, ∞)", &[]);
        assert!(l.contains("<m:limLow>"), "{l}");
        let d = omml("diff(x^2, x)", &[]);
        assert!(d.contains("<m:f>") && text(&d).starts_with("ddx"), "{d}");
    }

    #[test]
    fn comparisons_and_programs() {
        let x = omml("σ <= f.y", &[]);
        assert_eq!(text(&x), "σ≤fy");
        let e = omml("a == b", &[]);
        assert!(e.contains("<m:sty m:val=\"b\"/>"), "the comparison = is bold: {e}");
        let p = omml("f(x) := block(y := x, y^2)", &[]);
        assert!(p.contains("<m:eqArr>") && p.contains("m:val=\"│\""), "{p}");
        let i = omml("if(x > 0, y := 1, y := 2)", &[]);
        assert!(i.contains("<m:eqArr>") && text(&i).contains("else"), "{i}");
    }

    #[test]
    fn results_follow_with_their_units_and_strings_take_the_verdict_colour() {
        let units: Vec<String> = vec!["kN".into(), "m".into()];
        let style =
            MathStyle { units: &units, constants: &[], flat_units: true, group_digits: true, size: 20 };
        let input = parse("M := q*L^2/8").unwrap_or(Expr::Placeholder);
        let result = parse("45000 'kN*'m").unwrap_or(Expr::Placeholder);
        let x = equation(&input, Some(Shown { result: &result, symbolic: false, verdict: None }), &style);
        assert!(text(&x).ends_with("=45\u{2009}000\u{2009}kN·m"), "{}", text(&x));
        let ok = parse("\"OK\"").unwrap_or(Expr::Placeholder);
        let y = equation(&input, Some(Shown { result: &ok, symbolic: false, verdict: Some(true) }), &style);
        assert!(y.contains("<m:nor/>") && y.contains(PASS_COLOR), "{y}");
    }
}
