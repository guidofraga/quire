use crate::parser::ParseError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Num(String),
    Ident(String),
    Unit(String),
    Str(String),
    /// Operators and punctuation, normalized to their canonical spelling.
    Sym(&'static str),
    Eof,
}

#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub tok: Tok,
    /// Character offset into the source.
    pub pos: usize,
}

/// Longest spellings first; the second element is the canonical form.
const SYMBOLS: &[(&str, &str)] = &[
    ("::=", "≡"),
    (":=", ":="),
    ("==", "=="),
    ("!=", "≠"),
    ("<=", "≤"),
    (">=", "≥"),
    ("..", ".."),
    ("≡", "≡"),
    ("≠", "≠"),
    ("≤", "≤"),
    ("≥", "≥"),
    ("<", "<"),
    (">", ">"),
    ("+", "+"),
    ("-", "-"),
    ("−", "-"),
    ("±", "±"),
    ("*", "*"),
    ("·", "*"),
    ("⋅", "*"),
    ("÷", "/"),
    ("≔", ":="),
    ("×", "*"),
    ("/", "/"),
    ("%", "%"),
    ("^", "^"),
    ("!", "!"),
    ("(", "("),
    (")", ")"),
    ("[", "["),
    ("]", "]"),
    (",", ","),
    (";", ";"),
    ("?", "?"),
];

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '∞' || c == '…'
}

fn is_ident_continue(c: char) -> bool {
    // primes end a name, as in SMath (σ′, f″)
    c.is_alphanumeric() || c == '_' || matches!(c, '′' | '″' | '‴')
}

/// A quoted unit name is a run of these, with dots between them (`'kN`, `'Δ°C`, `'%`,
/// SMath's `'g.e` and `'lb.m`). A run such as `'%m` is one name, so an unknown one is an
/// "unknown unit" error rather than two tokens.
fn is_unit_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '°' | '%' | '‰' | '¤')
}

pub(crate) fn tokenize(src: &str) -> Result<Vec<Token>, ParseError> {
    let chars: Vec<char> = src.chars().collect();
    let len = chars.len();
    let at = |i: usize| chars.get(i).copied();
    let slice_str = |a: usize, b: usize| chars.get(a..b).unwrap_or_default().iter().collect::<String>();
    let mut out = Vec::new();
    let mut i = 0;

    'outer: while i < len {
        let Some(c) = at(i) else { break 'outer };
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        if c.is_ascii_digit() || (c == '.' && at(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            while at(i).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
            }
            if at(i) == Some('.') && at(i + 1) != Some('.') {
                i += 1;
                while at(i).is_some_and(|d| d.is_ascii_digit()) {
                    i += 1;
                }
            }
            if matches!(at(i), Some('e' | 'E')) {
                let mut j = i + 1;
                if matches!(at(j), Some('+' | '-')) {
                    j += 1;
                }
                if at(j).is_some_and(|d| d.is_ascii_digit()) {
                    i = j;
                    while at(i).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1;
                    }
                }
            }
            out.push(Token { tok: Tok::Num(slice_str(start, i)), pos: start });
            continue;
        }

        if is_ident_start(c) {
            i += 1;
            loop {
                if at(i).is_some_and(is_ident_continue) {
                    i += 1;
                } else if at(i) == Some('.') && at(i + 1).is_some_and(is_ident_continue) {
                    i += 2; // literal subscript: A.net, L.f.2m
                } else {
                    break;
                }
            }
            let word: String = slice_str(start, i);
            let tok = match word.as_str() {
                "and" => Tok::Sym("and"),
                "or" => Tok::Sym("or"),
                "not" => Tok::Sym("not"),
                _ => Tok::Ident(word),
            };
            out.push(Token { tok, pos: start });
            continue;
        }

        if c == '\'' {
            i += 1;
            while at(i).is_some_and(is_unit_char)
                || (at(i) == Some('.') && i > start + 1 && at(i + 1).is_some_and(is_unit_char))
            {
                i += 1;
            }
            if i == start + 1 {
                return Err(ParseError::new("expected a unit name after '", start));
            }
            out.push(Token { tok: Tok::Unit(slice_str(start + 1, i)), pos: start });
            continue;
        }

        if c == '"' {
            i += 1;
            let mut s = String::new();
            loop {
                let Some(ch) = at(i) else {
                    return Err(ParseError::new("unterminated string", start));
                };
                i += 1;
                match ch {
                    '"' => break,
                    '\\' => {
                        let esc = at(i).ok_or_else(|| ParseError::new("unterminated string", start))?;
                        i += 1;
                        s.push(match esc {
                            '"' => '"',
                            '\\' => '\\',
                            '/' => '/',
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            'b' => '\u{8}',
                            'f' => '\u{c}',
                            'u' => {
                                let hex: String =
                                    chars.get(i..i + 4).map(|h| h.iter().collect()).unwrap_or_default();
                                i += 4;
                                u32::from_str_radix(&hex, 16)
                                    .ok()
                                    .and_then(char::from_u32)
                                    .ok_or_else(|| ParseError::new("invalid \\u escape", i - 6))?
                            }
                            other => {
                                return Err(ParseError::new(format!("invalid escape \\{other}"), i - 2));
                            }
                        });
                    }
                    ch => s.push(ch),
                }
            }
            out.push(Token { tok: Tok::Str(s), pos: start });
            continue;
        }

        for (text, canon) in SYMBOLS {
            let n = text.chars().count();
            if chars.get(i..i + n).is_some_and(|w| w.iter().copied().eq(text.chars())) {
                out.push(Token { tok: Tok::Sym(canon), pos: start });
                i += n;
                continue 'outer;
            }
        }

        let msg = if c == '=' {
            "use := to define or == to compare".to_string()
        } else {
            format!("unexpected character '{c}'")
        };
        return Err(ParseError::new(msg, start));
    }

    out.push(Token { tok: Tok::Eof, pos: len });
    Ok(out)
}
