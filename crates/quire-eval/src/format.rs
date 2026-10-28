//! Result display: numbers rounded per the document/region settings, units either
//! forced by the region (SMath's "contract") or chosen from coherent SI.
//! Output is linear syntax, so it can be parsed back (`results.json`).

use quire_ast::{Expr, parse, print, quote_str};
use quire_units::{BASE_UNITS, Dim, Rational, Unit, UnitRegistry, format_product};

use crate::error::{Result, bail};
use crate::interp::{Env, Interp, Scope};
use crate::value::{Quantity, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct DisplaySettings {
    pub decimals: u32,
    /// Magnitudes ≥ 10^threshold are shown in scientific notation.
    pub exponential_threshold: i32,
    pub trailing_zeros: bool,
    /// Show results in the units the document is written in (`54 kN*m`) rather than
    /// coherent SI (`54000 J`). `"resultUnits": "working"` in a document.
    pub working_units: bool,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        DisplaySettings { decimals: 4, exponential_threshold: 5, trailing_zeros: false, working_units: false }
    }
}

/// A unit the document's author typed, in order of preference (most used first).
#[derive(Debug, Clone)]
pub struct WorkingUnit {
    pub name: String,
    pub unit: Unit,
}

/// The simplest way to write `dim` with the author's units: one unit (`MPa`), one unit
/// to a power (`m^2`, `cm^4`) or two units (`kN*m`, `kN/m`). Returns (factor, linear text).
pub fn working_unit(dim: Dim, vocab: &[WorkingUnit]) -> Option<(f64, String)> {
    const POWERS: [i32; 8] = [1, 2, 3, 4, -1, -2, -3, -4];
    let pow = |u: &WorkingUnit, k: i32| u.unit.dim.pow(Rational::int(k));
    // ((complexity, preference rank), [(unit index, power)]): lower scores are better
    type Candidate = ((i32, usize), Vec<(usize, i32)>);
    let mut found: Vec<Candidate> = Vec::new();
    for (i, a) in vocab.iter().enumerate() {
        for ka in POWERS {
            if pow(a, ka) == dim {
                found.push(((ka.abs(), i), vec![(i, ka)]));
            }
        }
        for (j, b) in vocab.iter().enumerate().skip(i + 1) {
            if a.unit.dim == b.unit.dim {
                continue; // `kN/N` is not a way to write anything
            }
            for ka in POWERS {
                for kb in POWERS {
                    if pow(a, ka) * pow(b, kb) == dim {
                        found.push(((ka.abs() + kb.abs(), i + j), vec![(i, ka), (j, kb)]));
                    }
                }
            }
        }
    }
    let (_, mut best) = found.into_iter().min_by_key(|(score, _)| *score)?;
    // `kN*m`, `kN/m`, `MPa*m`: lengths go after forces, stresses and the rest
    let is_length = |i: usize| vocab[i].unit.dim == Dim::from_ints([1, 0, 0, 0, 0, 0, 0]);
    best.sort_by_key(|&(i, _)| is_length(i));
    let factor = best.iter().map(|&(i, k)| vocab[i].unit.factor.powi(k)).product();
    let parts: Vec<(&str, Rational)> =
        best.iter().map(|&(i, k)| (vocab[i].name.as_str(), Rational::int(k))).collect();
    Some((factor, format_product(&parts, true)))
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
pub(crate) fn si_unit(dim: Dim) -> String {
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

/// A dimension in words for messages: "a length (m)", "a stress (Pa)", "a quantity in kg*m".
pub fn describe_dim(dim: Dim) -> String {
    if dim.is_dimensionless() {
        return "a plain number".to_string();
    }
    const NAMES: &[([i8; 7], &str)] = &[
        ([1, 0, 0, 0, 0, 0, 0], "a length"),
        ([2, 0, 0, 0, 0, 0, 0], "an area"),
        ([3, 0, 0, 0, 0, 0, 0], "a volume"),
        ([4, 0, 0, 0, 0, 0, 0], "a second moment of area"),
        ([0, 1, 0, 0, 0, 0, 0], "a mass"),
        ([0, 0, 1, 0, 0, 0, 0], "a time"),
        ([0, 0, -1, 0, 0, 0, 0], "a frequency"),
        ([1, 0, -1, 0, 0, 0, 0], "a speed"),
        ([1, 0, -2, 0, 0, 0, 0], "an acceleration"),
        ([1, 1, -2, 0, 0, 0, 0], "a force"),
        ([0, 1, -2, 0, 0, 0, 0], "a force per length"),
        ([-1, 1, -2, 0, 0, 0, 0], "a pressure or stress"),
        ([-2, 1, -2, 0, 0, 0, 0], "a unit weight"),
        ([2, 1, -2, 0, 0, 0, 0], "an energy or moment"),
        ([2, 1, -3, 0, 0, 0, 0], "a power"),
        ([-3, 1, 0, 0, 0, 0, 0], "a density"),
        ([0, 0, 0, 1, 0, 0, 0], "an electric current"),
        ([0, 0, 0, 0, 1, 0, 0], "a temperature"),
    ];
    let unit = si_unit(dim).replace('\'', "");
    match NAMES.iter().find(|(d, _)| Dim::from_ints(*d) == dim) {
        Some((_, name)) => format!("{name} ({unit})"),
        None => format!("a quantity in {unit}"),
    }
}

pub fn format_value(
    v: &Value,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
) -> Result<String> {
    format_value_in(v, spec, settings, units, &[])
}

/// [`format_value`], preferring the author's units when `settings.working_units` is on.
pub fn format_value_in(
    v: &Value,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
    vocab: &[WorkingUnit],
) -> Result<String> {
    match v {
        Value::Num(q) => format_quantity(*q, spec, settings, units, vocab),
        Value::Str(s) => Ok(quote_str(s)),
        Value::Matrix(m) => {
            let mut rows = Vec::with_capacity(m.rows);
            for r in 0..m.rows {
                let cells = (0..m.cols)
                    .map(|c| format_value_in(m.get(r, c), spec, settings, units, vocab))
                    .collect::<Result<Vec<_>>>()?;
                rows.push(cells.join(", "));
            }
            Ok(format!("[{}]", rows.join("; ")))
        }
    }
}

/// A result shown in the unit its region asks for. A unit of another kind keeps the rest
/// in SI, as SMath does: a force shown in kg reads `9.81 kg*m/s^2`.
pub fn format_shown(
    v: &Value,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
) -> Result<String> {
    if let (Value::Num(q), Some(u)) = (v, spec.unit.as_deref()) {
        let us = parse_unit_spec(u, units)?;
        if us.dim != q.dim && us.offset == 0.0 && !us.text.is_empty() {
            let d = spec.decimals.unwrap_or(settings.decimals);
            let rest = si_unit(q.dim / us.dim);
            let text = match rest.strip_prefix("1/") {
                Some(denominator) => format!("{}/{denominator}", us.text),
                None if rest.is_empty() => us.text.clone(),
                None => format!("{}*{rest}", us.text),
            };
            return Ok(join(format_number(q.v / us.factor, d, settings), &text));
        }
    }
    format_value(v, spec, settings, units)
}

fn format_quantity(
    q: Quantity,
    spec: &DisplaySpec,
    settings: &DisplaySettings,
    units: &UnitRegistry,
    vocab: &[WorkingUnit],
) -> Result<String> {
    let d = spec.decimals.unwrap_or(settings.decimals);
    if let Some(u) = spec.unit.as_deref() {
        let us = parse_unit_spec(u, units)?;
        if us.dim != q.dim {
            bail!("the display unit {u} doesn't fit this result, which is {}", describe_dim(q.dim));
        }
        return Ok(join(format_number((q.v - us.offset) / us.factor, d, settings), &us.text));
    }
    if q.dim.is_dimensionless() {
        return Ok(format_number(q.v, d, settings));
    }
    if settings.working_units
        && let Some((factor, text)) = working_unit(q.dim, vocab)
    {
        return Ok(join(format_number(q.v / factor, d, settings), &text));
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
        // shown in a unit of another kind, the rest stays in SI (SMath)
        assert_eq!(format_shown(&force, &spec("kg"), &s, &r).unwrap(), "17651.97 'kg*'m/'s^2");
        assert_eq!(format_shown(&moment, &spec("kN"), &s, &r).unwrap(), "0.01 'kN*'m");
        assert_eq!(format_shown(&line, &spec("kN"), &s, &r).unwrap(), "0.01 'kN/'m");
        assert!(
            format_shown(&force, &spec("°C"), &s, &r).is_err(),
            "a scale with an offset can't carry other units"
        );
    }
}
