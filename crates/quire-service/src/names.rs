//! Names in stored documents (docs/02-file-format.md §4.3, Units, and §5): a stored `2T` is
//! always the unit. On open, a unit name right after a number or unit that names a variable
//! defined above is quoted (`2 'T`), as the earlier rule read it; on save, a product with your
//! variable is written `2*T`. Both are worked out from the text alone, so neither evaluates.
//!
//! Every stored expression is visited in the order the worksheet runs them (global `≡`
//! definitions first): math, inline math in text, and the expressions of plots.

use std::collections::{HashMap, HashSet};

use quire_ast::{Expr, parse, print};
use quire_doc::{Document, Region};
use quire_eval::Worksheet;
use quire_eval::names::{Names, defined_names, explicit, upgrade};
use serde_json::Value as Json;

type Transform = fn(&Expr, &Names) -> Expr;

/// One stored expression and where it is kept: a JSON pointer into its region.
struct Slot {
    id: String,
    pointer: String,
    kind: Kind,
}

enum Kind {
    /// A whole expression (a math region's `expr`, a plot's `y`), with the names its region
    /// binds around it (a plot's variable).
    Expr { text: String, locals: Vec<String> },
    /// Inline math number `index` in a text region's Djot `source`.
    Inline { source: String, index: usize, text: String },
    /// A table that defines a variable.
    Table { name: String },
}

/// The expression part of inline math, without a trailing `=` or `→`.
fn inline_core(m: &str) -> &str {
    let t = m.trim_end();
    let core = t
        .strip_suffix('→')
        .or_else(|| t.strip_suffix("->"))
        .or_else(|| t.strip_suffix('=').filter(|rest| !rest.ends_with(['=', ':', '<', '>', '!', '≠'])));
    core.map_or(m, str::trim_end)
}

/// The text of a localized value the worksheet reads, and its key (`None` for a plain string).
fn localized_key<'a>(v: &'a Json, lang: Option<&str>) -> Option<(Option<&'a str>, &'a str)> {
    match v {
        Json::String(s) => Some((None, s)),
        Json::Object(m) => lang
            .and_then(|l| m.iter().find(|(k, _)| l.starts_with(k.as_str())))
            .or_else(|| m.iter().find(|(k, _)| k.as_str() == "en"))
            .or_else(|| m.iter().next())
            .and_then(|(k, v)| v.as_str().map(|s| (Some(k.as_str()), s))),
        _ => None,
    }
}

const PLOT3_KEYS: &[&str] = &["surface", "y", "xrange", "yrange", "range", "urange", "vrange"];

/// The expressions of a plot series (`/series/0`) or of a plot holding one series itself.
fn plot_slots(
    id: &str,
    base: &str,
    series: &serde_json::Map<String, Json>,
    three: bool,
    locals: &[String],
    out: &mut Vec<Slot>,
) {
    let mut push = |pointer: String, text: &str| {
        out.push(Slot {
            id: id.to_string(),
            pointer,
            kind: Kind::Expr { text: text.to_string(), locals: locals.to_vec() },
        });
    };
    let keys: &[&str] = if three { PLOT3_KEYS } else { &["y", "range"] };
    for key in keys {
        if let Some(text) = series.get(*key).and_then(Json::as_str) {
            push(format!("{base}/{key}"), text);
        }
    }
    if three && let Some(parts) = series.get("parametric").and_then(Json::as_array) {
        for (k, p) in parts.iter().enumerate() {
            if let Some(text) = p.as_str() {
                push(format!("{base}/parametric/{k}"), text);
            }
        }
    }
}

/// Every stored expression of `doc`, in reading order (as `math_inputs` lists them).
fn slots(doc: &Document) -> Vec<Slot> {
    let lang = doc.meta.get("lang").and_then(Json::as_str);
    let mut out = Vec::new();
    for p in doc.flatten() {
        let r = p.region;
        if r.disabled || r.unreadable.is_some() {
            continue;
        }
        let id = r.id.clone();
        match r.kind.as_str() {
            "math" => {
                if let Some(text) = &r.expr {
                    out.push(Slot {
                        id,
                        pointer: "/expr".into(),
                        kind: Kind::Expr { text: text.clone(), locals: Vec::new() },
                    });
                }
            }
            "text" => {
                let Some((key, source)) = r.extra.get("text").and_then(|t| localized_key(t, lang)) else {
                    continue;
                };
                let pointer = key.map_or("/text".to_string(), |k| {
                    format!("/text/{}", k.replace('~', "~0").replace('/', "~1"))
                });
                for (index, m) in crate::text::inline_math(source).into_iter().enumerate() {
                    let kind = Kind::Inline { source: source.to_string(), index, text: m };
                    out.push(Slot { id: id.clone(), pointer: pointer.clone(), kind });
                }
            }
            "table" if r.extra.get("rows").is_some_and(Json::is_array) => {
                if let Some(name) =
                    r.extra.get("name").and_then(Json::as_str).map(str::trim).filter(|n| !n.is_empty())
                {
                    out.push(Slot {
                        id,
                        pointer: String::new(),
                        kind: Kind::Table { name: name.to_string() },
                    });
                }
            }
            "plot2d" | "plot3d" => {
                let three = r.kind == "plot3d";
                let mut locals: Vec<String> = if three {
                    ["x", "y", "u", "v", "t"].iter().map(|s| s.to_string()).collect()
                } else {
                    Vec::new()
                };
                let series = r.extra.get("series").and_then(Json::as_array).cloned().unwrap_or_default();
                if let Some(var) = r.extra.get("animate").and_then(|a| a.get("var")).and_then(Json::as_str) {
                    locals.push(var.trim().to_string());
                }
                for (i, s) in series.iter().enumerate() {
                    let Some(s) = s.as_object() else { continue };
                    let mut locals = locals.clone();
                    if !three {
                        let var = s.get("x").and_then(Json::as_str).map(str::trim).filter(|v| !v.is_empty());
                        locals.push(var.unwrap_or("x").to_string());
                    }
                    plot_slots(&id, &format!("/series/{i}"), s, three, &locals, &mut out);
                }
                if three && series.is_empty() {
                    plot_slots(&id, "", &r.extra, true, &locals, &mut out);
                }
            }
            // a solve block's lines, in the order they run (`math_inputs`)
            "solve" => {
                for key in ["guesses", "given"] {
                    let lines = r.extra.get(key).and_then(Json::as_array).cloned().unwrap_or_default();
                    for (i, line) in lines.iter().enumerate() {
                        if let Some(text) = line.as_str() {
                            let kind = Kind::Expr { text: text.to_string(), locals: Vec::new() };
                            out.push(Slot { id: id.clone(), pointer: format!("/{key}/{i}"), kind });
                        }
                    }
                }
                if let Some(text) = r.extra.get("find").and_then(Json::as_str) {
                    let kind = Kind::Expr { text: text.to_string(), locals: Vec::new() };
                    out.push(Slot { id, pointer: "/find".into(), kind });
                }
            }
            _ => {}
        }
    }
    out
}

/// The expression a slot holds, parsed.
fn parsed(kind: &Kind) -> Option<Expr> {
    match kind {
        Kind::Expr { text, .. } => parse(text).ok(),
        Kind::Inline { text, .. } => parse(inline_core(text)).ok(),
        Kind::Table { .. } => None,
    }
}

/// The new text of each slot `transform` changes: `(region id, pointer)` → text. Inline math
/// is gathered per text, as its index → new text.
#[derive(Default)]
struct Plan {
    texts: HashMap<(String, String), String>,
    inline: HashMap<(String, String), (String, HashMap<usize, String>)>,
}

fn plan(doc: &Document, transform: Transform) -> Option<Plan> {
    if crate::marked_units(doc) {
        // every unit is quoted there, so a bare name is always a variable
        return None;
    }
    let mut ws = Worksheet::new(crate::settings_of(doc));
    for (name, def) in &doc.units {
        let _ = ws.define_unit(name, def);
    }
    let units = ws.units();
    let slots = slots(doc);
    let exprs: Vec<Option<Expr>> = slots.iter().map(|s| parsed(&s.kind)).collect();
    let mut plan = Plan::default();
    let mut rewrite = |slot: &Slot, e: &Expr, variables: &HashSet<String>| {
        let extra = match &slot.kind {
            Kind::Expr { locals, .. } => locals.as_slice(),
            _ => &[],
        };
        let names = Names::new(units, variables, e, extra);
        let new = transform(e, &names);
        if &new == e {
            return;
        }
        let key = (slot.id.clone(), slot.pointer.clone());
        match &slot.kind {
            Kind::Expr { .. } => {
                plan.texts.insert(key, print(&new));
            }
            Kind::Inline { source, index, text } => {
                let core = inline_core(text);
                let tail = text.get(core.len()..).unwrap_or_default();
                let entry = plan.inline.entry(key).or_insert_with(|| (source.clone(), HashMap::new()));
                entry.1.insert(*index, format!("{}{tail}", print(&new)));
            }
            Kind::Table { .. } => {}
        }
    };
    // as the worksheet runs: the global definitions first, then everything from the top
    let mut variables: HashSet<String> = HashSet::new();
    for (slot, e) in slots.iter().zip(&exprs) {
        if let Some(e @ Expr::Define { global: true, .. }) = e {
            rewrite(slot, e, &variables);
            variables.extend(defined_names(e));
        }
    }
    for (slot, e) in slots.iter().zip(&exprs) {
        if let Kind::Table { name } = &slot.kind {
            variables.insert(name.clone());
            continue;
        }
        let Some(e) = e else { continue };
        if matches!(e, Expr::Define { global: true, .. }) {
            continue;
        }
        rewrite(slot, e, &variables);
        // a plot's expressions define nothing for the regions below (a solve block's lines do)
        let block = slot.pointer == "/find" || slot.pointer.starts_with("/guesses/");
        let plot = matches!(slot.kind, Kind::Expr { .. }) && slot.pointer != "/expr" && !block;
        if !plot {
            variables.extend(defined_names(e));
        }
    }
    Some(plan)
}

/// The edits of a plan: `(region id, pointer, new text)`.
fn edits(plan: Plan) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> =
        plan.texts.into_iter().map(|((id, p), t)| (id, p, t)).collect();
    for ((id, pointer), (source, new)) in plan.inline {
        let text = crate::text::rewrite_inline_math(&source, |i, _| new.get(&i).cloned());
        out.push((id, pointer, text));
    }
    out
}

fn find_json<'a>(regions: &'a mut Json, id: &str) -> Option<&'a mut Json> {
    for r in regions.as_array_mut()? {
        if r.get("id").and_then(Json::as_str) == Some(id) {
            return Some(r);
        }
        if let Some(found) = r.get_mut("regions").and_then(|inner| find_json(inner, id)) {
            return Some(found);
        }
    }
    None
}

fn find_region<'a>(regions: &'a mut [Region], id: &str) -> Option<&'a mut Region> {
    for r in regions {
        if r.id == id {
            return Some(r);
        }
        if let Some(found) = find_region(&mut r.regions, id) {
            return Some(found);
        }
    }
    None
}

fn apply_json(doc: &mut Json, transform: Transform) {
    let Ok(typed) = Document::from_json(doc.clone()) else { return };
    let Some(plan) = plan(&typed, transform) else { return };
    let Some(regions) = doc.get_mut("regions") else { return };
    for (id, pointer, text) in edits(plan) {
        if let Some(slot) = find_json(regions, &id).and_then(|r| r.pointer_mut(&pointer)) {
            *slot = Json::String(text);
        }
    }
}

/// On open: a document stored with the earlier rule (a unit name right after a number or
/// unit was the unit, under a variable of that name too) computes as it did: `2T` with a
/// variable T above becomes `2 'T`.
pub fn upgrade_names(doc: &mut Json) {
    apply_json(doc, upgrade);
}

/// [`upgrade_names`] for a document read with `quire_doc::load` (`quire eval`, `quire check`).
pub fn upgrade_document(doc: &mut Document) {
    let Some(plan) = plan(doc, upgrade) else { return };
    for (id, pointer, text) in edits(plan) {
        let Some(r) = find_region(&mut doc.regions, &id) else { continue };
        if pointer == "/expr" {
            r.expr = Some(text);
            continue;
        }
        let mut fields = Json::Object(std::mem::take(&mut r.extra));
        if let Some(slot) = fields.pointer_mut(&pointer) {
            *slot = Json::String(text);
        }
        if let Json::Object(m) = fields {
            r.extra = m;
        }
    }
}

/// On save: a product with your variable is written explicitly, `2*T` rather than `2T`, so the
/// stored text means the same to every version.
pub(crate) fn explicit_names(doc: &mut Json) {
    apply_json(doc, explicit);
}
