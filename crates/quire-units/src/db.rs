//! Built-in unit table. Factors from NIST SP 811 (exact where the definition is exact), and
//! the names of the units as NIST SP 811 spells them.

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
    /// What the unit is called, in words: `degree Celsius`, `kilogram-force`.
    title: &'static str,
    factor: f64,
    dim: [i8; 7],
    prefixable: bool,
    offset: f64,
    /// Only as a quoted unit (`'e`, `'c`): a bare name never means it, so these don't change
    /// what a name means in a document that writes units bare.
    quoted: bool,
}

const fn u(
    names: &'static [&'static str],
    title: &'static str,
    factor: f64,
    dim: [i8; 7],
    prefixable: bool,
) -> Def {
    Def { names, title, factor, dim, prefixable, offset: 0.0, quoted: false }
}

/// A unit or constant SMath Studio writes in its files (`entries/Units.xml`, `Constants.xml`),
/// for the names Quire had no unit for; quoted only.
const fn sm(names: &'static [&'static str], title: &'static str, factor: f64, dim: [i8; 7]) -> Def {
    Def { names, title, factor, dim, prefixable: false, offset: 0.0, quoted: true }
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
const ACCELERATION: [i8; 7] = [1, 0, -2, 0, 0, 0, 0];
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
const CATALYTIC: [i8; 7] = [0, 0, -1, 0, 0, 1, 0];
const DOSE: [i8; 7] = [2, 0, -2, 0, 0, 0, 0];
const ILLUMINANCE: [i8; 7] = [-2, 0, 0, 0, 0, 0, 1];
const PER_AMOUNT: [i8; 7] = [0, 0, 0, 0, 0, -1, 0];

const G0: f64 = 9.80665; // standard gravity, exact
const LB: f64 = 0.45359237; // exact
const LBF: f64 = LB * G0;
const INCH: f64 = 0.0254; // exact

static DEFS: &[Def] = &[
    // SI base and coherent derived
    u(&["m"], "metre", 1.0, LEN, true),
    u(&["g"], "gram", 1e-3, MASS, true),
    u(&["s"], "second", 1.0, TIME, true),
    u(&["A"], "ampere", 1.0, CURRENT, true),
    u(&["K"], "kelvin", 1.0, TEMP, true),
    u(&["mol"], "mole", 1.0, AMOUNT, true),
    u(&["cd"], "candela", 1.0, LUMINOUS, true),
    u(&["N"], "newton", 1.0, FORCE, true),
    u(&["Pa"], "pascal", 1.0, PRESSURE, true),
    u(&["J"], "joule", 1.0, ENERGY, true),
    u(&["W"], "watt", 1.0, POWER, true),
    u(&["C"], "coulomb", 1.0, CHARGE, true),
    u(&["V"], "volt", 1.0, VOLTAGE, true),
    u(&["F"], "farad", 1.0, CAPACITANCE, true),
    u(&["Ω", "ohm"], "ohm", 1.0, RESISTANCE, true),
    u(&["S"], "siemens", 1.0, CONDUCTANCE, true),
    u(&["Wb"], "weber", 1.0, FLUX, true),
    u(&["T"], "tesla", 1.0, FLUX_DENSITY, true),
    u(&["H"], "henry", 1.0, INDUCTANCE, true),
    u(&["Hz"], "hertz", 1.0, FREQUENCY, true),
    // length
    u(&["Å"], "ångström", 1e-10, LEN, false),
    u(&["in", "inch"], "inch", INCH, LEN, false),
    u(&["ft"], "foot", 12.0 * INCH, LEN, false),
    u(&["yd"], "yard", 36.0 * INCH, LEN, false),
    u(&["mi", "mile"], "mile", 63360.0 * INCH, LEN, false),
    u(&["nmi"], "nautical mile", 1852.0, LEN, false),
    u(&["mil", "thou"], "mil", INCH / 1000.0, LEN, false),
    // area, volume
    u(&["ha"], "hectare", 1e4, AREA, false),
    u(&["acre"], "acre", 4046.8564224, AREA, false),
    u(&["L", "l"], "litre", 1e-3, VOLUME, true),
    u(&["gal"], "gallon (US)", 3.785411784e-3, VOLUME, false),
    // mass
    u(&["t", "tonne"], "tonne", 1e3, MASS, false),
    u(&["lb", "lbm"], "pound", LB, MASS, false),
    u(&["oz"], "ounce", LB / 16.0, MASS, false),
    u(&["slug"], "slug", LBF / 0.3048, MASS, false),
    // time
    u(&["min"], "minute", 60.0, TIME, false),
    u(&["h", "hr"], "hour", 3600.0, TIME, false),
    u(&["day"], "day", 86400.0, TIME, false),
    u(&["week"], "week", 604800.0, TIME, false),
    u(&["yr"], "year (Julian)", 31557600.0, TIME, false),
    // velocity, frequency
    u(&["mph"], "mile per hour", 63360.0 * INCH / 3600.0, VELOCITY, false),
    u(&["knot"], "knot", 1852.0 / 3600.0, VELOCITY, false),
    u(&["rpm"], "revolution per minute", 1.0 / 60.0, FREQUENCY, false),
    // force (gravitational units are first-class: kgf = k + gf)
    u(&["gf"], "gram-force", G0 * 1e-3, FORCE, true),
    u(&["tonnef", "tf"], "tonne-force", G0 * 1e3, FORCE, false),
    u(&["lbf"], "pound-force", LBF, FORCE, false),
    u(&["kip"], "kip", LBF * 1e3, FORCE, false),
    u(&["dyn"], "dyne", 1e-5, FORCE, false),
    // pressure
    u(&["bar"], "bar", 1e5, PRESSURE, true),
    u(&["atm"], "standard atmosphere", 101325.0, PRESSURE, false),
    u(&["psi"], "pound-force per square inch", LBF / (INCH * INCH), PRESSURE, false),
    u(&["ksi"], "kip per square inch", LBF * 1e3 / (INCH * INCH), PRESSURE, false),
    u(&["psf"], "pound-force per square foot", LBF / (144.0 * INCH * INCH), PRESSURE, false),
    u(&["mmHg"], "millimetre of mercury", 133.322387415, PRESSURE, false),
    u(&["torr"], "torr", 101325.0 / 760.0, PRESSURE, false),
    // energy, power
    u(&["Wh"], "watt hour", 3600.0, ENERGY, true),
    u(&["cal"], "calorie (thermochemical)", 4.184, ENERGY, true),
    u(&["eV"], "electronvolt", 1.602176634e-19, ENERGY, true),
    u(&["BTU"], "British thermal unit", 1055.05585262, ENERGY, false),
    u(&["erg"], "erg", 1e-7, ENERGY, false),
    u(&["hp"], "horsepower", 745.699_871_582_270_2, POWER, false),
    // angle (dimensionless)
    u(&["rad"], "radian", 1.0, NONE, true),
    u(&["deg", "°"], "degree", PI / 180.0, NONE, false),
    u(&["rev"], "revolution", 2.0 * PI, NONE, false),
    // temperature
    Def { offset: 273.15, ..u(&["°C", "degC"], "degree Celsius", 1.0, TEMP, false) },
    Def { offset: 459.67 * 5.0 / 9.0, ..u(&["°F", "degF"], "degree Fahrenheit", 5.0 / 9.0, TEMP, false) },
    u(&["°R", "degR"], "degree Rankine", 5.0 / 9.0, TEMP, false),
    // SMath Studio's units: factors as SMath defines them
    sm(&["%"], "percent", 0.01, NONE),
    sm(&["‰"], "per mille", 0.001, NONE),
    sm(&["ppm"], "part per million", 1e-06, NONE),
    sm(&["ppb"], "part per billion", 1e-09, NONE),
    sm(&["arcmin"], "minute of arc", 0.0002908882086657216, NONE),
    sm(&["arcsec"], "second of arc", 4.84813681109536e-06, NONE),
    sm(&["grad", "gon"], "gon", 0.015707963267948967, NONE),
    sm(&["rph"], "revolution per hour", 0.0017453292519943296, FREQUENCY),
    sm(&["barn"], "barn", 1e-28, AREA),
    sm(&["a"], "are", 100.0, AREA),
    sm(&["ca"], "centiare", 1.0, AREA),
    sm(&["daa"], "decare", 1000.0, AREA),
    sm(&["farad"], "farad", 1.0, CAPACITANCE),
    sm(&["kat", "katal"], "katal", 1.0, CATALYTIC),
    sm(&["Fr", "statC"], "statcoulomb", 3.3356409500000003e-10, CHARGE),
    sm(&["Fd", "faraday"], "faraday", 96485.3328959, CHARGE),
    sm(&["Gy", "Sv"], "gray", 1.0, DOSE),
    sm(&["Gi"], "gilbert", 0.7957747154594768, CURRENT),
    sm(&["joule"], "joule", 1.0, ENERGY),
    sm(&["dyne"], "dyne", 1e-05, FORCE),
    sm(&["tonf"], "ton-force (short)", 8896.443230521, FORCE),
    sm(&["radpm"], "radian per minute", 0.016666666666666666, FREQUENCY),
    sm(&["lx"], "lux", 1.0, ILLUMINANCE),
    sm(&["klx"], "kilolux", 1000.0, ILLUMINANCE),
    sm(&["henry"], "henry", 1.0, INDUCTANCE),
    sm(&["micron"], "micrometre", 1e-06, LEN),
    sm(&["Angstrom"], "ångström", 1e-10, LEN),
    sm(&["bohr"], "bohr radius", 5.291772108e-11, LEN),
    sm(&["au"], "astronomical unit", 149597870700.0, LEN),
    sm(&["ly"], "light year", 9460730472580800.0, LEN),
    sm(&["pc"], "parsec", 3.08567758149137e+16, LEN),
    sm(&["furlong"], "furlong", 201.168, LEN),
    sm(&["Smoot"], "smoot", 1.7018, LEN),
    sm(&["tesla"], "tesla", 1.0, FLUX_DENSITY),
    sm(&["G", "gauss"], "gauss", 0.0001, FLUX_DENSITY),
    sm(&["gram"], "gram", 0.001, MASS),
    sm(&["ct"], "carat (metric)", 0.0002, MASS),
    sm(&["ton"], "ton (short)", 907.1847399999999, MASS),
    sm(&["ounce"], "ounce", 0.028349523125, MASS),
    sm(&["lb.m", "pound"], "pound", 0.45359236999999997, MASS),
    sm(&["volt"], "volt", 1.0, VOLTAGE),
    sm(&["watt"], "watt", 1.0, POWER),
    sm(&["hhp"], "hydraulic horsepower", 746.043, POWER),
    sm(&["inHg"], "inch of mercury", 3386.3889999999997, PRESSURE),
    sm(&["kpsi"], "kilopound-force per square inch", 6894757.293168359, PRESSURE),
    sm(&["ksf"], "kip per square foot", 47880.2589803358, PRESSURE),
    sm(&["dpi"], "dot per inch", 39.37007874015748, [-1, 0, 0, 0, 0, 0, 0]),
    sm(&["atom"], "atom", 1.6605391e-24, AMOUNT),
    sm(&["lbmol"], "pound-mole", 453.59236999999996, AMOUNT),
    sm(&["°Ra"], "degree Rankine", 0.5555555555555556, TEMP),
    sm(&["Δ°C"], "degree Celsius (difference)", 1.0, TEMP),
    sm(&["Δ°Re"], "degree Réaumur (difference)", 1.25, TEMP),
    sm(&["Δ°F"], "degree Fahrenheit (difference)", 0.5555555555555556, TEMP),
    Def { offset: 273.15, ..sm(&["°Re"], "degree Réaumur", 1.25, TEMP) },
    // SMath's 'yr: the Gregorian year ('yr here is the Julian one)
    sm(&["yr.Gregorian"], "year (Gregorian)", 365.2425 * 86400.0, TIME),
    sm(&["sec"], "second", 1.0, TIME),
    sm(&["month"], "month", 2629746.0, TIME),
    sm(&["kph"], "kilometre per hour", 0.2777777777777778, VELOCITY),
    sm(&["kn"], "knot", 0.514444, VELOCITY),
    sm(&["P", "poise"], "poise", 0.1, [-1, 1, -1, 0, 0, 0, 0]),
    sm(&["St", "stokes"], "stokes", 0.0001, [2, 0, -1, 0, 0, 0, 0]),
    sm(&["Bq"], "becquerel", 1.0, FREQUENCY),
    sm(&["kBq"], "kilobecquerel", 1000.0, FREQUENCY),
    sm(&["MBq"], "megabecquerel", 1000000.0, FREQUENCY),
    sm(&["GBq"], "gigabecquerel", 1000000000.0, FREQUENCY),
    sm(&["Ci"], "curie", 37000000000.0, FREQUENCY),
    sm(&["μCi"], "microcurie", 37000.0, FREQUENCY),
    sm(&["mCi"], "millicurie", 37000000.0, FREQUENCY),
    sm(&["sr"], "steradian", 1.0, NONE),
    sm(&["lm"], "lumen", 1.0, LUMINOUS),
    sm(&["klm"], "kilolumen", 1000.0, LUMINOUS),
    sm(&["Mx"], "maxwell", 1e-08, FLUX),
    sm(&["D"], "debye", 3.3356409500000006e-30, [1, 0, 1, 1, 0, 0, 0]),
    sm(&["den"], "denier", 1.11e-07, [-1, 1, 0, 0, 0, 0, 0]),
    sm(&["Oe"], "oersted", 79.5775, [-1, 0, 0, 1, 0, 0, 0]),
    sm(&["sb"], "stilb", 10000.0, ILLUMINANCE),
    sm(&["nt"], "nit", 1.0, ILLUMINANCE),
    // SMath's 'cal and 'kcal: the International Table calorie ('cal here is the thermochemical one)
    sm(&["cal.IT"], "calorie (International Table)", 4.1868, ENERGY),
    sm(&["kcal.IT"], "kilocalorie (International Table)", 4186.8, ENERGY),
    // SMath Studio's constants, which its files write as units: the values of constants.rs
    // (CODATA 2018). SMath's 'h is the Planck constant, here 'ℎ, since 'h is the hour.
    sm(&["g.e"], "standard acceleration of gravity", G0, ACCELERATION),
    sm(&["c"], "speed of light in vacuum", 299_792_458.0, VELOCITY),
    sm(&["e"], "elementary charge", 1.602_176_634e-19, CHARGE),
    sm(&["m.e"], "electron mass", 9.109_383_701_5e-31, MASS),
    sm(&["m.p"], "proton mass", 1.672_621_923_69e-27, MASS),
    sm(&["m.n"], "neutron mass", 1.674_927_498_04e-27, MASS),
    sm(&["u"], "unified atomic mass unit", 1.660_539_066_60e-27, MASS),
    sm(&["ε.0"], "vacuum electric permittivity", 8.854_187_812_8e-12, [-3, -1, 4, 2, 0, 0, 0]),
    sm(&["G.N"], "Newtonian constant of gravitation", 6.674_30e-11, [3, -1, -2, 0, 0, 0, 0]),
    sm(&["ℎ"], "Planck constant", 6.626_070_15e-34, [2, 1, -1, 0, 0, 0, 0]),
    sm(&["N.A"], "Avogadro constant", 6.022_140_76e23, PER_AMOUNT),
    sm(&["μ.0"], "vacuum magnetic permeability", 1.256_637_062_12e-6, [1, 1, -2, -2, 0, 0, 0]),
    sm(&["R.m"], "molar gas constant", 8.314_462_618, [2, 1, -2, 0, -1, -1, 0]),
    sm(&["k"], "Boltzmann constant", 1.380_649e-23, [2, 1, -2, 0, -1, 0, 0]),
];

/// What a quantity of each dimension is called, and the named coherent SI unit for it when
/// there is one (results without an explicit unit are shown in it). Keyed by dimension, so a
/// unit's quantity follows from what it measures: `kgf` and `N` are both forces.
struct Kind {
    dim: [i8; 7],
    quantity: &'static str,
    si: Option<&'static str>,
}

const fn kind(dim: [i8; 7], quantity: &'static str, si: Option<&'static str>) -> Kind {
    Kind { dim, quantity, si }
}

/// The named units first, in the order results prefer them.
static KINDS: &[Kind] = &[
    kind(FORCE, "force", Some("N")),
    kind(PRESSURE, "pressure, stress", Some("Pa")),
    kind(ENERGY, "energy, moment", Some("J")),
    kind(POWER, "power", Some("W")),
    kind(CHARGE, "electric charge", Some("C")),
    kind(VOLTAGE, "voltage", Some("V")),
    kind(CAPACITANCE, "capacitance", Some("F")),
    kind(RESISTANCE, "resistance", Some("Ω")),
    kind(CONDUCTANCE, "conductance", Some("S")),
    kind(FLUX, "magnetic flux", Some("Wb")),
    kind(FLUX_DENSITY, "magnetic flux density", Some("T")),
    kind(INDUCTANCE, "inductance", Some("H")),
    kind(LEN, "length", None),
    kind(MASS, "mass", None),
    kind(TIME, "time", None),
    kind(CURRENT, "electric current", None),
    kind(TEMP, "temperature", None),
    kind(AMOUNT, "amount of substance", None),
    kind(LUMINOUS, "luminous intensity", None),
    kind(AREA, "area", None),
    kind(VOLUME, "volume", None),
    kind([4, 0, 0, 0, 0, 0, 0], "second moment of area", None),
    kind(VELOCITY, "velocity", None),
    kind(ACCELERATION, "acceleration", None),
    kind(FREQUENCY, "frequency", None),
    kind([0, 1, -2, 0, 0, 0, 0], "force per length", None),
    kind([-2, 1, -2, 0, 0, 0, 0], "unit weight", None),
    kind([-3, 1, 0, 0, 0, 0, 0], "density", None),
    kind([-1, 1, 0, 0, 0, 0, 0], "linear density", None),
    kind([-1, 1, -1, 0, 0, 0, 0], "dynamic viscosity", None),
    kind([2, 0, -1, 0, 0, 0, 0], "kinematic viscosity", None),
    kind(CATALYTIC, "catalytic activity", None),
    kind(DOSE, "absorbed dose", None),
    kind(ILLUMINANCE, "illuminance, luminance", None),
    kind([1, 0, 1, 1, 0, 0, 0], "electric dipole moment", None),
    kind([-1, 0, 0, 1, 0, 0, 0], "magnetic field strength", None),
    kind([-1, 0, 0, 0, 0, 0, 0], "per length", None),
    kind(PER_AMOUNT, "per amount of substance", None),
    kind([-3, -1, 4, 2, 0, 0, 0], "permittivity", None),
    kind([1, 1, -2, -2, 0, 0, 0], "permeability", None),
    kind([2, 1, -1, 0, 0, 0, 0], "action", None),
    kind([2, 1, -2, 0, -1, 0, 0], "heat capacity", None),
    kind([2, 1, -2, 0, -1, -1, 0], "molar heat capacity", None),
];

/// What a quantity of dimension `dim` is called (`force`, `temperature`), when it has a
/// common name. Dimensionless quantities (angles, ratios) have none.
pub fn quantity_of(dim: Dim) -> Option<&'static str> {
    KINDS.iter().find(|k| Dim::from_ints(k.dim) == dim).map(|k| k.quantity)
}

/// An SI prefix: its symbol, factor and word, and whether engineers use it every day (kN, mm,
/// MPa, μm, cm, GPa), which ranks the units written with it next to unprefixed ones.
#[derive(Debug)]
pub struct Prefix {
    pub symbol: &'static str,
    pub factor: f64,
    pub word: &'static str,
    pub common: bool,
    /// Another way to type a prefix listed before it (`u`, `µ` for `μ`).
    pub spelling: bool,
}

const fn px(symbol: &'static str, factor: f64, word: &'static str, common: bool) -> Prefix {
    Prefix { symbol, factor, word, common, spelling: false }
}

const fn alt(symbol: &'static str, factor: f64, word: &'static str) -> Prefix {
    Prefix { symbol, factor, word, common: false, spelling: true }
}

/// Two-letter `da` first so it wins over `d`.
pub static PREFIXES: &[Prefix] = &[
    px("da", 1e1, "deca", false),
    px("Q", 1e30, "quetta", false),
    px("R", 1e27, "ronna", false),
    px("Y", 1e24, "yotta", false),
    px("Z", 1e21, "zetta", false),
    px("E", 1e18, "exa", false),
    px("P", 1e15, "peta", false),
    px("T", 1e12, "tera", false),
    px("G", 1e9, "giga", true),
    px("M", 1e6, "mega", true),
    px("k", 1e3, "kilo", true),
    px("h", 1e2, "hecto", false),
    px("d", 1e-1, "deci", false),
    px("c", 1e-2, "centi", true),
    px("m", 1e-3, "milli", true),
    px("μ", 1e-6, "micro", true),
    alt("µ", 1e-6, "micro"),
    alt("u", 1e-6, "micro"),
    px("n", 1e-9, "nano", false),
    px("p", 1e-12, "pico", false),
    px("f", 1e-15, "femto", false),
    px("a", 1e-18, "atto", false),
    px("z", 1e-21, "zepto", false),
    px("y", 1e-24, "yocto", false),
    px("r", 1e-27, "ronto", false),
    px("q", 1e-30, "quecto", false),
];

/// Name → (unit, prefixable, quoted only).
fn table() -> &'static HashMap<&'static str, (Unit, bool, bool)> {
    static TABLE: OnceLock<HashMap<&'static str, (Unit, bool, bool)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = HashMap::new();
        for d in DEFS {
            for name in d.names {
                t.insert(*name, (d.unit(), d.prefixable, d.quoted));
            }
        }
        t
    })
}

impl Def {
    fn unit(&self) -> Unit {
        Unit { factor: self.factor, dim: Dim::from_ints(self.dim), offset: self.offset }
    }
}

/// A built-in unit as the editor lists it: every definition, and every prefixed form of the
/// prefixable ones (`kN`, `mm`), named from its prefix and base (`kilonewton`).
#[derive(Debug, Clone)]
pub struct UnitInfo {
    /// How it is written: `kN`, `°C`, `Ω`.
    pub symbol: String,
    /// Other spellings of the same unit: `degC`, `ohm`, `um` for `μm`.
    pub aliases: Vec<String>,
    /// What it is called: `kilonewton`, `degree Celsius`.
    pub title: String,
    /// What it measures (`force`), from its dimension.
    pub quantity: Option<&'static str>,
    pub unit: Unit,
    /// It takes SI prefixes (`N`, `Pa`; not `ft`).
    pub prefixable: bool,
    /// Only written quoted (SMath's `'%`, `'c`).
    pub quoted: bool,
    /// The prefix it is written with, if any.
    pub prefix: Option<&'static Prefix>,
}

/// Every built-in unit with its name and quantity, definitions first, then the prefixed forms.
pub fn catalog() -> &'static [UnitInfo] {
    static CATALOG: OnceLock<Vec<UnitInfo>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let reg = UnitRegistry::new();
        let mut out: Vec<UnitInfo> = DEFS
            .iter()
            .map(|d| UnitInfo {
                symbol: d.names[0].to_string(),
                aliases: d.names[1..].iter().map(|n| n.to_string()).collect(),
                title: d.title.to_string(),
                quantity: quantity_of(Dim::from_ints(d.dim)),
                unit: d.unit(),
                prefixable: d.prefixable,
                quoted: d.quoted,
                prefix: None,
            })
            .collect();
        let defined = table();
        for d in DEFS.iter().filter(|d| d.prefixable) {
            for p in PREFIXES.iter().filter(|p| !p.spelling) {
                let symbol = format!("{}{}", p.symbol, d.names[0]);
                // a defined name (`min`) or one that reads as another unit is not a prefixed form
                let same = |n: &str| {
                    reg.lookup(n).is_some_and(|u| u.dim == d.unit().dim && !defined.contains_key(n))
                };
                if !same(&symbol) {
                    continue;
                }
                let spellings = PREFIXES.iter().filter(|q| q.factor == p.factor).map(|q| q.symbol);
                let aliases = spellings
                    .flat_map(|q| d.names.iter().map(move |n| format!("{q}{n}")))
                    .filter(|n| *n != symbol && same(n))
                    .collect();
                out.push(UnitInfo {
                    symbol,
                    aliases,
                    title: format!("{}{}", p.word, d.title),
                    quantity: quantity_of(Dim::from_ints(d.dim)),
                    unit: Unit { factor: d.factor * p.factor, ..d.unit() },
                    prefixable: false,
                    quoted: false,
                    prefix: Some(p),
                });
            }
        }
        out
    })
}

/// The catalog entry written `name` (symbol or alias), if it is a built-in unit.
pub fn unit_info(name: &str) -> Option<&'static UnitInfo> {
    static INDEX: OnceLock<HashMap<String, usize>> = OnceLock::new();
    let index = INDEX.get_or_init(|| {
        let mut m = HashMap::new();
        for (i, info) in catalog().iter().enumerate() {
            for n in std::iter::once(&info.symbol).chain(&info.aliases) {
                m.entry(n.clone()).or_insert(i);
            }
        }
        m
    });
    index.get(name).and_then(|&i| catalog().get(i))
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
        PREFIXES.iter().find_map(|p| {
            let base = name.strip_prefix(p.symbol)?;
            match t.get(base) {
                Some((u, true, _)) => Some(Unit { factor: u.factor * p.factor, ..*u }),
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
                let unit = d.unit();
                d.names.iter().map(move |n| (*n, unit, d.prefixable))
            })
            .collect();
        out.sort_by_key(|(n, ..)| n.to_lowercase());
        out
    }

    /// Named coherent SI units used when displaying results without an explicit unit.
    pub fn named_si() -> &'static [(&'static str, Dim)] {
        static NAMED: OnceLock<Vec<(&'static str, Dim)>> = OnceLock::new();
        NAMED.get_or_init(|| KINDS.iter().filter_map(|k| k.si.map(|n| (n, Dim::from_ints(k.dim)))).collect())
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

    #[test]
    fn every_unit_has_a_full_name() {
        let unnamed: Vec<&str> =
            DEFS.iter().filter(|d| d.title.trim().is_empty()).map(|d| d.names[0]).collect();
        assert!(unnamed.is_empty(), "units without a full name: {unnamed:?}");
        assert!(catalog().iter().all(|i| !i.title.is_empty()));
    }

    #[test]
    fn prefixed_units_are_named_from_their_parts() -> Result<(), String> {
        let title = |n: &str| unit_info(n).map(|i| i.title.clone()).ok_or(format!("no {n}"));
        assert_eq!(title("kN")?, "kilonewton");
        assert_eq!(title("kgf")?, "kilogram-force");
        assert_eq!(title("MPa")?, "megapascal");
        assert_eq!(title("um")?, "micrometre", "u is a way to type μ");
        assert_eq!(title("°C")?, "degree Celsius");
        assert_eq!(title("ohm")?, "ohm");
        assert_eq!(title("min")?, "minute", "a defined name is not milli-inch");
        // every prefixed form means what lookup says it means
        let r = UnitRegistry::new();
        for i in catalog() {
            for n in std::iter::once(&i.symbol).chain(&i.aliases) {
                let u = unit(&r, n)?;
                assert!(close(u.factor, i.unit.factor) && u.dim == i.unit.dim, "{n}");
            }
        }
        Ok(())
    }

    #[test]
    fn quantities_follow_the_dimension() {
        let q = |n: &str| unit_info(n).and_then(|i| i.quantity);
        assert_eq!(q("°C"), Some("temperature"));
        assert_eq!(q("kgf"), Some("force"));
        assert_eq!(q("psi"), Some("pressure, stress"));
        assert_eq!(q("C"), Some("electric charge"));
        assert_eq!(q("rad"), None, "angles are dimensionless");
        let named: Vec<&str> = UnitRegistry::named_si().iter().map(|(n, _)| *n).collect();
        assert_eq!(named, ["N", "Pa", "J", "W", "C", "V", "F", "Ω", "S", "Wb", "T", "H"]);
    }
}
