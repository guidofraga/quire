//! Lenient reading (docs/02-file-format.md §7): a file a newer Quire wrote, or one edited by
//! hand, must open in this version and lose nothing when saved again.
//!
//! - A value is read when it can be, even if not exactly as this version writes it: `2.0`
//!   where a count is expected, `[x, y, z]` for a position. It is then also kept verbatim
//!   in `extra`, so a writer puts back what it found.
//! - A known key whose value can't be read at all is ignored and kept verbatim in `extra`,
//!   with a warning.
//! - A region without the fields every region needs (a string `id` and `kind`, an `at`
//!   position, `regions` as a list) becomes a placeholder holding it whole, with a warning.
//!
//! The editor holds the document as JSON, so it can't hold a placeholder in the model:
//! [`hold_unreadable`] wraps each such region in one the editor can show, and
//! [`restore_unreadable`] puts the original back before saving.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value as Json, json};

use crate::{Display, DisplaySettings, DocError, Document, Region, Settings};

/// The kind of a placeholder region, and of the wrapper the editor holds for one.
pub const UNREADABLE: &str = "unreadable";

/// The wrapper's key for the region as written.
const ORIGINAL: &str = "original";

/// How much of a value was understood.
enum Read<T> {
    /// As this version writes it.
    Exact(T),
    /// In part, or in another spelling (`2.0` for 2): kept verbatim as well.
    Loose(T),
    No,
}

/// An object's fields, taken key by key; what is left over becomes `extra`.
struct Fields<'w> {
    map: Map<String, Json>,
    /// Where the object is, for warnings: `document`, `region abc123, display`.
    place: String,
    warnings: &'w mut Vec<String>,
}

impl Fields<'_> {
    /// The value of `key`, read by `read`. Only a value read exactly leaves the map; any
    /// other stays there verbatim. `null` counts as absent.
    fn take<T>(&mut self, key: &str, read: impl FnOnce(&Json, &mut Vec<String>) -> Read<T>) -> Option<T> {
        let value = self.map.get(key).filter(|v| !v.is_null())?;
        match read(value, self.warnings) {
            Read::Exact(t) => {
                self.map.shift_remove(key);
                Some(t)
            }
            Read::Loose(t) => Some(t),
            Read::No => {
                self.warnings.push(format!(
                    "{}: \"{key}\" isn't understood by this version of Quire; it is kept as it is",
                    self.place
                ));
                None
            }
        }
    }
}

fn string(v: &Json, _: &mut Vec<String>) -> Read<String> {
    v.as_str().map_or(Read::No, |s| Read::Exact(s.to_string()))
}

fn boolean(v: &Json, _: &mut Vec<String>) -> Read<bool> {
    v.as_bool().map_or(Read::No, Read::Exact)
}

/// A whole number; one written with a point (`2.0`) reads too.
fn integer<T: TryFrom<i64>>(v: &Json, _: &mut Vec<String>) -> Read<T> {
    if let Some(n) = v.as_i64() {
        return T::try_from(n).map_or(Read::No, Read::Exact);
    }
    match v.as_f64() {
        // within i64, an integral f64 converts exactly
        Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => {
            T::try_from(f as i64).map_or(Read::No, Read::Loose)
        }
        _ => Read::No,
    }
}

/// `[x, y]`; anything after them is kept but not read.
fn point(v: &Json) -> Read<[f64; 2]> {
    match v.as_array().map(Vec::as_slice) {
        Some([x, y, rest @ ..]) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) if rest.is_empty() => Read::Exact([x, y]),
            (Some(x), Some(y)) => Read::Loose([x, y]),
            _ => Read::No,
        },
        _ => Read::No,
    }
}

fn object<'w>(v: &Json, place: String, warnings: &'w mut Vec<String>) -> Option<Fields<'w>> {
    v.as_object().map(|m| Fields { map: m.clone(), place, warnings })
}

pub(crate) fn document(v: Json) -> Result<Document, DocError> {
    let Json::Object(map) = v else {
        return Err(DocError("not a Quire document: it isn't a JSON object".into()));
    };
    let mut warnings = Vec::new();
    let mut f = Fields { map, place: "document".into(), warnings: &mut warnings };
    let Some(format) = f.take("format", string) else {
        return Err(DocError("not a Quire document: it has no \"format\"".into()));
    };
    let meta = f.map.shift_remove("meta").unwrap_or(Json::Null);
    let settings = f.take("settings", settings).unwrap_or_default();
    let units = f.take("units", units).unwrap_or_default();
    let regions = f.take("regions", regions).unwrap_or_default();
    let extra = f.map;
    Ok(Document { format, meta, settings, units, regions, extra, warnings })
}

fn settings(v: &Json, w: &mut Vec<String>) -> Read<Settings> {
    let Some(mut f) = object(v, "settings".into(), w) else { return Read::No };
    let display = f.take("display", display_settings).unwrap_or_default();
    Read::Exact(Settings { display, extra: f.map })
}

fn display_settings(v: &Json, w: &mut Vec<String>) -> Read<DisplaySettings> {
    let Some(mut f) = object(v, "settings, display".into(), w) else { return Read::No };
    Read::Exact(DisplaySettings {
        decimals: f.take("decimals", integer),
        exponential_threshold: f.take("exponentialThreshold", integer),
        trailing_zeros: f.take("trailingZeros", boolean),
        result_units: f.take("resultUnits", string),
        notation: f.take("notation", string),
        sig_figs: f.take("sigFigs", integer),
        extra: f.map,
    })
}

/// Custom units; a definition that isn't text is skipped, and the whole map kept as written.
fn units(v: &Json, w: &mut Vec<String>) -> Read<BTreeMap<String, String>> {
    let Some(map) = v.as_object() else { return Read::No };
    let mut out = BTreeMap::new();
    for (name, def) in map {
        match def.as_str() {
            Some(d) => {
                out.insert(name.clone(), d.to_string());
            }
            None => w.push(format!(
                "unit {name}: its definition isn't understood by this version of Quire; it is kept as it is"
            )),
        }
    }
    if out.len() == map.len() { Read::Exact(out) } else { Read::Loose(out) }
}

fn regions(v: &Json, w: &mut Vec<String>) -> Read<Vec<Region>> {
    v.as_array().map_or(Read::No, |list| Read::Exact(list.iter().map(|r| region(r, w)).collect()))
}

/// Whether a region has the fields every region needs, so the editor can place and draw it.
fn readable(v: &Json) -> bool {
    v.get("id").is_some_and(Json::is_string)
        && v.get("kind").is_some_and(Json::is_string)
        && v.get("at").is_some_and(|a| !matches!(point(a), Read::No))
        && v.get("regions").is_none_or(|r| r.is_null() || r.is_array())
}

fn region(v: &Json, w: &mut Vec<String>) -> Region {
    if let Some(original) = held(v) {
        return placeholder(v, original.clone(), w);
    }
    if !readable(v) {
        return placeholder(v, v.clone(), w);
    }
    let id = v.get("id").and_then(Json::as_str).unwrap_or_default().to_string();
    let map = v.as_object().cloned().unwrap_or_default();
    let mut f = Fields { map, place: format!("region {id}"), warnings: w };
    let id = f.take("id", string).unwrap_or_default();
    let kind = f.take("kind", string).unwrap_or_default();
    let at = f.take("at", |a, _| point(a)).unwrap_or_default();
    let expr = f.take("expr", string);
    let show = f.take("show", string);
    let place = format!("region {id}, display");
    let display = f.take("display", |d, w| region_display(d, place, w));
    let disabled = f.take("disabled", boolean).unwrap_or(false);
    let regions = f.take("regions", regions).unwrap_or_default();
    Region { id, kind, at, expr, show, display, disabled, regions, extra: f.map, unreadable: None }
}

fn region_display(v: &Json, place: String, w: &mut Vec<String>) -> Read<Display> {
    let Some(mut f) = object(v, place, w) else { return Read::No };
    Read::Exact(Display { unit: f.take("unit", string), decimals: f.take("decimals", integer), extra: f.map })
}

/// The original inside a wrapper made by [`hold_unreadable`].
fn held(v: &Json) -> Option<&Json> {
    (v.get("kind").and_then(Json::as_str) == Some(UNREADABLE)).then(|| v.get(ORIGINAL)).flatten()
}

/// A placeholder for `original`, placed where `shown` says (the wrapper, or the region itself).
fn placeholder(shown: &Json, original: Json, w: &mut Vec<String>) -> Region {
    let id = shown.get("id").and_then(Json::as_str).unwrap_or_default().to_string();
    let named = if id.is_empty() { "A region".to_string() } else { format!("Region {id}") };
    w.push(format!("{named} isn't understood by this version of Quire; it is kept as it is"));
    let at = match shown.get("at").map(point) {
        Some(Read::Exact(p) | Read::Loose(p)) => p,
        _ => [0.0, 0.0],
    };
    Region {
        id,
        kind: UNREADABLE.into(),
        at,
        expr: None,
        show: None,
        display: None,
        disabled: false,
        regions: Vec::new(),
        extra: Map::new(),
        unreadable: Some(original),
    }
}

/// Wrap each region this version can't read (inside areas too) in a placeholder region the
/// editor can show and move: `{"id", "kind": "unreadable", "at", "original": <as written>}`.
/// It keeps the region's id when it has one, and its position, or else the one of the
/// region before it, so it stays where it was in reading order.
pub fn hold_unreadable(doc: &mut Json) {
    let mut used = HashSet::new();
    collect_ids(doc, &mut used);
    let mut next = 0;
    hold_in(doc, &mut used, &mut next);
}

fn collect_ids(v: &Json, used: &mut HashSet<String>) {
    let Some(list) = v.get("regions").and_then(Json::as_array) else { return };
    for r in list {
        if let Some(id) = r.get("id").and_then(Json::as_str) {
            used.insert(id.to_string());
        }
        collect_ids(r, used);
    }
}

/// A region id (`[a-z2-9]{6}`) not in use yet.
fn fresh_id(used: &mut HashSet<String>, next: &mut u64) -> String {
    const DIGITS: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    loop {
        let mut n = *next;
        *next += 1;
        let mut id = String::with_capacity(6);
        for _ in 0..6 {
            id.push(char::from(DIGITS.get((n % 32) as usize).copied().unwrap_or(b'z')));
            n /= 32;
        }
        if used.insert(id.clone()) {
            return id;
        }
    }
}

fn hold_in(v: &mut Json, used: &mut HashSet<String>, next: &mut u64) {
    let Some(list) = v.get_mut("regions").and_then(Json::as_array_mut) else { return };
    let mut before = json!([0, 0]);
    for r in list.iter_mut() {
        if held(r).is_none() && !readable(r) {
            let id = match r.get("id").and_then(Json::as_str) {
                Some(id) => id.to_string(),
                None => fresh_id(used, next),
            };
            // its own position's numbers as written (`5` stays `5`, not `5.0`)
            let at = match (r.get("at").map(point), r.get("at").and_then(Json::as_array)) {
                (Some(Read::Exact(_) | Read::Loose(_)), Some(a)) => {
                    Json::Array(a.iter().take(2).cloned().collect())
                }
                _ => before.clone(),
            };
            let original = r.take();
            *r = json!({ "id": id, "kind": UNREADABLE, "at": at, "original": original });
        }
        hold_in(r, used, next);
        if let Some(at) = r.get("at") {
            before = at.clone();
        }
    }
}

/// Put back what [`hold_unreadable`] wrapped, as it was written.
pub fn restore_unreadable(doc: &mut Json) {
    let Some(list) = doc.get_mut("regions").and_then(Json::as_array_mut) else { return };
    for r in list.iter_mut() {
        if let Some(original) = held(r).cloned() {
            *r = original;
        } else {
            restore_unreadable(r);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(regions: Json) -> Result<Document, DocError> {
        Document::from_json(json!({ "format": "quire/1", "regions": regions }))
    }

    #[test]
    fn a_whole_number_written_with_a_point_reads_and_is_kept_as_written() -> Result<(), DocError> {
        let d =
            doc(json!([{ "id": "aaaaaa", "kind": "math", "at": [0, 0], "display": { "decimals": 2.0 } }]))?;
        let display =
            d.regions.first().and_then(|r| r.display.as_ref()).ok_or(DocError("no display".into()))?;
        assert_eq!(display.decimals, Some(2));
        assert_eq!(display.extra.get("decimals"), Some(&json!(2.0)));
        assert!(d.warnings.is_empty());
        Ok(())
    }

    #[test]
    fn a_value_that_cant_be_read_is_ignored_kept_and_warned_about() -> Result<(), DocError> {
        let d = Document::from_json(json!({
            "format": "quire/1",
            "settings": { "display": { "decimals": "two", "sigFigs": 2.5 } },
            "units": { "tf": "1000 'kgf", "odd": 3 },
            "regions": [{ "id": "aaaaaa", "kind": "math", "at": [0, 0], "expr": ["x"], "disabled": "no" }]
        }))?;
        assert_eq!(d.settings.display.decimals, None);
        assert_eq!(d.settings.display.extra.get("decimals"), Some(&json!("two")));
        assert_eq!(d.settings.display.sig_figs, None);
        assert_eq!(d.units.get("tf").map(String::as_str), Some("1000 'kgf"));
        assert_eq!(d.extra.get("units"), Some(&json!({ "tf": "1000 'kgf", "odd": 3 })));
        let r = d.regions.first().ok_or(DocError("no region".into()))?;
        assert_eq!((r.expr.as_deref(), r.disabled), (None, false));
        assert_eq!(r.extra.get("expr"), Some(&json!(["x"])));
        assert_eq!(d.warnings.len(), 5, "{:?}", d.warnings);
        Ok(())
    }

    #[test]
    fn a_position_with_more_than_two_numbers_reads_its_first_two() -> Result<(), DocError> {
        let d = doc(json!([{ "id": "aaaaaa", "kind": "math", "at": [3, 4, 5] }]))?;
        let r = d.regions.first().ok_or(DocError("no region".into()))?;
        assert_eq!(r.at, [3.0, 4.0]);
        assert_eq!(r.extra.get("at"), Some(&json!([3, 4, 5])));
        assert!(r.unreadable.is_none() && d.warnings.is_empty());
        Ok(())
    }

    #[test]
    fn a_region_that_cant_be_read_becomes_a_placeholder() -> Result<(), DocError> {
        let odd = json!({ "id": "bbbbbb", "kind": "math", "at": { "x": 0 }, "expr": "a := 1" });
        let d = doc(json!([odd, "a region", { "id": "cccccc", "kind": "math", "at": [0, 9] }]))?;
        let kinds: Vec<_> = d.regions.iter().map(|r| (r.id.as_str(), r.kind.as_str())).collect();
        assert_eq!(kinds, [("bbbbbb", UNREADABLE), ("", UNREADABLE), ("cccccc", "math")]);
        assert_eq!(d.regions.first().and_then(|r| r.unreadable.as_ref()), Some(&odd));
        assert_eq!(d.warnings.len(), 2);
        assert!(Document::from_json(json!({ "regions": [] })).is_err());
        assert!(Document::from_json(json!([1])).is_err());
        Ok(())
    }

    #[test]
    fn held_regions_are_shown_in_place_and_restored_as_written() -> Result<(), DocError> {
        let original = json!({
            "format": "quire/1",
            "regions": [
                { "id": "aaaaaa", "kind": "math", "at": [0, 18] },
                ["no", "shape"],
                { "id": "bbbbbb", "kind": "area", "at": [0, 36], "regions": [
                    { "id": "cccccc", "kind": 7, "at": [5, 0] } ] }
            ]
        });
        let mut held = original.clone();
        hold_unreadable(&mut held);
        assert_eq!(held["regions"][1]["kind"], UNREADABLE);
        assert_eq!(held["regions"][1]["at"], json!([0, 18]));
        assert_eq!(held["regions"][1][ORIGINAL], json!(["no", "shape"]));
        assert_eq!(held["regions"][2]["regions"][0]["id"], "cccccc");
        assert_eq!(held["regions"][2]["regions"][0]["at"], json!([5, 0]));
        let d = Document::from_json(held.clone())?;
        assert_eq!(d.warnings.len(), 2);
        // holding twice changes nothing
        let mut again = held.clone();
        hold_unreadable(&mut again);
        assert_eq!(again, held);
        restore_unreadable(&mut held);
        assert_eq!(held, original);
        Ok(())
    }
}
