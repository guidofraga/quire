//! SMath math: the RPN token stream of a region (`<e>` elements) → a small AST → Quire's
//! linear syntax. Mirrors `tools/sm2quire.py` (`rpn_to_ast`, `to_linear`).

use roxmltree::Node as XNode;

/// One AST node, as the Python reference builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub kind: Kind,
    pub value: String,
    pub args: Vec<Node>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Num,
    Id,
    Str,
    Unit,
    Paren,
    Unary,
    Postfix,
    Binary,
    Call,
}

const UNARY_PREC: u8 = 6;
const POSTFIX_PREC: u8 = 8;
const ATOM_PREC: u8 = 10;

/// SMath operator → (Quire spelling, precedence). In the .sm file ≡ is SMath's boolean
/// equal (shown as a bold =) and ≈ its approximately-equal comparison: both test equality.
fn binary(op: &str) -> Option<(&'static str, u8)> {
    Some(match op {
        ":" => (":=", 0),
        "≡" | "≈" | "=" => ("==", 3),
        "|" => ("or", 1),
        "&" => ("and", 2),
        "≠" => ("≠", 3),
        "<" => ("<", 3),
        ">" => (">", 3),
        "≤" => ("≤", 3),
        "≥" => ("≥", 3),
        "+" => ("+", 4),
        "-" => ("-", 4),
        "±" => ("±", 4),
        "*" => ("*", 5),
        "/" => ("/", 5),
        "%" => ("%", 5),
        "^" => ("^", 7),
        _ => return None,
    })
}

/// SMath (Russian-tradition) names → canonical Quire names.
fn rename(name: &str) -> &str {
    match name {
        "tg" => "tan",
        "ctg" => "cot",
        "sh" => "sinh",
        "ch" => "cosh",
        "th" => "tanh",
        "cth" => "coth",
        "arctg" => "atan",
        "arcctg" => "acot",
        "arcsin" => "asin",
        "arccos" => "acos",
        "arcsec" => "asec",
        "arccosec" => "acsc",
        "cosec" => "csc",
        "lg" => "log10",
        "nthroot" => "root",
        other => other,
    }
}

fn leaf(kind: Kind, value: &str) -> Node {
    Node { kind, value: value.to_string(), args: Vec::new() }
}

/// `[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?`
fn is_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > s
    };
    if !digits(&mut i) {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        digits(&mut i);
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

/// The `<e>` tokens under `container` (an `<input>`, `<result>` or `<contract>`) as an AST.
pub fn expr(container: Option<XNode>) -> Result<Option<Node>, String> {
    let Some(c) = container else { return Ok(None) };
    let toks: Vec<XNode> = c.children().filter(|n| n.is_element() && n.tag_name().name() == "e").collect();
    if toks.is_empty() {
        return Ok(None);
    }
    let mut stack: Vec<Node> = Vec::new();
    for e in toks {
        let typ = e.attribute("type").unwrap_or("");
        let text = e.text().unwrap_or("");
        match typ {
            "operand" => stack.push(match e.attribute("style") {
                Some("unit") => leaf(Kind::Unit, text),
                Some("string") => leaf(Kind::Str, text),
                _ if is_number(text) => leaf(Kind::Num, text),
                // SMath's filler dot in illustrative matrices
                _ if text == "." => leaf(Kind::Id, "…"),
                _ => leaf(Kind::Id, text),
            }),
            "bracket" => {
                let inner = stack.pop().ok_or("a bracket with nothing inside")?;
                stack.push(Node { kind: Kind::Paren, value: String::new(), args: vec![inner] });
            }
            "operator" | "function" => {
                let n: usize = e.attribute("args").and_then(|a| a.parse().ok()).unwrap_or(0);
                if n > stack.len() {
                    return Err(format!("malformed RPN ({text} needs {n} arguments)"));
                }
                let args = stack.split_off(stack.len() - n);
                let kind = if typ == "function" {
                    Kind::Call
                } else {
                    match n {
                        1 if text == "!" => Kind::Postfix,
                        1 => Kind::Unary,
                        2 => Kind::Binary,
                        _ => Kind::Call,
                    }
                };
                stack.push(Node { kind, value: text.to_string(), args });
            }
            other => return Err(format!("unknown token type '{other}'")),
        }
    }
    if stack.len() != 1 {
        return Err(format!("malformed RPN ({} items left)", stack.len()));
    }
    Ok(stack.pop())
}

fn is_empty_unit(n: &Node) -> bool {
    n.kind == Kind::Unit && n.value.is_empty()
}

fn is_unit_expr(n: &Node) -> bool {
    match n.kind {
        Kind::Unit => true,
        Kind::Binary if n.value == "*" || n.value == "/" => n.args.iter().all(is_unit_expr),
        Kind::Binary if n.value == "^" => {
            is_unit_expr(&n.args[0]) && matches!(n.args[1].kind, Kind::Num | Kind::Unary)
        }
        _ => false,
    }
}

/// `5.1 'm`, `64 'kgf*'m`: printed as juxtaposition.
fn is_quantity(n: &Node) -> bool {
    n.kind == Kind::Binary && n.value == "*" && n.args[0].kind == Kind::Num && is_unit_expr(&n.args[1])
}

fn prec(n: &Node) -> u8 {
    match n.kind {
        Kind::Binary if n.value == "*" && is_quantity(n) => 5,
        Kind::Binary => binary(&n.value).map_or(5, |b| b.1),
        Kind::Unary => UNARY_PREC,
        Kind::Postfix => POSTFIX_PREC,
        Kind::Num if n.value.starts_with('-') => UNARY_PREC,
        _ => ATOM_PREC,
    }
}

/// SMath names may end in primes (σ', f''); in Quire ' marks a unit, so use ′.
pub fn fmt_id(name: &str) -> String {
    name.replace('\'', "′")
}

/// The AST in Quire's linear syntax; `units_bare` prints `kgf` instead of `'kgf`.
pub fn to_linear(n: &Node, units_bare: bool) -> String {
    let lin = |x: &Node| to_linear(x, units_bare);
    match n.kind {
        Kind::Num => n.value.clone(),
        Kind::Id => fmt_id(&n.value),
        Kind::Str => serde_json::to_string(&n.value).unwrap_or_default(),
        Kind::Unit => {
            if units_bare {
                n.value.clone()
            } else {
                format!("'{}", n.value)
            }
        }
        Kind::Paren => format!("({})", lin(&n.args[0])),
        Kind::Unary => {
            let s = lin(&n.args[0]);
            if prec(&n.args[0]) < UNARY_PREC {
                format!("{}({s})", n.value)
            } else {
                format!("{}{s}", n.value)
            }
        }
        Kind::Postfix => {
            let s = lin(&n.args[0]);
            if prec(&n.args[0]) < POSTFIX_PREC {
                format!("({s}){}", n.value)
            } else {
                format!("{s}{}", n.value)
            }
        }
        Kind::Binary => {
            let (a, b) = (&n.args[0], &n.args[1]);
            // the SMath empty unit '' is a dimensionless marker: `1 ''` -> `1`
            if n.value == "*" && is_empty_unit(b) {
                return lin(a);
            }
            if n.value == "*" && is_empty_unit(a) {
                return lin(b);
            }
            let (op, p) = binary(&n.value).unwrap_or((n.value.as_str(), 5));
            let right_assoc = op == "^";
            let (mut sa, mut sb) = (lin(a), lin(b));
            if prec(a) < p || (right_assoc && prec(a) == p) {
                sa = format!("({sa})");
            }
            if prec(b) < p || (!right_assoc && prec(b) == p && op != "*" && op != "+") {
                sb = format!("({sb})");
            }
            if is_quantity(n) {
                format!("{sa} {sb}")
            } else if matches!(op, "*" | "/" | "^") {
                format!("{sa}{op}{sb}")
            } else {
                format!("{sa} {op} {sb}")
            }
        }
        Kind::Call => {
            let args = &n.args;
            if n.value == "mat"
                && args.len() >= 2
                && args[args.len() - 2].kind == Kind::Num
                && args[args.len() - 1].kind == Kind::Num
            {
                let r: usize = args[args.len() - 2].value.parse().unwrap_or(0);
                let c: usize = args[args.len() - 1].value.parse().unwrap_or(0);
                let cells: Vec<String> = args[..args.len() - 2].iter().map(lin).collect();
                let rows: Vec<String> = (0..r)
                    .map(|i| {
                        format!(
                            "  {}",
                            cells.get(i * c..((i + 1) * c).min(cells.len())).unwrap_or(&[]).join(", ")
                        )
                    })
                    .collect();
                if r * c <= 6 {
                    return format!("[{}]", rows.iter().map(|x| x.trim()).collect::<Vec<_>>().join("; "));
                }
                return format!("[\n{}\n]", rows.join(";\n"));
            }
            if n.value == "el" && args.len() >= 2 {
                let mut base = lin(&args[0]);
                if prec(&args[0]) < ATOM_PREC {
                    base = format!("({base})");
                }
                return format!("{base}[{}]", args[1..].iter().map(lin).collect::<Vec<_>>().join(", "));
            }
            format!("{}({})", rename(&n.value), args.iter().map(lin).collect::<Vec<_>>().join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(tokens: &str) -> String {
        let xml = format!("<input>{tokens}</input>");
        let doc = roxmltree::Document::parse(&xml).unwrap();
        to_linear(&expr(Some(doc.root_element())).unwrap().unwrap(), false)
    }

    #[test]
    fn rpn_becomes_linear_syntax() {
        let e = |t: &str, v: &str| format!(r#"<e type="{t}">{v}</e>"#);
        let op = |v: &str, n: u8| format!(r#"<e type="operator" args="{n}">{v}</e>"#);
        let f = |v: &str, n: u8| format!(r#"<e type="function" args="{n}">{v}</e>"#);
        let unit = |v: &str| format!(r#"<e type="operand" style="unit">{v}</e>"#);
        // L.span := 5.1 'm
        assert_eq!(
            conv(&(e("operand", "L.span") + &e("operand", "5.1") + &unit("m") + &op("*", 2) + &op(":", 2))),
            "L.span := 5.1 'm"
        );
        // if(Tipo ≡ 1, a, b): ≡ is equality
        assert_eq!(
            conv(
                &(e("operand", "Tipo")
                    + &e("operand", "1")
                    + &op("≡", 2)
                    + &e("operand", "a")
                    + &e("operand", "b")
                    + &f("if", 3))
            ),
            "if(Tipo == 1, a, b)"
        );
        // (a + b)·c, tg(x), el(M, 2, 3), σ'
        assert_eq!(
            conv(&(e("operand", "a") + &e("operand", "b") + &op("+", 2) + &e("operand", "c") + &op("*", 2))),
            "(a + b)*c"
        );
        assert_eq!(conv(&(e("operand", "x") + &f("tg", 1))), "tan(x)");
        assert_eq!(
            conv(&(e("operand", "M") + &e("operand", "2") + &e("operand", "3") + &f("el", 3))),
            "M[2, 3]"
        );
        assert_eq!(conv(&e("operand", "σ'")), "σ′");
        // mat(1, 2, 3, 4, 2, 2) and the empty unit
        assert_eq!(
            conv(
                &(["1", "2", "3", "4", "2", "2"].iter().map(|v| e("operand", v)).collect::<String>()
                    + &f("mat", 6))
            ),
            "[1, 2; 3, 4]"
        );
        assert_eq!(conv(&(e("operand", "1") + &unit("") + &op("*", 2))), "1");
        assert!(
            expr(Some(roxmltree::Document::parse("<i><e type=\"x\">1</e></i>").unwrap().root_element()))
                .is_err()
        );
    }
}
