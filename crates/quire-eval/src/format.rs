//! Result display: numbers rounded per the document/region settings, units either
//! forced by the region (SMath's "contract") or chosen from coherent SI.
//! Output is linear syntax, so it can be parsed back (`results.json`).

use quire_ast::{Expr, parse, print, quote_str};
use quire_units::{BASE_UNITS, Dim, Rational, UnitRegistry, format_product};

use crate::error::{Result, bail};
use crate::interp::{Env, Interp, Scope};
use crate::value::{Quantity, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct DisplaySettings {
    pub decimals: u32,
    /// Magnitudes ≥ 10^threshold are shown in scientific notation.
    pub exponential_threshold: i32,
    pub trailing_zeros: bool,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        DisplaySettings { decimals: 4, exponential_threshold: 5, trailing_zeros: false }
    }
}

/// Per-region overrides (`"display": { "unit": "kgf", "decimals": 2 }`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DisplaySpec {
    pub unit: Option<String>,
    pub decimals: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnitSpec {
    pub factor: f64,
    pub dim: Dim,
    pub offset: f64,
    /// Linear syntax with unit markers, e.g. `'kgf/'m^2`; empty for plain numbers.
    pub text: String,
}

fn as_units(e: Expr) -> Expr {
    let b = |x: Box<Expr>| Box::new(as_units(*x));
    match e {
        Expr::Ident(n) => Expr::Unit(n),
        Expr::Paren(x) => Expr::Paren(b(x)),
        Expr::Unary(op, x) => Expr::Unary(op, b(x)),
        Expr::Binary(op, l, r) if op == quire_ast::BinaryOp::Pow => Expr::Binary(op, b(l), r),
        Expr::Binary(op, l, r) => Expr::Binary(op, b(l), b(r)),
        other => other,
    }
}

/// Parse a display unit written without markers: `kgf`, `kgf/m^2`, `cm^2`, `°C`.
pub fn parse_unit_spec(spec: &str, units: &UnitRegistry) -> Result<UnitSpec> {
    let spec = spec.trim();
    if spec.is_empty() || spec == "1" {
        return Ok(UnitSpec { factor: 1.0, dim: Dim::NONE, offset: 0.0, text: String::new() });
    }
    let expr = match units.lookup(spec) {
        Some(_) => Expr::Unit(spec.to_string()),
        None => as_units(parse(spec)?),
    };
    let env = Env::new();
    let q = Interp::new(units).eval(&mut Scope::new(&env), &expr)?.as_num("a display unit")?;
    let offset = match &expr {
        Expr::Unit(n) => units.lookup(n).map_or(0.0, |u| u.offset),
        _ => 0.0,
    };
    Ok(UnitSpec { factor: q.v, dim: q.dim, offset, text: print(&expr) })
}

fn trim_zeros(s: String) -> String {
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
}

pub fn format_number(x: f64, decimals: u32, settings: &DisplaySettings) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "∞" } else { "-∞" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let d = decimals.min(15) as usize;
    let fixed = |v: f64| {
        let s = format!("{v:.d$}");
        if settings.trailing_zeros { s } else { trim_zeros(s) }
    };
    let ax = x.abs();
    let scale = 10f64.powi(d as i32);
    let rounded = (ax * scale).round() / scale;
    if rounded >= 10f64.powi(settings.exponential_threshold)
        || rounded == 0.0
        || ax < 10f64.powi(-settings.exponential_threshold)
    {
        let mut e = ax.log10().floor() as i32;
        let mut m = fixed(x / 10f64.powi(e));
        if m.trim_start_matches('-').starts_with("10") {
            e += 1;
            m = fixed(x / 10f64.powi(e));
        }
        return format!("{m}*10^{e}");
    }
    let s = fixed(x);
    if s == "-0" { "0".into() } else { s }
}

fn join(num: String, unit: &str) -> String {
    if unit.is_empty() {
        num
    } else if let Some(rest) = unit.strip_prefix("1/") {
        format!("{num}/{rest}")
    } else if num.contains("*10^") {
        format!("{num}*{unit}") // `1.2*10^5 'm` would parse as 10^(5 m)
    } else {
        format!("{num} {unit}")
    }
}

/// Coherent SI spelling for a dimension: a named unit (N, Pa, J…), a named unit
/// times a power of metres (N*m, N/m), or base units.
fn si_unit(dim: Dim) -> String {
    let named = UnitRegistry::named_si();
    if let Some((n, _)) = named.iter().find(|(_, d)| *d == dim) {
        return format!("'{n}");
    }
    let base = dim.parts();
    // mechanics (mass and time involved): prefer N/m, N*m, Pa*m… over kg/s^2
    let mechanical = !dim.0[1].is_zero() && !dim.0[2].is_zero();
    if mechanical {
        let metre = Dim::from_ints([1, 0, 0, 0, 0, 0, 0]);
        for (n, d) in named {
            for k in [1, -1, 2, -2, 3, -3] {
                if *d * metre.pow(Rational::int(k)) == dim {
                    return format_product(&[(n, Rational::ONE), (BASE_UNITS[0], Rational::int(k))], true);
                }
            }
        }
    }
    format_product(&base, true)
}

pub fn format_value(
    v: &Value,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
) -> Result<String> {
    match v {
        Value::Num(q) => format_quantity(*q, spec, settings, units),
        Value::Str(s) => Ok(quote_str(s)),
        Value::Matrix(m) => {
            let mut rows = Vec::with_capacity(m.rows);
            for r in 0..m.rows {
                let cells = (0..m.cols)
                    .map(|c| format_value(m.get(r, c), spec, settings, units))
                    .collect::<Result<Vec<_>>>()?;
                rows.push(cells.join(", "));
            }
            Ok(format!("[{}]", rows.join("; ")))
        }
    }
}

fn format_quantity(
    q: Quantity,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
) -> Result<String> {
    let d = spec.decimals.unwrap_or(settings.decimals);
    if let Some(u) = spec.unit.as_deref() {
        let us = parse_unit_spec(u, units)?;
        if us.dim != q.dim {
            bail!("the display unit '{u}' doesn't fit this result, whose units are {}", q.dim);
        }
        return Ok(join(format_number((q.v - us.offset) / us.factor, d, settings), &us.text));
    }
    if q.dim.is_dimensionless() {
        return Ok(format_number(q.v, d, settings));
    }
    Ok(join(format_number(q.v, d, settings), &si_unit(q.dim)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        let s = DisplaySettings::default();
        assert_eq!(format_number(25.5, 2, &s), "25.5");
        assert_eq!(format_number(2.0, 4, &s), "2");
        assert_eq!(format_number(2.5612496949731396, 2, &s), "2.56");
        assert_eq!(format_number(856.9, 0, &s), "857");
        assert_eq!(format_number(-0.0001, 2, &s), "-1*10^-4");
        assert_eq!(format_number(123456.0, 2, &s), "1.23*10^5");
        assert_eq!(format_number(99999.996, 2, &s), "1*10^5");
        let tz = DisplaySettings { trailing_zeros: true, ..s };
        assert_eq!(format_number(2.0, 2, &tz), "2.00");
    }

    #[test]
    fn units() {
        let r = UnitRegistry::new();
        let spec = |u: &str| DisplaySpec { unit: Some(u.into()), decimals: Some(2) };
        let force = Value::Num(Quantity::new(9.80665 * 1800.0, Dim::from_ints([1, 1, -2, 0, 0, 0, 0])));
        let s = DisplaySettings::default();
        assert_eq!(format_value(&force, &spec("kgf"), &s, &r).unwrap(), "1800 'kgf");
        assert_eq!(format_value(&force, &DisplaySpec::default(), &s, &r).unwrap(), "17651.97 'N");
        let moment = Value::Num(Quantity::new(10.0, Dim::from_ints([2, 1, -2, 0, 0, 0, 0])));
        assert_eq!(format_value(&moment, &spec("kgf*m"), &s, &r).unwrap(), "1.02 'kgf*'m");
        let line = Value::Num(Quantity::new(5.0, Dim::from_ints([0, 1, -2, 0, 0, 0, 0])));
        assert_eq!(format_value(&line, &DisplaySpec::default(), &s, &r).unwrap(), "5 'N/'m");
        let hz = Value::Num(Quantity::new(5.0, Dim::from_ints([0, 0, -1, 0, 0, 0, 0])));
        assert_eq!(format_value(&hz, &DisplaySpec::default(), &s, &r).unwrap(), "5/'s");
        let temp = Value::Num(Quantity::new(293.15, Dim::from_ints([0, 0, 0, 0, 1, 0, 0])));
        assert_eq!(format_value(&temp, &spec("°C"), &s, &r).unwrap(), "20 '°C");
        assert!(format_value(&temp, &spec("m"), &s, &r).is_err());
    }
}
