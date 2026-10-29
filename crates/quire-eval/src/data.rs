//! Data files carried inside the document, read by SMath's `importData`.
//!
//! The engine never touches the disk: the importer (or the app) copies a spreadsheet's
//! cells into the document's `data` (file → sheet → rows), so a worksheet travels with
//! its tables. `importData("tables.xlsx", "Sheet1", "A4:G20")` reads them back.

use std::collections::HashMap;

use crate::error::{Result, bail};
use crate::value::{Matrix, Value};

/// One spreadsheet cell.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Num(f64),
    Text(String),
}

/// Rows from A1, as stored in the document.
pub type Sheet = Vec<Vec<Cell>>;

/// Files by name (case-insensitive, without folders), each with its sheets in order.
#[derive(Debug, Clone, Default)]
pub struct DataFiles {
    files: HashMap<String, Vec<(String, Sheet)>>,
}

/// `C:\a\Tables.XLSX` → `tables.xlsx`.
fn file_key(name: &str) -> String {
    name.rsplit(['/', '\\']).next().unwrap_or(name).to_lowercase()
}

/// `AB12` → (row 11, column 27) zero-based.
fn cell_ref(s: &str) -> Option<(usize, usize)> {
    let s = s.trim().replace('$', "");
    let letters: String = s.chars().take_while(char::is_ascii_alphabetic).collect();
    let digits = &s[letters.len()..];
    if letters.is_empty() || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let col = letters.to_ascii_uppercase().bytes().fold(0usize, |n, b| n * 26 + (b - b'A' + 1) as usize);
    let row: usize = digits.parse().ok()?;
    (row >= 1).then(|| (row - 1, col - 1))
}

impl DataFiles {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn insert(&mut self, file: &str, sheet: &str, rows: Sheet) {
        let sheets = self.files.entry(file_key(file)).or_default();
        sheets.retain(|(name, _)| !name.eq_ignore_ascii_case(sheet));
        sheets.push((sheet.to_string(), rows));
    }

    /// `importData(file[, sheet[, range]])`: the cells as a matrix (numbers and text;
    /// empty cells are 0). Without a range, the sheet's filled area from A1.
    pub fn import(&self, name: &str, args: &[Value]) -> Result<Value> {
        let text = |i: usize, what: &str| -> Result<Option<String>> {
            match args.get(i) {
                None => Ok(None),
                Some(Value::Str(s)) => Ok(Some(s.clone())),
                Some(v) => bail!("{name}: {what} must be text, not {}", v.kind()),
            }
        };
        let Some(file) = text(0, "the file name")? else {
            bail!("{name} needs a file name: {name}(\"tables.xlsx\", \"Sheet1\", \"A1:C10\")")
        };
        if args.len() > 3 {
            bail!("{name} takes up to 3 arguments: file, sheet and range");
        }
        let Some(sheets) = self.files.get(&file_key(&file)) else {
            bail!(
                "{name}: {file} is not in this document; import the SMath file with {file} next to it so its tables come along"
            )
        };
        let (sheet_name, rows) = match text(1, "the sheet name")? {
            Some(want) => sheets.iter().find(|(n, _)| n.eq_ignore_ascii_case(&want)).ok_or_else(|| {
                let names: Vec<&str> = sheets.iter().map(|(n, _)| n.as_str()).collect();
                crate::error::EvalError::new(format!(
                    "{name}: {file} has no sheet {want} (it has {})",
                    names.join(", ")
                ))
            })?,
            None => {
                sheets.first().ok_or_else(|| crate::error::EvalError::new(format!("{file} has no sheets")))?
            }
        };
        let ((r0, c0), (r1, c1)) = match text(2, "the range")? {
            Some(range) => {
                let mut ends = range.split(':');
                let a = ends.next().and_then(cell_ref);
                let b = ends.next().map_or(a, cell_ref);
                match (a, b, ends.next()) {
                    (Some(a), Some(b), None) => ((a.0.min(b.0), a.1.min(b.1)), (a.0.max(b.0), a.1.max(b.1))),
                    _ => bail!("{name}: '{range}' is not a cell range like A4:G20"),
                }
            }
            None => {
                let filled = |row: &Vec<Cell>| row.iter().rposition(|c| *c != Cell::Empty);
                let last_row = rows.iter().rposition(|r| filled(r).is_some());
                let last_col = rows.iter().filter_map(filled).max();
                match (last_row, last_col) {
                    (Some(r), Some(c)) => ((0, 0), (r, c)),
                    _ => bail!("{name}: sheet {sheet_name} of {file} is empty"),
                }
            }
        };
        let (nr, nc) = (r1 - r0 + 1, c1 - c0 + 1);
        if nr * nc > 1_000_000 {
            bail!("{name}: the range has too many cells ({nr} × {nc})");
        }
        let mut data = Vec::with_capacity(nr * nc);
        for r in r0..=r1 {
            for c in c0..=c1 {
                data.push(match rows.get(r).and_then(|row| row.get(c)) {
                    Some(Cell::Num(v)) => Value::num(*v),
                    Some(Cell::Text(t)) => Value::Str(t.clone()),
                    Some(Cell::Empty) | None => Value::num(0.0),
                });
            }
        }
        Ok(Value::Matrix(Matrix::new(nr, nc, data)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> DataFiles {
        let mut d = DataFiles::default();
        let t = |s: &str| Cell::Text(s.into());
        d.insert(
            "C:\\work\\Tables.xlsx",
            "Shackle",
            vec![
                vec![t("Code"), t("WLL"), Cell::Empty],
                vec![t("G-2130"), Cell::Num(4.75), Cell::Num(13.0)],
                vec![t("G-2140"), Cell::Num(6.5), Cell::Empty],
            ],
        );
        d.insert("tables.xlsx", "Other", vec![vec![Cell::Num(1.0)]]);
        d
    }

    fn s(x: &str) -> Value {
        Value::Str(x.into())
    }

    #[test]
    fn reads_ranges_sheets_and_whole_sheets() {
        let d = files();
        let m = d.import("importData", &[s("TABLES.XLSX"), s("shackle"), s("A2:B3")]).unwrap();
        assert_eq!(
            m,
            Value::Matrix(Matrix::new(
                2,
                2,
                vec![s("G-2130"), Value::num(4.75), s("G-2140"), Value::num(6.5)]
            ))
        );
        let Value::Matrix(all) = d.import("importData", &[s("tables.xlsx")]).unwrap() else { panic!() };
        assert_eq!((all.rows, all.cols), (3, 3), "first sheet, filled area");
        assert_eq!(all.get(2, 2), &Value::num(0.0), "empty cells are 0");
        let Value::Matrix(one) = d.import("importData", &[s("tables.xlsx"), s("Other"), s("$A$1")]).unwrap()
        else {
            panic!()
        };
        assert_eq!((one.rows, one.cols), (1, 1));
    }

    #[test]
    fn explains_what_is_missing() {
        let d = files();
        let e = |args: &[Value]| d.import("importData.XLSX", args).unwrap_err().message;
        assert!(e(&[s("other.xlsx")]).contains("not in this document"));
        assert!(e(&[s("tables.xlsx"), s("Nope")]).contains("it has Shackle, Other"));
        assert!(e(&[s("tables.xlsx"), s("Shackle"), s("4:G")]).contains("not a cell range"));
        assert!(e(&[]).contains("needs a file name"));
        assert_eq!(cell_ref("AB12"), Some((11, 27)));
    }
}
