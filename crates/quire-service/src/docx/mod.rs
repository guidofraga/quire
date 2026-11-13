//! Export a report to Word (`.docx`): File ▸ Export as Word…, `quire export`, and a download in
//! the web version (issue #74).
//!
//! The file is written by hand as minimal Office Open XML, zipped with the `zip` crate the
//! bundles already use; no OOXML library is linked. What the reader gets is an editable copy of
//! the page view:
//!
//! - regions in the page's reading order (`layout.rs`), with regions side by side as rows of a
//!   borderless table;
//! - text as Word paragraphs with their formatting, lists and links (`djot.rs`); headings with
//!   Word's own numbering, so the contents list (a `TOC` field) and cross-references (`REF`
//!   fields to bookmarks) update in Word;
//! - math as Word equations (`omml.rs`), with results and units as Quire shows them, and checks
//!   with their ✓ / ✗;
//! - tables as Word tables whose header row repeats on each page, captions numbered with `SEQ`
//!   fields;
//! - plots and images as pictures. The engine can't draw a plot (the app draws them, as SVG and
//!   on a canvas), so the app passes each plot drawn to PNG in [`DocxOptions::pictures`]; without
//!   one (the CLI) a plot is a framed placeholder of its size that names what it plots;
//! - the page size, margins, headers and footers with `PAGE` / `NUMPAGES` fields, and manual
//!   page breaks.

mod djot;
mod image;
mod layout;
mod omml;
mod package;
mod xml;

use std::collections::{BTreeMap, HashMap};

use base64::Engine;
use quire_ast::Expr;
use quire_doc::{Document, Region};
use serde_json::Value as Json;

use crate::{RegionView, Report, Result, ServiceError, localized, verdict_of};
use djot::TextCtx;
use layout::{Flow, Item};
use omml::{FAIL_COLOR, MathStyle, PASS_COLOR, Shown};
use xml::{bookmark, emu, esc, half_points, hex_color, length_px, twips};

/// Numbering instances in `numbering.xml`: headings, bullets; ordered lists follow.
pub(crate) const HEADING_NUM: u32 = 1;
pub(crate) const BULLET_NUM: u32 = 2;
const MONO_FONT: &str = "Courier New";
const DEFAULT_FONT: &str = "Arial";
const NOTE_COLOR: &str = "6B7280";
const ERROR_COLOR: &str = "D1302A";
const TABLE_BORDER: &str = "9AA3AF";
const HEAD_FILL: &str = "F5F7FA";

/// What the app knows about the page that the engine doesn't, all optional: the CLI has none
/// of it.
#[derive(Debug, Default, Clone)]
pub struct DocxOptions {
    /// Pictures the app drew, by region id: each plot, and images Word can't show as they are
    /// (SVG, WebP). PNG (or JPEG) bytes.
    pub pictures: BTreeMap<String, Vec<u8>>,
    /// Each region's height and width on the page, in px, as measured there.
    pub heights: BTreeMap<String, f64>,
    pub widths: BTreeMap<String, f64>,
    /// The page (from 0) each region starts on, for the contents list's page numbers.
    pub pages: BTreeMap<String, u32>,
    /// How many pages the page view has.
    pub page_count: Option<u32>,
    /// `{file}` in headers and footers; also the title when the document has none.
    pub file: String,
    /// `{date}` and `{time}` as the page shows them now (Word keeps them as fields).
    pub date: String,
    pub time: String,
    /// `80 km/h` on one line rather than as a fraction (Settings ▸ Appearance).
    pub flat_units: bool,
}

impl DocxOptions {
    /// The options as the app sends them (camelCase JSON; pictures as base64).
    pub fn from_json(v: &Json) -> Result<Self> {
        let map_f64 = |key: &str| -> BTreeMap<String, f64> {
            v.get(key)
                .and_then(Json::as_object)
                .map(|m| m.iter().filter_map(|(k, x)| Some((k.clone(), x.as_f64()?))).collect())
                .unwrap_or_default()
        };
        let mut pictures = BTreeMap::new();
        if let Some(m) = v.get("pictures").and_then(Json::as_object) {
            for (id, data) in m {
                let Some(text) = data.as_str() else { continue };
                let text = text.split_once("base64,").map_or(text, |(_, b)| b);
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(text.trim())
                    .map_err(|e| ServiceError(format!("picture for {id}: {e}")))?;
                pictures.insert(id.clone(), bytes);
            }
        }
        let text = |key: &str| v.get(key).and_then(Json::as_str).unwrap_or_default().to_string();
        Ok(DocxOptions {
            pictures,
            heights: map_f64("heights"),
            widths: map_f64("widths"),
            pages: map_f64("pages").into_iter().map(|(k, p)| (k, p.max(0.0) as u32)).collect(),
            page_count: v.get("pageCount").and_then(Json::as_u64).map(|n| n as u32),
            file: text("file"),
            date: text("date"),
            time: text("time"),
            flat_units: v.get("flatUnits").and_then(Json::as_bool).unwrap_or(true),
        })
    }
}

/// Run properties (`w:rPr`).
#[derive(Clone, Default, Debug)]
pub(crate) struct RPr {
    pub style: Option<&'static str>,
    pub font: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub underline: bool,
    pub highlight: bool,
    pub color: Option<String>,
    /// Half-points.
    pub size: Option<u32>,
    pub vert: Option<&'static str>,
}

impl RPr {
    fn xml(&self) -> String {
        let mut s = String::new();
        if let Some(st) = self.style {
            s.push_str(&format!("<w:rStyle w:val=\"{st}\"/>"));
        }
        if let Some(f) = &self.font {
            let f = esc(f);
            s.push_str(&format!("<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:cs=\"{f}\"/>"));
        }
        if self.bold {
            s.push_str("<w:b/><w:bCs/>");
        }
        if self.italic {
            s.push_str("<w:i/><w:iCs/>");
        }
        if self.strike {
            s.push_str("<w:strike/>");
        }
        if let Some(c) = &self.color {
            s.push_str(&format!("<w:color w:val=\"{c}\"/>"));
        }
        if let Some(sz) = self.size {
            s.push_str(&format!("<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/>"));
        }
        if self.highlight {
            s.push_str("<w:highlight w:val=\"yellow\"/>");
        }
        if self.underline {
            s.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(v) = self.vert {
            s.push_str(&format!("<w:vertAlign w:val=\"{v}\"/>"));
        }
        if s.is_empty() { s } else { format!("<w:rPr>{s}</w:rPr>") }
    }

    /// A run of text; tabs become Word tabs.
    pub fn text(&self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        let mut inner = String::new();
        for (i, part) in text.split('\t').enumerate() {
            if i > 0 {
                inner.push_str("<w:tab/>");
            }
            if !part.is_empty() {
                inner.push_str(&format!("<w:t xml:space=\"preserve\">{}</w:t>", esc(part)));
            }
        }
        self.raw(&inner)
    }

    /// A run holding `inner` (a break, a tab, a drawing).
    pub fn raw(&self, inner: &str) -> String {
        format!("<w:r>{}{inner}</w:r>", self.xml())
    }

    /// A field: `instr` (`PAGE`, `REF _Ref_x \h`) showing `cached` until Word updates it.
    pub fn field(&self, instr: &str, cached: &str) -> String {
        let mut s = self.raw("<w:fldChar w:fldCharType=\"begin\"/>");
        s.push_str(&self.raw(&format!("<w:instrText xml:space=\"preserve\"> {} </w:instrText>", esc(instr))));
        s.push_str(&self.raw("<w:fldChar w:fldCharType=\"separate\"/>"));
        s.push_str(&self.text(if cached.is_empty() { " " } else { cached }));
        s.push_str(&self.raw("<w:fldChar w:fldCharType=\"end\"/>"));
        s
    }
}

/// A paragraph border.
#[derive(Clone, Debug)]
pub(crate) struct Border {
    /// Eighths of a point.
    pub size: u32,
    pub color: String,
    /// Points between the border and the text.
    pub space: u32,
}

/// Paragraph properties (`w:pPr`), written in the order the schema asks for.
#[derive(Clone, Default, Debug)]
pub(crate) struct PPr {
    pub style: Option<String>,
    pub keep_next: bool,
    pub page_break_before: bool,
    /// Numbering instance and level.
    pub num: Option<(u32, u32)>,
    pub border_top: Option<Border>,
    pub border_bottom_rule: Option<Border>,
    pub border_bottom: bool,
    pub border_left: bool,
    pub shading: Option<String>,
    /// (alignment, position in twips, leader).
    pub tabs: Vec<(&'static str, i64, Option<&'static str>)>,
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub ind_left: i64,
    pub ind_right: i64,
    pub jc: Option<&'static str>,
    /// Properties of the paragraph mark (and of the number, for a heading).
    pub mark: Option<RPr>,
}

fn border_xml(side: &str, b: &Border, style: &str) -> String {
    format!(
        "<w:{side} w:val=\"{style}\" w:sz=\"{}\" w:space=\"{}\" w:color=\"{}\"/>",
        b.size, b.space, b.color
    )
}

impl PPr {
    fn xml(&self) -> String {
        let mut s = String::new();
        if let Some(st) = &self.style {
            s.push_str(&format!("<w:pStyle w:val=\"{st}\"/>"));
        }
        if self.keep_next {
            s.push_str("<w:keepNext/>");
        }
        if self.page_break_before {
            s.push_str("<w:pageBreakBefore/>");
        }
        if let Some((id, lvl)) = self.num {
            s.push_str(&format!("<w:numPr><w:ilvl w:val=\"{lvl}\"/><w:numId w:val=\"{id}\"/></w:numPr>"));
        }
        let quiet = Border { size: 8, color: "C5CAD3".into(), space: 1 };
        let mut bdr = String::new();
        if let Some(b) = &self.border_top {
            bdr.push_str(&border_xml("top", b, "single"));
        }
        if self.border_left {
            bdr.push_str(&border_xml("left", &Border { size: 12, space: 6, ..quiet.clone() }, "single"));
        }
        if let Some(b) = &self.border_bottom_rule {
            bdr.push_str(&border_xml("bottom", b, "single"));
        } else if self.border_bottom {
            bdr.push_str(&border_xml("bottom", &quiet, "single"));
        }
        if !bdr.is_empty() {
            s.push_str(&format!("<w:pBdr>{bdr}</w:pBdr>"));
        }
        if let Some(fill) = &self.shading {
            s.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>"));
        }
        if !self.tabs.is_empty() {
            s.push_str("<w:tabs>");
            for (kind, pos, leader) in &self.tabs {
                match leader {
                    Some(l) => {
                        s.push_str(&format!("<w:tab w:val=\"{kind}\" w:leader=\"{l}\" w:pos=\"{pos}\"/>"))
                    }
                    None => s.push_str(&format!("<w:tab w:val=\"{kind}\" w:pos=\"{pos}\"/>")),
                }
            }
            s.push_str("</w:tabs>");
        }
        if self.before.is_some() || self.after.is_some() {
            s.push_str("<w:spacing");
            if let Some(b) = self.before {
                s.push_str(&format!(" w:before=\"{}\"", b.max(0)));
            }
            if let Some(a) = self.after {
                s.push_str(&format!(" w:after=\"{}\"", a.max(0)));
            }
            s.push_str("/>");
        }
        if self.ind_left != 0 || self.ind_right != 0 {
            s.push_str(&format!("<w:ind w:left=\"{}\" w:right=\"{}\"/>", self.ind_left, self.ind_right));
        }
        if let Some(jc) = self.jc {
            s.push_str(&format!("<w:jc w:val=\"{jc}\"/>"));
        }
        if let Some(m) = &self.mark {
            s.push_str(&m.xml());
        }
        if s.is_empty() { s } else { format!("<w:pPr>{s}</w:pPr>") }
    }
}

/// A table cell as written: its runs, its alignment, and whether it reads as pass or fail.
type Cell = (String, Option<&'static str>, Option<bool>);

/// A paragraph, or anything else that sits in the body (a table). Blocks live only while one
/// region is written, so a paragraph's properties are kept inline rather than boxed.
#[allow(clippy::large_enum_variant)]
pub(crate) enum Block {
    Para(PPr, String),
    Raw(String),
}

impl Block {
    fn xml(&self) -> String {
        match self {
            Block::Para(p, content) => format!("<w:p>{}{content}</w:p>", p.xml()),
            Block::Raw(s) => s.clone(),
        }
    }
}

/// What a cross-reference reads (`[](#ref:id){.num}`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum RefStyle {
    /// "Figure 2", "Section 2.1".
    Label,
    Num,
    Page,
    Title,
}

/// A numbered target: a heading or a captioned figure or table.
#[derive(Clone, Debug)]
enum Num {
    Heading { level: u32, number: String },
    Figure(u32),
    Table(u32),
}

struct Rel {
    id: String,
    kind: &'static str,
    target: String,
    external: bool,
}

/// The page: paper and margins in px.
#[derive(Clone, Copy)]
struct Geom {
    paper_w: f64,
    paper_h: f64,
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

impl Geom {
    fn content_w(&self) -> f64 {
        (self.paper_w - self.left - self.right).max(100.0)
    }
}

fn geometry(page: Option<&Json>) -> Geom {
    let mm = 96.0 / 25.4;
    let (mut w, mut h) = (210.0 * mm, 297.0 * mm);
    match page.and_then(|p| p.get("paper")) {
        Some(Json::String(s)) => {
            let size = match s.as_str() {
                "A3" => Some((297.0, 420.0)),
                "A4" => Some((210.0, 297.0)),
                "A5" => Some((148.0, 210.0)),
                "Letter" => Some((215.9, 279.4)),
                "Legal" => Some((215.9, 355.6)),
                _ => None,
            };
            if let Some((a, b)) = size {
                (w, h) = (a * mm, b * mm);
            }
        }
        Some(Json::Array(a)) => {
            w = length_px(a.first(), w);
            h = length_px(a.get(1), h);
        }
        _ => {}
    }
    if page.and_then(|p| p.get("orientation")).and_then(Json::as_str) == Some("landscape") {
        (w, h) = (h, w);
    }
    let m = page.and_then(|p| p.get("margins"));
    let side = |k: &str| length_px(m.and_then(|m| m.get(k)), 20.0 * mm);
    Geom {
        paper_w: w,
        paper_h: h,
        top: side("top"),
        right: side("right"),
        bottom: side("bottom"),
        left: side("left"),
    }
}

/// "Figure {n} –" and friends, per language, as `labels.ts` has them.
fn default_label(lang: &str, kind: &str) -> &'static str {
    let base = lang.split('-').next().unwrap_or("en");
    let table: [(&str, &str, &str, &str); 7] = [
        ("en", "Figure {n} –", "Table {n} –", "Section {n}"),
        ("pt-PT", "Figura {n} –", "Tabela {n} –", "Secção {n}"),
        ("pt", "Figura {n} –", "Tabela {n} –", "Seção {n}"),
        ("es", "Figura {n} –", "Tabla {n} –", "Sección {n}"),
        ("fr", "Figure {n} –", "Tableau {n} –", "Section {n}"),
        ("de", "Abbildung {n} –", "Tabelle {n} –", "Abschnitt {n}"),
        ("it", "Figura {n} –", "Tabella {n} –", "Sezione {n}"),
    ];
    let row = table
        .iter()
        .find(|r| r.0 == lang)
        .or_else(|| table.iter().find(|r| r.0 == base))
        .unwrap_or(&table[0]);
    match kind {
        "figure" => row.1,
        "table" => row.2,
        _ => row.3,
    }
}

/// `"Figure {n} –"` → ("Figure ", " –").
fn split_pattern(p: &str) -> (String, String) {
    match p.split_once("{n}") {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (format!("{p} "), String::new()),
    }
}

/// The pattern without trailing punctuation, for a reference: "Figure 3".
fn trim_label(s: &str) -> String {
    s.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '–' | '—' | ':' | '.' | '-')).to_string()
}

/// The level of the heading a text region starts with, as `headingLevel` in `store.ts`: 0 for
/// none and for a Title.
fn heading_level(text: &str) -> u32 {
    let first_attrs = text.starts_with('{') && text.find("}\n").is_some_and(|e| !text[..e].contains('\n'));
    let body = if first_attrs {
        let end = text.find("}\n").unwrap_or(0);
        if text[..end].split(|c: char| c.is_whitespace() || c == '{').any(|w| w == ".title") {
            return 0;
        }
        &text[end + 2..]
    } else {
        text
    };
    let hashes = body.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) && body.as_bytes().get(hashes).is_some_and(|b| *b == b' ' || *b == b'\t') {
        hashes as u32
    } else {
        0
    }
}

/// A check's verdict, as `mathCheck` in `checks.ts`.
fn math_check(r: &Region, v: &RegionView) -> Option<bool> {
    if r.kind != "math" || v.error.is_some() {
        return None;
    }
    let comparison = v.input.as_ref().is_some_and(is_comparison);
    if v.check.is_some() && comparison {
        return v.check;
    }
    r.show.as_ref()?;
    let text = v.result_text.as_deref()?;
    if comparison {
        return Some(text.trim() != "0");
    }
    match &v.result {
        Some(Expr::Str(s)) => verdict_of(s),
        _ => None,
    }
}

fn is_comparison(e: &Expr) -> bool {
    match e {
        Expr::Compare(..) => true,
        Expr::Define { rhs, .. } => matches!(**rhs, Expr::Compare(..)),
        _ => false,
    }
}

/// `9.80665 'm/'s^2` → `9.80665 m/s²`, as a spreadsheet cell shows a value (`prettyValue`).
fn pretty_value(v: &str) -> String {
    const SUP: [(char, char); 11] = [
        ('-', '⁻'),
        ('0', '⁰'),
        ('1', '¹'),
        ('2', '²'),
        ('3', '³'),
        ('4', '⁴'),
        ('5', '⁵'),
        ('6', '⁶'),
        ('7', '⁷'),
        ('8', '⁸'),
        ('9', '⁹'),
    ];
    let sup =
        |s: &str| -> String { s.chars().map(|c| SUP.iter().find(|p| p.0 == c).map_or(c, |p| p.1)).collect() };
    let v = v.replace('\'', "");
    let mut out = String::new();
    let mut rest = v.as_str();
    while let Some(i) = rest.find('^') {
        let (head, tail) = rest.split_at(i);
        let tail = &tail[1..];
        let paren = tail.starts_with('(');
        let body = if paren { &tail[1..] } else { tail };
        let n = body.char_indices().take_while(|(k, c)| c.is_ascii_digit() || (*k == 0 && *c == '-')).count();
        if n == 0 {
            out.push_str(head);
            out.push('^');
            rest = tail;
            continue;
        }
        let head = head.strip_suffix("*10").map_or(head.to_string(), |h| format!("{h}·10"));
        out.push_str(&head);
        out.push_str(&sup(&body[..n]));
        rest = &body[n..];
        if paren {
            rest = rest.strip_prefix(')').unwrap_or(rest);
        }
    }
    out.push_str(rest);
    out.replace('*', "·")
}

/// Writes one document; holds what the parts share (relationships, numbering, bookmarks).
pub(crate) struct Writer<'a> {
    doc: &'a Document,
    views: HashMap<&'a str, &'a RegionView>,
    opts: &'a DocxOptions,
    asset: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    lang: Option<String>,
    geom: Geom,
    pub(crate) body_size: u32,
    math_size: u32,
    group_digits: bool,
    headings_numbered: bool,
    patterns: [String; 3],
    numbers: HashMap<String, Num>,
    titles: HashMap<String, String>,
    /// Relationships of the part being written.
    rels: Vec<Rel>,
    media: Vec<(String, Vec<u8>)>,
    /// Ordered lists: (number format, level text style, start).
    ordered: Vec<(&'static str, &'static str, u64)>,
    bookmarks: u32,
    drawings: u32,
    pending_break: bool,
    /// Every region not hidden by a collapsed area, in reading order.
    order: Vec<String>,
}

impl<'a> Writer<'a> {
    pub(crate) fn next_bookmark(&mut self) -> u32 {
        self.bookmarks += 1;
        self.bookmarks
    }

    fn rel(&mut self, kind: &'static str, target: String, external: bool) -> String {
        if let Some(r) = self.rels.iter().find(|r| r.kind == kind && r.target == target) {
            return r.id.clone();
        }
        let id = format!("rId{}", self.rels.len() + 100);
        self.rels.push(Rel { id: id.clone(), kind, target, external });
        id
    }

    pub(crate) fn hyperlink(&mut self, url: &str) -> String {
        self.rel(package::REL_HYPERLINK, url.to_string(), true)
    }

    pub(crate) fn ordered_list(
        &mut self,
        numbering: jotdown::OrderedListNumbering,
        style: jotdown::OrderedListStyle,
        start: u64,
    ) -> u32 {
        let text = match style {
            jotdown::OrderedListStyle::Period => "%.",
            jotdown::OrderedListStyle::Paren => "%)",
            jotdown::OrderedListStyle::ParenParen => "(%)",
        };
        self.ordered.push((djot::num_format(numbering), text, start.max(1)));
        BULLET_NUM + self.ordered.len() as u32
    }

    fn view(&self, id: &str) -> Option<&'a RegionView> {
        self.views.get(id).copied()
    }

    fn math_style(&self, v: &'a RegionView, size: u32) -> MathStyle<'a> {
        MathStyle {
            units: &v.units,
            constants: &v.constants,
            flat_units: self.opts.flat_units,
            group_digits: self.group_digits,
            size,
        }
    }

    /// Inline math in text (`<region>:m<n>`): the equation with its result.
    pub(crate) fn inline_math(&mut self, id: &str, rpr: &RPr) -> String {
        let Some(v) = self.view(id) else { return String::new() };
        let size = rpr.size.unwrap_or(self.body_size);
        match &v.input {
            Some(input) => {
                let shown =
                    v.result.as_ref().map(|r| Shown { result: r, symbolic: v.symbolic, verdict: None });
                omml::equation(input, shown, &self.math_style(v, size))
            }
            None => rpr.text("?"),
        }
    }

    /// A cross-reference as a field Word keeps current.
    pub(crate) fn cross_ref(&mut self, target: &str, style: RefStyle, rpr: &RPr) -> String {
        let Some(num) = self.numbers.get(target).cloned() else {
            let mut r = rpr.clone();
            r.color = Some(ERROR_COLOR.into());
            return r.text("missing reference");
        };
        let mark = bookmark("_Ref_", target);
        let title = self.titles.get(target).cloned().unwrap_or_default();
        // without the page view (the CLI) the page is unknown until Word updates the field
        let page = self
            .opts
            .pages
            .get(target)
            .map_or_else(|| "?".to_string(), |p| (p + self.page_start()).to_string());
        let page_ref =
            |r: &RPr| format!("{}{}", r.text("page "), r.field(&format!("PAGEREF {mark} \\h"), &page));
        match (num, style) {
            (_, RefStyle::Page) => page_ref(rpr),
            (Num::Heading { number, .. }, RefStyle::Num) => {
                rpr.field(&format!("REF {mark} \\r \\h"), &number)
            }
            (Num::Heading { .. }, RefStyle::Title) => rpr.field(&format!("REF {mark} \\h"), &title),
            (Num::Heading { number, .. }, RefStyle::Label) => {
                if self.headings_numbered {
                    let (before, after) = split_pattern(&self.patterns[2]);
                    let after = trim_label(&after);
                    format!(
                        "{}{}{}",
                        rpr.text(&before),
                        rpr.field(&format!("REF {mark} \\r \\h"), &number),
                        rpr.text(&after)
                    )
                } else {
                    format!(
                        "{}{}{}",
                        rpr.text("“"),
                        rpr.field(&format!("REF {mark} \\h"), &title),
                        rpr.text("”")
                    )
                }
            }
            (Num::Figure(n) | Num::Table(n), RefStyle::Num) => {
                rpr.field(&format!("REF {} \\h", bookmark("_Num_", target)), &n.to_string())
            }
            (Num::Figure(n) | Num::Table(n), RefStyle::Title) => {
                let cached = if title.is_empty() { n.to_string() } else { title };
                rpr.field(&format!("REF {} \\h", bookmark("_Title_", target)), &cached)
            }
            (Num::Figure(n), RefStyle::Label) => rpr.field(
                &format!("REF {mark} \\h"),
                &trim_label(&self.patterns[0].replace("{n}", &n.to_string())),
            ),
            (Num::Table(n), RefStyle::Label) => rpr.field(
                &format!("REF {mark} \\h"),
                &trim_label(&self.patterns[1].replace("{n}", &n.to_string())),
            ),
        }
    }

    fn page_start(&self) -> u32 {
        self.doc
            .extra
            .get("page")
            .and_then(|p| p.get("pageNumber"))
            .and_then(|n| n.get("start"))
            .and_then(Json::as_u64)
            .map_or(1, |n| n as u32)
    }

    /// A picture as an inline drawing, `w` × `h` px; `None` when the bytes aren't PNG, JPEG or GIF.
    /// The relationship to a picture, stored once however often it is shown (a logo in every
    /// header).
    fn media_rel(&mut self, bytes: &[u8]) -> Option<String> {
        let ext = image::kind(bytes)?;
        let name = match self.media.iter().find(|(_, b)| b.as_slice() == bytes) {
            Some((name, _)) => name.clone(),
            None => {
                let name = format!(
                    "media/image{}.{}",
                    self.media.len() + 1,
                    if ext == "jpeg" { "jpg" } else { ext }
                );
                self.media.push((name.clone(), bytes.to_vec()));
                name
            }
        };
        Some(self.rel(package::REL_IMAGE, name, false))
    }

    fn picture(&mut self, bytes: &[u8], w: f64, h: f64, descr: &str) -> Option<String> {
        let rel = self.media_rel(bytes)?;
        self.drawings += 1;
        let (cx, cy, id) = (emu(w), emu(h), self.drawings);
        Some(format!(
            "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr id=\"{id}\" name=\"Picture {id}\" descr=\"{}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>{}</wp:inline></w:drawing></w:r>",
            esc(descr),
            graphic(id, &rel, cx, cy)
        ))
    }

    /// A picture behind the text, at (`x`, `y`) px from the paper's corner: a page background.
    fn background(&mut self, bytes: &[u8], x: f64, y: f64, w: f64, h: f64) -> Option<String> {
        let rel = self.media_rel(bytes)?;
        self.drawings += 1;
        let (cx, cy, id) = (emu(w), emu(h), self.drawings);
        Some(format!(
            "<w:r><w:drawing><wp:anchor distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" simplePos=\"0\" relativeHeight=\"0\" behindDoc=\"1\" locked=\"1\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/><wp:positionH relativeFrom=\"page\"><wp:posOffset>{}</wp:posOffset></wp:positionH><wp:positionV relativeFrom=\"page\"><wp:posOffset>{}</wp:posOffset></wp:positionV><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:wrapNone/><wp:docPr id=\"{id}\" name=\"Background {id}\"/><wp:cNvGraphicFramePr/>{}</wp:anchor></w:drawing></w:r>",
            emu(x),
            emu(y),
            graphic(id, &rel, cx, cy)
        ))
    }

    // -----------------------------------------------------------------------------------------
    // Regions
    // -----------------------------------------------------------------------------------------

    fn region_size(&self, r: &Region) -> Option<u32> {
        r.extra
            .get("style")
            .and_then(|s| s.get("size"))
            .and_then(Json::as_f64)
            .filter(|s| *s > 0.0)
            .map(half_points)
    }

    fn region_font(&self, r: &Region) -> Option<String> {
        r.extra.get("style").and_then(|s| s.get("font")).and_then(Json::as_str).map(str::to_string)
    }

    fn text_of(&self, r: &Region, key: &str) -> Option<String> {
        r.extra.get(key).and_then(|t| localized(t, self.lang.as_deref())).map(str::to_string)
    }

    /// One region as body blocks. `ind`: its left indent (twips) within the column or cell;
    /// `room`: the width it has, px; `before`: space above it (twips).
    fn region(&mut self, it: &Item, ind: i64, room: f64, before: i64) -> Vec<Block> {
        let r = it.region;
        let mut blocks = match r.kind.as_str() {
            "math" => self.math(r, ind),
            "text" => self.text(r, ind, room),
            "image" | "plot2d" | "plot3d" => self.figure(r, ind, room),
            "table" => self.table(r, ind, room),
            "solve" => self.solve(r, ind),
            "toc" => self.contents(r, ind, room),
            "area" => self.area(r),
            _ => Vec::new(),
        };
        if let Some(Block::Para(p, _)) = blocks.first_mut() {
            p.before = Some(p.before.unwrap_or(0) + before);
        }
        blocks
    }

    fn math(&mut self, r: &Region, ind: i64) -> Vec<Block> {
        let size = self.region_size(r).unwrap_or(self.math_size);
        let mut blocks = Vec::new();
        let mut content = String::new();
        let view = self.view(&r.id);
        if let Some(v) = view {
            let check = math_check(r, v);
            match &v.input {
                Some(input) => {
                    let comparison = check.is_some() && is_comparison(input);
                    let shown = if r.show.is_some() && !comparison {
                        v.result.as_ref().map(|res| Shown {
                            result: res,
                            symbolic: r.show.as_deref() == Some("symbolic"),
                            verdict: if matches!(res, Expr::Str(_)) { check } else { None },
                        })
                    } else {
                        None
                    };
                    content.push_str(&omml::equation(input, shown, &self.math_style(v, size)));
                    if comparison {
                        content.push_str(&badge(check == Some(true), true));
                    }
                }
                None => {
                    let rpr = RPr { font: Some(MONO_FONT.into()), size: Some(size), ..RPr::default() };
                    content.push_str(&rpr.text(r.expr.as_deref().unwrap_or_default()));
                }
            }
        }
        // a check is a target of the Summary of Checks
        if view.and_then(|v| math_check(r, v)).is_some() {
            let id = self.next_bookmark();
            content = format!(
                "<w:bookmarkStart w:id=\"{id}\" w:name=\"{}\"/>{content}<w:bookmarkEnd w:id=\"{id}\"/>",
                bookmark("_Ref_", &r.id)
            );
        }
        let note = r.extra.get("note").and_then(Json::as_str).map(str::to_string);
        let below = r.extra.get("notePosition").and_then(Json::as_str) == Some("below");
        let note_rpr = RPr { color: Some(NOTE_COLOR.into()), size: Some(size * 95 / 100), ..RPr::default() };
        if let (Some(n), false) = (&note, below) {
            content.push_str(&note_rpr.text("\u{2003}"));
            content.push_str(&djot::runs(self, n, &note_rpr, &r.id));
        }
        blocks.push(Block::Para(PPr { ind_left: ind, after: Some(40), ..PPr::default() }, content));
        if let (Some(n), true) = (&note, below) {
            let runs = djot::runs(self, n, &note_rpr, &r.id);
            blocks.push(Block::Para(PPr { ind_left: ind, after: Some(40), ..PPr::default() }, runs));
        }
        if let Some(e) = view.and_then(|v| v.error.as_deref()) {
            blocks.push(error_para(e, ind));
        }
        blocks
    }

    fn text(&mut self, r: &Region, ind: i64, room: f64) -> Vec<Block> {
        let src = self.text_of(r, "text").unwrap_or_default();
        let size = self.region_size(r);
        let fixed = r.extra.get("width").and_then(Json::as_f64);
        let ind_right = fixed.map_or(0, |w| twips((room - w).max(0.0)));
        let numbered = match self.numbers.get(&r.id) {
            Some(Num::Heading { level, .. }) if self.headings_numbered && *level <= 3 => Some(*level),
            _ => None,
        };
        let ctx = TextCtx {
            region: r.id.clone(),
            base: RPr { font: self.region_font(r), size, ..RPr::default() },
            ind_left: ind,
            ind_right,
            before: 0,
            numbered,
            after: djot::spacing_after(size.unwrap_or(self.body_size)),
        };
        djot::blocks(self, &src, &ctx)
    }

    /// A caption: "Figure 2 – text", the number a `SEQ` field, bookmarked for references.
    /// `ind` and `right`: the indents (twips) that centre it under its figure or over its table.
    fn caption(&mut self, r: &Region, ind: i64, right: i64) -> Option<Block> {
        let caption = r.extra.get("caption")?;
        let text = caption.get("text").and_then(|t| localized(t, self.lang.as_deref())).unwrap_or_default();
        let (pattern, seq, n) = match self.numbers.get(&r.id) {
            Some(Num::Table(n)) => (self.patterns[1].clone(), "Table", *n),
            Some(Num::Figure(n)) => (self.patterns[0].clone(), "Figure", *n),
            _ => return None,
        };
        let (before, after) = split_pattern(&pattern);
        let rpr = RPr::default();
        let (rf, num, title) = (self.next_bookmark(), self.next_bookmark(), self.next_bookmark());
        let mut c = format!("<w:bookmarkStart w:id=\"{rf}\" w:name=\"{}\"/>", bookmark("_Ref_", &r.id));
        c.push_str(&rpr.text(&before));
        c.push_str(&format!("<w:bookmarkStart w:id=\"{num}\" w:name=\"{}\"/>", bookmark("_Num_", &r.id)));
        c.push_str(&rpr.field(&format!("SEQ {seq} \\* ARABIC"), &n.to_string()));
        c.push_str(&format!("<w:bookmarkEnd w:id=\"{num}\"/>"));
        let trimmed = trim_label(&after);
        c.push_str(&rpr.text(&trimmed));
        c.push_str(&format!("<w:bookmarkEnd w:id=\"{rf}\"/>"));
        c.push_str(&rpr.text(&format!("{} ", &after[trimmed.len().min(after.len())..])));
        c.push_str(&format!("<w:bookmarkStart w:id=\"{title}\" w:name=\"{}\"/>", bookmark("_Title_", &r.id)));
        c.push_str(&djot::runs(self, text, &rpr, &r.id));
        c.push_str(&format!("<w:bookmarkEnd w:id=\"{title}\"/>"));
        Some(Block::Para(
            PPr { style: Some("Caption".into()), ind_left: ind, ind_right: right, ..PPr::default() },
            c,
        ))
    }

    fn above(r: &Region) -> bool {
        r.extra.get("caption").and_then(|c| c.get("position")).and_then(Json::as_str) == Some("above")
    }

    fn figure(&mut self, r: &Region, ind: i64, room: f64) -> Vec<Block> {
        let default = match r.kind.as_str() {
            "plot3d" => [420.0, 340.0],
            "plot2d" => [480.0, 260.0],
            _ => [200.0, 150.0],
        };
        let size = r
            .extra
            .get("size")
            .and_then(Json::as_array)
            .and_then(|s| Some([s.first()?.as_f64()?, s.get(1)?.as_f64()?]))
            .unwrap_or(default);
        // never wider than the room it has: Word would push it past the margin
        let scale = if size[0] > room && room > 0.0 { room / size[0] } else { 1.0 };
        let (w, h) = (size[0] * scale, size[1] * scale);
        let descr = self
            .text_of(r, "alt")
            .or_else(|| {
                r.extra
                    .get("caption")
                    .and_then(|c| c.get("text"))
                    .and_then(|t| localized(t, self.lang.as_deref()))
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let bytes = self.opts.pictures.get(&r.id).cloned().or_else(|| {
            if r.kind == "image" {
                r.extra.get("src").and_then(Json::as_str).and_then(|s| (self.asset)(s))
            } else {
                None
            }
        });
        let drawing = bytes.and_then(|b| self.picture(&b, w, h, &descr));
        let mut out = Vec::new();
        // the caption is centred under the figure, as on the page
        let right = twips((room - w).max(0.0));
        if Self::above(r)
            && let Some(c) = self.caption(r, ind, right)
        {
            out.push(c);
        }
        match drawing {
            Some(d) => {
                out.push(Block::Para(PPr { ind_left: ind, keep_next: Self::above(r), ..PPr::default() }, d))
            }
            None => out.push(Block::Raw(self.placeholder(r, ind, w, h))),
        }
        if let Some(e) = self.view(&r.id).and_then(|v| v.error.clone()) {
            out.push(error_para(&e, ind));
        }
        if !Self::above(r)
            && let Some(c) = self.caption(r, ind, right)
        {
            if let Some(Block::Para(p, _)) = out.last_mut() {
                p.keep_next = true;
            }
            out.push(c);
        }
        out
    }

    /// Where a picture can't be drawn here (a plot exported by the CLI, an SVG image): a frame
    /// of its size saying what it shows.
    fn placeholder(&self, r: &Region, ind: i64, w: f64, h: f64) -> String {
        let what = match r.kind.as_str() {
            "plot2d" => {
                let ys: Vec<String> = r
                    .extra
                    .get("series")
                    .and_then(Json::as_array)
                    .map(|s| {
                        s.iter()
                            .filter_map(|s| s.get("y").and_then(Json::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                format!("Plot of {}", if ys.is_empty() { "data".into() } else { ys.join(", ") })
            }
            "plot3d" => {
                let ys: Vec<String> = r
                    .extra
                    .get("series")
                    .and_then(Json::as_array)
                    .map(|s| {
                        s.iter()
                            .filter_map(|s| {
                                s.get("surface").and_then(Json::as_str).map(str::to_string).or_else(|| {
                                    s.get("parametric").and_then(Json::as_array).map(|p| {
                                        p.iter().filter_map(Json::as_str).collect::<Vec<_>>().join(", ")
                                    })
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                format!("3D plot of {}", if ys.is_empty() { "data".into() } else { ys.join("; ") })
            }
            _ => "Image".to_string(),
        };
        let note = "drawn by Quire; export from the app to include it";
        let rpr = RPr { color: Some(NOTE_COLOR.into()), size: Some(16), ..RPr::default() };
        let cell = format!(
            "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{}</w:p><w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{}</w:p>",
            rpr.text(&what),
            RPr { italic: true, ..rpr.clone() }.text(note)
        );
        let tw = twips(w);
        format!(
            "<w:tbl><w:tblPr><w:tblW w:w=\"{tw}\" w:type=\"dxa\"/><w:tblInd w:w=\"{ind}\" w:type=\"dxa\"/><w:tblBorders>{}</w:tblBorders><w:tblLayout w:type=\"fixed\"/></w:tblPr><w:tblGrid><w:gridCol w:w=\"{tw}\"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/><w:trHeight w:val=\"{}\" w:hRule=\"exact\"/></w:trPr><w:tc><w:tcPr><w:tcW w:w=\"{tw}\" w:type=\"dxa\"/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F3F4F6\"/><w:vAlign w:val=\"center\"/></w:tcPr>{cell}</w:tc></w:tr></w:tbl>",
            all_borders("single", 4, "C5CAD3"),
            twips(h)
        )
    }

    fn table(&mut self, r: &Region, ind: i64, room: f64) -> Vec<Block> {
        let head_row =
            r.extra.get("header").and_then(|h| h.get("row")).and_then(Json::as_bool).unwrap_or(false);
        let head_col =
            r.extra.get("header").and_then(|h| h.get("column")).and_then(Json::as_bool).unwrap_or(false);
        let view = self.view(&r.id);
        let columns: Vec<&Json> =
            r.extra.get("columns").and_then(Json::as_array).map(|c| c.iter().collect()).unwrap_or_default();
        let sheet = r.extra.get("rows").is_some_and(Json::is_array);
        // rows of (cell content, alignment, verdict)
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let size = if sheet { 18 } else { 16 };
        if sheet {
            let raw: Vec<Vec<String>> = r
                .extra
                .get("rows")
                .and_then(Json::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            row.as_array()
                                .map(|c| {
                                    c.iter()
                                        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
                                        .collect()
                                })
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            let cells = view.and_then(|v| v.cells.as_ref());
            for (i, row) in raw.iter().enumerate() {
                let mut out = Vec::new();
                for (j, text) in row.iter().enumerate() {
                    let c = cells.and_then(|c| c.get(i)).and_then(|r| r.get(j));
                    let head = (head_row && i == 0) || (head_col && j == 0);
                    let align =
                        columns.get(j).and_then(|c| c.get("align")).and_then(Json::as_str).and_then(|a| {
                            match a {
                                "right" => Some("right"),
                                "center" => Some("center"),
                                "left" => Some("left"),
                                _ => None,
                            }
                        });
                    let numeric =
                        c.and_then(|c| c.result.as_ref()).is_some_and(|e| !matches!(e, Expr::Str(_)));
                    let align = align.or(if numeric { Some("right") } else { None });
                    let verdict = c.filter(|c| c.error.is_none()).and_then(|c| c.verdict);
                    // a header cell is bold; a pass or fail is bold in its colour, as on the page
                    let base = RPr {
                        size: Some(size),
                        bold: head || verdict.is_some(),
                        color: verdict.map(|pass| if pass { PASS_COLOR } else { FAIL_COLOR }.to_string()),
                        ..RPr::default()
                    };
                    let content = match c {
                        Some(c) if c.error.is_some() => {
                            RPr { color: Some(ERROR_COLOR.into()), bold: true, ..base }.text("#ERROR")
                        }
                        Some(c) => match (&c.result, &c.text) {
                            (Some(Expr::Str(s)), _) => base.text(s),
                            (_, Some(t)) => cell_value(t, &base),
                            _ if text.starts_with('=') => String::new(),
                            _ => base.text(text),
                        },
                        None if text.starts_with('=') => String::new(),
                        None => base.text(text),
                    };
                    out.push((content, align, verdict));
                }
                rows.push(out);
            }
        } else if let Some(v) = view
            && let Some(Expr::Matrix(m)) = &v.result
        {
            let style = self.math_style(v, size);
            for (i, row) in m.iter().enumerate() {
                rows.push(
                    row.iter()
                        .enumerate()
                        .map(|(j, e)| {
                            let head = (head_row && i == 0) || (head_col && j == 0);
                            let content = match e {
                                Expr::Str(s) => {
                                    RPr { size: Some(size), bold: head, ..RPr::default() }.text(s)
                                }
                                e => omml::expression(e, &style),
                            };
                            (content, Some("center"), None)
                        })
                        .collect(),
                );
            }
        }
        let mut table_w = room;
        let table = if rows.is_empty() {
            let what = r.extra.get("source").and_then(Json::as_str).unwrap_or("—");
            Block::Para(
                PPr { ind_left: ind, ..PPr::default() },
                RPr { color: Some(NOTE_COLOR.into()), ..RPr::default() }.text(&format!("Table of {what}")),
            )
        } else {
            let ncols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
            let widths: Vec<f64> = (0..ncols)
                .map(|j| columns.get(j).and_then(|c| c.get("width")).and_then(Json::as_f64).unwrap_or(0.0))
                .collect();
            let given: f64 = widths.iter().sum();
            let missing = widths.iter().filter(|w| **w <= 0.0).count() as f64;
            let total_room = room.max(120.0);
            let fill = if missing > 0.0 { ((total_room - given) / missing).clamp(56.0, 200.0) } else { 0.0 };
            let mut widths: Vec<f64> = widths.into_iter().map(|w| if w > 0.0 { w } else { fill }).collect();
            let sum: f64 = widths.iter().sum();
            if sum > total_room {
                widths.iter_mut().for_each(|w| *w *= total_room / sum);
            }
            table_w = widths.iter().sum();
            let grid: String = widths.iter().map(|w| format!("<w:gridCol w:w=\"{}\"/>", twips(*w))).collect();
            let mut t = format!(
                "<w:tbl><w:tblPr><w:tblStyle w:val=\"QuireTable\"/><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblInd w:w=\"{ind}\" w:type=\"dxa\"/><w:tblBorders>{}</w:tblBorders><w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:left w:w=\"120\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tblCellMar><w:tblLook w:val=\"04A0\" w:firstRow=\"{}\" w:lastRow=\"0\" w:firstColumn=\"{}\" w:lastColumn=\"0\" w:noHBand=\"1\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>",
                all_borders("single", 4, TABLE_BORDER),
                u8::from(head_row),
                u8::from(head_col)
            );
            for (i, row) in rows.iter().enumerate() {
                let header = head_row && i == 0;
                t.push_str("<w:tr><w:trPr><w:cantSplit/>");
                if header {
                    // repeats at the top of every page the table runs onto
                    t.push_str("<w:tblHeader/>");
                }
                t.push_str("</w:trPr>");
                for j in 0..ncols {
                    let (content, align, verdict) = row.get(j).cloned().unwrap_or_default();
                    let head = header || (head_col && j == 0);
                    let shade = if head {
                        Some(HEAD_FILL)
                    } else {
                        match verdict {
                            Some(true) => Some("EEF7F0"),
                            Some(false) => Some("FBEDED"),
                            None => None,
                        }
                    };
                    let w = widths.get(j).copied().unwrap_or(fill);
                    t.push_str(&format!("<w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/>", twips(w)));
                    if let Some(f) = shade {
                        t.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{f}\"/>"));
                    }
                    t.push_str("<w:vAlign w:val=\"center\"/></w:tcPr>");
                    let jc = align.map(|a| format!("<w:jc w:val=\"{a}\"/>")).unwrap_or_default();
                    t.push_str(&format!("<w:p><w:pPr><w:spacing w:before=\"40\" w:after=\"40\"/>{jc}</w:pPr>{content}</w:p></w:tc>"));
                }
                t.push_str("</w:tr>");
            }
            t.push_str("</w:tbl>");
            Block::Raw(t)
        };
        // the caption is centred over the table, as on the page
        let right = twips((room - table_w).max(0.0));
        let mut out = Vec::new();
        if Self::above(r)
            && let Some(mut c) = self.caption(r, ind, right)
        {
            if let Block::Para(p, _) = &mut c {
                p.keep_next = true;
            }
            out.push(c);
        }
        out.push(table);
        if let Some(e) = view.and_then(|v| v.error.as_deref()) {
            out.push(error_para(e, ind));
        }
        if !Self::above(r)
            && let Some(c) = self.caption(r, ind, right)
        {
            out.push(c);
        }
        out
    }

    /// A solve block: its lines framed, as on the page (Given … find).
    fn solve(&mut self, r: &Region, ind: i64) -> Vec<Block> {
        let lines = |key: &str| -> usize { r.extra.get(key).and_then(Json::as_array).map_or(0, Vec::len) };
        let mut cell = String::new();
        let line = |w: &mut Self, id: String, check: bool, show: bool, top: bool| -> String {
            let mut content = String::new();
            let mut err = None;
            if let Some(v) = w.view(&id) {
                err = v.error.clone();
                if let Some(input) = &v.input {
                    let shown = if show {
                        v.result.as_ref().map(|res| Shown { result: res, symbolic: false, verdict: None })
                    } else {
                        None
                    };
                    content.push_str(&omml::equation(input, shown, &w.math_style(v, w.math_size)));
                }
                if check
                    && v.error.is_none()
                    && let Some(holds) = v.check
                {
                    content.push_str(&badge(holds, false));
                }
            }
            let mut p = PPr { after: Some(40), ..PPr::default() };
            if top {
                p.border_top = Some(Border { size: 4, color: "D3D7DE".into(), space: 4 });
                p.before = Some(80);
            }
            let mut out = Block::Para(p, content).xml();
            if let Some(e) = err {
                out.push_str(&error_para(&e, 0).xml());
            }
            out
        };
        for n in 0..lines("guesses") {
            cell.push_str(&line(self, format!("{}:g{n}", r.id), false, false, false));
        }
        let given = RPr { bold: true, size: Some(18), color: Some("1F2937".into()), ..RPr::default() };
        cell.push_str(
            &Block::Para(PPr { before: Some(40), after: Some(20), ..PPr::default() }, given.text("Given"))
                .xml(),
        );
        for n in 0..lines("given") {
            cell.push_str(&line(self, format!("{}:c{n}", r.id), true, false, false));
        }
        cell.push_str(&line(self, format!("{}:f", r.id), false, r.show.as_deref() == Some("value"), true));
        // a quiet frame with a blue rule down its left, as on the page
        let borders = "<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C5CAD3\"/><w:left w:val=\"single\" w:sz=\"18\" w:space=\"0\" w:color=\"7F9CC9\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C5CAD3\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"C5CAD3\"/>";
        vec![Block::Raw(format!(
            "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblInd w:w=\"{ind}\" w:type=\"dxa\"/><w:tblBorders>{borders}</w:tblBorders><w:tblCellMar><w:top w:w=\"90\" w:type=\"dxa\"/><w:left w:w=\"180\" w:type=\"dxa\"/><w:bottom w:w=\"120\" w:type=\"dxa\"/><w:right w:w=\"210\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w=\"4800\"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"FAFBFD\"/></w:tcPr>{cell}</w:tc></w:tr></w:tbl>"
        ))]
    }

    /// An area's band: its title over a rule, as the page draws it.
    fn area(&mut self, r: &Region) -> Vec<Block> {
        let title = self.text_of(r, "title").unwrap_or_default();
        let rpr = RPr { color: Some("475569".into()), size: Some(17), ..RPr::default() };
        let runs = djot::runs(self, &title, &rpr, &r.id);
        vec![Block::Para(
            PPr {
                border_top: Some(Border { size: 4, color: "B8C4D6".into(), space: 2 }),
                shading: Some("F5F7FB".into()),
                keep_next: true,
                after: Some(60),
                ..PPr::default()
            },
            runs,
        )]
    }

    fn contents(&mut self, r: &Region, ind: i64, room: f64) -> Vec<Block> {
        let of = r.extra.get("of").and_then(Json::as_str).unwrap_or("headings").to_string();
        let title = r.extra.get("title").and_then(Json::as_str).unwrap_or("Contents").to_string();
        let width = room.min(640.0);
        let tab = twips(width) + ind;
        let mut out = vec![Block::Para(
            PPr { style: Some("TOCHeading".into()), ind_left: ind, keep_next: true, ..PPr::default() },
            RPr::default().text(&title),
        )];
        if of == "checks" {
            out.extend(self.checks_list(ind, tab));
            return out;
        }
        // the entries as Word would write them, so the list reads right before Word updates it
        let entries: Vec<(String, String, u32, String)> = self
            .order
            .iter()
            .filter_map(|id| {
                let num = self.numbers.get(id)?;
                let page =
                    self.opts.pages.get(id).map(|p| (p + self.page_start()).to_string()).unwrap_or_default();
                let text = self.titles.get(id).cloned().unwrap_or_default();
                match (num, of.as_str()) {
                    (Num::Heading { level, number }, "headings") => {
                        let shown =
                            if self.headings_numbered { format!("{number}\u{2002}") } else { String::new() };
                        Some((id.clone(), format!("{shown}{text}"), *level, page))
                    }
                    (Num::Figure(n), "figures") => Some((
                        id.clone(),
                        format!("{} {text}", self.patterns[0].replace("{n}", &n.to_string())),
                        1,
                        page,
                    )),
                    (Num::Table(n), "tables") => Some((
                        id.clone(),
                        format!("{} {text}", self.patterns[1].replace("{n}", &n.to_string())),
                        1,
                        page,
                    )),
                    _ => None,
                }
            })
            .collect();
        let instr = match of.as_str() {
            "figures" => "TOC \\h \\z \\c \"Figure\"",
            "tables" => "TOC \\h \\z \\c \"Table\"",
            _ => "TOC \\o \"1-6\" \\h \\z \\u",
        };
        let rpr = RPr::default();
        let begin = format!(
            "{}{}{}",
            rpr.raw("<w:fldChar w:fldCharType=\"begin\"/>"),
            rpr.raw(&format!("<w:instrText xml:space=\"preserve\"> {} </w:instrText>", esc(instr))),
            rpr.raw("<w:fldChar w:fldCharType=\"separate\"/>")
        );
        let end = rpr.raw("<w:fldChar w:fldCharType=\"end\"/>");
        if entries.is_empty() {
            out.push(Block::Para(
                PPr { ind_left: ind, ..PPr::default() },
                format!(
                    "{begin}{}{end}",
                    RPr { color: Some(NOTE_COLOR.into()), ..RPr::default() }.text("Nothing to list yet.")
                ),
            ));
            return out;
        }
        let n = entries.len();
        for (i, (id, label, level, page)) in entries.into_iter().enumerate() {
            let mut c = String::new();
            if i == 0 {
                c.push_str(&begin);
            }
            c.push_str(&format!(
                "<w:hyperlink w:anchor=\"{}\" w:history=\"1\">{}{}{}</w:hyperlink>",
                bookmark("_Ref_", &id),
                rpr.text(&label),
                rpr.raw("<w:tab/>"),
                rpr.text(&page)
            ));
            if i + 1 == n {
                c.push_str(&end);
            }
            let style = if of == "headings" {
                format!("TOC{}", level.clamp(1, 6))
            } else {
                "TableofFigures".to_string()
            };
            out.push(Block::Para(
                PPr {
                    style: Some(style),
                    ind_left: ind + i64::from(level.saturating_sub(1)) * 240,
                    tabs: vec![("right", tab, Some("dot"))],
                    ..PPr::default()
                },
                c,
            ));
        }
        out
    }

    /// Insert ▸ Summary of Checks: every check with ✓ or ✗, as written now.
    fn checks_list(&mut self, ind: i64, tab: i64) -> Vec<Block> {
        let mut rows: Vec<(String, bool, String)> = Vec::new();
        let order = self.order.clone();
        for id in &order {
            let Some(r) = self.region_by_id(id) else { continue };
            let Some(v) = self.view(id) else { continue };
            if let Some(pass) = math_check(r, v) {
                let input = match &v.input {
                    Some(Expr::Define { rhs, .. }) => Some(&**rhs),
                    other => other.as_ref(),
                };
                let mut label = input
                    .map(|e| omml::expression(e, &self.math_style(v, self.body_size)))
                    .unwrap_or_default();
                if let Some(note) = r.extra.get("note").and_then(Json::as_str) {
                    label.push_str(
                        &RPr { color: Some(NOTE_COLOR.into()), ..RPr::default() }
                            .text(&format!("  {}", djot::plain(note))),
                    );
                }
                rows.push((id.clone(), pass, label));
            }
            if let Some(cells) = &v.cells {
                let raw = r.extra.get("rows").and_then(Json::as_array);
                let name = r
                    .extra
                    .get("caption")
                    .and_then(|c| c.get("text"))
                    .and_then(|t| localized(t, self.lang.as_deref()))
                    .map(str::to_string)
                    .or_else(|| r.extra.get("name").and_then(Json::as_str).map(str::to_string))
                    .unwrap_or_else(|| "Table".into());
                for (i, row) in cells.iter().enumerate() {
                    for c in row {
                        if let Some(pass) = c.verdict {
                            let first = raw
                                .and_then(|rows| rows.get(i))
                                .and_then(|r| r.get(0))
                                .and_then(Json::as_str)
                                .filter(|s| !s.is_empty())
                                .map_or(format!("row {}", i + 1), str::to_string);
                            rows.push((id.clone(), pass, RPr::default().text(&format!("{name} · {first}"))));
                        }
                    }
                }
            }
        }
        let failing = rows.iter().filter(|r| !r.1).count();
        let total = if rows.is_empty() {
            "No checks yet.".to_string()
        } else if failing > 0 {
            format!("{failing} of {} failing", rows.len())
        } else if rows.len() == 1 {
            "1 check, passing".into()
        } else {
            format!("All {} checks pass", rows.len())
        };
        let total_rpr = RPr {
            bold: true,
            color: Some(if failing > 0 { FAIL_COLOR } else { PASS_COLOR }.into()),
            ..RPr::default()
        };
        let mut out = vec![Block::Para(
            PPr { ind_left: ind, after: Some(60), ..PPr::default() },
            total_rpr.text(&total),
        )];
        for (id, pass, label) in rows {
            let page =
                self.opts.pages.get(&id).map(|p| (p + self.page_start()).to_string()).unwrap_or_default();
            let mark = RPr {
                bold: true,
                color: Some(if pass { PASS_COLOR } else { FAIL_COLOR }.into()),
                ..RPr::default()
            };
            let mut c = mark.text(if pass { "✓\u{2002}" } else { "✗\u{2002}" });
            c.push_str(&format!(
                "<w:hyperlink w:anchor=\"{}\" w:history=\"1\">{label}</w:hyperlink>",
                bookmark("_Ref_", &id)
            ));
            c.push_str(&RPr::default().raw("<w:tab/>"));
            c.push_str(&RPr::default().text(&page));
            out.push(Block::Para(
                PPr {
                    ind_left: ind,
                    tabs: vec![("right", tab, Some("dot"))],
                    after: Some(30),
                    ..PPr::default()
                },
                c,
            ));
        }
        out
    }

    fn region_by_id(&self, id: &str) -> Option<&'a Region> {
        fn find<'r>(regions: &'r [Region], id: &str) -> Option<&'r Region> {
            regions.iter().find_map(|r| if r.id == id { Some(r) } else { find(&r.regions, id) })
        }
        find(&self.doc.regions, id)
    }

    /// A Djot table inside text: a plain bordered Word table.
    pub(crate) fn simple_table(&mut self, rows: Vec<djot::Row>, ind: i64) -> String {
        let ncols = rows.iter().map(|r| r.0.len()).max().unwrap_or(1).max(1);
        let w = (twips(self.geom.content_w()) - ind).max(1440) / ncols as i64;
        let grid: String = (0..ncols).map(|_| format!("<w:gridCol w:w=\"{w}\"/>")).collect();
        let mut t = format!(
            "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblInd w:w=\"{ind}\" w:type=\"dxa\"/><w:tblBorders>{}</w:tblBorders></w:tblPr><w:tblGrid>{grid}</w:tblGrid>",
            all_borders("single", 4, TABLE_BORDER)
        );
        for (cells, head) in rows {
            t.push_str("<w:tr>");
            if head {
                t.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            for j in 0..ncols {
                let blocks =
                    cells.get(j).map(|c| c.iter().map(Block::xml).collect::<String>()).unwrap_or_default();
                let body = if blocks.ends_with("</w:p>") { blocks } else { format!("{blocks}<w:p/>") };
                t.push_str(&format!(
                    "<w:tc><w:tcPr><w:tcW w:w=\"{w}\" w:type=\"dxa\"/></w:tcPr>{body}</w:tc>"
                ));
            }
            t.push_str("</w:tr>");
        }
        t.push_str("</w:tbl>");
        t
    }

    /// Regions side by side: a borderless table, one column per column of regions.
    fn grid(&mut self, cols: &[f64], rows: &[(f64, Vec<Vec<Item>>)]) -> String {
        let content = self.geom.content_w();
        let left = cols.first().copied().unwrap_or(0.0).max(0.0);
        let widths: Vec<f64> = cols
            .iter()
            .enumerate()
            .map(|(i, x)| (cols.get(i + 1).copied().unwrap_or(content) - x).max(30.0))
            .collect();
        let grid: String = widths.iter().map(|w| format!("<w:gridCol w:w=\"{}\"/>", twips(*w))).collect();
        let mut t = format!(
            "<w:tbl><w:tblPr><w:tblW w:w=\"{}\" w:type=\"dxa\"/><w:tblInd w:w=\"{}\" w:type=\"dxa\"/><w:tblBorders>{}</w:tblBorders><w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:left w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"0\" w:type=\"dxa\"/></w:tblCellMar><w:tblLook w:val=\"0000\" w:firstRow=\"0\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"1\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>",
            twips(widths.iter().sum()),
            twips(left),
            all_borders("nil", 0, "auto")
        );
        for (gap, cells) in rows {
            t.push_str("<w:tr><w:trPr><w:cantSplit/></w:trPr>");
            for (j, w) in widths.iter().enumerate() {
                t.push_str(&format!("<w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/></w:tcPr>", twips(*w)));
                let col_x = cols.get(j).copied().unwrap_or(0.0);
                let mut body = String::new();
                let mut last: Option<f64> = None;
                for it in cells.get(j).map(Vec::as_slice).unwrap_or_default() {
                    let before = match last {
                        None => twips(gap.min(36.0)),
                        Some(b) => twips((it.y - b).clamp(0.0, 36.0)),
                    };
                    last = Some(it.y + it.h);
                    let ind = twips((it.x - col_x).max(0.0));
                    let room = (w - (it.x - col_x)).max(30.0);
                    for b in self.region(it, ind, room, before) {
                        body.push_str(&b.xml());
                    }
                }
                if !body.ends_with("</w:p>") {
                    body.push_str("<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr></w:p>");
                }
                t.push_str(&body);
                t.push_str("</w:tc>");
            }
            t.push_str("</w:tr>");
        }
        t.push_str("</w:tbl>");
        t
    }

    // -----------------------------------------------------------------------------------------
    // The body
    // -----------------------------------------------------------------------------------------

    fn body(&mut self, items: Vec<Item<'a>>) -> String {
        let mut out = String::new();
        for step in layout::flow(items) {
            let blocks = match step {
                Flow::Single { item, gap } => {
                    if item.region.kind == "pagebreak" {
                        self.pending_break = true;
                        continue;
                    }
                    let ind = twips(item.x.max(0.0));
                    let room = (self.geom.content_w() - item.x).max(60.0);
                    self.region(&item, ind, room, twips(gap.min(36.0)))
                }
                Flow::Grid { cols, rows } => vec![Block::Raw(self.grid(&cols, &rows))],
            };
            let mut blocks = blocks.into_iter();
            if let Some(first) = blocks.next() {
                let first = match (first, self.pending_break) {
                    (Block::Para(mut p, c), true) => {
                        p.page_break_before = true;
                        Block::Para(p, c)
                    }
                    (b, true) => {
                        out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
                        b
                    }
                    (b, false) => b,
                };
                self.pending_break = false;
                out.push_str(&first.xml());
            }
            for b in blocks {
                out.push_str(&b.xml());
            }
        }
        out
    }
}

/// The DrawingML picture inside an inline or anchored drawing.
fn graphic(id: u32, rel: &str, cx: i64, cy: i64) -> String {
    format!(
        "<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"Picture {id}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{rel}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>"
    )
}

fn all_borders(style: &str, size: u32, color: &str) -> String {
    ["top", "left", "bottom", "right", "insideH", "insideV"]
        .iter()
        .map(|s| format!("<w:{s} w:val=\"{style}\" w:sz=\"{size}\" w:space=\"0\" w:color=\"{color}\"/>"))
        .collect()
}

/// ✓ / ✗ after a check, coloured as on the page.
fn badge(pass: bool, words: bool) -> String {
    let rpr = RPr {
        bold: true,
        size: Some(if words { 17 } else { 15 }),
        color: Some(if pass { PASS_COLOR } else { FAIL_COLOR }.into()),
        ..RPr::default()
    };
    let text = match (pass, words) {
        (true, _) => "\u{2003}✓",
        (false, true) => "\u{2003}✗ fails",
        (false, false) => "\u{2003}✗",
    };
    rpr.text(text)
}

fn error_para(e: &str, ind: i64) -> Block {
    Block::Para(
        PPr { ind_left: ind, after: Some(40), ..PPr::default() },
        RPr { color: Some(ERROR_COLOR.into()), size: Some(16), ..RPr::default() }.text(e),
    )
}

/// A spreadsheet value as the cell shows it: the number, then its unit in the units' blue.
fn cell_value(linear: &str, base: &RPr) -> String {
    let pretty = pretty_value(linear);
    let split = pretty.char_indices().find(|(i, c)| c.is_whitespace() && *i > 0).map(|(i, _)| i);
    let num_ok = |s: &str| s.trim_start_matches('-').chars().next().is_some_and(|c| c.is_ascii_digit());
    match split {
        Some(i) if num_ok(&pretty[..i]) => {
            let unit = RPr { color: Some("1D5FA8".into()), ..base.clone() };
            format!("{}{}", base.text(&format!("{} ", &pretty[..i])), unit.text(pretty[i..].trim()))
        }
        _ => base.text(&pretty),
    }
}

/// Header and footer fields: `{page}`, `{pages}`, `{date}`, … as Word fields or text.
fn field_runs(text: &str, rpr: &RPr, w: &Writer) -> String {
    let meta = &w.doc.meta;
    let lang = w.lang.as_deref();
    let title = meta
        .get("title")
        .and_then(|t| localized(t, lang))
        .filter(|t| !t.trim().is_empty())
        .map_or(w.opts.file.clone(), str::to_string);
    let author = match meta.get("authors") {
        Some(Json::Array(a)) => a.iter().filter_map(Json::as_str).collect::<Vec<_>>().join(", "),
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    let company = meta.get("company").and_then(Json::as_str).unwrap_or_default().to_string();
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let (head, tail) = rest.split_at(open);
        out.push_str(&rpr.text(head));
        let Some(close) = tail.find('}') else {
            rest = tail;
            break;
        };
        let key = &tail[1..close];
        let pages = w.opts.page_count.unwrap_or(1).to_string();
        match key {
            "page" => out.push_str(&rpr.field("PAGE", &w.page_start().to_string())),
            "pages" => out.push_str(&rpr.field("NUMPAGES", &pages)),
            "date" => out.push_str(&rpr.field("DATE", &w.opts.date)),
            "time" => out.push_str(&rpr.field("TIME \\@ \"HH:mm\"", &w.opts.time)),
            "section" => out.push_str(&rpr.field("STYLEREF \"heading 1\"", "")),
            "file" => out.push_str(&rpr.text(&w.opts.file)),
            "title" => out.push_str(&rpr.text(&title)),
            "author" => out.push_str(&rpr.text(&author)),
            "company" => out.push_str(&rpr.text(&company)),
            _ => out.push_str(&rpr.text(&tail[..=close])),
        }
        rest = &tail[close + 1..];
    }
    out.push_str(&rpr.text(rest));
    out
}

impl Writer<'_> {
    /// One header or footer part (`w:hdr` / `w:ftr`). `content` holds the slots and image that
    /// show; `band` the shared colour, size, rule and distance; `backgrounds` are pictures
    /// behind the page this part is used on.
    fn band_part(
        &mut self,
        header: bool,
        band: &Json,
        content: Option<&Json>,
        backgrounds: &[Json],
    ) -> String {
        let color =
            band.get("color").and_then(Json::as_str).and_then(hex_color).unwrap_or_else(|| "6E737C".into());
        let size_pt = band.get("size").and_then(Json::as_f64).filter(|s| *s > 0.0).unwrap_or(8.0);
        let rpr = RPr {
            color: Some(color.clone()),
            size: Some(half_points(size_pt)),
            bold: band.get("bold").and_then(Json::as_bool).unwrap_or(false),
            ..RPr::default()
        };
        let room = if header { self.geom.top } else { self.geom.bottom };
        let content_w = self.geom.content_w();
        let slot =
            |k: &str| content.and_then(|c| c.get(k)).and_then(Json::as_str).unwrap_or_default().to_string();
        let image = content.and_then(|c| c.get("image"));
        let image_slot = image.and_then(|i| i.get("slot")).and_then(Json::as_str).unwrap_or("left");
        let image_h =
            image.map(|i| length_px(i.get("height"), room / 2.0).clamp(4.0, room.max(8.0))).unwrap_or(0.0);
        let picture = image
            .and_then(|i| i.get("src"))
            .and_then(Json::as_str)
            .and_then(|src| (self.asset)(src))
            .and_then(|bytes| {
                let (pw, ph) = image::dimensions(&bytes)?;
                let w = image_h * f64::from(pw) / f64::from(ph.max(1));
                self.picture(&bytes, w, image_h, "")
            });
        let mut c = String::new();
        for bg in backgrounds {
            let Some(bytes) = bg.get("src").and_then(Json::as_str).and_then(|s| (self.asset)(s)) else {
                continue;
            };
            let g = self.geom;
            let (x, y, w, h) = if bg.get("fit").and_then(Json::as_str) == Some("margins") {
                (g.left, g.top, g.content_w(), g.paper_h - g.top - g.bottom)
            } else {
                (0.0, 0.0, g.paper_w, g.paper_h)
            };
            if let Some(d) = self.background(&bytes, x, y, w, h) {
                c.push_str(&d);
            }
        }
        for (i, s) in ["left", "center", "right"].iter().enumerate() {
            if i > 0 {
                c.push_str(&rpr.raw("<w:tab/>"));
            }
            let pic = picture.as_deref().filter(|_| image_slot == *s);
            if *s != "right"
                && let Some(p) = pic
            {
                c.push_str(p);
                if !slot(s).is_empty() {
                    c.push_str(&rpr.text(" "));
                }
            }
            c.push_str(&field_runs(&slot(s), &rpr, self));
            if *s == "right"
                && let Some(p) = pic
            {
                if !slot(s).is_empty() {
                    c.push_str(&rpr.text(" "));
                }
                c.push_str(p);
            }
        }
        let rule = band.get("rule").map(|r| Border {
            size: ((length_px(r.get("width"), 0.5 * 96.0 / 72.0) * 72.0 / 96.0) * 8.0)
                .round()
                .clamp(2.0, 96.0) as u32,
            color: r.get("color").and_then(Json::as_str).and_then(hex_color).unwrap_or_else(|| color.clone()),
            space: 2,
        });
        let mut p = PPr {
            tabs: vec![("center", twips(content_w / 2.0), None), ("right", twips(content_w), None)],
            after: Some(0),
            mark: Some(rpr.clone()),
            ..PPr::default()
        };
        if header {
            p.border_bottom_rule = rule;
        } else {
            p.border_top = rule;
        }
        let tag = if header { "hdr" } else { "ftr" };
        format!("<w:{tag} {}>{}</w:{tag}>", package::NAMESPACES, Block::Para(p, c).xml())
    }

    /// From the paper's edge to the band's text, in px: `distance`, or the line centred in the
    /// margin, as the page places it (`bandLayout` in `pages.ts`).
    fn band_offset(&self, header: bool, band: Option<&Json>) -> f64 {
        let room = if header { self.geom.top } else { self.geom.bottom };
        let size =
            band.and_then(|b| b.get("size")).and_then(Json::as_f64).filter(|s| *s > 0.0).unwrap_or(8.0);
        let line = (size * 96.0 / 72.0 * 1.25).round();
        let image = band
            .and_then(|b| b.get("image"))
            .map(|i| length_px(i.get("height"), room / 2.0).clamp(4.0, room.max(8.0)))
            .unwrap_or(0.0);
        let row = line.max(image);
        match band.and_then(|b| b.get("distance")) {
            Some(d) => length_px(Some(d), 0.0).clamp(0.0, (room - row).max(0.0)),
            None => ((room - row) / 2.0).max(0.0),
        }
    }
}

/// Write `doc` (the editor's JSON) as a `.docx`. `asset` reads an image of the bundle
/// (`assets/…`); `report` is its evaluation.
pub(crate) fn write(
    doc_json: &Json,
    report: &Report,
    opts: &DocxOptions,
    asset: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let doc: Document = serde_json::from_value(doc_json.clone())?;
    let views: HashMap<&str, &RegionView> = report.regions.iter().map(|v| (v.id.as_str(), v)).collect();
    let lang = doc.meta.get("lang").and_then(Json::as_str).map(str::to_string);
    let styles = doc.extra.get("styles");
    let style_num = |k: &str, f: &str| styles.and_then(|s| s.get(k)).and_then(|s| s.get(f));
    let numbering = styles.and_then(|s| s.get("numbering"));
    let pattern = |key: &str, kind: &str| {
        numbering
            .and_then(|n| n.get(key))
            .and_then(Json::as_str)
            .filter(|s| !s.is_empty())
            .map_or_else(|| default_label(lang.as_deref().unwrap_or("en"), kind).to_string(), str::to_string)
    };
    let group_digits = doc.settings.display.extra.get("groupDigits").and_then(Json::as_bool).unwrap_or(false);
    let mut w = Writer {
        doc: &doc,
        views,
        opts,
        asset,
        lang: lang.clone(),
        geom: geometry(doc.extra.get("page")),
        body_size: half_points(style_num("body", "size").and_then(Json::as_f64).unwrap_or(10.0)),
        math_size: half_points(style_num("math", "size").and_then(Json::as_f64).unwrap_or(10.0)),
        group_digits,
        headings_numbered: numbering.and_then(|n| n.get("headings")).and_then(Json::as_str) != Some(""),
        patterns: [pattern("figures", "figure"), pattern("tables", "table"), pattern("sections", "section")],
        numbers: HashMap::new(),
        titles: HashMap::new(),
        rels: Vec::new(),
        media: Vec::new(),
        ordered: Vec::new(),
        bookmarks: 0,
        drawings: 0,
        pending_break: false,
        order: Vec::new(),
    };

    // numbering, as the page counts it: headings, then figures and tables with a caption
    let placed = layout::placed(&doc);
    let mut heading = [0u32; 6];
    let (mut figures, mut tables) = (0, 0);
    for (r, _, _, hidden) in &placed {
        if r.kind == "text" {
            let text = w.text_of(r, "text").unwrap_or_default();
            let level = heading_level(&text);
            if level > 0 {
                let i = level as usize - 1;
                heading[i] += 1;
                heading.iter_mut().skip(i + 1).for_each(|n| *n = 0);
                let number = heading.iter().take(i + 1).map(u32::to_string).collect::<Vec<_>>().join(".");
                w.numbers.insert(r.id.clone(), Num::Heading { level, number });
                w.titles.insert(r.id.clone(), djot::plain(&text));
            }
        } else if r.extra.get("caption").is_some() {
            let num = if r.kind == "table" {
                tables += 1;
                Num::Table(tables)
            } else {
                figures += 1;
                Num::Figure(figures)
            };
            w.numbers.insert(r.id.clone(), num);
            let text = r
                .extra
                .get("caption")
                .and_then(|c| c.get("text"))
                .and_then(|t| localized(t, lang.as_deref()))
                .unwrap_or_default();
            w.titles.insert(r.id.clone(), djot::plain(text));
        }
        if !hidden {
            w.order.push(r.id.clone());
        }
    }
    let content_w = w.geom.content_w();
    let items: Vec<Item> = placed
        .iter()
        .filter(|p| !p.3)
        .map(|&(r, x, y, _)| {
            let (iw, ih) = layout::size(r, x, content_w, &opts.heights, &opts.widths, lang.as_deref());
            Item { region: r, x, y, w: iw, h: ih }
        })
        .collect();

    let body = w.body(items);
    package::assemble(&mut w, body)
}

impl Writer<'_> {
    /// The body's relationships so far, taken (headers and footers have their own).
    fn take_rels(&mut self) -> Vec<Rel> {
        std::mem::take(&mut self.rels)
    }
}

#[cfg(test)]
mod tests;
