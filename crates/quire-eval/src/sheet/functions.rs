//! Spreadsheet functions: SUM, IF, VLOOKUP, INDEX/MATCH and the rest.

use super::*;

fn count_error(name: &str, want: &str) -> EvalError {
    EvalError::new(format!("{name} takes {want}"))
}

impl Sheet<'_, '_, '_> {
    /// An argument as rows of values (a single value is a 1×1 range; matrices spread out).
    fn rows(&mut self, f: &F) -> Result<Vec<Vec<CV>>> {
        Ok(match self.eval_any(f)? {
            Got::Many(rows) => rows,
            Got::One(CV::V(Value::Matrix(m))) => {
                (0..m.rows).map(|r| (0..m.cols).map(|c| CV::V(m.get(r, c).clone())).collect()).collect()
            }
            Got::One(v) => vec![vec![v]],
        })
    }

    /// Every value of the arguments, flattened; `true` marks values from ranges.
    fn spread(&mut self, args: &[F]) -> Result<Vec<(CV, bool)>> {
        let mut out = Vec::new();
        for a in args {
            // values reached through references are skipped when they are text, as
            // spreadsheets do; only what is typed into the call itself must be a number
            let ranged = matches!(a, F::Range(..) | F::Ext(..) | F::Lit(_) | F::Cell(..) | F::Quire(_));
            for row in self.rows(a)? {
                for v in row {
                    out.push((v, ranged));
                }
            }
        }
        Ok(out)
    }

    /// The numbers among the arguments, as spreadsheets count them: text and blanks in
    /// ranges are skipped, true/false typed directly count as 1/0.
    fn numbers(&mut self, name: &str, args: &[F]) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        for (v, ranged) in self.spread(args)? {
            match v {
                CV::Blank => {}
                CV::Bool(b) if !ranged => out.push(Value::bool(b)),
                CV::Bool(_) => {}
                CV::V(Value::Str(s)) if ranged || s.is_empty() => {}
                CV::V(Value::Str(s)) => bail!("{name}: \"{s}\" is text, not a number"),
                CV::V(Value::Matrix(_)) => bail!("{name}: nested matrices are not supported"),
                CV::V(v) => out.push(v),
            }
        }
        Ok(out)
    }

    fn one(&mut self, name: &str, args: &[F], k: usize) -> Result<Quantity> {
        self.eval(&args[k])?.value().as_num(&format!("the argument of {name}"))
    }

    fn scalar(&mut self, name: &str, args: &[F], k: usize) -> Result<f64> {
        self.eval(&args[k])?.value().as_scalar(&format!("the argument of {name}"))
    }

    pub(super) fn call(&mut self, name: &str, args: &[F]) -> Result<CV> {
        let up = name.to_ascii_uppercase();
        let n = args.len();
        let arity = |lo: usize, hi: usize, want: &str| -> Result<()> {
            if n < lo || n > hi { Err(count_error(&up, want)) } else { Ok(()) }
        };
        let num = |x: f64| Ok(CV::V(Value::num(x)));
        let with_dim = |x: f64, q: Quantity| Ok(CV::V(Value::Num(Quantity::new(x, q.dim))));
        match up.as_str() {
            // logic
            "IF" => {
                arity(2, 3, "a condition and one or two values")?;
                return if self.eval(&args[0])?.truthy()? {
                    self.eval(&args[1])
                } else if n == 3 {
                    self.eval(&args[2])
                } else {
                    Ok(CV::Bool(false))
                };
            }
            "IFS" => {
                if n == 0 || n % 2 == 1 {
                    return Err(count_error(&up, "pairs of a condition and a value"));
                }
                for pair in args.chunks(2) {
                    if self.eval(&pair[0])?.truthy()? {
                        return self.eval(&pair[1]);
                    }
                }
                bail!("IFS: no condition holds");
            }
            "IFERROR" => {
                arity(2, 2, "a value and what to show on an error")?;
                return self.eval(&args[0]).or_else(|_| self.eval(&args[1]));
            }
            "AND" | "OR" | "XOR" => {
                let mut vals = Vec::new();
                for (v, _) in self.spread(args)? {
                    if !matches!(v, CV::Blank) {
                        vals.push(v.truthy()?);
                    }
                }
                let hits = vals.iter().filter(|b| **b).count();
                return Ok(CV::Bool(match up.as_str() {
                    "AND" => hits == vals.len(),
                    "OR" => hits > 0,
                    _ => hits % 2 == 1,
                }));
            }
            "NOT" => {
                arity(1, 1, "one value")?;
                return Ok(CV::Bool(!self.eval(&args[0])?.truthy()?));
            }
            "TRUE" | "FALSE" if n == 0 => return Ok(CV::Bool(up == "TRUE")),
            "CHOOSE" => {
                if n < 2 {
                    return Err(count_error(&up, "an index and the values to choose from"));
                }
                let i = self.eval(&args[0])?.value().as_int("the index of CHOOSE")?;
                if i < 1 || i as usize >= n {
                    bail!("CHOOSE: the index {i} is not between 1 and {}", n - 1);
                }
                return self.eval(&args[i as usize]);
            }
            // aggregates
            "SUM" | "PRODUCT" | "AVERAGE" | "MIN" | "MAX" | "MEDIAN" => {
                let vals = self.numbers(&up, args)?;
                return aggregate(&up, vals).map(CV::V);
            }
            "COUNT" => return num(self.numbers(&up, args).map(|v| v.len())? as f64),
            "COUNTA" => {
                return num(self.spread(args)?.iter().filter(|(v, _)| !matches!(v, CV::Blank)).count() as f64);
            }
            "COUNTBLANK" => {
                return num(self.spread(args)?.iter().filter(|(v, _)| matches!(v, CV::Blank)).count() as f64);
            }
            "SUMPRODUCT" => {
                if n == 0 {
                    return Err(count_error(&up, "one or more ranges of the same size"));
                }
                let ranges = args.iter().map(|a| self.rows(a)).collect::<Result<Vec<_>>>()?;
                let shape = |r: &Vec<Vec<CV>>| (r.len(), r.first().map_or(0, Vec::len));
                if ranges.iter().any(|r| shape(r) != shape(&ranges[0])) {
                    bail!("SUMPRODUCT: the ranges must have the same size");
                }
                let mut total: Option<Value> = None;
                let (h, w) = shape(&ranges[0]);
                for r in 0..h {
                    for c in 0..w {
                        let mut p = Value::num(1.0);
                        for range in &ranges {
                            p = arith(BinaryOp::Mul, &p, &range[r][c].value())?;
                        }
                        total = Some(match total {
                            None => p,
                            Some(t) => arith(BinaryOp::Add, &t, &p)?,
                        });
                    }
                }
                return Ok(CV::V(total.unwrap_or(Value::num(0.0))));
            }
            "SUMIF" | "COUNTIF" | "AVERAGEIF" => {
                let (lo, hi) = if up == "COUNTIF" { (2, 2) } else { (2, 3) };
                arity(lo, hi, "a range, a criterion and optionally the range to add up")?;
                let test: Vec<CV> = self.rows(&args[0])?.into_iter().flatten().collect();
                let crit = self.eval(&args[1])?;
                let values: Vec<CV> =
                    if n == 3 { self.rows(&args[2])?.into_iter().flatten().collect() } else { test.clone() };
                let mut picked = Vec::new();
                for (i, v) in test.iter().enumerate() {
                    if criterion(&crit, v, self.interp, self.scope)? {
                        picked.push(values.get(i).cloned().unwrap_or(CV::Blank));
                    }
                }
                if up == "COUNTIF" {
                    return num(picked.len() as f64);
                }
                let vals: Vec<Value> = picked
                    .into_iter()
                    .filter_map(|v| match v {
                        CV::V(Value::Num(q)) => Some(Value::Num(q)),
                        _ => None,
                    })
                    .collect();
                return aggregate(if up == "SUMIF" { "SUM" } else { "AVERAGE" }, vals).map(CV::V);
            }
            // numbers
            "ROUND" | "ROUNDUP" | "ROUNDDOWN" => {
                arity(1, 2, "a number and the decimals to keep")?;
                let q = self.one(&up, args, 0)?;
                let d = if n == 2 { self.scalar(&up, args, 1)? as i32 } else { 0 };
                let f = 10f64.powi(d);
                let x = q.v * f;
                let r = match up.as_str() {
                    "ROUND" => x.round(),
                    "ROUNDUP" => x.abs().ceil() * x.signum(),
                    _ => x.trunc(),
                };
                return with_dim(r / f, q);
            }
            "INT" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return with_dim(q.v.floor(), q);
            }
            "TRUNC" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return with_dim(q.v.trunc(), q);
            }
            "CEILING" | "FLOOR" => {
                arity(1, 2, "a number and the step to round to")?;
                let q = self.one(&up, args, 0)?;
                let step = if n == 2 { self.one(&up, args, 1)? } else { Quantity::new(1.0, q.dim) };
                if step.dim != q.dim {
                    bail!("{up}: the step must be in the same kind of unit as the number");
                }
                if step.v == 0.0 {
                    return with_dim(0.0, q);
                }
                let k = q.v / step.v;
                // nudge away floating-point noise so 0.3/0.1 rounds to 3, not 4
                let k = if (k - k.round()).abs() < 1e-9 { k.round() } else { k };
                let k = if up == "CEILING" { k.ceil() } else { k.floor() };
                return with_dim(k * step.v, q);
            }
            "MOD" => {
                arity(2, 2, "a number and a divisor")?;
                let a = self.one(&up, args, 0)?;
                let b = self.one(&up, args, 1)?;
                if a.dim != b.dim && !b.dim.is_dimensionless() {
                    bail!("MOD: the divisor must be in the same kind of unit");
                }
                if b.v == 0.0 {
                    bail!("MOD: division by zero");
                }
                return with_dim(a.v - b.v * (a.v / b.v).floor(), a);
            }
            "POWER" => {
                arity(2, 2, "a number and an exponent")?;
                let a = self.eval(&args[0])?.value();
                let b = self.eval(&args[1])?.value();
                return arith(BinaryOp::Pow, &a, &b).map(CV::V);
            }
            "PI" if n == 0 => return num(std::f64::consts::PI),
            "RADIANS" => {
                arity(1, 1, "an angle in degrees")?;
                return num(self.scalar(&up, args, 0)?.to_radians());
            }
            "DEGREES" => {
                arity(1, 1, "an angle in radians")?;
                return num(self.scalar(&up, args, 0)?.to_degrees());
            }
            "LOG" if n == 2 => {
                let x = self.scalar(&up, args, 0)?;
                let b = self.scalar(&up, args, 1)?;
                return num(x.ln() / b.ln());
            }
            "LOG" if n == 1 => return num(self.scalar(&up, args, 0)?.log10()),
            "SIGN" => {
                arity(1, 1, "one number")?;
                let q = self.one(&up, args, 0)?;
                return num(if q.v == 0.0 { 0.0 } else { q.v.signum() });
            }
            // text
            "CONCAT" | "CONCATENATE" => {
                let mut s = String::new();
                for (v, _) in self.spread(args)? {
                    s += &v.text(self.settings, self.interp.units);
                }
                return Ok(CV::V(Value::Str(s)));
            }
            "LEN" | "UPPER" | "LOWER" | "TRIM" => {
                arity(1, 1, "one text")?;
                let t = self.eval(&args[0])?.text(self.settings, self.interp.units);
                return match up.as_str() {
                    "LEN" => num(t.chars().count() as f64),
                    "UPPER" => Ok(CV::V(Value::Str(t.to_uppercase()))),
                    "LOWER" => Ok(CV::V(Value::Str(t.to_lowercase()))),
                    _ => Ok(CV::V(Value::Str(t.split_whitespace().collect::<Vec<_>>().join(" ")))),
                };
            }
            "LEFT" | "RIGHT" => {
                arity(1, 2, "a text and how many characters")?;
                let t: Vec<char> =
                    self.eval(&args[0])?.text(self.settings, self.interp.units).chars().collect();
                let k = if n == 2 { self.scalar(&up, args, 1)?.max(0.0) as usize } else { 1 }.min(t.len());
                let part = if up == "LEFT" { &t[..k] } else { &t[t.len() - k..] };
                return Ok(CV::V(Value::Str(part.iter().collect())));
            }
            // lookup
            "VLOOKUP" | "HLOOKUP" => {
                arity(
                    3,
                    4,
                    "a value, a range, a column (row) number and optionally FALSE for an exact match",
                )?;
                let key = self.eval(&args[0])?;
                let mut table = self.rows(&args[1])?;
                if up == "HLOOKUP" {
                    table = transpose(table);
                }
                let k = self.eval(&args[2])?.value().as_int("the column number")?;
                let exact = n == 4 && !self.eval(&args[3])?.truthy()?;
                let width = table.first().map_or(0, Vec::len);
                if k < 1 || k as usize > width {
                    bail!("{up}: {k} is outside the range, which has {width}");
                }
                let keys: Vec<CV> = table.iter().map(|r| r[0].clone()).collect();
                let at = lookup(&keys, &key, if exact { 0 } else { 1 })?.ok_or_else(|| {
                    EvalError::new(format!(
                        "{up}: {} is not in the table",
                        key.text(self.settings, self.interp.units)
                    ))
                })?;
                return Ok(table[at][k as usize - 1].clone());
            }
            "MATCH" => {
                arity(2, 3, "a value, a row or column and optionally the match type")?;
                let key = self.eval(&args[0])?;
                let list: Vec<CV> = self.rows(&args[1])?.into_iter().flatten().collect();
                let kind = if n == 3 { self.scalar(&up, args, 2)? as i32 } else { 1 };
                let at = lookup(&list, &key, kind)?.ok_or_else(|| {
                    EvalError::new(format!(
                        "MATCH: {} is not found",
                        key.text(self.settings, self.interp.units)
                    ))
                })?;
                return num((at + 1) as f64);
            }
            "INDEX" => {
                arity(2, 3, "a range, a row and optionally a column")?;
                let table = self.rows(&args[0])?;
                let i = self.eval(&args[1])?.value().as_int("the row")?;
                let j = if n == 3 { Some(self.eval(&args[2])?.value().as_int("the column")?) } else { None };
                let (h, w) = (table.len(), table.first().map_or(0, Vec::len));
                // INDEX(row or column, k) picks along it
                let (r, c) = match j {
                    Some(j) => (i, j),
                    None if h == 1 => (1, i),
                    None => (i, 1),
                };
                if r < 1 || c < 1 || r as usize > h || c as usize > w {
                    bail!("INDEX: ({r}, {c}) is outside the range ({h} × {w})");
                }
                return Ok(table[r as usize - 1][c as usize - 1].clone());
            }
            _ => {}
        }
        self.through_worksheet(name, args)
    }

    /// Anything else: your functions (`f(x) := …`) and Quire's (`sqrt`, `linterp`, …),
    /// with spreadsheet names (`SQRT`, `ABS`, `EXP`, `LN`) mapped to Quire's.
    fn through_worksheet(&mut self, name: &str, args: &[F]) -> Result<CV> {
        let mut vals = Vec::with_capacity(args.len());
        for a in args {
            let v = match self.eval_any(a)? {
                Got::One(v) => v.value(),
                Got::Many(rows) => {
                    let (h, w) = (rows.len(), rows.first().map_or(0, Vec::len));
                    Value::Matrix(Matrix::new(h, w, rows.into_iter().flatten().map(|v| v.value()).collect()))
                }
            };
            vals.push(v);
        }
        let names: Vec<String> = (0..vals.len()).map(|i| format!("__arg{i}")).collect();
        let saved: Vec<_> = names.iter().zip(vals).map(|(n, v)| (n.clone(), self.scope.bind(n, v))).collect();
        let call =
            |f: &str| Expr::Call(f.to_string(), names.iter().map(|n| Expr::Ident(n.clone())).collect());
        let mut r = self.interp.eval(self.scope, &call(name));
        let lower = name.to_lowercase();
        if let Err(e) = &r
            && e.message.ends_with("is not a known function")
            && lower != name
        {
            r = self.interp.eval(self.scope, &call(&lower)).map_err(|e| {
                if e.message.ends_with("is not a known function") {
                    EvalError::new(format!("{name} is not a known function"))
                } else {
                    e
                }
            });
        }
        for (n, prev) in saved.into_iter().rev() {
            self.scope.restore(&n, prev);
        }
        r.map(CV::V)
    }
}

fn transpose(rows: Vec<Vec<CV>>) -> Vec<Vec<CV>> {
    let w = rows.first().map_or(0, Vec::len);
    (0..w).map(|c| rows.iter().map(|r| r[c].clone()).collect()).collect()
}

fn aggregate(name: &str, vals: Vec<Value>) -> Result<Value> {
    if vals.is_empty() {
        return match name {
            "SUM" => Ok(Value::num(0.0)),
            "PRODUCT" => Ok(Value::num(1.0)),
            _ => bail!("{name}: there are no numbers"),
        };
    }
    let fold = |op: BinaryOp| -> Result<Value> {
        let mut it = vals.iter();
        let mut acc = it.next().cloned().unwrap_or(Value::num(0.0));
        for v in it {
            acc = arith(op, &acc, v)?;
        }
        Ok(acc)
    };
    match name {
        "SUM" => fold(BinaryOp::Add),
        "PRODUCT" => fold(BinaryOp::Mul),
        "AVERAGE" => arith(BinaryOp::Div, &fold(BinaryOp::Add)?, &Value::num(vals.len() as f64)),
        "MIN" | "MAX" => {
            let mut best = vals[0].clone();
            for v in &vals[1..] {
                let better = compare(if name == "MIN" { CmpOp::Lt } else { CmpOp::Gt }, v, &best)?;
                if better {
                    best = v.clone();
                }
            }
            Ok(best)
        }
        _ => {
            // MEDIAN
            let mut sorted = vals.clone();
            for v in &sorted[1..] {
                compare(CmpOp::Lt, v, &sorted[0])?;
            }
            sorted.sort_by(|a, b| {
                let (Value::Num(x), Value::Num(y)) = (a, b) else { return std::cmp::Ordering::Equal };
                x.v.total_cmp(&y.v)
            });
            let k = sorted.len();
            if k % 2 == 1 {
                Ok(sorted[k / 2].clone())
            } else {
                arith(
                    BinaryOp::Div,
                    &arith(BinaryOp::Add, &sorted[k / 2 - 1], &sorted[k / 2])?,
                    &Value::num(2.0),
                )
            }
        }
    }
}

/// Position of `key` in `list`: kind 0 exact, 1 the last one ≤ key (sorted ascending),
/// -1 the last one ≥ key (sorted descending).
fn lookup(list: &[CV], key: &CV, kind: i32) -> Result<Option<usize>> {
    if kind == 0 {
        for (i, v) in list.iter().enumerate() {
            if !matches!(v, CV::Blank) && cmp(CmpOp::Eq, v, key).unwrap_or(false) {
                return Ok(Some(i));
            }
        }
        return Ok(None);
    }
    let mut found = None;
    for (i, v) in list.iter().enumerate() {
        if matches!(v, CV::Blank) {
            continue;
        }
        let ok = cmp(if kind > 0 { CmpOp::Le } else { CmpOp::Ge }, v, key)?;
        if ok {
            found = Some(i);
        } else {
            break;
        }
    }
    Ok(found)
}

/// SUMIF/COUNTIF criteria: a value (`5`, `"Steel"`) or text with a comparison (`">10"`,
/// `"<>0"`, `">=12 kN"`).
fn criterion(crit: &CV, v: &CV, interp: &mut Interp, scope: &mut Scope) -> Result<bool> {
    let CV::V(Value::Str(s)) = crit else { return Ok(cmp(CmpOp::Eq, v, crit).unwrap_or(false)) };
    let (op, rest) = [
        ("<=", CmpOp::Le),
        (">=", CmpOp::Ge),
        ("<>", CmpOp::Ne),
        ("<", CmpOp::Lt),
        (">", CmpOp::Gt),
        ("=", CmpOp::Eq),
    ]
    .iter()
    .find_map(|(p, op)| s.strip_prefix(p).map(|r| (*op, r.trim())))
    .unwrap_or((CmpOp::Eq, s.trim()));
    let target = match literal(rest, interp.units) {
        Some(e) => CV::V(interp.eval(scope, &e)?),
        None if rest.is_empty() => CV::Blank,
        None => CV::V(Value::Str(rest.to_string())),
    };
    if matches!(v, CV::Blank) && !matches!(target, CV::Blank) && op != CmpOp::Ne {
        return Ok(false);
    }
    Ok(cmp(op, v, &target).unwrap_or(op == CmpOp::Ne))
}
