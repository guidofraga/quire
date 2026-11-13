//! Djot (text regions, captions, notes) → WordprocessingML paragraphs.
//!
//! The same rules as the HTML in `text.rs`: documents are untrusted, so raw HTML is dropped
//! and only http(s), mailto and in-document links become links. Inline math (`` $`A =` ``) is
//! an equation with its current result; a cross-reference (`[](#ref:id)`) is a Word field that
//! Word can update.

use jotdown::{AttributeKind, Attributes, Container, Event, LinkType, ListKind, OrderedListNumbering};

use super::xml::{hex_color, twips};
use super::{Block, PPr, RPr, RefStyle, Writer};

/// Where a text region's paragraphs sit.
#[derive(Clone, Default)]
pub(super) struct TextCtx {
    /// The region, for its inline math (`<id>:m<n>`) and its heading's bookmark.
    pub region: String,
    /// The region's own font, size and colour.
    pub base: RPr,
    /// Left and right indent (twips): the region's place across the column.
    pub ind_left: i64,
    pub ind_right: i64,
    /// Space before the first paragraph (twips).
    pub before: i64,
    /// The region's heading number, when it is numbered: its level from 1.
    pub numbered: Option<u32>,
    /// Paragraph spacing after, in twips (0.3em of the region's size).
    pub after: i64,
}

struct ListState {
    num: u32,
    level: u32,
    tight: bool,
    /// The next paragraph starts an item (it carries the bullet or number).
    item_start: bool,
}

/// A row of a Djot table: its cells' blocks, and whether it is a header row.
pub(super) type Row = (Vec<Vec<Block>>, bool);

/// A Djot table being read: its rows, and its caption (which Word puts after it).
#[derive(Default)]
struct TableBuild {
    rows: Vec<Row>,
    after: Vec<Block>,
    in_caption: bool,
}

struct Conv<'w, 'a> {
    w: &'w mut Writer<'a>,
    ctx: &'w TextCtx,
    out: Vec<Block>,
    /// Blocks of table cells under construction: rows of cells of blocks.
    tables: Vec<TableBuild>,
    para: Option<(PPr, String)>,
    runs: Vec<RPr>,
    lists: Vec<ListState>,
    quote: u32,
    /// Classes of the section a heading opens (`{.title}`, `{.center}`).
    section_classes: Vec<String>,
    heading_numbered: bool,
    /// Inside a container whose text is not shown as text (math, a reference, a raw block).
    skip: u32,
    math_index: usize,
    /// `Some(bookmark id)` while the region's first heading is written.
    heading_mark: Option<u32>,
    links: Vec<bool>,
    in_code_block: bool,
}

fn classes(attrs: &Attributes) -> Vec<String> {
    attrs
        .iter()
        .filter(|(k, _)| matches!(k, AttributeKind::Class))
        .flat_map(|(_, v)| v.to_string().split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .collect()
}

fn pair(attrs: &Attributes, key: &str) -> Option<String> {
    attrs.iter().find_map(|(k, v)| match k {
        AttributeKind::Pair { key: k } if k.as_ref() == key => Some(v.to_string()),
        _ => None,
    })
}

fn jc_of(classes: &[String]) -> Option<&'static str> {
    classes.iter().find_map(|c| match c.as_str() {
        "center" => Some("center"),
        "right" => Some("right"),
        "justify" => Some("both"),
        _ => None,
    })
}

/// A span's attributes on its runs: `.underline`, `.strike`, `color`, `size` (pt), `font`.
fn apply_attrs(r: &mut RPr, attrs: &Attributes) {
    for c in classes(attrs) {
        match c.as_str() {
            "underline" => r.underline = true,
            "strike" => r.strike = true,
            _ => {}
        }
    }
    if let Some(c) = pair(attrs, "color").as_deref().and_then(hex_color) {
        r.color = Some(c);
    }
    if let Some(s) = pair(attrs, "size").and_then(|s| s.parse::<f64>().ok()).filter(|s| *s > 0.0) {
        r.size = Some(super::xml::half_points(s));
    }
    if let Some(f) = pair(attrs, "font").filter(|f| !f.contains('"')) {
        r.font = Some(f);
    }
}

fn safe_link(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

impl Conv<'_, '_> {
    fn rpr(&self) -> RPr {
        self.runs.last().cloned().unwrap_or_else(|| self.ctx.base.clone())
    }

    fn push_run(&mut self, f: impl FnOnce(&mut RPr)) {
        let mut r = self.rpr();
        f(&mut r);
        self.runs.push(r);
    }

    fn pop_run(&mut self) {
        self.runs.pop();
    }

    fn sink(&mut self) -> &mut Vec<Block> {
        match self.tables.last_mut() {
            // a table's caption follows it
            Some(t) if t.in_caption => &mut t.after,
            Some(t) => match t.rows.last_mut().and_then(|(cells, _)| cells.last_mut()) {
                Some(cell) => cell,
                None => &mut self.out,
            },
            None => &mut self.out,
        }
    }

    fn open(&mut self, mut p: PPr) {
        self.close();
        let in_table = !self.tables.is_empty();
        if !in_table {
            p.ind_left += self.ctx.ind_left;
            p.ind_right += self.ctx.ind_right;
        }
        p.ind_left += i64::from(self.quote) * 240;
        if self.quote > 0 {
            p.border_left = true;
        }
        if p.after.is_none() {
            p.after = Some(self.ctx.after);
        }
        if let Some(list) = self.lists.last_mut() {
            if list.item_start {
                p.num = Some((list.num, list.level));
                list.item_start = false;
            } else {
                p.ind_left += 360 * i64::from(list.level + 1);
            }
            if list.tight {
                p.after = Some(0);
            }
        }
        self.para = Some((p, String::new()));
    }

    fn close(&mut self) {
        if let Some((p, content)) = self.para.take() {
            self.sink().push(Block::Para(p, content));
        }
    }

    fn content(&mut self) -> &mut String {
        if self.para.is_none() {
            self.open(PPr::default());
        }
        &mut self.para.get_or_insert_with(|| (PPr::default(), String::new())).1
    }

    fn text(&mut self, s: &str) {
        if self.skip > 0 {
            return;
        }
        let r = self.rpr();
        let xml = if self.in_code_block {
            // a code block keeps its lines
            let lines: Vec<String> = s.split('\n').map(|l| r.text(l)).collect();
            lines.join(&r.raw("<w:br/>"))
        } else {
            r.text(s)
        };
        self.content().push_str(&xml);
    }

    fn start(&mut self, c: Container, attrs: Attributes) {
        match c {
            Container::Section { .. } => self.section_classes = classes(&attrs),
            Container::Heading { level, .. } => {
                let section = std::mem::take(&mut self.section_classes);
                let mut own = classes(&attrs);
                own.extend(section);
                let title = own.iter().any(|c| c == "title");
                let mut p = PPr { keep_next: true, jc: jc_of(&own), after: Some(0), ..PPr::default() };
                // a region numbers its first heading only, as the page does
                let first = !self.heading_numbered && !title;
                if title {
                    p.style = Some("Title".into());
                } else {
                    p.style = Some(format!("Heading{}", u32::from(level).clamp(1, 6)));
                    if first && let Some(n) = self.ctx.numbered {
                        p.num = Some((super::HEADING_NUM, n.saturating_sub(1)));
                    }
                }
                self.open(p);
                if first {
                    self.heading_numbered = true;
                }
                let size = self.rpr().size.unwrap_or(self.w.body_size);
                self.push_run(|r| {
                    r.bold = true;
                    if title {
                        r.size = Some((f64::from(size) * 1.8).round() as u32);
                    }
                });
                // the heading's number is set in the paragraph mark's font
                let mark = self.rpr();
                if let Some((p, _)) = &mut self.para {
                    p.mark = Some(mark);
                }
                if first {
                    let id = self.w.next_bookmark();
                    let name = super::xml::bookmark("_Ref_", &self.ctx.region);
                    self.content().push_str(&format!("<w:bookmarkStart w:id=\"{id}\" w:name=\"{name}\"/>"));
                    self.heading_mark = Some(id);
                }
            }
            Container::Paragraph => {
                let own = classes(&attrs);
                self.open(PPr { jc: jc_of(&own), ..PPr::default() });
                self.push_run(|r| apply_attrs(r, &attrs));
            }
            Container::Blockquote => {
                self.close();
                self.quote += 1;
            }
            Container::List { kind, tight } => {
                self.close();
                let level = self.lists.len() as u32;
                let num = match kind {
                    ListKind::Ordered { numbering, style, start } => {
                        self.w.ordered_list(numbering, style, start)
                    }
                    ListKind::Unordered(_) | ListKind::Task(_) => super::BULLET_NUM,
                };
                self.lists.push(ListState { num, level: level.min(8), tight, item_start: false });
            }
            Container::ListItem | Container::TaskListItem { .. } => {
                self.close();
                if let Some(l) = self.lists.last_mut() {
                    l.item_start = true;
                }
                if let Container::TaskListItem { checked } = c {
                    self.text(if checked { "☒ " } else { "☐ " });
                }
            }
            Container::DescriptionList | Container::Div { .. } | Container::Footnote { .. } => self.close(),
            Container::DescriptionTerm => {
                self.open(PPr::default());
                self.push_run(|r| r.bold = true);
            }
            Container::DescriptionDetails => {
                self.close();
                self.quote += 1;
            }
            Container::CodeBlock { .. } => {
                self.open(PPr::default());
                self.push_run(|r| r.font = Some(super::MONO_FONT.into()));
                self.in_code_block = true;
            }
            Container::Table => {
                self.close();
                self.tables.push(TableBuild::default());
            }
            Container::TableRow { head } => {
                if let Some(t) = self.tables.last_mut() {
                    t.rows.push((Vec::new(), head));
                }
            }
            Container::TableCell { alignment, head } => {
                if let Some(t) = self.tables.last_mut()
                    && let Some((cells, _)) = t.rows.last_mut()
                {
                    cells.push(Vec::new());
                }
                let jc = match alignment {
                    jotdown::Alignment::Center => Some("center"),
                    jotdown::Alignment::Right => Some("right"),
                    _ => None,
                };
                self.open(PPr { jc, after: Some(0), ..PPr::default() });
                self.push_run(|r| r.bold |= head);
            }
            Container::Caption => {
                self.close();
                if let Some(t) = self.tables.last_mut() {
                    t.in_caption = true;
                }
                self.open(PPr { style: Some("Caption".into()), ..PPr::default() });
                self.push_run(|_| {});
            }
            Container::LinkDefinition { .. } | Container::RawBlock { .. } | Container::RawInline { .. } => {
                self.skip += 1
            }
            Container::Math { .. } => {
                let n = self.math_index;
                self.math_index += 1;
                let id = format!("{}:m{n}", self.ctx.region);
                let rpr = self.rpr();
                let xml = self.w.inline_math(&id, &rpr);
                if self.skip == 0 {
                    self.content().push_str(&xml);
                }
                self.skip += 1;
            }
            Container::Link(url, ty) => {
                let url = url.to_string();
                if let Some(target) = url.strip_prefix("#ref:") {
                    let style = match classes(&attrs).iter().find_map(|c| match c.as_str() {
                        "num" => Some(RefStyle::Num),
                        "page" => Some(RefStyle::Page),
                        "title" => Some(RefStyle::Title),
                        _ => None,
                    }) {
                        Some(s) => s,
                        None => RefStyle::Label,
                    };
                    let rpr = self.rpr();
                    let xml = self.w.cross_ref(target, style, &rpr);
                    if self.skip == 0 {
                        self.content().push_str(&xml);
                    }
                    self.skip += 1;
                    self.links.push(false);
                    return;
                }
                let url = if matches!(ty, LinkType::Email) { format!("mailto:{url}") } else { url };
                if safe_link(&url) && self.skip == 0 {
                    let rel = self.w.hyperlink(&url);
                    self.content().push_str(&format!("<w:hyperlink r:id=\"{rel}\" w:history=\"1\">"));
                    self.push_run(|r| {
                        r.style = Some("Hyperlink");
                    });
                    self.links.push(true);
                } else {
                    self.push_run(|_| {});
                    self.links.push(false);
                }
            }
            Container::Image(..) => self.push_run(|r| r.italic = true),
            Container::Span => self.push_run(|r| apply_attrs(r, &attrs)),
            Container::Strong => self.push_run(|r| r.bold = true),
            Container::Emphasis => self.push_run(|r| r.italic = true),
            Container::Delete => self.push_run(|r| r.strike = true),
            Container::Insert => self.push_run(|r| r.underline = true),
            Container::Mark => self.push_run(|r| r.highlight = true),
            Container::Superscript => self.push_run(|r| r.vert = Some("superscript")),
            Container::Subscript => self.push_run(|r| r.vert = Some("subscript")),
            Container::Verbatim => self.push_run(|r| r.font = Some(super::MONO_FONT.into())),
            Container::Document => {}
        }
    }

    fn end(&mut self, c: Container) {
        match c {
            Container::Heading { .. } => {
                self.pop_run();
                if let Some(id) = self.heading_mark.take() {
                    self.content().push_str(&format!("<w:bookmarkEnd w:id=\"{id}\"/>"));
                }
                self.close();
            }
            Container::Paragraph | Container::DescriptionTerm => {
                self.pop_run();
                self.close();
            }
            Container::Caption => {
                self.pop_run();
                self.close();
                if let Some(t) = self.tables.last_mut() {
                    t.in_caption = false;
                }
            }
            Container::CodeBlock { .. } => {
                self.in_code_block = false;
                self.pop_run();
                self.close();
            }
            Container::Blockquote | Container::DescriptionDetails => {
                self.close();
                self.quote = self.quote.saturating_sub(1);
            }
            Container::List { .. } => {
                self.close();
                self.lists.pop();
            }
            Container::TableCell { .. } => {
                self.pop_run();
                self.close();
            }
            Container::Table => {
                self.close();
                if let Some(t) = self.tables.pop() {
                    let table = self.w.simple_table(t.rows, self.ctx.ind_left);
                    self.sink().push(Block::Raw(table));
                    for b in t.after {
                        self.sink().push(b);
                    }
                }
            }
            Container::LinkDefinition { .. }
            | Container::RawBlock { .. }
            | Container::RawInline { .. }
            | Container::Math { .. } => self.skip = self.skip.saturating_sub(1),
            Container::Link(url, _) => {
                if url.starts_with("#ref:") {
                    self.skip = self.skip.saturating_sub(1);
                    self.links.pop();
                    return;
                }
                if self.links.pop() == Some(true) {
                    self.content().push_str("</w:hyperlink>");
                }
                self.pop_run();
            }
            Container::Image(..)
            | Container::Span
            | Container::Strong
            | Container::Emphasis
            | Container::Delete
            | Container::Insert
            | Container::Mark
            | Container::Superscript
            | Container::Subscript
            | Container::Verbatim => self.pop_run(),
            Container::ListItem
            | Container::TaskListItem { .. }
            | Container::DescriptionList
            | Container::Div { .. }
            | Container::Footnote { .. }
            | Container::Section { .. }
            | Container::TableRow { .. }
            | Container::Document => self.close(),
        }
    }

    fn event(&mut self, e: Event) {
        match e {
            Event::Start(c, attrs) => self.start(c, attrs),
            Event::End(c) => self.end(c),
            Event::Str(s) => self.text(&s),
            Event::FootnoteReference(label) => {
                if self.skip == 0 {
                    let mut r = self.rpr();
                    r.vert = Some("superscript");
                    let xml = r.text(&label);
                    self.content().push_str(&xml);
                }
            }
            Event::Symbol(s) => self.text(&format!(":{s}:")),
            Event::LeftSingleQuote => self.text("‘"),
            Event::RightSingleQuote => self.text("’"),
            Event::LeftDoubleQuote => self.text("“"),
            Event::RightDoubleQuote => self.text("”"),
            Event::Ellipsis => self.text("…"),
            Event::EnDash => self.text("–"),
            Event::EmDash => self.text("—"),
            Event::NonBreakingSpace => self.text("\u{a0}"),
            Event::Softbreak => self.text(" "),
            Event::Hardbreak => {
                if self.skip == 0 {
                    let xml = self.rpr().raw("<w:br/>");
                    self.content().push_str(&xml);
                }
            }
            Event::ThematicBreak(_) => {
                self.open(PPr { border_bottom: true, ..PPr::default() });
                self.close();
            }
            Event::Escape | Event::Blankline | Event::Attributes(_) => {}
        }
    }
}

/// A text region's blocks. The first block gets `ctx.before`, the last no space after.
pub(super) fn blocks(w: &mut Writer, src: &str, ctx: &TextCtx) -> Vec<Block> {
    let src = crate::text::quote_colors(src);
    let mut conv = Conv {
        w,
        ctx,
        out: Vec::new(),
        tables: Vec::new(),
        para: None,
        runs: Vec::new(),
        lists: Vec::new(),
        quote: 0,
        section_classes: Vec::new(),
        heading_numbered: false,
        skip: 0,
        math_index: 0,
        heading_mark: None,
        links: Vec::new(),
        in_code_block: false,
    };
    for e in jotdown::Parser::new(&src) {
        conv.event(e);
    }
    conv.close();
    let mut out = conv.out;
    if out.is_empty() {
        out.push(Block::Para(
            PPr { ind_left: ctx.ind_left, ind_right: ctx.ind_right, ..PPr::default() },
            String::new(),
        ));
    }
    if let Some(Block::Para(p, _)) = out.first_mut() {
        p.before = Some(p.before.unwrap_or(0) + ctx.before);
    }
    if let Some(Block::Para(p, _)) = out.last_mut() {
        p.after = Some(0);
    }
    out
}

/// Djot as the runs of one paragraph (captions, notes, area titles): block structure is
/// flattened, paragraphs joined by a space.
pub(super) fn runs(w: &mut Writer, src: &str, base: &RPr, region: &str) -> String {
    let ctx = TextCtx { region: region.to_string(), base: base.clone(), ..TextCtx::default() };
    let blocks = blocks(w, src, &ctx);
    let mut out = String::new();
    for b in blocks {
        if let Block::Para(_, content) = b {
            if !out.is_empty() && !content.is_empty() {
                out.push_str(&base.text(" "));
            }
            out.push_str(&content);
        }
    }
    out
}

/// Djot as plain words, for bookmarks' cached text and the contents list.
pub(super) fn plain(src: &str) -> String {
    let src = crate::text::quote_colors(src);
    let mut out = String::new();
    let mut skip = 0u32;
    for e in jotdown::Parser::new(&src) {
        match e {
            Event::Start(
                Container::Math { .. } | Container::RawInline { .. } | Container::RawBlock { .. },
                _,
            ) => skip += 1,
            Event::End(Container::Math { .. } | Container::RawInline { .. } | Container::RawBlock { .. }) => {
                skip = skip.saturating_sub(1)
            }
            Event::Start(Container::Heading { .. }, _) if !out.is_empty() => break,
            Event::End(Container::Heading { .. }) => break,
            Event::Str(s) if skip == 0 => out.push_str(&s),
            Event::Softbreak | Event::Hardbreak => out.push(' '),
            Event::EnDash => out.push('–'),
            Event::EmDash => out.push('—'),
            Event::Ellipsis => out.push('…'),
            Event::LeftSingleQuote => out.push('‘'),
            Event::RightSingleQuote => out.push('’'),
            Event::LeftDoubleQuote => out.push('“'),
            Event::RightDoubleQuote => out.push('”'),
            Event::NonBreakingSpace => out.push('\u{a0}'),
            Event::End(Container::Paragraph) => out.push(' '),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An ordered list's number format in Word's words.
pub(super) fn num_format(n: OrderedListNumbering) -> &'static str {
    match n {
        OrderedListNumbering::Decimal => "decimal",
        OrderedListNumbering::AlphaLower => "lowerLetter",
        OrderedListNumbering::AlphaUpper => "upperLetter",
        OrderedListNumbering::RomanLower => "lowerRoman",
        OrderedListNumbering::RomanUpper => "upperRoman",
    }
}

/// Spacing after a paragraph of a region set in `size_hp` half-points: 0.3em.
pub(super) fn spacing_after(size_hp: u32) -> i64 {
    twips(f64::from(size_hp) / 2.0 * 0.3 * 96.0 / 72.0)
}
