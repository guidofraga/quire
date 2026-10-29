//! Canonical linear-syntax printer. It adds parentheses only where the grammar
//! needs them; parentheses the user typed survive as `Expr::Paren`.

use crate::ast::{BinaryOp, Expr, UnaryOp};

pub fn print(e: &Expr) -> String {
    let mut out = String::new();
    write(&mut out, e);
    out
}

/// JSON-compatible string literal (matches the importer's `json.dumps`).
pub fn quote_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const ADDITIVE: u8 = 6;
const MULTIPLICATIVE: u8 = 7;
const UNARY: u8 = 8;
const POWER: u8 = 10;
const POSTFIX: u8 = 11;

fn level(op: BinaryOp) -> u8 {
    match op {
        BinaryOp::Or => 1,
        BinaryOp::And => 2,
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::PlusMinus => ADDITIVE,
        BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => MULTIPLICATIVE,
        BinaryOp::Pow => POWER,
        BinaryOp::Juxt => 9,
    }
}

/// Binding strength of an expression as it would print, loosest = 0.
fn prec(e: &Expr) -> u8 {
    match e {
        Expr::Define { .. } => 0,
        Expr::Unary(UnaryOp::Not, _) => 3,
        Expr::Compare(..) => 4,
        Expr::Range(..) => 5,
        // binds tighter than * and unary minus, looser than ^: (5 'm)^2 keeps its parens
        _ if e.is_quantity() => 9,
        Expr::Binary(op, ..) => level(*op),
        Expr::Unary(..) => UNARY,
        Expr::Factorial(_) | Expr::Index(..) => POSTFIX,
        _ => 12,
    }
}

fn child(out: &mut String, e: &Expr, min: u8) {
    if prec(e) < min {
        out.push('(');
        write(out, e);
        out.push(')');
    } else {
        write(out, e);
    }
}

fn write(out: &mut String, e: &Expr) {
    match e {
        Expr::Num(t) | Expr::Ident(t) => out.push_str(t),
        Expr::Unit(u) => {
            out.push('\'');
            out.push_str(u);
        }
        Expr::Str(s) => out.push_str(&quote_str(s)),
        Expr::Placeholder => out.push('?'),
        Expr::Paren(x) => {
            out.push('(');
            write(out, x);
            out.push(')');
        }
        Expr::Unary(UnaryOp::Not, x) => {
            out.push_str("not ");
            child(out, x, 3);
        }
        Expr::Unary(op, x) => {
            out.push_str(op.symbol());
            child(out, x, UNARY);
        }
        Expr::Factorial(x) => {
            child(out, x, POSTFIX);
            out.push('!');
        }
        Expr::Binary(op, a, b) => {
            if e.is_quantity() {
                write(out, a);
                out.push(' ');
                write(out, b);
                return;
            }
            if *op == BinaryOp::Pow {
                child(out, a, POSTFIX);
                out.push('^');
                child(out, b, UNARY);
                return;
            }
            let p = level(*op);
            child(out, a, p);
            match op {
                BinaryOp::Mul | BinaryOp::Div => out.push_str(op.symbol()),
                _ => {
                    out.push(' ');
                    out.push_str(op.symbol());
                    out.push(' ');
                }
            }
            child(out, b, p + 1);
        }
        Expr::Compare(first, rest) => {
            child(out, first, 5);
            for (op, x) in rest {
                out.push(' ');
                out.push_str(op.symbol());
                out.push(' ');
                child(out, x, 5);
            }
        }
        Expr::Call(name, args) => {
            out.push_str(name);
            out.push('(');
            list(out, args);
            out.push(')');
        }
        Expr::Index(base, args) => {
            child(out, base, POSTFIX);
            out.push('[');
            list(out, args);
            out.push(']');
        }
        Expr::Matrix(rows) => {
            let cells = rows.len() * rows.first().map_or(0, Vec::len);
            let printed: Vec<String> =
                rows.iter().map(|r| r.iter().map(print).collect::<Vec<_>>().join(", ")).collect();
            if cells <= 6 {
                out.push('[');
                out.push_str(&printed.join("; "));
                out.push(']');
            } else {
                out.push_str("[\n");
                let indented: Vec<String> = printed.iter().map(|r| format!("  {r}")).collect();
                out.push_str(&indented.join(";\n"));
                out.push_str("\n]");
            }
        }
        Expr::Range(a, b) => {
            child(out, a, ADDITIVE);
            out.push_str("..");
            child(out, b, ADDITIVE);
        }
        Expr::Define { lhs, rhs, global } => {
            child(out, lhs, 1);
            out.push_str(if *global { " ≡ " } else { " := " });
            write(out, rhs);
        }
    }
}

fn list(out: &mut String, args: &[Expr]) {
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        write(out, a);
    }
}

#[cfg(test)]
mod tests {
    use crate::{Expr, parse, print};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn roundtrip(src: &str) -> TestResult {
        let e = parse(src).map_err(|err| format!("{src}: {err}"))?;
        assert_eq!(print(&e), src, "print(parse(s)) != s");
        assert_eq!(parse(&print(&e))?, e, "parse(print(e)) != e");
        Ok(())
    }

    #[test]
    fn canonical_text_roundtrips() -> TestResult {
        for src in [
            "L.span := 5.1 'm",
            "A.área := L.span*b.flange",
            "M.beam.simple := 64 'kgf*'m",
            "A.área.footing := 12 'cm*12*'cm",
            "k := 1/150*'mm/'kgf",
            "F.braço.clamp := 2*900*'kgf",
            "C.allow := H.brace*L.brace^2/(4*k*D.brace^2)",
            "A.tank := π*(D.base.tank/2)^2",
            "F.cr := (0.658^(F.y/F.e))*F.y",
            "r.tube := sqrt((D^2 + d.tube^2))/4",
            "L.vão.max := max([L.vão.x, L.vão.y])",
            "check := if(C < L, \"OK\", \"FALHA\")",
            "a < c < b",
            "x - (y - z)",
            "-x^2",
            "2^-1",
            "a^b^c",
            "f(x, y) := x^2 + y",
            "g ≡ 9.80665 'm/'s^2",
            "v[i, j] := v[i - 1, j]*2",
            "n!",
            "a and not b or c",
            "for(j := 1, j ≤ cols(A), j := j + 1, p[j] := -q[m - j + 1])",
            "25.5 'm^2",
            "L := 2 m",
            "g := 9.81 m/s^2",
            "M := 64 kgf*m",
            "y := 2 sin(x)*3 'mm",
            "A := 2 x^2",
            "1..10",
            "ε := 10^(-5)",
            "s := \"a \\\"quoted\\\" word\"",
            "M := [1, 2; 3, 4]",
            "t := [0; 1; 2] s",
            "F := [1, 2] kN/m",
            "[\n  1, 2, 3;\n  4, 5, 6;\n  7, 8, 9\n]",
            "x ≡ ?",
            "[a, …; …, b]",
        ] {
            roundtrip(src)?;
        }
        Ok(())
    }

    #[test]
    fn precedence() -> TestResult {
        let e = parse("1 + 2*3^2")?;
        assert_eq!(print(&e), "1 + 2*3^2");
        // juxtaposed quantity is one primary: 10/5 'm is 10/(5 m)
        let Expr::Binary(_, _, rhs) = parse("10/5 'm")? else {
            return Err("expected a binary expression".into());
        };
        assert!(rhs.is_quantity());
        let squared =
            Expr::Binary(crate::BinaryOp::Pow, Box::new(parse("5 'm")?), Box::new(Expr::Num("2".into())));
        assert_eq!(print(&squared), "(5 'm)^2");
        assert_eq!(print(&parse("-5 'm")?), "-5 'm");
        Ok(())
    }

    #[test]
    fn aliases_normalize() -> TestResult {
        assert_eq!(print(&parse("a <= b != c")?), "a ≤ b ≠ c");
        assert_eq!(print(&parse("g ::= 1")?), "g ≡ 1");
        assert_eq!(print(&parse("a·b×c")?), "a*b*c");
        Ok(())
    }

    #[test]
    fn errors_point_at_the_problem() -> TestResult {
        let err = parse("x = 2").err().ok_or("expected a parse error")?;
        assert!(err.message.contains(":="), "{err}");
        assert_eq!(err.pos, 2);
        assert!(parse("(1 + 2").err().is_some_and(|e| e.message.contains("')'")));
        assert!(parse("[1, 2; 3]").err().is_some_and(|e| e.message.contains("different lengths")));
        assert!(parse("5 '").is_err());
        Ok(())
    }
}
