//! Units and dimensional analysis for Quire.
//!
//! Every quantity is held in coherent SI with a [`Dim`] of rational exponents, so
//! `sqrt('m^2)` and `'Hz^(1/2)` are representable. Units are looked up at runtime
//! (users type them), with SI prefixes applied to prefixable units.

mod db;
mod dim;
mod rational;

pub use db::{Unit, UnitRegistry};
pub use dim::{BASE_UNITS, Dim, format_product};
pub use rational::Rational;
