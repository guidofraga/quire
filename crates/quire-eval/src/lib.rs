//! Quire numeric kernel and worksheet evaluator.
//!
//! - [`Value`]: numbers carry SI magnitude + [`quire_units::Dim`]; matrices and strings.
//! - [`Interp`]: evaluates one expression in a [`Scope`].
//! - [`Worksheet`]: SMath/Mathcad document semantics — regions run in reading order,
//!   a definition is visible below it, `≡` global definitions are visible everywhere.

mod builtins;
mod constants;
mod error;
mod format;
mod interp;
mod ops;
mod value;
mod worksheet;

pub use constants::{CONSTANTS, Constant, constant};
pub use error::{EvalError, Result};
pub use format::{DisplaySettings, DisplaySpec, format_number, format_value, parse_unit_spec};
pub use interp::{Binding, Env, Interp, Scope};
pub use value::{Matrix, Quantity, Value};
pub use worksheet::{MathInput, Outcome, Worksheet};
