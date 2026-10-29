use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct EvalError {
    pub message: String,
}

impl EvalError {
    pub fn new(message: impl Into<String>) -> Self {
        EvalError { message: message.into() }
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EvalError {}

impl From<quire_ast::ParseError> for EvalError {
    fn from(e: quire_ast::ParseError) -> Self {
        EvalError::new(format!("syntax error: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, EvalError>;

macro_rules! bail {
    ($($t:tt)*) => { return Err($crate::error::EvalError::new(format!($($t)*))) };
}
pub(crate) use bail;

/// For a value the code's own shapes guarantee to be there. It reports an engine bug
/// rather than panicking, and is never caused by the user's input.
pub(crate) fn internal(what: &str) -> EvalError {
    EvalError::new(format!("internal error: {what} has an unexpected shape"))
}
