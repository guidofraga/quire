//! The converter (first written in Python as tools/sm2quire.py, since removed): settings,
//! metadata, page model, every region kind, the post-processing (captions, default fonts) and
//! the results/stats it reports.
//!
//! Python exceptions map onto this port as follows: a region that Python would fail on
//! becomes a warning plus a `legacy` region (the same fallback Python uses); a bad
//! document-level value (settings, page) becomes a warning and the key is left out.

use std::collections::{BTreeMap, HashMap, HashSet};

use roxmltree::Node;
use serde_json::{Map, Number, Value as Json, json};
use sha1::{Digest, Sha1};
use sha2::Sha256;

use crate::math::{self, Kind, Node as Ast};
use crate::text::{self, InlineMath, RegionFont};
use crate::{Asset, ImportError, Imported};

/// Errors inside one region or one setting, reported as text (the Python exception message).
type Res<T> = std::result::Result<T, String>;
type Obj = Map<String, Json>;

const FORMAT: &str = "quire/1";
/// How deeply `<region>` elements may nest (areas, text regions hoisting regions) before the
/// inner content is kept as a legacy region instead of being converted. Each level costs
/// real stack in debug builds, so this stays small; SMath documents use one or two levels.
const MAX_REGION_DEPTH: usize = 16;
/// How deeply unknown XML is copied into a legacy region before the rest is written empty.
const MAX_XML_DEPTH: usize = 128;

const ID_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
const KNOWN_ASSEMBLIES: [&str; 5] = ["SMath Core", "MathRegion", "TextRegion", "PictureRegion", "AreaRegion"];

/// The note of a math region: SMath keeps one `<description>` per language. A note is a
/// single text in Quire, so take the one a reader most likely wants: Portuguese, else
/// English (what multilingual text falls back to), else the first active one.
fn note_variant<'a, 'i>(m: Node<'a, 'i>) -> Option<Node<'a, 'i>> {
    let active: Vec<Node> =
        children(m, "description").into_iter().filter(|d| d.attribute("active") == Some("true")).collect();
    let by = |lang: &str| active.iter().copied().find(|d| d.attribute("lang") == Some(lang));
    by("por").or_else(|| by("eng")).or_else(|| active.first().copied())
}

/// Python `LANG` for the languages that have a short code; anything else is `None`.
fn lang_code(lang: &str) -> Option<&'static str> {
    match lang {
        "eng" => Some("en"),
        "rus" => Some("ru"),
        "por" => Some("pt"),
        "deu" => Some("de"),
        "fra" => Some("fr"),
        "spa" => Some("es"),
        "ita" => Some("it"),
        _ => None,
    }
}

/// Python `PAPER`: SMath paper ids -> named sizes.
fn paper_name(id: i64) -> Option<&'static str> {
    match id {
        9 => Some("A4"),
        1 => Some("Letter"),
        5 => Some("Legal"),
        8 => Some("A3"),
        11 => Some("A5"),
        _ => None,
    }
}

/// Key of a `<metadata>` title: `LANG.get(lang) or lang`.
fn meta_lang_key(lang: Option<&str>) -> String {
    match lang {
        None => "null".to_string(),
        Some(l) => lang_code(l).unwrap_or(l).to_string(),
    }
}

/// Key of a `<text>` variant: `LANG.get(lang, lang) or "und"` (`cpp` maps to `None`).
fn text_lang_key(lang: Option<&str>) -> String {
    let key = match lang {
        None | Some("cpp") => None,
        Some(l) => Some(lang_code(l).unwrap_or(l)),
    };
    match key {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => "und".to_string(),
    }
}

// ---------------------------------------------------------------------------
// XML helpers (ElementTree semantics, matched by local name)
// ---------------------------------------------------------------------------

/// First child element with the local name `name` (Python `child`).
fn child<'a, 'i>(el: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    el.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

/// All child elements with the local name `name` (Python `children`).
fn children<'a, 'i>(el: Node<'a, 'i>, name: &str) -> Vec<Node<'a, 'i>> {
    el.children().filter(|c| c.is_element() && c.tag_name().name() == name).collect()
}

/// ElementTree `.text`: the text before the first child element, `None` when empty.
fn text_of(el: Node) -> Option<String> {
    let mut s = String::new();
    for c in el.children() {
        if c.is_element() {
            break;
        }
        if c.is_text() {
            s.push_str(c.text().unwrap_or(""));
        }
    }
    (!s.is_empty()).then_some(s)
}

/// ElementTree `.tail`: the text after the element, up to its next sibling element.
fn tail_of(el: Node) -> Option<String> {
    let mut s = String::new();
    for n in el.next_siblings().skip(1) {
        if n.is_element() {
            break;
        }
        if n.is_text() {
            s.push_str(n.text().unwrap_or(""));
        }
    }
    (!s.is_empty()).then_some(s)
}

/// A non-empty attribute value (Python truthiness of `el.get(name)`).
fn nonempty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// Python `int(str)`.
fn pint(s: &str) -> Res<i64> {
    s.trim().parse::<i64>().map_err(|_| format!("invalid literal for int() with base 10: {s:?}"))
}

/// Python `int(el.get(name, default))`.
fn int_attr(el: Node, name: &str, default: i64) -> Res<i64> {
    match el.attribute(name) {
        Some(s) => pint(s),
        None => Ok(default),
    }
}

/// Python `int(el.get(name))`, where a missing attribute is an error.
fn req_int(el: Node, name: &str) -> Res<i64> {
    let s = el.attribute(name).ok_or_else(|| format!("missing attribute {name:?}"))?;
    pint(s)
}

/// Pixels per unit of a 2D plot at zoom 1. Read off the screenshots: at zoom `z` the horizontal
/// axis shows `6·z` px per unit (HermitePolynomials, Legendre).
const SMATH_PX_PER_UNIT: f64 = 6.0;

/// Pixels per unit at zoom 1 for plots saved by SMath's Plot Region 1.9 and later, per pixel of
/// the plot's width: those views scale with the region (Beam: zoom 1.105 in a 556 px plot
/// shows its supports 15 units apart 246 px apart, 16.4 px per unit). 1.8 and earlier use a
/// fixed 6 px per unit (PlanetaryGear, Hermite, Legendre).
const SMATH_PX_PER_UNIT_PER_WIDTH: f64 = 1.0 / 37.5;

/// How many px one unit takes in this plot at `zoom`.
fn px_per_unit(p: Node, zoom: f64, width: i64) -> f64 {
    if plot_region_scales_with_width(p) {
        zoom * width as f64 * SMATH_PX_PER_UNIT_PER_WIDTH
    } else {
        SMATH_PX_PER_UNIT * zoom
    }
}

/// Whether the worksheet was saved with Plot Region 1.9 or later (its `<dependencies>` list).
fn plot_region_scales_with_width(p: Node) -> bool {
    let Some(version) = p
        .document()
        .descendants()
        .find(|n| n.tag_name().name() == "assembly" && n.attribute("name") == Some("Plot Region"))
        .and_then(|n| n.attribute("version"))
    else {
        return false;
    };
    let mut parts = version.split('.').map(|x| x.trim().parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    (major, minor) >= (1, 9)
}

/// The x values visible across a 2D SMath plot `width` px wide, from its view attributes.
/// SMath keeps the horizontal zoom in `scale_y` (and the vertical one in `scale_x`), and
/// `transpose_x` moves the drawing right by that many px: x = 0 sits at `width/2 + transpose_x`.
/// Beam's view does not fit this model, but its curves are explicit data, so nothing relies on it.
fn visible_x(p: Node, width: i64) -> Option<(f64, f64)> {
    let zoom = p.attribute("scale_y").unwrap_or("1").trim().parse::<f64>().ok()?;
    let px_per_unit = px_per_unit(p, zoom, width);
    if !(px_per_unit.is_finite() && px_per_unit > 0.0) {
        return None;
    }
    let shift = p.attribute("transpose_x").unwrap_or("0").trim().parse::<f64>().ok()?;
    let half = width as f64 / 2.0;
    Some(((-half - shift) / px_per_unit, (half - shift) / px_per_unit))
}

/// The y values visible across a 2D SMath plot `height` px tall, from its view attributes. The
/// vertical zoom is in `scale_x` (the same px per unit as x), and the window's centre sits
/// `-transpose_y` px above y = 0: Beam (transpose_y = -34) shows its beam, at y = 2, in the
/// middle. Read off the Hermite screenshot: a 351 px plot at zoom 2.78 shows about ±10.5 units.
fn visible_y(p: Node, width: i64, height: i64) -> Option<(f64, f64)> {
    let zoom = p.attribute("scale_x")?.trim().parse::<f64>().ok()?;
    let px_per_unit = px_per_unit(p, zoom, width);
    if !(px_per_unit.is_finite() && px_per_unit > 0.0) {
        return None;
    }
    let shift = p.attribute("transpose_y").unwrap_or("0").trim().parse::<f64>().ok()?;
    let half = height as f64 / 2.0;
    Some(((-shift - half) / px_per_unit, (-shift + half) / px_per_unit))
}

/// Whether an expression reads the variable `x`.
fn mentions_x(ast: &Ast) -> bool {
    (ast.kind == Kind::Id && ast.value == "x") || ast.args.iter().any(mentions_x)
}

/// A range end written with at most three decimals.
fn bound(v: f64) -> String {
    format!("{}", (v * 1000.0).round() / 1000.0)
}

/// Python `re.sub(r"^\{[^}\n]*\}\n", "", s)`: drops a leading `{attrs}` line.
fn strip_attr_line(s: &str) -> &str {
    let Some(rest) = s.strip_prefix('{') else {
        return s;
    };
    let Some(idx) = rest.find(['}', '\n']) else {
        return s;
    };
    let Some((_, after)) = rest.split_at_checked(idx) else {
        return s;
    };
    after.strip_prefix("}\n").unwrap_or(s)
}

/// Python `base64.b64decode` for valid input: non-alphabet characters are skipped.
/// Never fails (a malformed payload yields the bytes that decode).
fn decode_b64(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Python `re.split(r" {3,}", s)` followed by `strip()` and dropping empty parts.
fn split_runs(s: &str, min: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != ' ' {
            cur.push(c);
            continue;
        }
        let mut run = 1;
        while chars.peek() == Some(&' ') {
            chars.next();
            run += 1;
        }
        if run >= min {
            parts.push(std::mem::take(&mut cur));
        } else {
            cur.extend(std::iter::repeat_n(' ', run));
        }
    }
    parts.push(cur);
    parts
}

/// Python `re.sub(r"&\[([A-Z]+)\]", ...)` with the header/footer field table.
fn expand_fields(s: &str) -> String {
    const FIELDS: [(&str, &str); 8] = [
        ("DATE", "{date}"),
        ("TIME", "{time}"),
        ("FILENAME", "{file}"),
        ("PAGENUM", "{page}"),
        ("COUNT", "{pages}"),
        ("AUTHOR", "{author}"),
        ("COMPANY", "{company}"),
        ("TITLE", "{title}"),
    ];
    let mut out = String::new();
    let mut rest = s;
    while let Some(pos) = rest.find("&[") {
        let Some((before, after)) = rest.split_at_checked(pos) else {
            break;
        };
        let Some(body) = after.strip_prefix("&[") else {
            break;
        };
        let name_len = body.bytes().take_while(u8::is_ascii_uppercase).count();
        let Some((name, tail)) = body.split_at_checked(name_len) else {
            break;
        };
        out.push_str(before);
        match tail.strip_prefix(']') {
            Some(after_close) if name_len > 0 => {
                match FIELDS.iter().find(|(k, _)| *k == name) {
                    Some((_, v)) => out.push_str(v),
                    None => out.push_str(&format!("&[{name}]")),
                }
                rest = after_close;
            }
            _ => {
                out.push_str("&[");
                rest = body;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Distinct items in first-seen order (the Python sets used for font promotion).
fn distinct<T: PartialEq>(items: impl Iterator<Item = T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// Position of a region's `at` pair, `(x, y)`.
fn pair(v: Option<&Json>) -> (i64, i64) {
    let arr = v.and_then(Json::as_array);
    let get = |i: usize| arr.and_then(|a| a.get(i)).and_then(Json::as_i64).unwrap_or(0);
    (get(0), get(1))
}

fn at_of(v: &Json) -> (i64, i64) {
    pair(v.get("at"))
}

fn size_of(v: &Json) -> (i64, i64) {
    pair(v.get("size"))
}

fn kind_of(v: &Json) -> &str {
    v.get("kind").and_then(Json::as_str).unwrap_or("")
}

fn id_of(v: &Json) -> &str {
    v.get("id").and_then(Json::as_str).unwrap_or("")
}

/// Python `num(s)`: an integral float as an int, otherwise the float.
fn number_of(f: f64) -> Option<Json> {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Some(json!(f as i64))
    } else {
        Number::from_f64(f).map(Json::Number)
    }
}

fn same_number(a: &Json, b: &Json) -> bool {
    a.as_f64().is_some() && a.as_f64() == b.as_f64()
}

// ---------------------------------------------------------------------------
// Math and text bridges (errors as text)
// ---------------------------------------------------------------------------

/// Python `math_expr(container)`: `None` when absent or without tokens.
fn math_of(container: Option<Node>) -> Res<Option<Ast>> {
    math::math_expr(container).map_err(|e| e.to_string())
}

/// Python `to_linear(ast, units_bare)`.
fn lin(ast: &Ast, units_bare: bool) -> Res<String> {
    math::statement_to_linear(ast, units_bare).map_err(|e| e.to_string())
}

/// Python `xml.etree` `tostring` of a region: the element with its tail, with SMath's
/// namespace written as `ns0` the way ElementTree does.
/// Returns the XML and whether any element below `MAX_XML_DEPTH` was cut off.
fn xml_of(el: Node) -> (String, bool) {
    let mut ns: Vec<&str> = Vec::new();
    for d in el.descendants() {
        if let Some(u) = d.tag_name().namespace()
            && !ns.contains(&u)
        {
            ns.push(u);
        }
    }
    let mut out = String::new();
    let cut = write_xml(el, &ns, true, 0, &mut out);
    if let Some(t) = tail_of(el) {
        out.push_str(&escape_text(&t));
    }
    (out, cut)
}

/// Writes `el` as XML. Returns true when deeper elements were written empty instead.
fn write_xml(el: Node, ns: &[&str], top: bool, depth: usize, out: &mut String) -> bool {
    let local = el.tag_name().name();
    let name = match el.tag_name().namespace() {
        Some(u) => format!("ns{}:{local}", ns.iter().position(|x| *x == u).unwrap_or(0)),
        None => local.to_string(),
    };
    out.push('<');
    out.push_str(&name);
    if top {
        for (i, u) in ns.iter().enumerate() {
            out.push_str(&format!(" xmlns:ns{i}=\"{}\"", escape_attr(u)));
        }
    }
    for a in el.attributes() {
        out.push_str(&format!(" {}=\"{}\"", a.name(), escape_attr(a.value())));
    }
    if depth >= MAX_XML_DEPTH {
        out.push_str(" />");
        return true;
    }
    let text = text_of(el);
    let has_children = el.children().any(|c| c.is_element());
    if text.is_none() && !has_children {
        out.push_str(" />");
        return false;
    }
    out.push('>');
    if let Some(t) = &text {
        out.push_str(&escape_text(t));
    }
    let mut cut = false;
    for c in el.children().filter(|c| c.is_element()) {
        cut |= write_xml(c, ns, false, depth.saturating_add(1), out);
        if let Some(t) = tail_of(c) {
            out.push_str(&escape_text(&t));
        }
    }
    out.push_str(&format!("</{name}>"));
    cut
}

fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_attr(s: &str) -> String {
    escape_text(s).replace('"', "&quot;").replace('\r', "&#13;").replace('\n', "&#10;").replace('\t', "&#09;")
}

/// Python `header_footer(h)`: a header or footer split into its left/center/right slots.
fn header_footer(h: Node) -> Obj {
    let raw = text_of(h).unwrap_or_default();
    let text = expand_fields(&raw);
    let parts: Vec<String> =
        split_runs(&text, 3).iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    let align = h.attribute("alignment").unwrap_or("Center").to_lowercase();
    let mut out = Obj::new();
    match parts.as_slice() {
        [one] => {
            out.insert(align, json!(one));
        }
        [left, right] => {
            out.insert("left".into(), json!(left));
            out.insert("right".into(), json!(right));
        }
        [first, middle @ .., last] => {
            out.insert("left".into(), json!(first));
            out.insert("center".into(), json!(middle.join(" ")));
            out.insert("right".into(), json!(last));
        }
        [] => {}
    }
    if let Some(c) = nonempty(h.attribute("color")) {
        out.insert("color".into(), json!(c.to_lowercase()));
    }
    out
}

/// Python `margins` entries: stored in hundredths of an inch, at 3/4 of the nominal size.
fn margin_mm(v: i64) -> String {
    format!("{:.1}mm", (v as f64) * 0.254 * 0.75).replace(".0mm", "mm")
}

/// Python `f"{int(...) * 0.254:.1f}mm"`, for paper sizes without a name.
fn paper_mm(v: i64) -> String {
    format!("{:.1}mm", (v as f64) * 0.254)
}

/// Tally that keeps insertion order, like a Python `Counter`: `top` is the first key
/// with the highest count (`most_common(1)`).
#[derive(Default)]
struct Tally<K> {
    items: Vec<(K, usize)>,
}

impl<K: PartialEq> Tally<K> {
    fn add(&mut self, k: K) {
        match self.items.iter_mut().find(|e| e.0 == k) {
            Some(entry) => entry.1 += 1,
            None => self.items.push((k, 1)),
        }
    }

    fn top(&self) -> Option<&K> {
        let mut best: Option<&(K, usize)> = None;
        for item in &self.items {
            if best.is_none_or(|b| item.1 > b.1) {
                best = Some(item);
            }
        }
        best.map(|b| &b.0)
    }
}

/// ID alphabet digits of the low 30 bits: char `i` is `(h >> 5i) & 31`.
fn short_id(v: u32) -> String {
    (0..6u32)
        .map(|i| {
            let idx = ((v >> (5 * i)) & 31) as usize;
            char::from(ID_ALPHABET.get(idx).copied().unwrap_or(b'a'))
        })
        .collect()
}

/// `h //= 7` on a 160-bit big-endian integer.
fn divide7(h: &mut [u8; 20]) {
    let mut rem: u32 = 0;
    for b in h.iter_mut() {
        let cur = rem * 256 + u32::from(*b);
        *b = (cur / 7) as u8;
        rem = cur % 7;
    }
}

fn low30(h: &[u8; 20]) -> u32 {
    let [.., a, b, c, d] = *h;
    u32::from_be_bytes([a, b, c, d]) & 0x3FFF_FFFF
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Converter {
    ids: HashSet<String>,
    seq: u64,
    assets: Vec<Asset>,
    asset_shas: HashSet<String>,
    results: Obj,
    stats: BTreeMap<String, usize>,
    warnings: Vec<String>,
    math_sizes: Tally<String>,
    /// Current `<region>` nesting, bounded by `MAX_REGION_DEPTH`.
    region_depth: usize,
    text_fonts: Tally<(String, String)>,
    /// The Python globals INLINE_MATH / INLINE_ORDER. Shared on purpose: nested text
    /// regions clear it, as the Python code does.
    inline: InlineMath,
}

/// Convert the parsed worksheet. Called by `crate::convert` after the XML has been read.
pub(crate) fn run(xml: &str) -> crate::Result<Imported> {
    let xml = xml.strip_prefix('\u{feff}').unwrap_or(xml);
    let doc = roxmltree::Document::parse(xml).map_err(|e| ImportError::Xml(e.to_string()))?;
    let root = doc.root_element();
    let mut c = Converter::default();
    let settings = child(root, "settings");

    let mut out = Obj::new();
    out.insert("format".into(), json!(FORMAT));
    out.insert("meta".into(), c.meta(settings));
    out.insert("settings".into(), c.calc_settings(settings));
    let page = c.page(settings);
    if !page.is_empty() {
        out.insert("page".into(), Json::Object(page));
    }

    let regions_el = if root.tag_name().name() == "regions" { Some(root) } else { child(root, "regions") };
    let mut regions = regions_el.map(|el| c.region_list(el, (0, 0))).unwrap_or_default();
    c.attach_captions(&mut regions);
    let styles = c.styles();
    out.insert("styles".into(), Json::Object(styles.clone()));
    c.strip_default_fonts(&mut regions, &styles);
    out.insert("regions".into(), Json::Array(regions));
    let deps = c.dependencies(settings);
    if !deps.is_empty() {
        out.insert("requires".into(), json!(deps));
    }

    Ok(Imported {
        document: Json::Object(out),
        results: Json::Object(c.results),
        assets: c.assets,
        stats: c.stats,
        warnings: c.warnings,
    })
}

impl Converter {
    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }

    fn count(&mut self, key: &str, by: usize) {
        *self.stats.entry(key.to_string()).or_insert(0) += by;
    }

    /// Python `num(s)` on a font size; a value that is not a number falls back to 10.
    fn num(&mut self, s: &str) -> Json {
        match s.trim().parse::<f64>() {
            Ok(f) if f.is_finite() => match number_of(f) {
                Some(n) => n,
                None => json!(10),
            },
            _ => {
                self.warn(format!("font size {s:?} is not a number; using 10"));
                json!(10)
            }
        }
    }

    // -- ids & assets -------------------------------------------------------

    /// Python `new_id`: sha1 of `"{seq}:{hint}"` as a 160-bit integer; six base-32 digits
    /// from its low bits, divided by 7 on each collision.
    fn new_id(&mut self, hint: &str) -> String {
        self.seq += 1;
        let digest = Sha1::digest(format!("{}:{hint}", self.seq).as_bytes());
        let mut h: [u8; 20] = digest.into();
        loop {
            let rid = short_id(low30(&h));
            if self.ids.insert(rid.clone()) {
                return rid;
            }
            if h.iter().all(|&b| b == 0) {
                break;
            }
            divide7(&mut h);
        }
        // h is 0 and every candidate is taken: append a counter instead of looping.
        let mut n: u64 = 1;
        loop {
            let rid = format!("aaaaaa{n}");
            if self.ids.insert(rid.clone()) {
                return rid;
            }
            n = n.saturating_add(1);
        }
    }

    /// Python `asset`: content-addressed by sha256, first-seen order kept.
    fn asset(&mut self, data: &[u8], ext: &str) -> String {
        let digest = Sha256::digest(data);
        let sha: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let prefix: String = sha.chars().take(16).collect();
        let path = format!("assets/{prefix}.{ext}");
        if self.asset_shas.insert(sha) {
            self.assets.push(Asset { path: path.clone(), data: data.to_vec() });
        }
        path
    }

    // -- document -----------------------------------------------------------

    fn meta(&mut self, settings: Option<Node>) -> Json {
        let mut meta = Obj::new();
        let mut authors: Vec<String> = Vec::new();
        let mut titles = Obj::new();
        let mut langs: Vec<Option<&str>> = Vec::new();
        for m in settings.map(|s| children(s, "metadata")).unwrap_or_default() {
            let lang = m.attribute("lang");
            if let Some(a) = child(m, "author").and_then(text_of)
                && !authors.contains(&a)
            {
                authors.push(a);
            }
            if let Some(t) = child(m, "title").and_then(text_of) {
                titles.insert(meta_lang_key(lang), json!(t));
            }
            langs.push(lang);
        }
        if titles.len() == 1 {
            if let Some(v) = titles.values().next() {
                meta.insert("title".into(), v.clone());
            }
        } else if !titles.is_empty() {
            meta.insert("title".into(), Json::Object(titles));
        }
        if !authors.is_empty() {
            meta.insert("authors".into(), json!(authors));
        }
        if let Some(id) = settings.and_then(|s| child(s, "identity")).and_then(|i| child(i, "id")) {
            meta.insert("id".into(), text_of(id).map_or(Json::Null, Json::String));
        }
        if langs.contains(&Some("por")) {
            meta.insert("lang".into(), json!("pt-BR"));
        }
        meta.insert("source".into(), json!({"app": "SMath Studio"}));
        Json::Object(meta)
    }

    fn int_field(&mut self, name: &str, v: &str) -> Option<i64> {
        match pint(v) {
            Ok(n) => Some(n),
            Err(e) => {
                self.warn(format!("settings {name}: {e}"));
                None
            }
        }
    }

    fn calc_settings(&mut self, settings: Option<Node>) -> Json {
        let mut out = Obj::new();
        // SMath writes every unit quoted ('m), so a bare name is a variable, never a unit or constant
        out.insert("units".into(), json!({ "marked": true }));
        let Some(calc) = settings.and_then(|s| child(s, "calculation")) else {
            return Json::Object(out);
        };
        let g = |name: &str| child(calc, name).and_then(text_of);
        let mut c = Obj::new();
        if let Some(v) = g("precision").filter(|s| !s.is_empty())
            && let Some(n) = self.int_field("precision", &v)
        {
            c.insert("decimals".into(), json!(n));
        }
        if let Some(v) = g("exponentialThreshold").filter(|s| !s.is_empty())
            && let Some(n) = self.int_field("exponentialThreshold", &v)
        {
            c.insert("exponentialThreshold".into(), json!(n));
        }
        if g("trailingZeros").as_deref() == Some("true") {
            c.insert("trailingZeros".into(), json!(true));
        }
        if let Some(v) = g("fractions").filter(|s| !s.is_empty() && s.as_str() != "decimal") {
            c.insert("fractions".into(), json!(v));
        }
        if let Some(v) = g("approximateEqualAccuracy").filter(|s| !s.is_empty())
            && let Some(n) = self.int_field("approximateEqualAccuracy", &v)
        {
            c.insert("approxEqualDigits".into(), json!(n));
        }
        out.insert("display".into(), Json::Object(c));
        Json::Object(out)
    }

    fn page(&mut self, settings: Option<Node>) -> Obj {
        let mut page = Obj::new();
        let Some(pm) = settings.and_then(|s| child(s, "pageModel")) else {
            return page;
        };
        let view = if pm.attribute("active") == Some("true") { "pages" } else { "canvas" };
        page.insert("view".into(), json!(view));
        if let Some(paper) = child(pm, "paper") {
            let pid = match paper.attribute("id") {
                None => 0,
                Some(s) => match pint(s) {
                    Ok(n) => n,
                    Err(e) => {
                        self.warn(format!("page paper: {e}"));
                        0
                    }
                },
            };
            match paper_name(pid) {
                Some(name) => {
                    page.insert("paper".into(), json!(name));
                }
                None => match (req_int(paper, "width"), req_int(paper, "height")) {
                    (Ok(w), Ok(h)) => {
                        page.insert("paper".into(), json!([paper_mm(w), paper_mm(h)]));
                    }
                    (Err(e), _) | (_, Err(e)) => self.warn(format!("page paper: {e}")),
                },
            }
            if paper.attribute("orientation").unwrap_or("Portrait").to_lowercase() != "portrait" {
                page.insert("orientation".into(), json!("landscape"));
            }
        }
        if let Some(mg) = child(pm, "margins") {
            let mut m = Obj::new();
            for k in ["top", "right", "bottom", "left"] {
                match req_int(mg, k) {
                    Ok(v) => {
                        m.insert(k.into(), json!(margin_mm(v)));
                    }
                    Err(e) => self.warn(format!("page margins: {e}")),
                }
            }
            page.insert("margins".into(), Json::Object(m));
        }
        for which in ["header", "footer"] {
            if let Some(h) = child(pm, which)
                && text_of(h).is_some_and(|t| !t.trim().is_empty())
            {
                page.insert(which.into(), Json::Object(header_footer(h)));
            }
        }
        if let Some(bgs) = child(pm, "backgrounds") {
            let mut out = Vec::new();
            for img in children(bgs, "image") {
                let data = decode_b64(&text_of(img).unwrap_or_default());
                let ext = if data.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
                let src = self.asset(&data, ext);
                let fit = if img.attribute("fullPage") == Some("true") { "page" } else { "margins" };
                out.push(json!({
                    "pages": img.attribute("page").unwrap_or("all"),
                    "src": src,
                    "fit": fit,
                }));
                self.count("background", 1);
            }
            if !out.is_empty() {
                page.insert("backgrounds".into(), Json::Array(out));
            }
        }
        page
    }

    fn dependencies(&self, settings: Option<Node>) -> Vec<String> {
        let Some(deps) = settings.and_then(|s| child(s, "dependencies")) else {
            return Vec::new();
        };
        children(deps, "assembly")
            .into_iter()
            .filter_map(|a| {
                let name = a.attribute("name");
                if name.is_some_and(|n| KNOWN_ASSEMBLIES.contains(&n)) {
                    return None;
                }
                Some(format!("smath:{}@{}", name.unwrap_or("None"), a.attribute("version").unwrap_or("None")))
            })
            .collect()
    }

    // -- regions ------------------------------------------------------------

    /// Python `region_list`: the regions of `parent`, sorted by (y, x).
    fn region_list(&mut self, parent: Node, origin: (i64, i64)) -> Vec<Json> {
        let mut out = Vec::new();
        for r in children(parent, "region") {
            out.extend(self.region(r, origin));
        }
        out.sort_by_key(|reg| {
            let (x, y) = at_of(reg);
            (y, x)
        });
        out
    }

    /// Python `base`: the fields every region has.
    fn base(&mut self, r: Node, origin: (i64, i64), kind: &str) -> Res<Obj> {
        let x = int_attr(r, "left", 0)?.saturating_sub(origin.0);
        let y = int_attr(r, "top", 0)?.saturating_sub(origin.1);
        let hint = match nonempty(r.attribute("id")) {
            Some(id) => id.to_string(),
            None => format!("{x},{y}"),
        };
        let id = self.new_id(&hint);
        let mut reg = Obj::new();
        reg.insert("id".into(), json!(id));
        reg.insert("kind".into(), json!(kind));
        reg.insert("at".into(), json!([x, y]));
        if r.attribute("isBreakable") == Some("false") {
            reg.insert("keep".into(), json!(true));
        }
        if r.attribute("enabled") == Some("false") {
            reg.insert("disabled".into(), json!(true));
        }
        let bg = r.attribute("bgColor").unwrap_or("").to_lowercase();
        if !bg.is_empty() && !matches!(bg.as_str(), "#ffffff" | "white" | "transparent") {
            reg.insert("background".into(), json!(bg));
        }
        if r.attribute("border") == Some("true") {
            reg.insert("border".into(), json!(true));
        }
        let color = nonempty(r.attribute("color")).unwrap_or("#000000").to_lowercase();
        if color != "#000000" {
            reg.insert("color".into(), json!(color));
        }
        Ok(reg)
    }

    /// Python `region`: the output regions for one `<region>` element. Any failure inside
    /// the handler becomes a warning and a `legacy` region holding the original XML.
    fn region(&mut self, r: Node, origin: (i64, i64)) -> Vec<Json> {
        // Every recursive path (area -> region list, text -> hoisted region) goes through
        // here, so this one check bounds the depth of the whole conversion.
        if self.region_depth >= MAX_REGION_DEPTH {
            let t = r
                .children()
                .find(|c| c.is_element() && c.tag_name().name() != "region")
                .map_or_else(|| "empty".to_string(), |c| c.tag_name().name().to_string());
            self.warn(format!(
                "region at top={}: regions nested too deeply; kept as legacy XML",
                r.attribute("top").unwrap_or("None")
            ));
            return self.legacy(r, &t, origin);
        }
        self.region_depth = self.region_depth.saturating_add(1);
        let out = self.region_inner(r, origin);
        self.region_depth = self.region_depth.saturating_sub(1);
        out
    }

    fn region_inner(&mut self, r: Node, origin: (i64, i64)) -> Vec<Json> {
        let kids: Vec<Node> =
            r.children().filter(|c| c.is_element() && c.tag_name().name() != "region").collect();
        let Some(&body) = kids.first() else {
            return Vec::new();
        };
        let t = body.tag_name().name().to_string();
        self.count(&t, 1);
        let attempt = match t.as_str() {
            "math" => Some(self.math(r, body, origin).map(|v| vec![v])),
            "text" => Some(self.text(r, &kids, origin)),
            "picture" => Some(self.picture(r, body, origin).map(|v| vec![v])),
            "area" => Some(self.area(r, body, origin)),
            "table" => Some(self.table(r, body, origin).map(|v| vec![v])),
            "plot" => Some(self.plot(r, body, origin).map(|v| vec![v])),
            "pagebreak" => Some(self.base(r, origin, "pagebreak").map(|m| vec![Json::Object(m)])),
            _ => None,
        };
        match attempt {
            None => self.legacy(r, &t, origin),
            Some(Ok(v)) => v,
            Some(Err(msg)) => {
                let top = r.attribute("top").unwrap_or("None");
                self.warn(format!("region at top={top}: {t}: {msg}"));
                self.legacy(r, &t, origin)
            }
        }
    }

    /// Python `legacy`: an unknown or unconvertible region kept as its XML.
    fn legacy(&mut self, r: Node, t: &str, origin: (i64, i64)) -> Vec<Json> {
        self.count(&format!("legacy:{t}"), 1);
        let mut reg = match self.base(r, origin, "legacy") {
            Ok(m) => m,
            Err(e) => {
                self.warn(format!("region dropped: {e}"));
                return Vec::new();
            }
        };
        let w = self.dimension(r, "width");
        let h = self.dimension(r, "height");
        reg.insert("size".into(), json!([w, h]));
        let (raw, cut) = xml_of(r);
        if cut {
            self.warn(format!(
                "region at top={}: {t}: XML nested too deeply; deeper elements dropped",
                r.attribute("top").unwrap_or("None")
            ));
        }
        let src = self.asset(raw.as_bytes(), "xml");
        reg.insert("legacy".into(), json!({"format": format!("smath:{t}"), "src": src}));
        vec![Json::Object(reg)]
    }

    /// Python `int(r.get(name, 0))` where a bad value only costs a warning.
    fn dimension(&mut self, r: Node, name: &str) -> i64 {
        match int_attr(r, name, 0) {
            Ok(v) => v,
            Err(e) => {
                self.warn(format!("{name}: {e}"));
                0
            }
        }
    }

    fn math(&mut self, r: Node, m: Node, origin: (i64, i64)) -> Res<Json> {
        let mut reg = self.base(r, origin, "math")?;
        let input = child(m, "input").unwrap_or(m);
        let ast = math_of(Some(input))?.ok_or_else(|| "empty math".to_string())?;
        reg.insert("expr".into(), json!(lin(&ast, false)?));
        let result = child(m, "result");
        let contract = math_of(child(m, "contract"))?;
        let mut fmt = Obj::new();
        if let Some(c) = &contract {
            fmt.insert("unit".into(), json!(lin(c, true)?));
        }
        if let Some(dp) = nonempty(m.attribute("decimalPlaces")) {
            fmt.insert("decimals".into(), json!(pint(dp)?));
        }
        if let Some(res) = result {
            let symbolic = res.attribute("action") == Some("symbolic") && !math::is_numeric_matrix(res);
            let show = if symbolic { "symbolic" } else { "value" };
            reg.insert("show".into(), json!(show));
            if let Some(val) = math_of(Some(res))? {
                let mut shown = lin(&val, false)?;
                if let Some(c) = &contract {
                    shown = format!("{shown} {}", lin(c, false)?);
                }
                let id = id_str(&reg);
                self.results.insert(id, json!(shown));
            }
        }
        if !fmt.is_empty() {
            reg.insert("display".into(), Json::Object(fmt));
        }
        match m.attribute("optimize") {
            Some("1") => {
                reg.insert("mode".into(), json!("symbolic"));
            }
            Some("2") => {
                reg.insert("mode".into(), json!("numeric"));
            }
            _ => {}
        }
        if r.attribute("showInputData").unwrap_or("").to_lowercase() == "false" && reg.contains_key("show") {
            reg.insert("hideInput".into(), json!(true));
        }
        if let Some(desc) = note_variant(m) {
            let note = self.paragraph_join(desc);
            if !note.is_empty() {
                reg.insert("note".into(), json!(note));
                let pos = desc.attribute("position").unwrap_or("Right");
                if pos != "Right" {
                    reg.insert("notePosition".into(), json!(pos.to_lowercase()));
                }
            }
        }
        self.math_sizes.add(r.attribute("fontSize").unwrap_or("10").to_string());
        Ok(Json::Object(reg))
    }

    /// Python `"\n\n".join(b for b, _ in paragraphs(el) if b)`.
    fn paragraph_join(&mut self, el: Node) -> String {
        text::paragraphs(el, &mut self.inline)
            .into_iter()
            .map(|(b, _)| b)
            .filter(|b| !b.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn text(&mut self, r: Node, kids: &[Node], origin: (i64, i64)) -> Res<Vec<Json>> {
        let mut reg = self.base(r, origin, "text")?;
        let texts: Vec<Node> = kids.iter().copied().filter(|k| k.tag_name().name() == "text").collect();
        let first = texts.first().copied().ok_or_else(|| "text region without a <text>".to_string())?;

        // embedded math regions become inline math; anything else is hoisted below
        self.inline = InlineMath::default();
        let mut cached: HashMap<String, String> = HashMap::new();
        for v in &texts {
            let Some(sub) = child(*v, "regions") else {
                continue;
            };
            for e in children(sub, "region") {
                let Some(m) = child(e, "math") else {
                    continue;
                };
                let Some(inp) = child(m, "input") else {
                    continue;
                };
                let Some(ast) = math_of(Some(inp))? else {
                    continue;
                };
                let Some(id) = nonempty(e.attribute("id")) else {
                    continue;
                };
                let shown = child(m, "result").is_some();
                let mut inline = format!("$`{}", lin(&ast, false)?);
                if shown {
                    inline.push_str(" =");
                }
                inline.push('`');
                self.inline.map.insert(id.to_string(), inline);
                if shown && let Some(val) = math_of(child(m, "result"))? {
                    cached.insert(id.to_string(), lin(&val, false)?);
                }
            }
        }

        let mut font = RegionFont {
            family: nonempty(first.attribute("fontFamily")).unwrap_or("Arial").to_string(),
            size: nonempty(first.attribute("fontSize"))
                .or(nonempty(r.attribute("fontSize")))
                .unwrap_or("10")
                .to_string(),
        };
        let mut by_lang = Obj::new();
        for v in &texts {
            let paras = text::paragraphs(*v, &mut self.inline);
            // promote a uniformly-sized single paragraph's font size to the region
            let sizes = distinct(paras.iter().filter_map(|(_, st)| {
                st.get("font-size").map(|s| s.replace("px", "")).filter(|s| !s.is_empty())
            }));
            if let [only] = sizes.as_slice() {
                font.size = only.clone();
            }
            let fams = distinct(paras.iter().filter_map(|(_, st)| st.get("font-family").cloned()));
            if let [only] = fams.as_slice() {
                font.family = only.clone();
            }
            let blocks: Vec<String> = paras
                .iter()
                .filter(|(b, _)| !b.is_empty())
                .map(|(b, st)| text::para_block(b, st, &font))
                .collect();
            by_lang.insert(text_lang_key(v.attribute("lang")), json!(blocks.join("\n\n")));
        }
        let first_val = by_lang.values().next().cloned();
        let uniform = by_lang.values().all(|v| Some(v) == first_val.as_ref());
        let text_json = if uniform { first_val.unwrap_or_else(|| json!("")) } else { Json::Object(by_lang) };
        reg.insert("text".into(), text_json);

        // inline math ids follow their order in the (first) text: <region id>:m<n>
        let n_texts = texts.len().max(1);
        let order: Vec<String> =
            self.inline.order.iter().take(self.inline.order.len() / n_texts).cloned().collect();
        let id = id_str(&reg);
        for (n, src_id) in order.iter().enumerate() {
            if let Some(val) = cached.get(src_id) {
                self.results.insert(format!("{id}:m{n}"), json!(val));
            }
        }
        self.count("inline-math", order.len());
        if let Some(w) = nonempty(first.attribute("width")) {
            reg.insert("width".into(), json!(pint(w)?));
        }
        reg.insert("font".into(), json!({"family": font.family, "size": font.size}));
        self.text_fonts.add((font.family.clone(), font.size.clone()));

        // heading detection: "1. ASSUMPTIONS" / "*7. CONCLUSION*" -> auto-numbered heading
        let source = reg.get("text").and_then(Json::as_str).map(str::to_string);
        if let Some(src) = source {
            let body = strip_attr_line(&src).to_string();
            if !body.contains('\n')
                && let Some((num, title)) = text::heading(&text::plain(&body))
                && body.starts_with('*')
                && title.chars().count() < 80
            {
                let level = num.matches('.').count() + 1;
                let heading = format!("{} {}", "#".repeat(level), text::esc(title.trim()));
                reg.insert("text".into(), json!(heading));
                self.count("heading", 1);
            }
        }

        let text_empty = matches!(reg.get("text"), Some(Json::String(s)) if s.is_empty());
        let mut out = vec![Json::Object(reg)];
        // other regions embedded in text are hoisted to siblings at absolute positions
        for v in &texts {
            let Some(sub) = child(*v, "regions") else {
                continue;
            };
            let inner_origin = (
                origin.0.saturating_sub(int_attr(r, "left", 0)?),
                origin.1.saturating_sub(int_attr(r, "top", 0)?),
            );
            for e in children(sub, "region") {
                let inline = e.attribute("id").is_some_and(|id| self.inline.map.contains_key(id));
                if !inline {
                    let hoisted = self.region(e, inner_origin);
                    out.extend(hoisted);
                    self.count("hoisted", 1);
                }
            }
        }
        if text_empty && out.len() > 1 {
            out.remove(0);
        }
        Ok(out)
    }

    fn picture(&mut self, r: Node, p: Node, origin: (i64, i64)) -> Res<Json> {
        let mut reg = self.base(r, origin, "image")?;
        let raw = child(p, "raw").ok_or_else(|| "'NoneType' has no attribute 'text'".to_string())?;
        let data = decode_b64(&text_of(raw).unwrap_or_default());
        let src = self.asset(&data, raw.attribute("format").unwrap_or("png"));
        reg.insert("src".into(), json!(src));
        let size = [req_int(r, "width")?, req_int(r, "height")?];
        reg.insert("size".into(), json!(size));
        Ok(Json::Object(reg))
    }

    fn area(&mut self, r: Node, a: Node, origin: (i64, i64)) -> Res<Vec<Json>> {
        if a.attribute("terminator") == Some("true") {
            return Ok(Vec::new());
        }
        let mut reg = self.base(r, origin, "area")?;
        let top = int_attr(r, "top", 0)?;
        let y = pair(reg.get("at")).1;
        reg.insert("at".into(), json!([0, y]));
        if let Some(title) = child(a, "title") {
            let t = self.paragraph_join(title);
            if !t.is_empty() {
                reg.insert("title".into(), json!(t));
            }
        }
        if a.attribute("collapsed") == Some("true") {
            reg.insert("collapsed".into(), json!(true));
        }
        if a.attribute("locked") == Some("true") {
            reg.insert("locked".into(), json!(true));
        }
        let term: Vec<Node> = children(r, "region")
            .into_iter()
            .filter(|c| child(*c, "area").is_some_and(|x| x.attribute("terminator") == Some("true")))
            .collect();
        if let Some(last) = term.last() {
            let bottom = req_int(*last, "top")?;
            reg.insert("height".into(), json!(bottom.saturating_sub(top)));
        }
        let inner = self.region_list(r, (origin.0, top));
        reg.insert("regions".into(), Json::Array(inner));
        Ok(vec![Json::Object(reg)])
    }

    fn table(&mut self, r: Node, t: Node, origin: (i64, i64)) -> Res<Json> {
        let mut reg = self.base(r, origin, "table")?;
        let size = [req_int(r, "width")?, req_int(r, "height")?];
        reg.insert("size".into(), json!(size));
        let body = child(t, "regions").and_then(|layout| child(layout, "body"));
        let inputs = child(t, "inputs").ok_or_else(|| "'NoneType' object is not iterable".to_string())?;
        let bound: Vec<Option<String>> = children(inputs, "e")
            .into_iter()
            .filter(|e| e.attribute("regions") == Some("rows"))
            .map(text_of)
            .collect();
        let source = bound.into_iter().next().flatten();
        reg.insert("source".into(), json!(source));
        if let Some(body) = body {
            // SMath tables display a matrix variable; the matrix's first row/column
            // act as headers. Cell values are recomputed live, never stored.
            let tds = child(body, "tr").map(|tr| children(tr, "td")).unwrap_or_default();
            let column = tds.first().is_some_and(|td| text_of(*td).unwrap_or_default().trim().is_empty());
            reg.insert("header".into(), json!({"row": true, "column": column}));
            let numbers = nonempty(body.attribute("numbers")).unwrap_or("Default,2");
            let dec = numbers.split(',').nth(1).ok_or_else(|| "list index out of range".to_string())?;
            let decimals = pint(dec)?;
            reg.insert("display".into(), json!({"decimals": decimals}));
        }
        let dropped = body
            .map_or(0, |b| b.descendants().filter(|d| d.is_element() && d.tag_name().name() == "td").count());
        self.count("table-cells-dropped", dropped);
        Ok(Json::Object(reg))
    }

    fn plot(&mut self, r: Node, p: Node, origin: (i64, i64)) -> Res<Json> {
        let kind = if p.attribute("type") == Some("3d") { "plot3d" } else { "plot2d" };
        let mut reg = self.base(r, origin, kind)?;
        let width = req_int(r, "width")?;
        let size = [width, req_int(r, "height")?];
        reg.insert("size".into(), json!(size));
        let mut series: Vec<Json> = Vec::new();
        // SMath sweeps a free x over the visible range without saying so: give it explicitly
        let view = if kind == "plot2d" { visible_x(p, width) } else { None };
        let view_y = if kind == "plot2d" { visible_y(p, width, size[1]) } else { None };
        if let Some(ast) = math_of(child(p, "input"))? {
            let is_sys = ast.kind == Kind::Call && ast.value == "sys";
            let mut items: Vec<&Ast> = if is_sys { ast.args.iter().collect() } else { vec![&ast] };
            if is_sys && items.len() > 2 {
                items.truncate(items.len().saturating_sub(2)); // sys(..., rows, cols)
            }
            for item in items {
                let y = lin(item, false)?;
                series.push(match view {
                    Some((lo, hi)) if mentions_x(item) => {
                        json!({"y": y, "x": "x", "range": format!("{}..{}", bound(lo), bound(hi))})
                    }
                    _ => json!({"y": y}),
                });
            }
        }
        reg.insert("series".into(), Json::Array(series));
        reg.insert("grid".into(), json!(p.attribute("grid") == Some("true")));
        // SMath draws a fixed window (its zoom and pan), never fitting the data: carry the window
        // over whether or not the axes are shown, so a drawing keeps its size next to markers
        // whose sizes are in pixels (PlanetaryGear's star against its wheel)
        let axes_shown = p.attribute("axes") != Some("false");
        let round = |v: f64| (v * 1000.0).round() / 1000.0;
        let mut axes = serde_json::Map::new();
        if let Some((lo, hi)) = view {
            axes.insert("x".into(), json!({"min": round(lo), "max": round(hi)}));
        }
        if let Some((lo, hi)) = view_y {
            axes.insert("y".into(), json!({"min": round(lo), "max": round(hi)}));
        }
        if axes.is_empty() {
            reg.insert("axes".into(), json!(axes_shown));
        } else {
            if !axes_shown {
                axes.insert("visible".into(), json!(false));
            }
            reg.insert("axes".into(), Json::Object(axes));
        }
        // SMath's plots have no legend, and they use SMath's own series colours in order
        reg.insert("legend".into(), json!(false));
        reg.insert("palette".into(), json!("smath"));
        // SMath's equal scales (scale_x = scale_y) keep a circle round
        if kind == "plot2d"
            && p.attribute("scale_x").is_some()
            && p.attribute("scale_x") == p.attribute("scale_y")
        {
            reg.insert("aspect".into(), json!("equal"));
        }
        // `animate` names the list of values that drives the frames (SMath's `step`). The variable
        // it binds is the last plain name the plotted call reads (`f(path, t)` binds `t`).
        if let Some(ast) = math_of(child(p, "input"))?
            && let Some(list) = nonempty(p.attribute("animate"))
            && ast.kind == Kind::Call
            && let Some(var) = ast.args.iter().rev().find(|a| a.kind == Kind::Id).map(|a| a.value.clone())
        {
            let fps = p
                .attribute("frameRate")
                .and_then(|f| f.trim().parse::<f64>().ok())
                .filter(|f| f.is_finite() && *f > 0.0)
                .unwrap_or(20.0);
            reg.insert("animate".into(), json!({"var": var, "over": list, "fps": fps}));
        }
        if let Some(render) = nonempty(p.attribute("render"))
            && render != "lines"
        {
            reg.insert("render".into(), json!(render));
        }
        Ok(Json::Object(reg))
    }

    // -- post-processing ----------------------------------------------------

    /// Python `attach_captions`: a caption text next to a figure or table becomes that
    /// figure's `caption`, and the text region is removed.
    fn attach_captions(&mut self, regions: &mut Vec<Json>) {
        let snapshot: Vec<Json> = regions.clone();
        for tr in &snapshot {
            if kind_of(tr) != "text" {
                continue;
            }
            let Some(text_src) = tr.get("text").and_then(Json::as_str) else {
                continue;
            };
            if strip_attr_line(text_src).contains('\n') {
                continue;
            }
            let Some((label, _number, caption)) = text::caption(&text::plain(text_src)) else {
                continue;
            };
            let want_table = label.to_lowercase().starts_with("tab");
            let (_, ty) = at_of(tr);
            // (gap, index in regions, figure y)
            let mut best: Option<(i64, usize, i64)> = None;
            for (i, f) in regions.iter().enumerate() {
                let fk = kind_of(f);
                if !matches!(fk, "image" | "table" | "plot2d" | "plot3d") {
                    continue;
                }
                if (fk == "table") != want_table || f.get("caption").is_some() {
                    continue;
                }
                let (_, fy) = at_of(f);
                let (_, fh) = size_of(f);
                let gap = ty
                    .saturating_sub(fy.saturating_add(fh))
                    .saturating_abs()
                    .min(fy.saturating_sub(ty).saturating_sub(20).saturating_abs());
                if gap <= 60 && best.is_none_or(|(g, _, _)| gap < g) {
                    best = Some((gap, i, fy));
                }
            }
            if let Some((_, i, fy)) = best {
                let position = if ty < fy { "above" } else { "below" };
                if let Some(f) = regions.get_mut(i).and_then(Json::as_object_mut) {
                    f.insert(
                        "caption".into(),
                        json!({"text": text::esc(caption.trim()), "position": position}),
                    );
                }
                let tr_id = id_of(tr);
                if let Some(pos) = regions.iter().position(|r| id_of(r) == tr_id) {
                    regions.remove(pos);
                }
                self.count("caption", 1);
            }
        }
        for r in regions.iter_mut() {
            if kind_of(r) != "area" {
                continue;
            }
            if let Some(Json::Array(sub)) = r.as_object_mut().and_then(|o| o.get_mut("regions")) {
                self.attach_captions(sub);
            }
        }
    }

    /// Python `styles()`: the most used body font and math size, plus the numbering format.
    fn styles(&mut self) -> Obj {
        let (fam, size) =
            self.text_fonts.top().cloned().unwrap_or_else(|| ("Arial".to_string(), "10".to_string()));
        let msize = self.math_sizes.top().cloned().unwrap_or_else(|| "10".to_string());
        let body_size = self.num(&size);
        let math_size = self.num(&msize);
        let mut out = Obj::new();
        out.insert("body".into(), json!({"font": fam, "size": body_size}));
        out.insert("math".into(), json!({"font": "STIX Two Math", "size": math_size}));
        out.insert(
            "numbering".into(),
            json!({"headings": "1.1", "figures": "Figura {n} \u{2013}", "tables": "Tabela {n} \u{2013}"}),
        );
        out
    }

    /// Python `strip_default_fonts`: a region's font becomes `style` only where it differs
    /// from the document body font.
    fn strip_default_fonts(&mut self, regions: &mut [Json], styles: &Obj) {
        let body = styles.get("body").and_then(Json::as_object);
        let body_font = body.and_then(|b| b.get("font")).cloned().unwrap_or(Json::Null);
        let body_size = body.and_then(|b| b.get("size")).cloned().unwrap_or(Json::Null);
        for r in regions.iter_mut() {
            let Some(obj) = r.as_object_mut() else {
                continue;
            };
            if let Some(f) = obj.shift_remove("font") {
                let family = f.get("family").cloned().unwrap_or(Json::Null);
                let size_src = f.get("size").and_then(Json::as_str).unwrap_or("10");
                let size = self.num(size_src);
                let mut over = Obj::new();
                if family != body_font {
                    over.insert("font".into(), family);
                }
                if !same_number(&size, &body_size) {
                    over.insert("size".into(), size);
                }
                if !over.is_empty() {
                    obj.insert("style".into(), Json::Object(over));
                }
            }
            if obj.get("kind").and_then(Json::as_str) == Some("area")
                && let Some(Json::Array(sub)) = obj.get_mut("regions")
            {
                self.strip_default_fonts(sub, styles);
            }
        }
    }
}

/// `id` of a region map, as a string ("" when absent).
fn id_str(reg: &Obj) -> String {
    reg.get("id").and_then(Json::as_str).unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn ids_for(hints: &[&str]) -> Vec<String> {
        let mut c = Converter::default();
        hints.iter().map(|h| c.new_id(h)).collect()
    }

    #[test]
    fn ids_match_python_reference() {
        // expected values from the Python importer's Converter.new_id, one converter, in order
        let got = ids_for(&["", "1,2", "a1b2", "1,2"]);
        assert_eq!(got, ["az3hst", "zue3jq", "gat2zu", "2shca9"]);
    }

    #[test]
    fn colliding_id_is_divided_by_seven() {
        // Python: Converter with ids={"az3hst"}, new_id("") -> "e4nvwm" (h //= 7 once)
        let mut c = Converter::default();
        c.ids.insert("az3hst".to_string());
        assert_eq!(c.new_id(""), "e4nvwm");
    }

    #[test]
    fn colliding_ids_stay_unique() {
        let mut c = Converter::default();
        let mut seen = HashSet::new();
        for _ in 0..2000 {
            let id = c.new_id("same");
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn divide7_matches_integer_division() {
        let mut h = [0u8; 20];
        h[19] = 0x2a; // 42
        divide7(&mut h);
        assert_eq!(h[19], 6);
        let mut big = [0xffu8; 20];
        divide7(&mut big);
        // (2^160 - 1) / 7 = 0x2492...4924 (low byte 0x24 with the pattern 0x24 0x92 ...)
        assert_eq!(big[0], 0x24);
        assert_eq!(big[1], 0x92);
        assert_eq!(big[2], 73);
    }

    #[test]
    fn asset_is_deduplicated_by_content() {
        let mut c = Converter::default();
        let a = c.asset(b"hello", "png");
        let b = c.asset(b"hello", "png");
        let other = c.asset(b"world", "jpg");
        assert_eq!(a, b);
        assert_ne!(a, other);
        assert_eq!(c.assets.len(), 2);
        assert_eq!(c.assets.first().map(|x| x.path.as_str()), Some(a.as_str()));
        // sha256("hello") starts 2cf24dba5fb0a30e
        assert_eq!(a, "assets/2cf24dba5fb0a30e.png");
    }

    #[test]
    fn non_xml_is_an_error() {
        assert!(matches!(crate::convert("this is not xml"), Err(ImportError::Xml(_))));
    }

    #[test]
    fn malformed_region_becomes_legacy_with_warning() -> TestResult {
        // an operator with too few operands: the math region cannot be converted
        let xml = r#"<?xml version="1.0"?>
<regions xmlns="http://smath.info/schemas/worksheet/1.0">
<region id="r1" left="9" top="9" width="100" height="20">
<math><input><e type="operand">a</e><e type="operator" args="2">+</e></input></math>
</region>
</regions>"#;
        let out = crate::convert(xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        assert_eq!(regions.len(), 1);
        assert_eq!(regions.first().map(kind_of), Some("legacy"));
        assert_eq!(out.warnings.len(), 1);
        assert_eq!(out.assets.len(), 1);
        Ok(())
    }

    #[test]
    fn an_animated_plot_names_its_list_and_its_variable() -> TestResult {
        // f(path, t) animated over `step` at 20 frames a second, with equal scales
        let xml = r#"<?xml version="1.0"?>
<regions xmlns="http://smath.info/schemas/worksheet/1.0">
<region id="p" left="9" top="9" width="227" height="219">
<plot type="2d" render="lines" grid="false" axes="false" scale_x="2.5" scale_y="2.5" animate="step" frameRate="20">
<input><e type="operand">path</e><e type="operand">t</e><e type="function" args="2">f</e></input>
</plot>
</region>
</regions>"#;
        let out = crate::convert(xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        let plot = regions.first().ok_or("no plot")?;
        assert_eq!(plot.get("animate"), Some(&json!({"var": "t", "over": "step", "fps": 20.0})));
        assert_eq!(plot.get("aspect"), Some(&json!("equal")));
        // SMath's window is kept, with the axes hidden
        let axes = plot.get("axes").ok_or("no axes")?;
        assert_eq!(axes.get("visible"), Some(&json!(false)));
        assert!(axes.get("x").and_then(|x| x.get("max")).is_some());
        Ok(())
    }

    #[test]
    fn smath_line_blocks_keep_their_last_statement_and_equality_is_a_test() -> TestResult {
        // line(a, b, rows, cols): the last two numbers are the block's layout, not its value
        let xml = r#"<?xml version="1.0"?>
<regions xmlns="http://smath.info/schemas/worksheet/1.0">
<region id="m" left="9" top="9" width="100" height="20">
<math><input><e type="operand">a</e><e type="operand">1</e><e type="operator" args="2">≡</e><e type="operand">a</e><e type="operand">2</e><e type="operand">1</e><e type="function" args="4">line</e></input></math>
</region>
</regions>"#;
        let out = crate::convert(xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        let expr = regions.first().and_then(|r| r.get("expr")).and_then(Json::as_str).ok_or("no expr")?;
        assert_eq!(expr, "block(a == 1, a)");
        Ok(())
    }

    #[test]
    fn a_plot_sweeps_the_free_x_over_the_visible_range() -> TestResult {
        // zoom 2 on the horizontal axis (scale_y) shows 12 px per unit; 350 px wide, so x runs
        // from -175/12 to 175/12; a transpose of 60 px moves the window right by 5 units
        let xml_for = |tx: &str| {
            format!(
                r#"<?xml version="1.0"?>
<regions xmlns="http://smath.info/schemas/worksheet/1.0">
<region id="p" left="9" top="9" width="350" height="200">
<plot type="2d" render="lines" scale_x="1" scale_y="2" transpose_x="{tx}" transpose_y="0">
<input><e type="operand">x</e><e type="operand">0</e><e type="function" args="2">H</e>
<e type="operand">y</e><e type="operand">1</e><e type="operator" args="2">+</e><e type="operand">2</e><e type="operand">1</e><e type="function" args="4">sys</e></input>
</plot>
</region>
</regions>"#
            )
        };
        let out = crate::convert(&xml_for("0"))?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        let plot = regions.first().ok_or("no plot")?;
        let series = plot.get("series").and_then(Json::as_array).ok_or("no series")?;
        // the first item reads x: it gets the range; the second has no x and gets none
        let first = series.first().ok_or("no first series")?;
        assert_eq!(first.get("x").and_then(Json::as_str), Some("x"));
        assert_eq!(first.get("range").and_then(Json::as_str), Some("-14.583..14.583"));
        assert!(series.get(1).is_some_and(|s| s.get("range").is_none()));
        // SMath shows axes unless the plot turns them off; with them shown, the y window is 351 px / (6 × 2.5)
        assert_ne!(plot.get("axes"), Some(&json!(false)), "SMath shows axes unless the plot turns them off");
        assert_eq!(plot.pointer("/axes/y/min").and_then(Json::as_f64), Some(-16.667));
        // the window moves with transpose_x: x = 0 is at width/2 + 60 px, so x runs from
        // -235/12 to 115/12
        let moved = crate::convert(&xml_for("60"))?;
        let regions = moved.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        let series =
            regions.first().and_then(|p| p.get("series")).and_then(Json::as_array).ok_or("no series")?;
        let range = series.first().and_then(|s| s.get("range")).and_then(Json::as_str);
        assert_eq!(range, Some("-19.583..9.583"));
        Ok(())
    }

    /// `n` regions, each an area holding the next one, closed at the end.
    fn nested_areas_xml(n: usize) -> String {
        let mut s = String::from(r#"<?xml version="1.0"?><regions><region left="0" top="0"><area/>"#);
        for i in 1..n {
            s.push_str(&format!(r#"<region left="0" top="{i}"><area/>"#));
        }
        s.push_str(&"</region>".repeat(n));
        s.push_str("</regions>");
        s
    }

    #[test]
    fn deeply_nested_areas_do_not_need_deep_stack() -> TestResult {
        // 5000 levels: refused by the iterative nesting check before roxmltree (which
        // recurses per level) or the converter ever recurses, so 256 KB is enough.
        let xml = nested_areas_xml(5000);
        let handle = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || -> Result<bool, String> { Ok(crate::convert(&xml).is_ok()) })?;
        let accepted = handle.join().map_err(|_| "conversion thread panicked")??;
        if accepted {
            return Err("5000 nested levels should be refused".into());
        }
        Ok(())
    }

    #[test]
    fn nested_areas_convert_on_a_small_stack() -> TestResult {
        // MAX_REGION_DEPTH + 4 areas (about 40 XML levels, which roxmltree parses on 256 KB); the converter
        // must handle that on a 256 KB thread (the walk is capped at MAX_REGION_DEPTH).
        let xml = nested_areas_xml(MAX_REGION_DEPTH + 4);
        let handle =
            std::thread::Builder::new().stack_size(256 * 1024).spawn(move || -> Result<usize, String> {
                let out = run(&xml).map_err(|e| e.to_string())?;
                Ok(out.warnings.len())
            })?;
        let warnings = handle.join().map_err(|_| "conversion thread panicked")??;
        if warnings == 0 {
            return Err("expected a nesting warning".into());
        }
        Ok(())
    }

    #[test]
    fn nested_areas_stop_at_region_depth_limit_with_warning() -> TestResult {
        let out = run(&nested_areas_xml(60))?;
        let mut depth = 0usize;
        let mut level = out.document.get("regions").and_then(Json::as_array).cloned();
        while let Some(list) = level {
            match list.first() {
                Some(r) if kind_of(r) == "area" => {
                    depth += 1;
                    level = r.get("regions").and_then(Json::as_array).cloned();
                }
                _ => break,
            }
        }
        assert!(depth <= MAX_REGION_DEPTH, "depth {depth}");
        if !out.warnings.iter().any(|w| w.contains("nested too deeply")) {
            return Err("missing nesting warning".into());
        }
        Ok(())
    }

    #[test]
    fn deep_unknown_xml_is_cut_off_with_warning() -> TestResult {
        let n = 120;
        let mut xml = String::from(r#"<?xml version="1.0"?><regions><region left="0" top="0"><foo>"#);
        xml.push_str(&"<x>".repeat(n));
        xml.push_str(&"</x>".repeat(n));
        xml.push_str("</foo></region></regions>");
        let out = run(&xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        assert_eq!(regions.first().map(kind_of), Some("legacy"));
        Ok(())
    }

    #[test]
    fn xml_copy_is_cut_at_its_depth_limit() -> TestResult {
        // Parsed on a big stack: roxmltree recurses per level, and this only tests xml_of.
        let n = MAX_XML_DEPTH + 20;
        let mut xml = String::from(r#"<regions><region left="0" top="0"><foo>"#);
        xml.push_str(&"<x>".repeat(n));
        xml.push_str(&"</x>".repeat(n));
        xml.push_str("</foo></region></regions>");
        let handle = std::thread::Builder::new().stack_size(8 * 1024 * 1024).spawn(
            move || -> Result<bool, String> {
                let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
                let region = doc.root_element().first_element_child().ok_or("no region")?;
                let (_, cut) = xml_of(region);
                Ok(cut)
            },
        )?;
        if !handle.join().map_err(|_| "copy thread panicked")?? {
            return Err("expected the copy to be cut".into());
        }
        Ok(())
    }

    #[test]
    fn extreme_attribute_values_saturate_instead_of_overflowing() -> TestResult {
        let min = "-9223372036854775808";
        let max = "9223372036854775807";
        // area height: bottom (max) - top (min) overflows
        let xml = format!(
            r#"<?xml version="1.0"?><regions>
<region left="{min}" top="{min}"><area><title>t</title></area>
<region left="0" top="{max}"><area terminator="true"/></region>
</region>
<region left="{min}" top="{max}"><area/><region left="{max}" top="{max}"><area/></region></region>
<region left="{max}" top="{min}"><text><regions><region left="{min}" top="{max}"><math><input><e type="operand">1</e></input></math></region></regions></text></region>
<region left="{min}" top="{min}" width="{max}" height="{min}"><math><input><e type="operand">1</e></input></math></region>
</regions>"#
        );
        let out = crate::convert(&xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        let area = regions.iter().find(|r| kind_of(r) == "area").ok_or("no area")?;
        assert_eq!(area.get("height"), Some(&json!(i64::MAX)));
        Ok(())
    }

    #[test]
    fn bad_attributes_and_missing_children_never_fail_the_document() -> TestResult {
        let xml = r#"<?xml version="1.0"?>
<regions>
<settings><calculation><precision>x</precision></calculation><pageModel active="true"><paper id="zz"/><margins top="q"/></pageModel></settings>
<region left="oops" top="1"><math><input><e type="operand">1</e></input></math></region>
<region left="2" top="3"><text/></region>
<region left="4" top="5"><picture/></region>
<region left="6" top="7"><table/></region>
<region left="8" top="9"><plot width="w"/></region>
<region left="10" top="11"><area><title/></area></region>
</regions>"#;
        let out = crate::convert(xml)?;
        let regions = out.document.get("regions").and_then(Json::as_array).ok_or("no regions")?;
        // every region is still present, as a legacy or a converted region
        assert!(regions.len() >= 5);
        assert!(!out.warnings.is_empty());
        Ok(())
    }

    #[test]
    fn strip_attr_line_drops_only_a_leading_attribute_line() {
        assert_eq!(strip_attr_line("{.center}\nHi"), "Hi");
        assert_eq!(strip_attr_line("{.center} Hi"), "{.center} Hi");
        assert_eq!(strip_attr_line("{a\nb}\nHi"), "{a\nb}\nHi");
    }

    #[test]
    fn b64_skips_whitespace() {
        assert_eq!(decode_b64("aGVs\n bG8="), b"hello".to_vec());
    }

    #[test]
    fn split_runs_splits_on_wide_gaps_only() {
        assert_eq!(split_runs("a   b  c", 3), vec!["a".to_string(), "b  c".to_string()]);
    }

    #[test]
    fn expand_fields_replaces_known_fields() {
        assert_eq!(expand_fields("x &[PAGENUM] &[NOPE] y"), "x {page} &[NOPE] y");
    }

    #[test]
    fn a_math_note_prefers_portuguese_then_english() -> TestResult {
        let note = |descs: &str| -> std::result::Result<Option<String>, Box<dyn std::error::Error>> {
            let xml = format!("<math>{descs}</math>");
            let doc = roxmltree::Document::parse(&xml)?;
            Ok(note_variant(doc.root_element()).and_then(|d| d.attribute("lang")).map(str::to_string))
        };
        let ru = r#"<description active="true" lang="rus"><p>Радиус</p></description>"#;
        let en = r#"<description active="true" lang="eng"><p>Radius</p></description>"#;
        let pt = r#"<description active="true" lang="por"><p>Raio</p></description>"#;
        let off = r#"<description active="false" lang="eng"><p>Radius</p></description>"#;
        assert_eq!(note(&format!("{ru}{en}"))?.as_deref(), Some("eng"));
        assert_eq!(note(&format!("{ru}{en}{pt}"))?.as_deref(), Some("por"));
        assert_eq!(note(&format!("{ru}{off}"))?.as_deref(), Some("rus"));
        assert_eq!(note(off)?, None);
        Ok(())
    }
}
