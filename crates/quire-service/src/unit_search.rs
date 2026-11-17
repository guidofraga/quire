//! Finding a unit by what you type: a ranked, fuzzy match over every unit's symbol, other
//! spellings, full name and quantity (`C` finds coulomb and °C, `cel` finds °C, `kn` finds kN),
//! for the list that opens while a unit is typed and the units a result can be shown in.
//!
//! Nothing here knows any particular unit: the order comes from the unit table (crates/quire-units)
//! and from how a name matches.

use quire_doc::Document;
use quire_units::{UnitInfo, catalog, quantity_of, unit_info};
use serde_json::Value as Json;

use crate::{Completion, Here, Result, UNIT_CHOICES, UnitChoice, run, unit_choices};

/// How many rows a search returns.
const LIMIT: usize = 60;

/// Something a typed name can be matched against.
pub(crate) struct Candidate<'a> {
    pub symbol: &'a str,
    pub aliases: Vec<&'a str>,
    /// Its full name (`degree Celsius`), or "".
    pub title: &'a str,
    pub quantity: Option<&'a str>,
    /// How common it is, lower first (see [`unit_class`]).
    pub class: u8,
    /// Only written quoted (SMath's units): always after the rest.
    pub quoted: bool,
    /// The SI prefix it is written with (`k` in kN), or "". Its symbol matches only what says
    /// more than the prefix (`kn` finds kN; `c` alone does not list every centi-unit), and
    /// never as a subsequence.
    pub prefix: &'a str,
    /// Its place in the unit table, the last tie-break.
    pub order: usize,
}

/// Where a candidate goes in the list: compared field by field, smallest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Rank {
    quoted: bool,
    /// How the name matched (0, the symbol as typed … 7, a subsequence).
    tier: u8,
    class: u8,
    len: usize,
    order: usize,
}

/// The symbol without its decorations: `°C` → `C`, `lb.m` → `lbm`.
fn plain(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// `needle` appears in `hay` in order, not necessarily together (`kgf` in `kilogram-force`).
fn subsequence(needle: &str, hay: &str) -> bool {
    let mut hay = hay.chars();
    needle.chars().all(|n| hay.any(|h| h == n))
}

fn words(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty())
}

/// How well `query` matches `c`, or `None` when it does not.
pub(crate) fn rank(query: &str, c: &Candidate) -> Option<Rank> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    let lower = q.to_lowercase();
    let names: Vec<&str> = std::iter::once(c.symbol).chain(c.aliases.iter().copied()).collect();
    let plains: Vec<String> = names.iter().map(|n| plain(n)).filter(|p| !p.is_empty()).collect();
    let prefixed = !c.prefix.is_empty();
    // a prefixed unit matches the start of a name, or one in another case, only once what is
    // typed is more than its prefix
    let typed = q.chars().count();
    let beyond = !prefixed || typed > c.prefix.chars().count();
    // a rare prefix is taken as typed: `pa` is not the petaampere
    let any_case = beyond && c.class < RARE;
    // words are matched once they say something: `c` alone is not every "centi…" and "charge"
    let wordy = typed >= if prefixed { 3 } else { 2 };
    let title = c.title.to_lowercase();
    let tier = if names.contains(&q) {
        0
    } else if plains.iter().any(|p| p == q) {
        1
    } else if any_case
        && (names.iter().any(|n| n.to_lowercase() == lower)
            || plains.iter().any(|p| p.to_lowercase() == lower))
    {
        2
    } else if beyond && (names.iter().any(|n| n.starts_with(q)) || plains.iter().any(|p| p.starts_with(q))) {
        3
    } else if any_case
        && (names.iter().any(|n| n.to_lowercase().starts_with(&lower))
            || plains.iter().any(|p| p.to_lowercase().starts_with(&lower)))
    {
        4
    } else if wordy && (title.starts_with(&lower) || words(&title).any(|w| w.starts_with(&lower))) {
        5
    } else if !prefixed
        && typed >= 2
        && c.quantity.is_some_and(|k| words(&k.to_lowercase()).any(|w| w.starts_with(&lower)))
    {
        6
    } else if !prefixed && typed >= 2 && names.iter().any(|n| subsequence(&lower, &n.to_lowercase())) {
        7
    } else {
        return None;
    };
    Some(Rank { quoted: c.quoted, tier, class: c.class, len: c.symbol.chars().count(), order: c.order })
}

/// How common a unit is in engineering, from the table alone, lower first: a coherent SI unit
/// (`m`, `N`, `kg`), then units that take prefixes and those written with a common prefix
/// (`L`, `bar`, `kN`, `mm`), then other units (`ft`, `psi`, `°C`), then those with a rare
/// prefix (`hPa`, `dam`).
fn unit_class(i: &UnitInfo) -> u8 {
    let coherent = i.unit.factor == 1.0 && i.unit.offset == 0.0;
    match i.prefix {
        Some(p) if !p.common => RARE,
        _ if coherent => 0,
        Some(_) => 1,
        None if i.prefixable => 1,
        None => 2,
    }
}

/// The class of a unit with a rare prefix (`hPa`, `PA`): matched only as typed, or by name.
const RARE: u8 = 4;

/// A constant (`g`, `G`) is as common as a unit with no prefix.
const CONSTANT_CLASS: u8 = 2;

fn unit_candidate(i: &UnitInfo, order: usize) -> Candidate<'_> {
    Candidate {
        symbol: &i.symbol,
        aliases: i.aliases.iter().map(String::as_str).collect(),
        title: &i.title,
        quantity: i.quantity,
        class: unit_class(i),
        quoted: i.quoted,
        prefix: i.prefix.map_or("", |p| p.symbol),
        order,
    }
}

/// What a unit is called: `tesla`, `kilonewton`, or its name when it is not a built-in.
pub(crate) fn unit_title(name: &str) -> String {
    unit_info(name).map_or_else(|| name.to_string(), |i| i.title.clone())
}

/// What a unit written in linear syntax is called, from its parts: `kN*m` → `kilonewton
/// metre`, `N/mm^2` → `newton per square millimetre`, `m/s^2` → `metre per second squared`.
pub(crate) fn compound_title(spec: &str) -> Option<String> {
    let part = |p: &str| -> Option<String> {
        let (name, power) = p.split_once('^').unwrap_or((p, "1"));
        let info = unit_info(name.trim())?;
        let t = &info.title;
        let length = info.quantity == Some("length");
        Some(match power.trim() {
            "1" => t.clone(),
            "2" if length => format!("square {t}"),
            "3" if length => format!("cubic {t}"),
            "2" => format!("{t} squared"),
            "3" => format!("{t} cubed"),
            "4" => format!("{t} to the fourth power"),
            _ => return None,
        })
    };
    let group = |g: &str| -> Option<String> {
        g.split('*')
            .map(|p| part(p.trim_matches(|c| c == '(' || c == ')')))
            .collect::<Option<Vec<_>>>()
            .map(|v| v.join(" "))
    };
    match spec.split_once('/') {
        Some((num, den)) => Some(format!("{} per {}", group(num)?, group(den)?)),
        None => group(spec),
    }
}

/// What can go where a unit is being typed in region `region_id`, best first: the units
/// `query` matches (by symbol, other spellings, full name or quantity), and your variables and
/// the constants it matches, scored the same way. Each comes with the text to insert there
/// (`°C`, or `'°C` where a plain name would mean something else).
pub fn complete_units(doc_json: &Json, region_id: &str, query: &str) -> Result<Vec<Completion>> {
    let here = Here::new(doc_json, region_id)?;
    let units = catalog();
    let custom: Vec<(String, u8)> = here.custom_units.iter().map(|n| (n.clone(), CONSTANT_CLASS)).collect();
    // every candidate, with what to make of it when it is kept
    enum Of<'a> {
        Unit(&'a str),
        Yours(usize),
        Constant(&'a quire_eval::Constant),
    }
    let yours = here.yours(|_| true);
    let mut ranked: Vec<(Rank, Of)> = Vec::new();
    for (order, i) in units.iter().enumerate() {
        if let Some(r) = rank(query, &unit_candidate(i, order)) {
            ranked.push((r, Of::Unit(&i.symbol)));
        }
    }
    for (n, class) in &custom {
        let c = Candidate {
            symbol: n,
            aliases: Vec::new(),
            title: "",
            quantity: None,
            class: *class,
            quoted: false,
            prefix: "",
            order: 0,
        };
        if let Some(r) = rank(query, &c) {
            ranked.push((r, Of::Unit(n)));
        }
    }
    for (order, y) in yours.iter().enumerate() {
        let c = Candidate {
            symbol: &y.name,
            aliases: Vec::new(),
            title: "",
            quantity: None,
            class: 0,
            quoted: false,
            prefix: "",
            order,
        };
        if let Some(r) = rank(query, &c) {
            ranked.push((r, Of::Yours(order)));
        }
    }
    for (order, k) in quire_eval::CONSTANTS.iter().enumerate() {
        let c = Candidate {
            symbol: k.name,
            aliases: Vec::new(),
            title: k.title,
            quantity: quantity_of(k.dim()),
            class: CONSTANT_CLASS,
            quoted: false,
            prefix: "",
            order,
        };
        if let Some(r) = rank(query, &c) {
            ranked.push((r, Of::Constant(k)));
        }
    }
    ranked.sort_by_key(|(r, _)| *r);
    let mut seen = std::collections::HashSet::new();
    Ok(ranked
        .into_iter()
        .filter_map(|(_, of)| match of {
            Of::Unit(n) => here.unit(n, true),
            Of::Yours(i) => yours.get(i).cloned(),
            Of::Constant(k) => Some(here.constant(k)),
        })
        // a unit defined twice (the document's own `tf`) is listed once
        .filter(|c| seen.insert((c.kind, c.name.clone())))
        .take(LIMIT)
        .collect())
}

/// The units the result of region `region_id` can be shown in that `query` matches, best
/// first, each with the result in it: the usual ones for its kind, then every unit of that
/// kind. Nothing typed lists the usual ones.
pub fn show_in(doc_json: &Json, region_id: &str, query: &str) -> Result<Vec<UnitChoice>> {
    let doc: Document = serde_json::from_value(doc_json.clone())?;
    let ev = run(&doc, true);
    let Some((input, o)) = ev.inputs.iter().zip(&ev.outcomes).find(|(i, _)| i.id == region_id) else {
        return Ok(Vec::new());
    };
    let Some(quire_eval::Value::Num(q)) = o.value.as_ref().filter(|_| input.show && o.error.is_none()) else {
        return Ok(Vec::new());
    };
    let units = ev.worksheet.units();
    let dim = q.dim;
    let usual: Vec<&'static str> = UNIT_CHOICES
        .iter()
        .copied()
        .filter(|u| quire_eval::parse_unit_spec(u, units).is_ok_and(|s| s.dim == dim))
        .collect();
    let picked: Vec<String> = if query.trim().is_empty() {
        usual.iter().map(|u| u.to_string()).collect()
    } else {
        let titles: Vec<String> = usual.iter().map(|u| compound_title(u).unwrap_or_default()).collect();
        let mut ranked: Vec<(Rank, String)> = Vec::new();
        for (order, (u, title)) in usual.iter().zip(&titles).enumerate() {
            let c = Candidate {
                symbol: u,
                aliases: Vec::new(),
                title,
                quantity: quantity_of(dim),
                class: 0,
                quoted: false,
                prefix: "",
                order,
            };
            ranked.extend(rank(query, &c).map(|r| (r, u.to_string())));
        }
        for (order, i) in catalog().iter().enumerate() {
            if i.quoted || i.unit.dim != dim || usual.contains(&i.symbol.as_str()) {
                continue;
            }
            let c = unit_candidate(i, order);
            // after the usual units, however well it matches
            let c = Candidate { class: c.class.max(1), ..c };
            ranked.extend(rank(query, &c).map(|r| (r, i.symbol.clone())));
        }
        ranked.sort_by_key(|(r, _)| *r);
        ranked.into_iter().map(|(_, u)| u).take(LIMIT).collect()
    };
    let candidates: Vec<(&str, quire_units::Dim)> = picked.iter().map(|u| (u.as_str(), dim)).collect();
    Ok(unit_choices(o.value.as_ref(), &input.display, ev.worksheet.settings(), units, &candidates))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn doc(exprs: &[&str]) -> Json {
        let regions: Vec<Json> = exprs
            .iter()
            .enumerate()
            .map(|(i, e)| match e.strip_suffix(" =") {
                Some(e) => json!({ "id": format!("r{i}"), "kind": "math", "at": [0, i * 40], "expr": e, "show": "value" }),
                None => json!({ "id": format!("r{i}"), "kind": "math", "at": [0, i * 40], "expr": e }),
            })
            .collect();
        json!({ "format": "quire/1", "regions": regions })
    }

    /// The symbols listed for `query` in a new region of an empty document.
    fn found(query: &str) -> std::result::Result<Vec<String>, Box<dyn std::error::Error>> {
        Ok(complete_units(&doc(&[]), "new", query)?.into_iter().map(|c| c.name).collect())
    }

    fn place(list: &[String], name: &str) -> Option<usize> {
        list.iter().position(|n| n == name)
    }

    #[test]
    fn c_lists_coulomb_and_degree_celsius_first() -> TestResult {
        let list = found("C")?;
        assert_eq!(list.first().map(String::as_str), Some("C"), "{list:?}");
        assert!(place(&list, "°C").is_some_and(|i| i < 3), "{list:?}");
        // and other units that start that way
        assert!(place(&list, "cd").is_some() && place(&list, "cal").is_some(), "{list:?}");
        Ok(())
    }

    #[test]
    fn full_names_and_other_cases_find_a_unit() -> TestResult {
        assert_eq!(found("cel")?.first().map(String::as_str), Some("°C"));
        assert_eq!(found("kn")?.first().map(String::as_str), Some("kN"));
        assert_eq!(found("mpa")?.first().map(String::as_str), Some("MPa"));
        assert_eq!(found("ohm")?.first().map(String::as_str), Some("Ω"));
        assert_eq!(found("Ω")?.first().map(String::as_str), Some("Ω"));
        assert_eq!(found("psi")?.first().map(String::as_str), Some("psi"));
        assert!(place(&found("degF")?, "°F").is_some_and(|i| i < 5));
        assert!(place(&found("F")?, "°F").is_some_and(|i| i < 5));
        assert!(found("kilo")?.iter().take(12).any(|n| n == "kN"));
        assert!(found("temp")?.iter().take(8).any(|n| n == "°C"), "by quantity");
        assert!(found("nonsense")?.is_empty());
        Ok(())
    }

    #[test]
    fn smath_only_units_come_last() -> TestResult {
        let list = complete_units(&doc(&[]), "new", "c")?;
        let quoted = |c: &Completion| c.insert.starts_with('\'');
        let names: Vec<&str> = list.iter().map(|c| c.insert.as_str()).collect();
        let first_quoted = list.iter().position(quoted).ok_or(format!("no quoted unit for c: {names:?}"))?;
        assert!(list[first_quoted..].iter().all(|c| c.kind == "unit" && quoted(c)), "{list:?}");
        // `'c`, the speed of light as SMath writes it, is listed but quoted
        assert!(list.iter().any(|c| c.insert == "'c"));
        Ok(())
    }

    #[test]
    fn rows_carry_what_to_insert_and_what_it_is() -> TestResult {
        let list = complete_units(&doc(&[]), "new", "C")?;
        let celsius = list.iter().find(|c| c.name == "°C").ok_or("no °C")?;
        assert_eq!(celsius.insert, "°C", "°C is written as it is");
        assert_eq!(celsius.title.as_deref(), Some("degree Celsius"));
        assert_eq!(celsius.quantity, Some("temperature"));
        // your variable C is first, and the unit then needs its quote
        let mine = complete_units(&doc(&["C := 4"]), "new", "C")?;
        assert_eq!((mine[0].kind, mine[0].name.as_str()), ("variable", "C"));
        let unit = mine.iter().find(|c| c.kind == "unit" && c.name == "C").ok_or("no unit C")?;
        assert_eq!(unit.insert, "'C");
        Ok(())
    }

    #[test]
    fn the_units_a_result_can_be_shown_in_are_searched_the_same_way() -> TestResult {
        let d = doc(&["F := 12 kN", "F ="]);
        let usual: Vec<String> = show_in(&d, "r1", "")?.into_iter().map(|c| c.unit).collect();
        assert_eq!(usual.first().map(String::as_str), Some("N"));
        let kilo = show_in(&d, "r1", "kn")?;
        assert_eq!(kilo.first().map(|c| (c.unit.as_str(), c.title.as_str())), Some(("kN", "kilonewton")));
        assert_eq!(kilo[0].text, "12 'kN");
        // a force in a unit that is not among the usual ones
        let dyn_ = show_in(&d, "r1", "dyn")?;
        assert_eq!(dyn_.first().map(|c| c.unit.as_str()), Some("dyn"));
        assert!(show_in(&d, "r1", "pascal")?.is_empty(), "only units of the result's kind");
        Ok(())
    }

    #[test]
    fn compound_units_are_named_from_their_parts() {
        assert_eq!(compound_title("kN*m").as_deref(), Some("kilonewton metre"));
        assert_eq!(compound_title("N/mm^2").as_deref(), Some("newton per square millimetre"));
        assert_eq!(compound_title("m/s^2").as_deref(), Some("metre per second squared"));
        assert_eq!(compound_title("°C").as_deref(), Some("degree Celsius"));
    }
}
