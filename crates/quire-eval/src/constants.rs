//! Built-in constants (CODATA 2018 / SI exact values where defined).
//!
//! Name resolution for a plain name, in order:
//! 1. a variable defined at that point (yours always wins);
//! 2. right after a number or unit (`2 g`, `100 km/h`): a unit;
//! 3. otherwise a constant, then a unit (`m*g` uses standard gravity).
//!
//! `'g` always means the unit.

use quire_units::Dim;

pub struct Constant {
    pub name: &'static str,
    pub title: &'static str,
    pub value: f64,
    /// SI exponents: L, M, T, I, Θ, N, J.
    pub dim: [i8; 7],
}

const fn k(name: &'static str, title: &'static str, value: f64, dim: [i8; 7]) -> Constant {
    Constant { name, title, value, dim }
}

const NONE: [i8; 7] = [0; 7];

pub static CONSTANTS: &[Constant] = &[
    k("π", "pi", std::f64::consts::PI, NONE),
    k("pi", "pi", std::f64::consts::PI, NONE),
    k("e", "Euler's number", std::f64::consts::E, NONE),
    k("∞", "infinity", f64::INFINITY, NONE),
    k("g", "standard gravity", 9.80665, [1, 0, -2, 0, 0, 0, 0]),
    k("c", "speed of light in vacuum", 299_792_458.0, [1, 0, -1, 0, 0, 0, 0]),
    k("G", "gravitational constant", 6.674_30e-11, [3, -1, -2, 0, 0, 0, 0]),
    k("h", "Planck constant", 6.626_070_15e-34, [2, 1, -1, 0, 0, 0, 0]),
    k("ħ", "reduced Planck constant", 1.054_571_817e-34, [2, 1, -1, 0, 0, 0, 0]),
    k("k.B", "Boltzmann constant", 1.380_649e-23, [2, 1, -2, 0, -1, 0, 0]),
    k("N.A", "Avogadro constant", 6.022_140_76e23, [0, 0, 0, 0, 0, -1, 0]),
    k("R", "molar gas constant", 8.314_462_618, [2, 1, -2, 0, -1, -1, 0]),
    k("q.e", "elementary charge", 1.602_176_634e-19, [0, 0, 1, 1, 0, 0, 0]),
    k("m.e", "electron mass", 9.109_383_701_5e-31, [0, 1, 0, 0, 0, 0, 0]),
    k("m.p", "proton mass", 1.672_621_923_69e-27, [0, 1, 0, 0, 0, 0, 0]),
    k("ε.0", "vacuum permittivity", 8.854_187_812_8e-12, [-3, -1, 4, 2, 0, 0, 0]),
    k("μ.0", "vacuum permeability", 1.256_637_062_12e-6, [1, 1, -2, -2, 0, 0, 0]),
    k("σ.SB", "Stefan–Boltzmann constant", 5.670_374_419e-8, [0, 1, -3, 0, -4, 0, 0]),
    k("ρ.w", "density of water (4 °C)", 999.97, [-3, 1, 0, 0, 0, 0, 0]),
    k("p.atm", "standard atmosphere", 101_325.0, [-1, 1, -2, 0, 0, 0, 0]),
];

pub fn constant(name: &str) -> Option<&'static Constant> {
    CONSTANTS.iter().find(|c| c.name == name)
}

impl Constant {
    pub fn dim(&self) -> Dim {
        Dim::from_ints(self.dim)
    }
}
