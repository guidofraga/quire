//! Text, number and logic functions from SMath (strlen, substr, error, gcd, …).
//!
//! String positions are 0-based, as in SMath, and count characters (not bytes).

use std::cell::Cell;

use quire_units::{Dim, UnitRegistry};

use crate::error::{Result, bail};
use crate::ops;
use crate::value::{Quantity, Value};

/// `None` when `name` is not one of this module's functions.
pub fn call(name: &str, args: &[Value]) -> Option<Result<Value>> {
    let r = match name {
        // text
        "strlen" => strlen(args),
        "substr" => substr(args),
        "findstr" => findstr(args),
        "strrep" => strrep(args),
        "insert" => insert(args),
        "str2num" => str2num(args),
        "tolower" => change_case(name, args, false),
        "toupper" => change_case(name, args, true),
        "IsString" => is_string(args),
        "error" => error(args),
        // numbers
        "gcd" => gcd_lcm(name, args, false),
        "lcm" => gcd_lcm(name, args, true),
        "random" => random(args),
        "Gamma" => real(name, gamma, args),
        "erf" => real(name, erf, args),
        "erfc" => real(name, erfc, args),
        "nthroot" => nthroot(args),
        "perm" => perm_comb(name, args, false),
        "comb" => perm_comb(name, args, true),
        "fact" => fact(args),
        "UnitsOf" => units_of(args),
        // Russian-style names SMath also accepts
        "tg" => real(name, f64::tan, args),
        "ctg" => real(name, |x| 1.0 / x.tan(), args),
        "arctg" => real(name, f64::atan, args),
        "arcctg" => real(name, |x| (1.0 / x).atan(), args),
        "arcsin" => real(name, f64::asin, args),
        "arccos" => real(name, f64::acos, args),
        "sh" => real(name, f64::sinh, args),
        "ch" => real(name, f64::cosh, args),
        "th" => real(name, f64::tanh, args),
        "cth" => real(name, |x| 1.0 / x.tanh(), args),
        "cosec" => real(name, |x| 1.0 / x.sin(), args),
        "arcsec" => real(name, |x| (1.0 / x).acos(), args),
        "arccosec" => real(name, |x| (1.0 / x).asin(), args),
        _ => return None,
    };
    Some(r)
}

fn arity(name: &str, args: &[Value], ok: impl Fn(usize) -> bool, expected: &str) -> Result<()> {
    if !ok(args.len()) {
        bail!("{name} takes {expected}, but got {}", args.len());
    }
    Ok(())
}

fn real(name: &str, f: fn(f64) -> f64, args: &[Value]) -> Result<Value> {
    arity(name, args, |n| n == 1, "1 argument")?;
    let x = args[0].as_scalar(&format!("the argument of {name}"))?;
    let v = f(x);
    if v.is_nan() && !x.is_nan() {
        bail!("{name}({x}) has no real result");
    }
    if v.is_infinite() && x.is_finite() {
        bail!("{name}({x}) is infinite");
    }
    Ok(Value::num(v))
}

fn text<'a>(v: &'a Value, what: &str) -> Result<&'a str> {
    match v {
        Value::Str(s) => Ok(s),
        other => bail!("{what} must be a string, not {}", other.kind()),
    }
}

/// A 0-based character position, not past `len` (the end of the string).
fn position(v: &Value, what: &str, len: usize) -> Result<usize> {
    let p = v.as_int(what)?;
    if p < 0 || p as usize > len {
        bail!("{what} is {p}, but it must be between 0 and {len} (positions start at 0)");
    }
    Ok(p as usize)
}

// ---------------------------------------------------------------- text

/// `strlen(s)`: number of characters.
fn strlen(args: &[Value]) -> Result<Value> {
    arity("strlen", args, |n| n == 1, "1 argument")?;
    let s = text(&args[0], "the argument of strlen")?;
    Ok(Value::num(s.chars().count() as f64))
}

/// `substr(s, start[, length])`: the characters from `start` (0-based); without
/// `length`, up to the end. A `length` past the end stops at the end.
fn substr(args: &[Value]) -> Result<Value> {
    arity("substr", args, |n| n == 2 || n == 3, "2 or 3 arguments: substr(s, start[, length])")?;
    let s: Vec<char> = text(&args[0], "the string of substr")?.chars().collect();
    let start = position(&args[1], "the start of substr", s.len())?;
    let len = match args.get(2) {
        Some(l) => {
            let l = l.as_int("the length of substr")?;
            if l < 0 {
                bail!("the length of substr cannot be negative, got {l}");
            }
            (l as usize).min(s.len() - start)
        }
        None => s.len() - start,
    };
    Ok(Value::Str(s[start..start + len].iter().collect()))
}

/// `findstr(s, sub)`: 0-based position of the first `sub` in `s`, or -1.
fn findstr(args: &[Value]) -> Result<Value> {
    arity("findstr", args, |n| n == 2, "2 arguments: findstr(s, sub)")?;
    let s = text(&args[0], "the string of findstr")?;
    let sub = text(&args[1], "the text to find")?;
    if sub.is_empty() {
        bail!("findstr needs a non-empty text to find");
    }
    Ok(Value::num(match s.find(sub) {
        Some(byte) => s[..byte].chars().count() as f64,
        None => -1.0,
    }))
}

/// `strrep(s, old, new)`: every `old` replaced by `new`.
fn strrep(args: &[Value]) -> Result<Value> {
    arity("strrep", args, |n| n == 3, "3 arguments: strrep(s, old, new)")?;
    let s = text(&args[0], "the string of strrep")?;
    let old = text(&args[1], "the text to replace")?;
    let new = text(&args[2], "the replacement text")?;
    if old.is_empty() {
        bail!("strrep needs a non-empty text to replace");
    }
    Ok(Value::Str(s.replace(old, new)))
}

/// `insert(s, pos, sub)`: `sub` placed before the character at `pos` (0-based).
/// `insert(s, sub, pos)` is accepted too.
fn insert(args: &[Value]) -> Result<Value> {
    arity("insert", args, |n| n == 3, "3 arguments: insert(s, pos, sub)")?;
    let s: Vec<char> = text(&args[0], "the string of insert")?.chars().collect();
    let (pos, sub) = match (&args[1], &args[2]) {
        (Value::Str(sub), p @ Value::Num(_)) => (p, sub.as_str()),
        (p, sub) => (p, text(sub, "the text to insert")?),
    };
    let pos = position(pos, "the position of insert", s.len())?;
    let mut out: String = s[..pos].iter().collect();
    out.push_str(sub);
    out.extend(&s[pos..]);
    Ok(Value::Str(out))
}

/// "1.5" or "1,5" (a comma is the decimal mark when there is no point).
fn parse_decimal(t: &str) -> Option<f64> {
    let t = if t.contains('.') { t.to_string() } else { t.replace(',', ".") };
    let first = t.chars().next()?;
    if !(first.is_ascii_digit() || matches!(first, '+' | '-' | '.')) {
        return None;
    }
    t.parse().ok()
}

/// `str2num(s)`: "1.5", "1,5", "-2e3", optionally followed by one built-in unit
/// name ("12 kN", "20 'kN", "25°C").
fn str2num(args: &[Value]) -> Result<Value> {
    arity("str2num", args, |n| n == 1, "1 argument")?;
    let s = text(&args[0], "the argument of str2num")?.trim();
    if let Some(x) = parse_decimal(s) {
        return Ok(Value::num(x));
    }
    // longest numeric prefix; the rest is a unit name
    let cut = s
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()))
        .rev()
        .find(|&i| i > 0 && parse_decimal(&s[..i]).is_some());
    let Some(cut) = cut else { bail!("str2num could not read a number from \"{s}\"") };
    let x = parse_decimal(&s[..cut]).unwrap_or_default();
    let unit = s[cut..].trim().trim_start_matches('\'');
    let Some(u) = UnitRegistry::new().lookup(unit) else {
        bail!("str2num reads a number with one unit name, like \"12 kN\"; \"{unit}\" is not a known unit")
    };
    Ok(Value::Num(Quantity::new(x * u.factor + u.offset, u.dim)))
}

fn change_case(name: &str, args: &[Value], upper: bool) -> Result<Value> {
    arity(name, args, |n| n == 1, "1 argument")?;
    let s = text(&args[0], &format!("the argument of {name}"))?;
    Ok(Value::Str(if upper { s.to_uppercase() } else { s.to_lowercase() }))
}

/// `IsString(x)`: 1 for a string, 0 otherwise.
fn is_string(args: &[Value]) -> Result<Value> {
    arity("IsString", args, |n| n == 1, "1 argument")?;
    Ok(Value::bool(matches!(args[0], Value::Str(_))))
}

/// `error(msg)`: stops the calculation with `msg` as the message.
fn error(args: &[Value]) -> Result<Value> {
    arity("error", args, |n| n == 1, "1 argument: error(\"message\")")?;
    let msg = text(&args[0], "the message of error")?;
    bail!("{msg}")
}

// ---------------------------------------------------------------- numbers

fn gcd(mut a: i64, mut b: i64) -> i64 {
    a = a.abs();
    b = b.abs();
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// `gcd(a, b, …)` / `lcm(a, b, …)` of whole numbers; matrices are flattened.
fn gcd_lcm(name: &str, args: &[Value], lcm: bool) -> Result<Value> {
    let mut items = Vec::new();
    for a in args {
        match a {
            Value::Matrix(m) => items.extend(m.data.iter()),
            v => items.push(v),
        }
    }
    if items.is_empty() {
        bail!("{name} needs at least one whole number");
    }
    let what = format!("an argument of {name}");
    let mut acc = items[0].as_int(&what)?.abs();
    for v in &items[1..] {
        let n = v.as_int(&what)?.abs();
        acc = if !lcm {
            gcd(acc, n)
        } else if acc == 0 || n == 0 {
            0
        } else {
            match (acc / gcd(acc, n)).checked_mul(n) {
                Some(m) if m <= 1_000_000_000_000_000 => m,
                _ => bail!("lcm is too large"),
            }
        };
    }
    Ok(Value::num(acc as f64))
}

thread_local! {
    static SEED: Cell<u64> = const { Cell::new(0) };
}

/// xorshift64*, seeded from the clock on first use. Uniform in [0, 1).
fn next_unit() -> f64 {
    SEED.with(|s| {
        let mut x = s.get();
        if x == 0 {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos() as u64);
            x = (t ^ 0x9e37_79b9_7f4a_7c15).max(1);
        }
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        s.set(x);
        (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    })
}

/// `random(max)`: uniform between 0 and `max`, in the units of `max`.
fn random(args: &[Value]) -> Result<Value> {
    arity("random", args, |n| n == 1, "1 argument")?;
    let m = args[0].as_num("the argument of random")?;
    if !m.v.is_finite() {
        bail!("random needs a finite maximum");
    }
    Ok(Value::Num(Quantity::new(m.v * next_unit(), m.dim)))
}

/// Lanczos approximation (g = 7, 9 terms), reflection below 1/2.
fn gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x <= 0.0 && x.fract() == 0.0 {
        return f64::NAN; // poles at 0, -1, -2, …
    }
    if x < 0.5 {
        let pi = std::f64::consts::PI;
        return pi / ((pi * x).sin() * gamma(1.0 - x));
    }
    let x = x - 1.0;
    let t = x + 7.5;
    let s = G[1..].iter().enumerate().fold(G[0], |acc, (i, c)| acc + c / (x + i as f64 + 1.0));
    (2.0 * std::f64::consts::PI).sqrt() * t.powf(x + 0.5) * (-t).exp() * s
}

/// erf by its all-positive series below 2.5, by erfc's continued fraction above.
fn erf(x: f64) -> f64 {
    if x < 0.0 {
        return -erf(-x);
    }
    if x >= 2.5 {
        return 1.0 - erfc_cf(x);
    }
    // erf(x) = 2/√π · e^(-x²) · Σ (2x²)^n · x / (1·3·…·(2n+1))
    let mut term = x;
    let mut sum = x;
    let mut n = 0.0;
    while term > sum * 1e-17 {
        n += 1.0;
        term *= 2.0 * x * x / (2.0 * n + 1.0);
        sum += term;
    }
    2.0 / std::f64::consts::PI.sqrt() * (-x * x).exp() * sum
}

fn erfc(x: f64) -> f64 {
    if x < 0.0 {
        2.0 - erfc(-x)
    } else if x >= 2.5 {
        erfc_cf(x)
    } else {
        1.0 - erf(x)
    }
}

/// erfc(x) = e^(-x²)/√π · 1/(x + ½/(x + 1/(x + 3/2/(x + …)))), for x ≥ 2.5.
fn erfc_cf(x: f64) -> f64 {
    let mut t = x;
    for k in (1..=200).rev() {
        t = x + (k as f64 / 2.0) / t;
    }
    (-x * x).exp() / std::f64::consts::PI.sqrt() / t
}

/// `nthroot(x, n)`: same as `root`; odd roots of negatives are negative.
fn nthroot(args: &[Value]) -> Result<Value> {
    arity("nthroot", args, |n| n == 2, "2 arguments: nthroot(x, n)")?;
    let x = args[0].as_num("the radicand")?;
    let n = args[1].as_int("the root degree")?;
    if n == 0 {
        bail!("the root degree cannot be zero");
    }
    if x.v < 0.0 {
        if n % 2 == 0 {
            bail!("an even root of a negative number has no real result");
        }
        let pos = ops::pow(Quantity::new(-x.v, x.dim), Quantity::scalar(1.0 / n as f64))?;
        return Ok(Value::Num(Quantity::new(-pos.v, pos.dim)));
    }
    Ok(Value::Num(ops::pow(x, Quantity::new(1.0 / n as f64, Dim::NONE))?))
}

/// `perm(n, k)` = n!/(n−k)!, `comb(n, k)` = n!/(k!(n−k)!).
fn perm_comb(name: &str, args: &[Value], comb: bool) -> Result<Value> {
    arity(name, args, |n| n == 2, "2 arguments: (n, k)")?;
    let n = args[0].as_int(&format!("n in {name}"))?;
    let k = args[1].as_int(&format!("k in {name}"))?;
    if n < 0 || k < 0 || k > n {
        bail!("{name}(n, k) needs 0 ≤ k ≤ n, got n = {n}, k = {k}");
    }
    let steps = if comb { k.min(n - k) } else { k };
    let mut r = 1.0f64;
    for i in 0..steps {
        r *= (n - i) as f64;
        if comb {
            r /= (i + 1) as f64;
        }
    }
    if comb {
        r = r.round();
    }
    if !r.is_finite() {
        bail!("{name}({n}, {k}) is too large");
    }
    Ok(Value::num(r))
}

/// `fact(n)` = n!.
fn fact(args: &[Value]) -> Result<Value> {
    arity("fact", args, |n| n == 1, "1 argument")?;
    let n = args[0].as_int("the argument of fact")?;
    if n < 0 {
        bail!("fact needs a whole number ≥ 0, got {n}");
    }
    if n > 170 {
        bail!("fact({n}) is too large");
    }
    Ok(Value::num((1..=n).fold(1.0, |acc, i| acc * i as f64)))
}

/// `UnitsOf(x)`: 1 in the SI units of x (`UnitsOf(5 kN)` = 1 N).
fn units_of(args: &[Value]) -> Result<Value> {
    arity("UnitsOf", args, |n| n == 1, "1 argument")?;
    let dim = match &args[0] {
        Value::Matrix(m) => ops::uniform(m, "an element of UnitsOf")?.1,
        other => other.as_num("the argument of UnitsOf")?.dim,
    };
    Ok(Value::Num(Quantity::new(1.0, dim)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Matrix;

    fn s(t: &str) -> Value {
        Value::Str(t.into())
    }
    fn n(x: f64) -> Value {
        Value::num(x)
    }
    fn ok(name: &str, args: &[Value]) -> Value {
        call(name, args).expect("known function").expect("no error")
    }
    fn err(name: &str, args: &[Value]) -> String {
        call(name, args).expect("known function").expect_err("an error").message
    }
    fn num(name: &str, args: &[Value]) -> f64 {
        match ok(name, args) {
            Value::Num(q) => q.v,
            other => panic!("expected a number, got {other:?}"),
        }
    }
    fn close(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol * b.abs().max(1.0), "{a} ≠ {b}");
    }
    fn force() -> Dim {
        Dim::from_ints([1, 1, -2, 0, 0, 0, 0])
    }

    #[test]
    fn unknown_name_falls_through() {
        assert!(call("nope", &[]).is_none());
        assert!(call("sin", &[n(1.0)]).is_none());
    }

    #[test]
    fn strlen_counts_chars() {
        assert_eq!(num("strlen", &[s("abc")]), 3.0);
        assert_eq!(num("strlen", &[s("")]), 0.0);
        assert_eq!(num("strlen", &[s("ação")]), 4.0);
        assert!(err("strlen", &[n(1.0)]).contains("must be a string"));
        assert!(err("strlen", &[]).contains("takes 1 argument"));
    }

    #[test]
    fn substr_zero_based() {
        assert_eq!(ok("substr", &[s("Hello"), n(1.0), n(3.0)]), s("ell"));
        assert_eq!(ok("substr", &[s("Hello"), n(2.0)]), s("llo"));
        assert_eq!(ok("substr", &[s("Hello"), n(3.0), n(10.0)]), s("lo"));
        assert_eq!(ok("substr", &[s("Hello"), n(5.0)]), s(""));
        assert_eq!(ok("substr", &[s("pré-sal"), n(2.0), n(2.0)]), s("é-"));
        assert!(err("substr", &[s("Hello"), n(6.0)]).contains("between 0 and 5"));
        assert!(err("substr", &[s("Hello"), n(-1.0)]).contains("between 0 and 5"));
        assert!(err("substr", &[s("Hello"), n(1.0), n(-2.0)]).contains("negative"));
        assert!(err("substr", &[s("Hello"), n(1.5)]).contains("whole number"));
        assert!(err("substr", &[s("Hello")]).contains("2 or 3"));
    }

    #[test]
    fn findstr_position_or_minus_one() {
        assert_eq!(num("findstr", &[s("Hello"), s("l")]), 2.0);
        assert_eq!(num("findstr", &[s("Hello"), s("H")]), 0.0);
        assert_eq!(num("findstr", &[s("Hello"), s("z")]), -1.0);
        assert_eq!(num("findstr", &[s("ção x"), s("x")]), 4.0);
        assert!(err("findstr", &[s("Hello"), s("")]).contains("non-empty"));
        assert!(err("findstr", &[s("Hello"), n(1.0)]).contains("must be a string"));
    }

    #[test]
    fn strrep_replaces_all() {
        assert_eq!(ok("strrep", &[s("a-b-c"), s("-"), s("+")]), s("a+b+c"));
        assert_eq!(ok("strrep", &[s("abc"), s("x"), s("y")]), s("abc"));
        assert!(err("strrep", &[s("abc"), s(""), s("y")]).contains("non-empty"));
        assert!(err("strrep", &[s("abc"), s("a")]).contains("3 arguments"));
    }

    #[test]
    fn insert_at_position() {
        assert_eq!(ok("insert", &[s("Hlo"), n(1.0), s("el")]), s("Hello"));
        assert_eq!(ok("insert", &[s("Hlo"), s("el"), n(1.0)]), s("Hello"));
        assert_eq!(ok("insert", &[s("ab"), n(2.0), s("c")]), s("abc"));
        assert_eq!(ok("insert", &[s("ab"), n(0.0), s("_")]), s("_ab"));
        assert!(err("insert", &[s("ab"), n(3.0), s("c")]).contains("between 0 and 2"));
        assert!(err("insert", &[s("ab"), n(1.0), n(2.0)]).contains("must be a string"));
    }

    #[test]
    fn str2num_numbers_and_units() {
        assert_eq!(num("str2num", &[s("1.5")]), 1.5);
        assert_eq!(num("str2num", &[s(" 1,5 ")]), 1.5);
        assert_eq!(num("str2num", &[s("-2e3")]), -2000.0);
        let Value::Num(q) = ok("str2num", &[s("12 kN")]) else { panic!() };
        assert_eq!((q.v, q.dim), (12_000.0, force()));
        let Value::Num(q) = ok("str2num", &[s("12'kN")]) else { panic!() };
        assert_eq!(q.v, 12_000.0);
        let Value::Num(q) = ok("str2num", &[s("2,5 mm")]) else { panic!() };
        close(q.v, 0.0025, 1e-15);
        assert!(err("str2num", &[s("abc")]).contains("could not read"));
        assert!(err("str2num", &[s("inf")]).contains("could not read"));
        assert!(err("str2num", &[s("3 zorks")]).contains("not a known unit"));
        assert!(err("str2num", &[n(3.0)]).contains("must be a string"));
    }

    #[test]
    fn case_and_type() {
        assert_eq!(ok("toupper", &[s("aço")]), s("AÇO"));
        assert_eq!(ok("tolower", &[s("AbC")]), s("abc"));
        assert!(err("toupper", &[n(1.0)]).contains("must be a string"));
        assert_eq!(num("IsString", &[s("x")]), 1.0);
        assert_eq!(num("IsString", &[n(1.0)]), 0.0);
        assert_eq!(num("IsString", &[Value::Matrix(Matrix::column(vec![s("x")]))]), 0.0);
        assert!(err("IsString", &[]).contains("1 argument"));
    }

    #[test]
    fn error_uses_message() {
        assert_eq!(err("error", &[s("h too small")]), "h too small");
        assert!(err("error", &[n(1.0)]).contains("must be a string"));
        assert!(err("error", &[]).contains("1 argument"));
    }

    #[test]
    fn gcd_and_lcm() {
        assert_eq!(num("gcd", &[n(12.0), n(18.0)]), 6.0);
        assert_eq!(num("gcd", &[n(12.0), n(18.0), n(8.0)]), 2.0);
        assert_eq!(num("gcd", &[n(-4.0), n(6.0)]), 2.0);
        assert_eq!(num("gcd", &[n(0.0), n(5.0)]), 5.0);
        assert_eq!(num("lcm", &[n(4.0), n(6.0)]), 12.0);
        assert_eq!(num("lcm", &[n(2.0), n(3.0), n(4.0)]), 12.0);
        assert_eq!(num("lcm", &[n(0.0), n(3.0)]), 0.0);
        let v = Value::Matrix(Matrix::column(vec![n(4.0), n(10.0)]));
        assert_eq!(num("lcm", &[v]), 20.0);
        assert!(err("gcd", &[]).contains("at least one"));
        assert!(err("gcd", &[n(1.5), n(3.0)]).contains("whole number"));
        assert!(err("lcm", &[n(1e14), n(1e14 - 1.0)]).contains("too large"));
    }

    #[test]
    fn random_in_range_with_units() {
        for _ in 0..1000 {
            let x = num("random", &[n(10.0)]);
            assert!((0.0..10.0).contains(&x));
        }
        let Value::Num(q) = ok("random", &[Value::Num(Quantity::new(5.0, force()))]) else { panic!() };
        assert!(q.dim == force() && (0.0..5.0).contains(&q.v));
        assert!(err("random", &[s("x")]).contains("must be a number"));
        assert!(err("random", &[n(f64::INFINITY)]).contains("finite"));
    }

    #[test]
    fn gamma_values() {
        let pi = std::f64::consts::PI;
        close(num("Gamma", &[n(5.0)]), 24.0, 1e-13);
        close(num("Gamma", &[n(0.5)]), pi.sqrt(), 1e-14);
        close(num("Gamma", &[n(1.5)]), pi.sqrt() / 2.0, 1e-14);
        close(num("Gamma", &[n(-0.5)]), -2.0 * pi.sqrt(), 1e-13);
        close(num("Gamma", &[n(11.3)]) / num("Gamma", &[n(10.3)]), 10.3, 1e-13);
        assert!(err("Gamma", &[n(0.0)]).contains("no real result"));
        assert!(err("Gamma", &[n(-2.0)]).contains("no real result"));
        assert!(err("Gamma", &[n(200.0)]).contains("infinite"));
        assert!(err("Gamma", &[Value::Num(Quantity::new(1.0, force()))]).contains("plain number"));
    }

    #[test]
    fn erf_values() {
        close(num("erf", &[n(0.0)]), 0.0, 1e-16);
        close(num("erf", &[n(0.5)]), 0.520_499_877_813_046_5, 1e-14);
        close(num("erf", &[n(-1.0)]), -0.842_700_792_949_714_9, 1e-14);
        close(num("erf", &[n(2.0)]), 0.995_322_265_018_952_7, 1e-14);
        close(num("erf", &[n(3.0)]), 0.999_977_909_503_001_4, 1e-14);
        close(num("erfc", &[n(1.0)]), 0.157_299_207_050_285_13, 1e-13);
        close(num("erfc", &[n(3.0)]) / 2.209_049_699_858_544e-5, 1.0, 1e-12);
        close(num("erfc", &[n(5.0)]) / 1.537_459_794_428_034_8e-12, 1.0, 1e-12);
        close(num("erfc", &[n(-1.0)]), 1.842_700_792_949_715, 1e-14);
        assert!(err("erf", &[s("x")]).contains("must be a number"));
    }

    #[test]
    fn nthroot_like_root() {
        close(num("nthroot", &[n(27.0), n(3.0)]), 3.0, 1e-15);
        close(num("nthroot", &[n(-8.0), n(3.0)]), -2.0, 1e-15);
        let area = Dim::from_ints([2, 0, 0, 0, 0, 0, 0]);
        let Value::Num(q) = ok("nthroot", &[Value::Num(Quantity::new(4.0, area)), n(2.0)]) else { panic!() };
        assert_eq!(q.dim, Dim::from_ints([1, 0, 0, 0, 0, 0, 0]));
        close(q.v, 2.0, 1e-15);
        assert!(err("nthroot", &[n(-4.0), n(2.0)]).contains("no real result"));
        assert!(err("nthroot", &[n(4.0), n(0.0)]).contains("zero"));
        assert!(err("nthroot", &[n(4.0)]).contains("2 arguments"));
    }

    #[test]
    fn perm_comb_fact() {
        assert_eq!(num("perm", &[n(5.0), n(2.0)]), 20.0);
        assert_eq!(num("comb", &[n(5.0), n(2.0)]), 10.0);
        assert_eq!(num("comb", &[n(52.0), n(5.0)]), 2_598_960.0);
        assert_eq!(num("comb", &[n(5.0), n(0.0)]), 1.0);
        assert_eq!(num("perm", &[n(3.0), n(3.0)]), 6.0);
        assert!(err("comb", &[n(2.0), n(3.0)]).contains("0 ≤ k ≤ n"));
        assert!(err("perm", &[n(-1.0), n(0.0)]).contains("0 ≤ k ≤ n"));
        assert!(err("perm", &[n(1000.0), n(500.0)]).contains("too large"));
        assert_eq!(num("fact", &[n(0.0)]), 1.0);
        assert_eq!(num("fact", &[n(5.0)]), 120.0);
        assert!(err("fact", &[n(-1.0)]).contains("≥ 0"));
        assert!(err("fact", &[n(171.0)]).contains("too large"));
        assert!(err("fact", &[n(2.5)]).contains("whole number"));
    }

    #[test]
    fn units_of_quantity() {
        let Value::Num(q) = ok("UnitsOf", &[Value::Num(Quantity::new(5000.0, force()))]) else { panic!() };
        assert_eq!(q, Quantity::new(1.0, force()));
        assert_eq!(ok("UnitsOf", &[n(3.0)]), n(1.0));
        let m = Value::Matrix(Matrix::column(vec![
            Value::Num(Quantity::new(1.0, force())),
            Value::Num(Quantity::new(2.0, force())),
        ]));
        assert_eq!(ok("UnitsOf", &[m]), Value::Num(Quantity::new(1.0, force())));
        assert!(err("UnitsOf", &[s("x")]).contains("must be a number"));
    }

    #[test]
    fn russian_aliases() {
        let cases: [(&str, f64, f64); 13] = [
            ("tg", 0.5, 0.5f64.tan()),
            ("ctg", 0.5, 1.0 / 0.5f64.tan()),
            ("arctg", 0.5, 0.5f64.atan()),
            ("arcctg", 2.0, 0.5f64.atan()),
            ("arcsin", 0.5, 0.5f64.asin()),
            ("arccos", 0.5, 0.5f64.acos()),
            ("sh", 0.5, 0.5f64.sinh()),
            ("ch", 0.5, 0.5f64.cosh()),
            ("th", 0.5, 0.5f64.tanh()),
            ("cth", 0.5, 1.0 / 0.5f64.tanh()),
            ("cosec", 0.5, 1.0 / 0.5f64.sin()),
            ("arcsec", 2.0, 0.5f64.acos()),
            ("arccosec", 2.0, 0.5f64.asin()),
        ];
        for (name, x, want) in cases {
            close(num(name, &[n(x)]), want, 1e-15);
        }
        assert!(err("arcsin", &[n(2.0)]).contains("no real result"));
        assert!(err("tg", &[]).contains("1 argument"));
        assert!(err("ch", &[Value::Num(Quantity::new(1.0, force()))]).contains("plain number"));
    }
}
