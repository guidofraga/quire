//! Built-in unit table. Factors from NIST SP 811 (exact where the definition is exact).

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::OnceLock;

use crate::Dim;

/// A resolved unit: `value_SI = number * factor + offset`.
/// `offset` is non-zero only for absolute temperature scales (°C, °F).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unit {
    pub factor: f64,
    pub dim: Dim,
    pub offset: f64,
}

struct Def {
    names: &'static [&'static str],
    factor: f64,
    dim: [i8; 7],
    prefixable: bool,
    offset: f64,
    /// Only as a quoted unit (`'e`, `'c`): a bare name never means it, so these don't change
    /// what a name means in a document that writes units bare.
    quoted: bool,
}

const fn u(names: &'static [&'static str], factor: f64, dim: [i8; 7], prefixable: bool) -> Def {
    Def { names, factor, dim, prefixable, offset: 0.0, quoted: false }
}

/// A unit or constant SMath Studio writes in its files (`entries/Units.xml`, `Constants.xml`),
/// for the names Quire had no unit for; quoted only.
const fn sm(names: &'static [&'static str], factor: f64, dim: [i8; 7]) -> Def {
    Def { names, factor, dim, prefixable: false, offset: 0.0, quoted: true }
}

//                         L  M  T  I  Θ  N  J
const NONE: [i8; 7] = [0, 0, 0, 0, 0, 0, 0];
const LEN: [i8; 7] = [1, 0, 0, 0, 0, 0, 0];
const MASS: [i8; 7] = [0, 1, 0, 0, 0, 0, 0];
const TIME: [i8; 7] = [0, 0, 1, 0, 0, 0, 0];
const CURRENT: [i8; 7] = [0, 0, 0, 1, 0, 0, 0];
const TEMP: [i8; 7] = [0, 0, 0, 0, 1, 0, 0];
const AMOUNT: [i8; 7] = [0, 0, 0, 0, 0, 1, 0];
const LUMINOUS: [i8; 7] = [0, 0, 0, 0, 0, 0, 1];
const AREA: [i8; 7] = [2, 0, 0, 0, 0, 0, 0];
const VOLUME: [i8; 7] = [3, 0, 0, 0, 0, 0, 0];
const VELOCITY: [i8; 7] = [1, 0, -1, 0, 0, 0, 0];
const FREQUENCY: [i8; 7] = [0, 0, -1, 0, 0, 0, 0];
pub(crate) const FORCE: [i8; 7] = [1, 1, -2, 0, 0, 0, 0];
pub(crate) const PRESSURE: [i8; 7] = [-1, 1, -2, 0, 0, 0, 0];
pub(crate) const ENERGY: [i8; 7] = [2, 1, -2, 0, 0, 0, 0];
pub(crate) const POWER: [i8; 7] = [2, 1, -3, 0, 0, 0, 0];
pub(crate) const CHARGE: [i8; 7] = [0, 0, 1, 1, 0, 0, 0];
pub(crate) const VOLTAGE: [i8; 7] = [2, 1, -3, -1, 0, 0, 0];
pub(crate) const CAPACITANCE: [i8; 7] = [-2, -1, 4, 2, 0, 0, 0];
pub(crate) const RESISTANCE: [i8; 7] = [2, 1, -3, -2, 0, 0, 0];
pub(crate) const CONDUCTANCE: [i8; 7] = [-2, -1, 3, 2, 0, 0, 0];
pub(crate) const FLUX: [i8; 7] = [2, 1, -2, -1, 0, 0, 0];
pub(crate) const FLUX_DENSITY: [i8; 7] = [0, 1, -2, -1, 0, 0, 0];
pub(crate) const INDUCTANCE: [i8; 7] = [2, 1, -2, -2, 0, 0, 0];

const G0: f64 = 9.80665; // standard gravity, exact
const LB: f64 = 0.45359237; // exact
const LBF: f64 = LB * G0;
const INCH: f64 = 0.0254; // exact

static DEFS: &[Def] = &[
    // SI base and coherent derived
    u(&["m"], 1.0, LEN, true),
    u(&["g"], 1e-3, MASS, true),
    u(&["s"], 1.0, TIME, true),
    u(&["A"], 1.0, CURRENT, true),
    u(&["K"], 1.0, TEMP, true),
    u(&["mol"], 1.0, AMOUNT, true),
    u(&["cd"], 1.0, LUMINOUS, true),
    u(&["N"], 1.0, FORCE, true),
    u(&["Pa"], 1.0, PRESSURE, true),
    u(&["J"], 1.0, ENERGY, true),
    u(&["W"], 1.0, POWER, true),
    u(&["C"], 1.0, CHARGE, true),
    u(&["V"], 1.0, VOLTAGE, true),
    u(&["F"], 1.0, CAPACITANCE, true),
    u(&["Ω", "ohm"], 1.0, RESISTANCE, true),
    u(&["S"], 1.0, CONDUCTANCE, true),
    u(&["Wb"], 1.0, FLUX, true),
    u(&["T"], 1.0, FLUX_DENSITY, true),
    u(&["H"], 1.0, INDUCTANCE, true),
    u(&["Hz"], 1.0, FREQUENCY, true),
    // length
    u(&["Å"], 1e-10, LEN, false),
    u(&["in", "inch"], INCH, LEN, false),
    u(&["ft"], 12.0 * INCH, LEN, false),
    u(&["yd"], 36.0 * INCH, LEN, false),
    u(&["mi", "mile"], 63360.0 * INCH, LEN, false),
    u(&["nmi"], 1852.0, LEN, false),
    u(&["mil", "thou"], INCH / 1000.0, LEN, false),
    // area, volume
    u(&["ha"], 1e4, AREA, false),
    u(&["acre"], 4046.8564224, AREA, false),
    u(&["L", "l"], 1e-3, VOLUME, true),
    u(&["gal"], 3.785411784e-3, VOLUME, false),
    // mass
    u(&["t", "tonne"], 1e3, MASS, false),
    u(&["lb", "lbm"], LB, MASS, false),
    u(&["oz"], LB / 16.0, MASS, false),
    u(&["slug"], LBF / 0.3048, MASS, false),
    // time
    u(&["min"], 60.0, TIME, false),
    u(&["h", "hr"], 3600.0, TIME, false),
    u(&["day"], 86400.0, TIME, false),
    u(&["week"], 604800.0, TIME, false),
    u(&["yr"], 31557600.0, TIME, false),
    // velocity, frequency
    u(&["mph"], 63360.0 * INCH / 3600.0, VELOCITY, false),
    u(&["knot"], 1852.0 / 3600.0, VELOCITY, false),
    u(&["rpm"], 1.0 / 60.0, FREQUENCY, false),
    // force (gravitational units are first-class: kgf = k + gf)
    u(&["gf"], G0 * 1e-3, FORCE, true),
    u(&["tonnef", "tf"], G0 * 1e3, FORCE, false),
    u(&["lbf"], LBF, FORCE, false),
    u(&["kip"], LBF * 1e3, FORCE, false),
    u(&["dyn"], 1e-5, FORCE, false),
    // pressure
    u(&["bar"], 1e5, PRESSURE, true),
    u(&["atm"], 101325.0, PRESSURE, false),
    u(&["psi"], LBF / (INCH * INCH), PRESSURE, false),
    u(&["ksi"], LBF * 1e3 / (INCH * INCH), PRESSURE, false),
    u(&["psf"], LBF / (144.0 * INCH * INCH), PRESSURE, false),
    u(&["mmHg"], 133.322387415, PRESSURE, false),
    u(&["torr"], 101325.0 / 760.0, PRESSURE, false),
    // energy, power
    u(&["Wh"], 3600.0, ENERGY, true),
    u(&["cal"], 4.184, ENERGY, true),
    u(&["eV"], 1.602176634e-19, ENERGY, true),
    u(&["BTU"], 1055.05585262, ENERGY, false),
    u(&["erg"], 1e-7, ENERGY, false),
    u(&["hp"], 745.699_871_582_270_2, POWER, false),
    // angle (dimensionless)
    u(&["rad"], 1.0, NONE, true),
    u(&["deg", "°"], PI / 180.0, NONE, false),
    u(&["rev"], 2.0 * PI, NONE, false),
    // temperature
    Def { offset: 273.15, ..u(&["°C", "degC"], 1.0, TEMP, false) },
    Def { offset: 459.67 * 5.0 / 9.0, ..u(&["°F", "degF"], 5.0 / 9.0, TEMP, false) },
    u(&["°R", "degR"], 5.0 / 9.0, TEMP, false),
    // SMath Studio's units: factors as SMath defines them
    sm(&["%"], 0.01, NONE),
    sm(&["‰"], 0.001, NONE),
    sm(&["ppm"], 1e-06, NONE),
    sm(&["ppb"], 1e-09, NONE),
    sm(&["arcmin"], 0.0002908882086657216, NONE),
    sm(&["arcsec"], 4.84813681109536e-06, NONE),
    sm(&["grad", "gon"], 0.015707963267948967, NONE),
    sm(&["rph"], 0.0017453292519943296, FREQUENCY),
    sm(&["barn"], 1e-28, AREA),
    sm(&["a"], 100.0, AREA),
    sm(&["ca"], 1.0, AREA),
    sm(&["daa"], 1000.0, AREA),
    sm(&["farad"], 1.0, CAPACITANCE),
    sm(&["kat", "katal"], 1.0, [0, 0, -1, 0, 0, 1, 0]),
    sm(&["Fr", "statC"], 3.3356409500000003e-10, CHARGE),
    sm(&["Fd", "faraday"], 96485.3328959, CHARGE),
    sm(&["Gy", "Sv"], 1.0, [2, 0, -2, 0, 0, 0, 0]),
    sm(&["Gi"], 0.7957747154594768, CURRENT),
    sm(&["joule"], 1.0, ENERGY),
    sm(&["dyne"], 1e-05, FORCE),
    sm(&["tonf"], 8896.443230521, FORCE),
    sm(&["radpm"], 0.016666666666666666, FREQUENCY),
    sm(&["lx"], 1.0, [-2, 0, 0, 0, 0, 0, 1]),
    sm(&["klx"], 1000.0, [-2, 0, 0, 0, 0, 0, 1]),
    sm(&["henry"], 1.0, INDUCTANCE),
    sm(&["micron"], 1e-06, LEN),
    sm(&["Angstrom"], 1e-10, LEN),
    sm(&["bohr"], 5.291772108e-11, LEN),
    sm(&["au"], 149597870700.0, LEN),
    sm(&["ly"], 9460730472580800.0, LEN),
    sm(&["pc"], 3.08567758149137e+16, LEN),
    sm(&["furlong"], 201.168, LEN),
    sm(&["Smoot"], 1.7018, LEN),
    sm(&["tesla"], 1.0, FLUX_DENSITY),
    sm(&["G", "gauss"], 0.0001, FLUX_DENSITY),
    sm(&["gram"], 0.001, MASS),
    sm(&["ct"], 0.0002, MASS),
    sm(&["ton"], 907.1847399999999, MASS),
    sm(&["ounce"], 0.028349523125, MASS),
    sm(&["lb.m", "pound"], 0.45359236999999997, MASS),
    sm(&["volt"], 1.0, VOLTAGE),
    sm(&["watt"], 1.0, POWER),
    sm(&["hhp"], 746.043, POWER),
    sm(&["inHg"], 3386.3889999999997, PRESSURE),
    sm(&["kpsi"], 6894757.293168359, PRESSURE),
    sm(&["ksf"], 47880.2589803358, PRESSURE),
    sm(&["dpi"], 39.37007874015748, [-1, 0, 0, 0, 0, 0, 0]),
    sm(&["atom"], 1.6605391e-24, [0, 0, 0, 0, 0, 1, 0]),
    sm(&["lbmol"], 453.59236999999996, [0, 0, 0, 0, 0, 1, 0]),
    sm(&["°Ra"], 0.5555555555555556, TEMP),
    sm(&["Δ°C"], 1.0, TEMP),
    sm(&["Δ°Re"], 1.25, TEMP),
    sm(&["Δ°F"], 0.5555555555555556, TEMP),
    Def { offset: 273.15, ..sm(&["°Re"], 1.25, TEMP) },
    // SMath's 'yr: the Gregorian year ('yr here is the Julian one)
    sm(&["yr.Gregorian"], 365.2425 * 86400.0, TIME),
    sm(&["sec"], 1.0, TIME),
    sm(&["month"], 2629746.0, TIME),
    sm(&["kph"], 0.2777777777777778, VELOCITY),
    sm(&["kn"], 0.514444, VELOCITY),
    sm(&["P", "poise"], 0.1, [-1, 1, -1, 0, 0, 0, 0]),
    sm(&["St", "stokes"], 0.0001, [2, 0, -1, 0, 0, 0, 0]),
    sm(&["Bq"], 1.0, FREQUENCY),
    sm(&["kBq"], 1000.0, FREQUENCY),
    sm(&["MBq"], 1000000.0, FREQUENCY),
    sm(&["GBq"], 1000000000.0, FREQUENCY),
    sm(&["Ci"], 37000000000.0, FREQUENCY),
    sm(&["μCi"], 37000.0, FREQUENCY),
    sm(&["mCi"], 37000000.0, FREQUENCY),
    sm(&["sr"], 1.0, NONE),
    sm(&["lm"], 1.0, LUMINOUS),
    sm(&["klm"], 1000.0, LUMINOUS),
    sm(&["Mx"], 1e-08, FLUX),
    sm(&["D"], 3.3356409500000006e-30, [1, 0, 1, 1, 0, 0, 0]),
    sm(&["den"], 1.11e-07, [-1, 1, 0, 0, 0, 0, 0]),
    sm(&["Oe"], 79.5775, [-1, 0, 0, 1, 0, 0, 0]),
    sm(&["sb"], 10000.0, [-2, 0, 0, 0, 0, 0, 1]),
    sm(&["nt"], 1.0, [-2, 0, 0, 0, 0, 0, 1]),
    // SMath's 'cal and 'kcal: the International Table calorie ('cal here is the thermochemical one)
    sm(&["cal.IT"], 4.1868, ENERGY),
    sm(&["kcal.IT"], 4186.8, ENERGY),
    // SMath Studio's constants, which its files write as units: the values of constants.rs
    // (CODATA 2018). SMath's 'h is the Planck constant, here 'ℎ, since 'h is the hour.
    sm(&["g.e"], G0, [1, 0, -2, 0, 0, 0, 0]),
    sm(&["c"], 299_792_458.0, VELOCITY),
    sm(&["e"], 1.602_176_634e-19, CHARGE),
    sm(&["m.e"], 9.109_383_701_5e-31, MASS),
    sm(&["m.p"], 1.672_621_923_69e-27, MASS),
    sm(&["m.n"], 1.674_927_498_04e-27, MASS),
    sm(&["u"], 1.660_539_066_60e-27, MASS),
    sm(&["ε.0"], 8.854_187_812_8e-12, [-3, -1, 4, 2, 0, 0, 0]),
    sm(&["G.N"], 6.674_30e-11, [3, -1, -2, 0, 0, 0, 0]),
    sm(&["ℎ"], 6.626_070_15e-34, [2, 1, -1, 0, 0, 0, 0]),
    sm(&["N.A"], 6.022_140_76e23, [0, 0, 0, 0, 0, -1, 0]),
    sm(&["μ.0"], 1.256_637_062_12e-6, [1, 1, -2, -2, 0, 0, 0]),
    sm(&["R.m"], 8.314_462_618, [2, 1, -2, 0, -1, -1, 0]),
    sm(&["k"], 1.380_649e-23, [2, 1, -2, 0, -1, 0, 0]),
];

/// Two-letter `da` first so it wins over `d`.
static PREFIXES: &[(&str, f64)] = &[
    ("da", 1e1),
    ("Q", 1e30),
    ("R", 1e27),
    ("Y", 1e24),
    ("Z", 1e21),
    ("E", 1e18),
    ("P", 1e15),
    ("T", 1e12),
    ("G", 1e9),
    ("M", 1e6),
    ("k", 1e3),
    ("h", 1e2),
    ("d", 1e-1),
    ("c", 1e-2),
    ("m", 1e-3),
    ("μ", 1e-6),
    ("µ", 1e-6),
    ("u", 1e-6),
    ("n", 1e-9),
    ("p", 1e-12),
    ("f", 1e-15),
    ("a", 1e-18),
    ("z", 1e-21),
    ("y", 1e-24),
    ("r", 1e-27),
    ("q", 1e-30),
];

/// Name → (unit, prefixable, quoted only).
fn table() -> &'static HashMap<&'static str, (Unit, bool, bool)> {
    static TABLE: OnceLock<HashMap<&'static str, (Unit, bool, bool)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = HashMap::new();
        for d in DEFS {
            let unit = Unit { factor: d.factor, dim: Dim::from_ints(d.dim), offset: d.offset };
            for name in d.names {
                t.insert(*name, (unit, d.prefixable, d.quoted));
            }
        }
        t
    })
}

/// Built-in units plus a document's custom ones (`"units": { "tf": "1000 'kgf" }`).
#[derive(Debug, Clone, Default)]
pub struct UnitRegistry {
    custom: HashMap<String, Unit>,
}

impl UnitRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn define(&mut self, name: impl Into<String>, unit: Unit) {
        self.custom.insert(name.into(), unit);
    }

    /// Resolve a unit name: custom, then exact built-in, then prefix + prefixable built-in.
    pub fn lookup(&self, name: &str) -> Option<Unit> {
        if let Some(u) = self.custom.get(name) {
            return Some(*u);
        }
        let t = table();
        if let Some((u, ..)) = t.get(name) {
            return Some(*u);
        }
        PREFIXES.iter().find_map(|(p, scale)| {
            let base = name.strip_prefix(p)?;
            match t.get(base) {
                Some((u, true, _)) => Some(Unit { factor: u.factor * scale, ..*u }),
                _ => None,
            }
        })
    }

    /// [`lookup`](Self::lookup) for a bare name (`5 kN`): units that are only written quoted
    /// (SMath's `'e`, `'c`, `'%`) are left out.
    pub fn lookup_bare(&self, name: &str) -> Option<Unit> {
        match table().get(name) {
            Some((_, _, true)) if !self.custom.contains_key(name) => None,
            _ => self.lookup(name),
        }
    }

    /// Every built-in unit name (aliases included) with its definition, for the symbol library.
    pub fn builtin() -> Vec<(&'static str, Unit, bool)> {
        let mut out: Vec<_> = DEFS
            .iter()
            .filter(|d| !d.quoted)
            .flat_map(|d| {
                let unit = Unit { factor: d.factor, dim: Dim::from_ints(d.dim), offset: d.offset };
                d.names.iter().map(move |n| (*n, unit, d.prefixable))
            })
            .collect();
        out.sort_by_key(|(n, ..)| n.to_lowercase());
        out
    }

    /// Named coherent SI units used when displaying results without an explicit unit.
    pub fn named_si() -> &'static [(&'static str, Dim)] {
        static NAMED: OnceLock<Vec<(&'static str, Dim)>> = OnceLock::new();
        NAMED.get_or_init(|| {
            [
                ("N", FORCE),
                ("Pa", PRESSURE),
                ("J", ENERGY),
                ("W", POWER),
                ("C", CHARGE),
                ("V", VOLTAGE),
                ("F", CAPACITANCE),
                ("Ω", RESISTANCE),
                ("S", CONDUCTANCE),
                ("Wb", FLUX),
                ("T", FLUX_DENSITY),
                ("H", INDUCTANCE),
            ]
            .into_iter()
            .map(|(n, d)| (n, Dim::from_ints(d)))
            .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
    }

    fn unit(r: &UnitRegistry, name: &str) -> Result<Unit, String> {
        r.lookup(name).ok_or_else(|| format!("unknown unit {name}"))
    }

    #[test]
    fn prefixes_and_exact_names() -> Result<(), String> {
        let r = UnitRegistry::new();
        assert!(close(unit(&r, "mm")?.factor, 1e-3));
        assert!(close(unit(&r, "kg")?.factor, 1.0));
        assert!(close(unit(&r, "kgf")?.factor, 9.80665));
        assert!(close(unit(&r, "tonnef")?.factor, 9806.65));
        assert!(close(unit(&r, "MPa")?.factor, 1e6));
        assert!(close(unit(&r, "min")?.factor, 60.0)); // not milli-inch
        assert!(close(unit(&r, "dam")?.factor, 10.0));
        assert!(close(unit(&r, "μm")?.factor, 1e-6));
        assert_eq!(unit(&r, "cd")?.dim, Dim::from_ints(LUMINOUS));
        assert!(r.lookup("kft").is_none(), "ft is not prefixable");
        assert!(r.lookup("nope").is_none());
        Ok(())
    }

    #[test]
    fn imperial() -> Result<(), String> {
        let r = UnitRegistry::new();
        assert!(close(unit(&r, "lbf")?.factor, 4.4482216152605));
        assert!(close(unit(&r, "psi")?.factor, 6894.757293168361));
        assert!(close(unit(&r, "°F")?.offset, 255.37222222222223));
        Ok(())
    }
}
