use quire_units::Dim;

use crate::error::{Result, bail};

/// A magnitude in coherent SI units plus its dimension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quantity {
    pub v: f64,
    pub dim: Dim,
}

impl Quantity {
    pub fn new(v: f64, dim: Dim) -> Self {
        Quantity { v, dim }
    }

    pub fn scalar(v: f64) -> Self {
        Quantity { v, dim: Dim::NONE }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(Quantity),
    Str(String),
    Matrix(Matrix),
}

/// Row-major; elements may mix numbers and strings (e.g. a report table).
#[derive(Debug, Clone, PartialEq)]
pub struct Matrix {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<Value>,
}

impl Matrix {
    pub fn new(rows: usize, cols: usize, data: Vec<Value>) -> Self {
        debug_assert_eq!(rows * cols, data.len());
        Matrix { rows, cols, data }
    }

    pub fn column(data: Vec<Value>) -> Self {
        Matrix { rows: data.len(), cols: 1, data }
    }

    /// 0-based.
    pub fn get(&self, r: usize, c: usize) -> &Value {
        &self.data[r * self.cols + c]
    }

    pub fn is_vector(&self) -> bool {
        self.rows == 1 || self.cols == 1
    }
}

impl Value {
    pub fn num(v: f64) -> Value {
        Value::Num(Quantity::scalar(v))
    }

    pub fn bool(b: bool) -> Value {
        Value::num(if b { 1.0 } else { 0.0 })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Value::Num(_) => "a number",
            Value::Str(_) => "a string",
            Value::Matrix(_) => "a matrix",
        }
    }

    pub fn as_num(&self, what: &str) -> Result<Quantity> {
        match self {
            Value::Num(q) => Ok(*q),
            other => bail!("{what} must be a number, not {}", other.kind()),
        }
    }

    /// Dimensionless number.
    pub fn as_scalar(&self, what: &str) -> Result<f64> {
        let q = self.as_num(what)?;
        if !q.dim.is_dimensionless() {
            bail!("{what} must be a plain number, but it is {}", crate::format::describe_dim(q.dim));
        }
        Ok(q.v)
    }

    /// Dimensionless whole number (indices, counts, loop bounds).
    pub fn as_int(&self, what: &str) -> Result<i64> {
        let x = self.as_scalar(what)?;
        if x.fract() != 0.0 || x.abs() > 1e15 {
            bail!("{what} must be a whole number, got {x}");
        }
        Ok(x as i64)
    }

    pub fn truthy(&self) -> Result<bool> {
        Ok(self.as_num("a condition")?.v != 0.0)
    }
}
