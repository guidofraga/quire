//! Parametric engineering sketches: evaluate element coordinates (length quantities in model
//! space, y up), `{expr}` label interpolations, and auto-measured `dimension` lengths where
//! the sketch sits in worksheet reading order.

use std::collections::{BTreeMap, BTreeSet};

use quire_ast::parse;
use quire_units::{Dim, UnitRegistry};

use crate::error::EvalError;
use crate::format::{DisplaySettings, DisplaySpec, WorkingUnit, describe_dim, format_value_in};
use crate::interp::{Interp, Scope};
use crate::value::{Quantity, Value};
use crate::worksheet::{Fix, Outcome, explicit_units, names};

pub fn length_dim() -> Dim {
    Dim::from_ints([1, 0, 0, 0, 0, 0, 0])
}

#[derive(Debug, Clone, Default)]
pub struct SketchElementInput {
    pub kind: String,
    pub from: Option<[String; 2]>,
    pub to: Option<[String; 2]>,
    pub at: Option<[String; 2]>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SketchInput {
    pub elements: Vec<SketchElementInput>,
    pub display: DisplaySpec,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SketchCoord {
    pub si: f64,
    pub dim: Dim,
}

#[derive(Debug, Clone, Default)]
pub struct SketchOutcome {
    pub values: BTreeMap<String, SketchCoord>,
    pub labels: BTreeMap<usize, String>,
    /// Each label split into `(is_value, text)` pieces so callers can pretty-print only `{expr}` values.
    pub label_chunks: BTreeMap<usize, Vec<(bool, String)>>,
    pub errors: BTreeMap<usize, String>,
    pub fixes: BTreeMap<usize, Fix>,
    pub reads: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum LabelPiece {
    Text(String),
    Value(Value),
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SketchRaw {
    pub(crate) parts: BTreeMap<usize, Vec<LabelPiece>>,
    pub(crate) dim_lengths: BTreeMap<usize, f64>,
    pub(crate) unit_vars: BTreeMap<usize, Vec<String>>,
}

/// Byte offsets and trimmed inner expression for each `{expr}` chunk in `label`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LabelToken<'a> {
    Text(&'a str),
    Expr { start: usize, end: usize, expr: &'a str },
}

/// Parse `{expr}` interpolations out of a sketch label string.
pub fn scan_label(label: &str) -> std::result::Result<Vec<LabelToken<'_>>, String> {
    let mut out = Vec::new();
    let mut text_start = 0;
    let mut chars = label.char_indices();
    while let Some((open_idx, ch)) = chars.next() {
        if ch != '{' {
            continue;
        }
        if open_idx > text_start {
            out.push(LabelToken::Text(&label[text_start..open_idx]));
        }
        let mut in_str = false;
        let mut escape = false;
        let mut close_idx = None;
        for (idx, c) in chars.by_ref() {
            if escape {
                escape = false;
                continue;
            }
            if in_str {
                if c == '\\' {
                    escape = true;
                } else if c == '"' {
                    in_str = false;
                }
                continue;
            }
            if c == '"' {
                in_str = true;
            } else if c == '}' {
                close_idx = Some(idx);
                break;
            }
        }
        let Some(end) = close_idx else {
            return Err("unclosed '{' in label".into());
        };
        let raw_inner = &label[open_idx + 1..end];
        let expr = raw_inner.trim();
        if expr.is_empty() {
            return Err("empty '{}' in label".into());
        }
        let trim_lead = raw_inner.len() - raw_inner.trim_start().len();
        out.push(LabelToken::Expr {
            start: open_idx + 1 + trim_lead,
            end: open_idx + 1 + trim_lead + expr.len(),
            expr,
        });
        text_start = end + 1;
    }
    if text_start < label.len() {
        out.push(LabelToken::Text(&label[text_start..]));
    }
    Ok(out)
}

pub(crate) fn collect_expr_parts(sk: &SketchInput, units_out: &mut Vec<String>, reads_out: &mut Vec<String>) {
    let mut visit = |s: &str| {
        if let Ok(e) = parse(s.trim()) {
            explicit_units(&e, units_out);
            names(&e, reads_out);
        }
    };
    for el in &sk.elements {
        if let Some([x, y]) = &el.from {
            visit(x);
            visit(y);
        }
        if let Some([x, y]) = &el.to {
            visit(x);
            visit(y);
        }
        if let Some([x, y]) = &el.at {
            visit(x);
            visit(y);
        }
        if let Some(label) = &el.label
            && let Ok(tokens) = scan_label(label)
        {
            for tok in tokens {
                if let LabelToken::Expr { expr, .. } = tok {
                    visit(expr);
                }
            }
        }
    }
}

struct EvalCtx<'a, 'i, 's> {
    interp: &'a mut Interp<'i>,
    scope: &'a mut Scope<'s>,
    marked_units: bool,
    units: &'a UnitRegistry,
    read_names: BTreeSet<String>,
    used_units: BTreeSet<String>,
    used_consts: BTreeSet<String>,
}

impl EvalCtx<'_, '_, '_> {
    fn eval_one(
        &mut self,
        expr_str: &str,
        el_unit_vars: &mut Vec<String>,
    ) -> std::result::Result<Value, String> {
        let trimmed = expr_str.trim();
        if trimmed.is_empty() {
            return Err("missing expression".into());
        }
        let parsed = parse(trimmed).map_err(|e| EvalError::from(e).message)?;
        let mut referenced = Vec::new();
        names(&parsed, &mut referenced);
        for n in referenced {
            self.read_names.insert(n);
        }
        let res = self.interp.eval(self.scope, &parsed);
        let expr_units: Vec<String> = std::mem::take(&mut self.interp.unit_idents).into_iter().collect();
        let expr_consts: Vec<String> = std::mem::take(&mut self.interp.constant_idents).into_iter().collect();
        for n in crate::unit_names::read_as_units(&parsed, &expr_units) {
            if !el_unit_vars.contains(&n) {
                el_unit_vars.push(n);
            }
        }
        for n in &expr_consts {
            if !el_unit_vars.contains(n) {
                el_unit_vars.push(n.clone());
            }
        }
        self.used_units.extend(expr_units);
        self.used_consts.extend(expr_consts);

        let val = res.map_err(|e| e.message)?;
        if self.marked_units
            && crate::symbolic::bridge::has_sym(&val)
            && let Some(name) = crate::symbolic::bridge::free_name(&val)
        {
            return Err(if self.units.lookup_bare(&name).is_some() {
                format!("{name} is not defined; for the unit, write '{name}")
            } else {
                format!("{name} is not defined")
            });
        }
        Ok(val)
    }

    fn eval_length(
        &mut self,
        expr_str: &str,
        el_unit_vars: &mut Vec<String>,
    ) -> std::result::Result<SketchCoord, String> {
        let trimmed = expr_str.trim();
        if trimmed.is_empty() {
            return Err("missing coordinate".into());
        }
        let val = self.eval_one(trimmed, el_unit_vars)?;
        let len_dim = length_dim();
        match val {
            Value::Num(q) => {
                if !q.v.is_finite() {
                    Err("coordinate is not finite".into())
                } else if q.dim == len_dim {
                    Ok(SketchCoord { si: q.v, dim: q.dim })
                } else if q.dim.is_dimensionless() {
                    Err("expected a length (such as 0 m), got a plain number".into())
                } else {
                    Err(format!("expected a length (m), got {}", describe_dim(q.dim)))
                }
            }
            other => Err(format!("expected a length (m), got {}", other.kind())),
        }
    }
}

pub(crate) fn evaluate(
    id: &str,
    sk: &SketchInput,
    interp: &mut Interp<'_>,
    scope: &mut Scope<'_>,
    settings: &DisplaySettings,
    units: &UnitRegistry,
) -> Outcome {
    let mut out = Outcome::new(id);
    let mut sk_out = SketchOutcome::default();
    let mut raw = SketchRaw::default();
    let mut ctx = EvalCtx {
        interp,
        scope,
        marked_units: settings.marked_units,
        units,
        read_names: BTreeSet::new(),
        used_units: BTreeSet::new(),
        used_consts: BTreeSet::new(),
    };

    for (i, el) in sk.elements.iter().enumerate() {
        let mut el_err: Option<String> = None;
        let mut record_err = |msg: String| {
            if el_err.is_none() {
                el_err = Some(msg);
            }
        };
        let mut el_unit_vars = Vec::new();

        let is_span = matches!(el.kind.as_str(), "member" | "udl" | "dimension");
        let is_point = matches!(el.kind.as_str(), "support" | "point" | "moment" | "label");
        if !is_span && !is_point {
            continue;
        }

        if is_span {
            match (&el.from, &el.to) {
                (Some([fx, fy]), Some([tx, ty])) => {
                    let coords = [("from.0", fx), ("from.1", fy), ("to.0", tx), ("to.1", ty)];
                    for (suffix, expr_s) in coords {
                        match ctx.eval_length(expr_s, &mut el_unit_vars) {
                            Ok(coord) => {
                                sk_out.values.insert(format!("{i}.{suffix}"), coord);
                            }
                            Err(msg) => record_err(msg),
                        }
                    }
                    if el.kind == "dimension"
                        && el.label.as_deref().is_none_or(|s| s.trim().is_empty())
                        && let (Some(x0), Some(y0), Some(x1), Some(y1)) = (
                            sk_out.values.get(&format!("{i}.from.0")),
                            sk_out.values.get(&format!("{i}.from.1")),
                            sk_out.values.get(&format!("{i}.to.0")),
                            sk_out.values.get(&format!("{i}.to.1")),
                        )
                    {
                        raw.dim_lengths.insert(i, (x1.si - x0.si).hypot(y1.si - y0.si));
                    }
                }
                _ => record_err("missing coordinates".into()),
            }
        } else {
            match &el.at {
                Some([ax, ay]) => {
                    for (suffix, expr_s) in [("at.0", ax), ("at.1", ay)] {
                        match ctx.eval_length(expr_s, &mut el_unit_vars) {
                            Ok(coord) => {
                                sk_out.values.insert(format!("{i}.{suffix}"), coord);
                            }
                            Err(msg) => record_err(msg),
                        }
                    }
                }
                None => record_err("missing coordinates".into()),
            }
        }

        if let Some(label) = el.label.as_deref().filter(|s| !s.is_empty()) {
            match scan_label(label) {
                Ok(tokens) => {
                    let mut pieces = Vec::with_capacity(tokens.len());
                    for tok in tokens {
                        match tok {
                            LabelToken::Text(t) => pieces.push(LabelPiece::Text(t.to_string())),
                            LabelToken::Expr { expr, .. } => match ctx.eval_one(expr, &mut el_unit_vars) {
                                Ok(v) => pieces.push(LabelPiece::Value(v)),
                                Err(msg) => record_err(msg),
                            },
                        }
                    }
                    if el_err.is_none() || pieces.iter().all(|p| matches!(p, LabelPiece::Text(_))) {
                        raw.parts.insert(i, pieces);
                    }
                }
                Err(msg) => record_err(msg),
            }
        }

        if !el_unit_vars.is_empty() {
            raw.unit_vars.insert(i, el_unit_vars);
        }
        if let Some(msg) = el_err {
            sk_out.errors.insert(i, msg);
        }
    }

    format_labels(&sk.display, &raw, &mut sk_out, settings, units, &[]);

    sk_out.reads = ctx
        .read_names
        .into_iter()
        .filter(|n| !ctx.used_units.contains(n) && !ctx.used_consts.contains(n))
        .collect();
    out.units = ctx.used_units.into_iter().collect();
    out.constants = ctx.used_consts.into_iter().collect();
    out.error = sk_out.errors.values().next().cloned();
    out.sketch = Some(sk_out);
    out.sketch_raw = Some(raw);
    out
}

pub(crate) fn format_labels(
    display: &DisplaySpec,
    raw: &SketchRaw,
    out: &mut SketchOutcome,
    settings: &DisplaySettings,
    units: &UnitRegistry,
    vocab: &[WorkingUnit],
) {
    out.labels.clear();
    out.label_chunks.clear();
    let len_dim = length_dim();
    for (&i, pieces) in &raw.parts {
        let mut rendered = String::new();
        let mut chunks = Vec::with_capacity(pieces.len());
        let mut fmt_err = None;
        for piece in pieces {
            match piece {
                LabelPiece::Text(t) => {
                    rendered.push_str(t);
                    chunks.push((false, t.clone()));
                }
                LabelPiece::Value(Value::Str(s)) => {
                    rendered.push_str(s);
                    chunks.push((false, s.clone()));
                }
                LabelPiece::Value(v) => match format_value_in(v, display, settings, units, vocab) {
                    Ok(s) => {
                        rendered.push_str(&s);
                        chunks.push((true, s));
                    }
                    Err(err) => {
                        fmt_err = Some(err.message);
                        break;
                    }
                },
            }
        }
        match fmt_err {
            Some(msg) => {
                out.errors.entry(i).or_insert(msg);
            }
            None => {
                out.labels.insert(i, rendered);
                out.label_chunks.insert(i, chunks);
            }
        }
    }
    for (&i, &dist) in &raw.dim_lengths {
        if out.labels.contains_key(&i) || out.errors.contains_key(&i) {
            continue;
        }
        let v = Value::Num(Quantity::new(dist, len_dim));
        match format_value_in(&v, display, settings, units, vocab) {
            Ok(s) => {
                out.label_chunks.insert(i, vec![(true, s.clone())]);
                out.labels.insert(i, s);
            }
            Err(msg) => {
                out.errors.entry(i).or_insert(msg.message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worksheet::{Fix, MathInput, Worksheet};

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn el(
        kind: &str,
        from: Option<[&str; 2]>,
        to: Option<[&str; 2]>,
        at: Option<[&str; 2]>,
        label: Option<&str>,
    ) -> SketchElementInput {
        SketchElementInput {
            kind: kind.into(),
            from: from.map(|[a, b]| [a.into(), b.into()]),
            to: to.map(|[a, b]| [a.into(), b.into()]),
            at: at.map(|[a, b]| [a.into(), b.into()]),
            label: label.map(Into::into),
        }
    }

    fn beam_elements(span: &str, q_label: Option<&str>, dim_label: Option<&str>) -> Vec<SketchElementInput> {
        vec![
            el("member", Some(["0 m", "0 m"]), Some([span, "0 m"]), None, None),
            el("support", None, None, Some(["0 m", "0 m"]), None),
            el("support", None, None, Some([span, "0 m"]), None),
            el("udl", Some(["0 m", "0 m"]), Some([span, "0 m"]), None, q_label),
            el("dimension", Some(["0 m", "0 m"]), Some([span, "0 m"]), None, dim_label),
        ]
    }

    #[test]
    fn sketch_evaluates_coordinates_interpolates_labels_and_measures_dimensions() -> TestResult {
        let inputs = vec![
            MathInput { id: "a".into(), expr: "L := 6 m".into(), ..Default::default() },
            MathInput { id: "b".into(), expr: "q := 10.6 kN/m".into(), ..Default::default() },
            MathInput {
                id: "s".into(),
                sketch: Some(SketchInput {
                    elements: beam_elements("L", Some("q = {q}"), None),
                    display: DisplaySpec::default(),
                }),
                ..Default::default()
            },
        ];
        let settings = DisplaySettings { working_units: true, decimals: 2, ..Default::default() };
        let outs = Worksheet::new(settings).run(&inputs);
        assert_eq!(outs[2].error, None);
        let sk = outs[2].sketch.as_ref().ok_or("no sketch outcome")?;
        assert_eq!(sk.values["0.to.0"].si, 6.0);
        assert_eq!(sk.labels.get(&3).map(String::as_str), Some("q = 10.6 'kN/'m"));
        assert_eq!(sk.labels.get(&4).map(String::as_str), Some("6 'm"));
        assert_eq!(sk.reads, vec!["L".to_string(), "q".to_string()]);
        Ok(())
    }

    #[test]
    fn element_errors_are_isolated_and_non_length_fails() -> TestResult {
        let inputs = vec![
            MathInput { id: "a".into(), expr: "P := 10 kN".into(), ..Default::default() },
            MathInput {
                id: "s".into(),
                sketch: Some(SketchInput {
                    elements: vec![
                        el("member", Some(["0 m", "0 m"]), Some(["4 m", "0 m"]), None, None),
                        el("support", None, None, Some(["4", "0 m"]), None),
                        el("point", None, None, Some(["P", "0 m"]), None),
                    ],
                    display: DisplaySpec::default(),
                }),
                ..Default::default()
            },
        ];
        let outs = Worksheet::new(DisplaySettings::default()).run(&inputs);
        let sk = outs[1].sketch.as_ref().ok_or("no sketch outcome")?;
        assert_eq!(sk.values["0.to.0"].si, 4.0);
        assert!(sk.errors[&1].contains("expected a length"));
        assert!(sk.errors[&2].contains("expected a length"));
        assert!(outs[1].error.is_some());
        Ok(())
    }

    #[test]
    fn sketch_above_definition_reports_defined_below_fix() -> TestResult {
        let inputs = vec![
            MathInput {
                id: "s".into(),
                sketch: Some(SketchInput {
                    elements: vec![
                        el("member", Some(["0 m", "0 m"]), Some(["L", "0 m"]), None, None),
                        el("support", None, None, Some(["span", "0 m"]), None),
                        el("label", None, None, Some(["0 m", "0 m"]), Some("L = {L}")),
                    ],
                    display: DisplaySpec::default(),
                }),
                ..Default::default()
            },
            MathInput { id: "l".into(), expr: "L := 6 m".into(), ..Default::default() },
            MathInput { id: "sp".into(), expr: "span := 6 m".into(), ..Default::default() },
        ];
        let outs = Worksheet::new(DisplaySettings::default()).run(&inputs);
        let sk = outs[0].sketch.as_ref().ok_or("no sketch outcome")?;
        assert!(sk.errors[&0].contains("L is defined further down"), "{}", sk.errors[&0]);
        assert!(sk.errors[&1].contains("span is defined further down"), "{}", sk.errors[&1]);
        assert!(sk.errors[&2].contains("L is defined further down"), "{}", sk.errors[&2]);
        assert!(!sk.labels.contains_key(&2));
        assert_eq!(sk.fixes.get(&0), Some(&Fix::DefinedBelow { index: 1 }));
        assert_eq!(sk.fixes.get(&1), Some(&Fix::DefinedBelow { index: 2 }));
        assert_eq!(sk.fixes.get(&2), Some(&Fix::DefinedBelow { index: 1 }));
        assert_eq!(outs[0].fix, Some(Fix::DefinedBelow { index: 1 }));
        assert!(outs[0].error.as_deref().is_some_and(|e| e.contains("L is defined further down")));
        Ok(())
    }
}
