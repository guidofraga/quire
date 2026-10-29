//! SMath XHTML-ish paragraphs -> Djot.
//!
//! Python's ElementTree model is reproduced by walking roxmltree children: `el.text` is
//! the run of text nodes before the first child element, `c.tail` the run after `c` up
//! to the next element (comments and processing instructions are skipped, as ElementTree
//! drops them, so text on either side of a comment joins). Element names match the
//! namespace of the document root, the same way Python compares against `NS`.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use regex::Regex;
use roxmltree::Node;

/// Parsed `style="k: v; …"` (keys lower-cased, values trimmed).
pub(crate) type Css = BTreeMap<String, String>;

/// Replaces the Python globals INLINE_MATH / INLINE_ORDER: math regions embedded in a
/// text region, by SMath region id, as Djot inline math (`$`expr =``), and the ids in
/// the order the text referenced them.
#[derive(Debug, Default, Clone)]
pub(crate) struct InlineMath {
    pub map: HashMap<String, String>,
    pub order: Vec<String>,
}

/// The region's base font: `family` and `size` as written in the XML (e.g. "10").
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RegionFont {
    pub family: String,
    pub size: String,
}

/// Python's `str.isspace()`: Unicode White_Space plus U+001C..=U+001F.
fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python `str.strip()` with no arguments.
fn py_strip(s: &str) -> &str {
    s.trim_matches(is_py_space)
}

/// Compile a constant pattern once. The patterns are constants covered by the unit
/// tests, so `None` (a broken pattern) is unreachable; callers then fall back to a
/// no-op rather than panic.
fn cached(cell: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

/// Namespace of the document root: the `NS` that Python's `tag()`/`child()` strip or match.
fn root_ns<'a, 'i: 'a>(n: Node<'a, 'i>) -> Option<&'a str> {
    n.document().root_element().tag_name().namespace()
}

/// `tag(n) == name` in the Python sense: an element in the root's namespace.
fn is_named(n: Node<'_, '_>, ns: Option<&str>, name: &str) -> bool {
    n.is_element() && n.tag_name().name() == name && n.tag_name().namespace() == ns
}

/// ElementTree text run: the text nodes starting at `first`, up to the next element.
fn text_run(first: Option<Node<'_, '_>>) -> String {
    let mut s = String::new();
    let mut cur = first;
    while let Some(n) = cur {
        if n.is_element() {
            break;
        }
        if let Some(t) = n.text().filter(|_| n.is_text()) {
            s.push_str(t);
        }
        cur = n.next_sibling();
    }
    s
}

fn is_style(st: &Css, key: &str, value: &str) -> bool {
    st.get(key).is_some_and(|v| v == value)
}

pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '*' | '_' | '[' | ']' | '{' | '}' | '`' | '~' | '^' | '$' | '<') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub(crate) fn css(style: Option<&str>) -> Css {
    let mut out = Css::new();
    for part in style.unwrap_or("").split(';') {
        if let Some((k, v)) = part.split_once(':') {
            out.insert(py_strip(k).to_lowercase(), py_strip(v).to_string());
        }
    }
    out
}

pub(crate) fn wrap_inline(text: &str, st: &Css) -> String {
    let core = py_strip(text);
    if core.is_empty() {
        return text.to_string();
    }
    let head = text.len() - text.trim_start_matches(is_py_space).len();
    let tail_start = text.trim_end_matches(is_py_space).len();
    let lead = text.get(..head).unwrap_or_default();
    let trail = text.get(tail_start..).unwrap_or_default();
    let mut core = core.to_string();

    let mut attrs: Vec<String> = Vec::new();
    if is_style(st, "text-decoration", "underline") {
        attrs.push(".underline".to_string());
    }
    if is_style(st, "text-decoration", "line-through") {
        attrs.push(".strike".to_string());
    }
    let color = st.get("color").map(|c| c.to_lowercase()).unwrap_or_default();
    if !color.is_empty() && color != "#000000" && color != "black" {
        attrs.push(format!("color={color}"));
    }
    if is_style(st, "font-style", "italic") {
        core = format!("_{core}_");
    }
    if is_style(st, "font-weight", "bold") {
        core = format!("*{core}*");
    }
    if !attrs.is_empty() {
        core = format!("[{core}]{{{}}}", attrs.join(" "));
    }
    format!("{lead}{core}{trail}")
}

const WS_PATTERN: &str = r"[\s\x1c-\x1f]*\n[\s\x1c-\x1f]*";

/// XML pretty-print whitespace (runs containing a newline) is not content.
pub(crate) fn ws(s: Option<&str>) -> String {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let s = s.unwrap_or("");
    if py_strip(s).is_empty() && s.contains('\n') {
        return String::new();
    }
    match cached(&RE, WS_PATTERN) {
        Some(re) => re.replace_all(s, " ").into_owned(),
        None => s.to_string(),
    }
}

/// SMath embeds math in text as `\\[REGION[<id>]]\\` markers.
const REGION_PATTERN: &str = r"\\\[REGION\[([0-9A-Za-z]+)\]\]\\";

/// Escape `s` as Djot text, replacing each region marker with its inline math (and
/// recording the id in `im.order`) when `im.map` knows the region.
pub(crate) fn esc_text(s: &str, im: &mut InlineMath) -> String {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(re) = cached(&RE, REGION_PATTERN) else {
        return esc(s);
    };
    let mut out = String::new();
    let mut pos = 0;
    for m in re.captures_iter(s) {
        let Some(whole) = m.get(0) else { continue };
        out.push_str(&esc(s.get(pos..whole.start()).unwrap_or_default()));
        // group 1 always matches (`+`), so "" only for a regex that cannot match
        let id = m.get(1).map_or("", |g| g.as_str());
        if let Some(math) = im.map.get(id) {
            out.push_str(math);
            im.order.push(id.to_string());
        }
        pos = whole.end();
    }
    out.push_str(&esc(s.get(pos..).unwrap_or_default()));
    out
}

/// Element nesting past which `inline_djot` stops descending: deeper subtrees are
/// rendered as their flattened text, so hostile input cannot exhaust the stack.
const MAX_DEPTH: usize = 64;

/// Render the children of `<p>`/`<span>` as Djot inline text.
pub(crate) fn inline_djot(el: Node<'_, '_>, im: &mut InlineMath) -> String {
    inline_djot_at(el, im, 0)
}

/// `inline_djot` for `el` nested `depth` elements deep. Children of an element at
/// `MAX_DEPTH` are not descended into; their text is flattened instead.
fn inline_djot_at(el: Node<'_, '_>, im: &mut InlineMath, depth: usize) -> String {
    let ns = root_ns(el);
    let lead = text_run(el.first_child());
    let mut parts = vec![esc_text(&ws(Some(&lead)), im)];
    for c in el.children() {
        if !c.is_element() {
            continue;
        }
        if is_named(c, ns, "br") {
            parts.push("\\\n".to_string());
        } else if depth >= MAX_DEPTH {
            parts.push(esc_text(&ws(Some(&flat_text(c))), im));
        } else if is_named(c, ns, "span") {
            let inner = inline_djot_at(c, im, depth + 1);
            parts.push(wrap_inline(&inner, &css(c.attribute("style"))));
        } else {
            parts.push(inline_djot_at(c, im, depth + 1));
        }
        let tail = text_run(c.next_sibling());
        parts.push(esc_text(&ws(Some(&tail)), im));
    }
    parts.concat()
}

/// All text nodes of `el`'s subtree, concatenated in document order (no recursion).
fn flat_text(el: Node<'_, '_>) -> String {
    let mut s = String::new();
    for n in el.descendants().filter(|n| n.is_text()) {
        if let Some(t) = n.text() {
            s.push_str(t);
        }
    }
    s
}

const HEADING_PATTERN: &str = concat!(r"^\*?(\d+(?:\.\d+)*)\.?\*?", r"[\s\x1c-\x1f]+(.+)\n?\z");

const CAPTION_PATTERN: &str = concat!(
    r"(?i)^(Figura|Figure|Fig\.|Tabela|Table|Gráfico|Chart)",
    r"[\s\x1c-\x1f]*(\d+)[\s\x1c-\x1f]*[–—-][\s\x1c-\x1f]*(.+)\n?\z"
);

/// Remove trailing hard breaks: Python `re.sub(r"(?:\\\n)+$", "", s)`, where `$` also
/// matches before a final newline.
fn strip_trailing_breaks(s: &str) -> &str {
    let mut t = s;
    if !t.ends_with("\\\n") {
        match t.strip_suffix('\n') {
            Some(x) if x.ends_with("\\\n") => t = x,
            _ => return s,
        }
    }
    while let Some(x) = t.strip_suffix("\\\n") {
        t = x;
    }
    t
}

/// Djot paragraphs of one `<text>` language variant, with each paragraph's CSS.
pub(crate) fn paragraphs(text_el: Node<'_, '_>, im: &mut InlineMath) -> Vec<(String, Css)> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let ns = root_ns(text_el);
    let holder = text_el.children().find(|c| is_named(*c, ns, "content")).unwrap_or(text_el);
    let mut out = Vec::new();
    for p in holder.children().filter(|c| is_named(*c, ns, "p")) {
        let mut st = css(p.attribute("style"));
        if p.attribute("bold") == Some("true") {
            // 0.55-era attribute
            st.insert("font-weight".to_string(), "bold".to_string());
        }
        let djot = inline_djot(p, im);
        let mut body = djot.trim_matches(' ').to_string();
        // drop leading indentation hacks and trailing hard breaks
        let mut lead_trimmed = body.as_str();
        while let Some(rest) = lead_trimmed.strip_prefix("\\\n") {
            lead_trimmed = rest;
        }
        body = py_strip(strip_trailing_breaks(lead_trimmed)).to_string();
        if let Some(re) = cached(&RE, r"\n +") {
            body = re.replace_all(&body, "\n").into_owned();
        }
        if is_style(&st, "font-weight", "bold") && !body.is_empty() && !body.starts_with('*') {
            let mut bold = Css::new();
            bold.insert("font-weight".to_string(), "bold".to_string());
            body = wrap_inline(&body, &bold);
        }
        out.push((body, st));
    }
    out
}

/// Python `float(a) != float(b)`; when either is not a number (Python would raise),
/// the trimmed strings are compared instead.
fn sizes_differ(a: &str, b: &str) -> bool {
    match (py_strip(a).parse::<f64>(), py_strip(b).parse::<f64>()) {
        (Ok(x), Ok(y)) => x != y,
        _ => py_strip(a) != py_strip(b),
    }
}

pub(crate) fn para_block(body: &str, st: &Css, region_font: &RegionFont) -> String {
    let mut attrs: Vec<String> = Vec::new();
    if let Some(align) = st.get("text-align").filter(|a| matches!(a.as_str(), "center" | "right" | "justify"))
    {
        attrs.push(format!(".{align}"));
    }
    let size = st.get("font-size").map(String::as_str).unwrap_or("").replace("px", "").replace("pt", "");
    if !size.is_empty() && !region_font.size.is_empty() && sizes_differ(&size, &region_font.size) {
        let shown =
            if size.contains('.') { size.trim_end_matches('0').trim_end_matches('.') } else { size.as_str() };
        attrs.push(format!("size={shown}"));
    }
    if let Some(fam) = st.get("font-family").filter(|f| !f.is_empty() && **f != region_font.family) {
        attrs.push(format!("font=\"{fam}\""));
    }
    let head = if attrs.is_empty() { String::new() } else { format!("{{{}}}\n", attrs.join(" ")) };
    format!("{head}{body}")
}

/// Strip Djot markup for pattern matching.
pub(crate) fn plain(djot: &str) -> String {
    static BRACES: OnceLock<Option<Regex>> = OnceLock::new();
    static ESCAPED: OnceLock<Option<Regex>> = OnceLock::new();
    let s = match cached(&BRACES, r"\{[^}]*\}") {
        Some(re) => re.replace_all(djot, "").into_owned(),
        None => djot.to_string(),
    };
    let s = match cached(&ESCAPED, r"\\(.)") {
        Some(re) => re.replace_all(&s, "$1").into_owned(),
        None => s,
    };
    let s: String = s.chars().filter(|c| !matches!(c, '*' | '_' | '[' | ']')).collect();
    py_strip(&s).to_string()
}

/// `HEADING_RE`: `(number, title)` of a plain heading, e.g. ("2.1", "Bending").
pub(crate) fn heading(plain: &str) -> Option<(String, String)> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = cached(&RE, HEADING_PATTERN)?;
    let c = re.captures(plain)?;
    Some((c.get(1)?.as_str().to_string(), c.get(2)?.as_str().to_string()))
}

/// `CAPTION_RE` (case-insensitive): `(label, number, caption)` of a plain caption,
/// e.g. ("Figure", "2", "Moments"). The groups are raw; callers strip them.
pub(crate) fn caption(plain: &str) -> Option<(String, String, String)> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    let re = cached(&RE, CAPTION_PATTERN)?;
    let c = re.captures(plain)?;
    Some((c.get(1)?.as_str().to_string(), c.get(2)?.as_str().to_string(), c.get(3)?.as_str().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    const NS_OPEN: &str = r#"<worksheet xmlns="http://smath.info/schemas/worksheet/1.0">"#;

    fn doc(body: &str) -> Result<roxmltree::Document<'_>, roxmltree::Error> {
        roxmltree::Document::parse(body)
    }

    fn wrap(inner: &str) -> String {
        format!("{NS_OPEN}{inner}</worksheet>")
    }

    fn css_of(pairs: &[(&str, &str)]) -> Css {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn esc_escapes_djot_specials() {
        assert_eq!(esc(r"a*b_c[d]{e}`f~g^h$i<j\k"), r"a\*b\_c\[d\]\{e\}\`f\~g\^h\$i\<j\\k");
        assert_eq!(esc("plain text, 1+2=3"), "plain text, 1+2=3");
        assert_eq!(esc(""), "");
    }

    #[test]
    fn css_parses_and_overwrites() {
        let st = css(Some(" Font-Weight : bold ;COLOR:Red; ; junk ;font-weight:normal"));
        assert_eq!(st, css_of(&[("color", "Red"), ("font-weight", "normal")]));
        assert!(css(None).is_empty());
        assert!(css(Some("")).is_empty());
        // only the first colon splits; value keeps the rest
        assert_eq!(
            css(Some("font-family: 'Cambria Math', serif")),
            css_of(&[("font-family", "'Cambria Math', serif")])
        );
    }

    #[test]
    fn wrap_inline_styles() {
        let bold = css_of(&[("font-weight", "bold")]);
        let italic = css_of(&[("font-style", "italic")]);
        let underline = css_of(&[("text-decoration", "underline")]);
        let strike = css_of(&[("text-decoration", "line-through")]);
        let red = css_of(&[("color", "#FF0000")]);
        let black = css_of(&[("color", "#000000")]);
        assert_eq!(wrap_inline("hi", &bold), "*hi*");
        assert_eq!(wrap_inline("hi", &italic), "_hi_");
        assert_eq!(wrap_inline("hi", &underline), "[hi]{.underline}");
        assert_eq!(wrap_inline("hi", &strike), "[hi]{.strike}");
        assert_eq!(wrap_inline("hi", &red), "[hi]{color=#ff0000}");
        assert_eq!(wrap_inline("hi", &black), "hi");
        assert_eq!(wrap_inline("hi", &css_of(&[("color", "Black")])), "hi");
        // leading and trailing spaces stay outside the markup
        assert_eq!(wrap_inline("  hi there  ", &bold), "  *hi there*  ");
        assert_eq!(wrap_inline(" x\t", &italic), " _x_\t");
        // whitespace-only text is returned as is
        assert_eq!(wrap_inline("   ", &bold), "   ");
        // combined: italic inside bold, attrs outside both
        let all =
            css_of(&[("font-weight", "bold"), ("font-style", "italic"), ("text-decoration", "underline")]);
        assert_eq!(wrap_inline(" a ", &all), " [*_a_*]{.underline} ");
    }

    #[test]
    fn ws_rules() {
        assert_eq!(ws(None), "");
        assert_eq!(ws(Some("")), "");
        assert_eq!(ws(Some("\n    \n\t")), "");
        assert_eq!(ws(Some("   ")), "   ");
        assert_eq!(ws(Some("a\n   b")), "a b");
        assert_eq!(ws(Some("a  \n\n  b")), "a b");
        assert_eq!(ws(Some("  x \n")), "  x ");
        assert_eq!(ws(Some("a\u{1c}\nb")), "a b");
    }

    #[test]
    fn esc_text_replaces_known_regions_only() -> TestResult {
        let mut im = InlineMath::default();
        im.map.insert("r1".to_string(), "$`x^2`".to_string());
        let s = r"a*b \[REGION[r1]]\ c \[REGION[zz]]\ d";
        // an unknown region id is dropped, as in Python (nothing is appended)
        assert_eq!(esc_text(s, &mut im), r"a\*b $`x^2` c  d");
        assert_eq!(im.order, vec!["r1".to_string()]);
        Ok(())
    }

    #[test]
    fn esc_text_region_marker_text() {
        let mut im = InlineMath::default();
        im.map.insert("r9".to_string(), "M".to_string());
        assert_eq!(esc_text(r"\[REGION[r9]]\", &mut im), "M");
        assert_eq!(esc_text(r"\[REGION[r9]]\\[REGION[r9]]\", &mut im), "MM");
        assert_eq!(im.order.len(), 3);
        // a marker with an unknown id is dropped, as in Python
        let mut empty = InlineMath::default();
        assert_eq!(esc_text(r"\[REGION[q]]\", &mut empty), "");
        assert!(empty.order.is_empty());
    }

    #[test]
    fn inline_djot_handles_text_tail_br_and_span() -> TestResult {
        let xml = wrap(
            "<p>Hello <span style=\"font-weight:bold\">big</span> world<br/>next *x*\n  <span style=\"font-style: italic\">it</span>tail</p>",
        );
        let d = doc(&xml)?;
        let p = d.descendants().find(|n| n.has_tag_name("p")).ok_or("no p")?;
        let mut im = InlineMath::default();
        assert_eq!(inline_djot(p, &mut im), "Hello *big* world\\\nnext \\*x\\* _it_tail");
        Ok(())
    }

    #[test]
    fn inline_djot_joins_text_around_comments() -> TestResult {
        let xml = wrap("<p>a<!-- note -->b<br/>c<!--x-->d</p>");
        let d = doc(&xml)?;
        let p = d.descendants().find(|n| n.has_tag_name("p")).ok_or("no p")?;
        let mut im = InlineMath::default();
        assert_eq!(inline_djot(p, &mut im), "ab\\\ncd");
        Ok(())
    }

    /// 1,000 nested spans need no deep stack in this module: rendering runs on a 256 KiB
    /// thread, the first `MAX_DEPTH` levels keep their formatting and the rest is flattened
    /// text. roxmltree's own parser recurses per element (`convert` refuses such input
    /// before parsing), so here parsing runs on a separate, larger thread.
    #[test]
    fn inline_djot_deep_spans_fit_small_stack() -> TestResult {
        const DEPTH: usize = 1_000;
        let bold = "<span style=\"font-weight:bold\">";
        let deep_xml = wrap(&format!("<p>{}x{}</p>", bold.repeat(DEPTH), "</span>".repeat(DEPTH)));
        let shallow_xml = wrap(
            "<p>a<span style=\"font-weight:bold\">b<span style=\"font-style:italic\">c</span></span>d</p>",
        );
        let (deep_out, shallow_out) = std::thread::scope(|s| -> Result<(String, String), String> {
            let parse_deep = std::thread::Builder::new()
                .stack_size(64 * 1024 * 1024)
                .spawn_scoped(s, || roxmltree::Document::parse(&deep_xml).map_err(|e| e.to_string()))
                .map_err(|e| e.to_string())?;
            let parse_shallow = std::thread::Builder::new()
                .stack_size(64 * 1024 * 1024)
                .spawn_scoped(s, || roxmltree::Document::parse(&shallow_xml).map_err(|e| e.to_string()))
                .map_err(|e| e.to_string())?;
            let deep_doc = parse_deep.join().map_err(|_| "parse thread panicked".to_string())??;
            let shallow_doc = parse_shallow.join().map_err(|_| "parse thread panicked".to_string())??;
            let render = std::thread::Builder::new()
                .stack_size(256 * 1024)
                .spawn_scoped(s, move || {
                    let render_one = |d: &roxmltree::Document<'_>| -> Result<String, String> {
                        let p = d.descendants().find(|n| n.has_tag_name("p")).ok_or("no p")?;
                        Ok(inline_djot(p, &mut InlineMath::default()))
                    };
                    Ok::<_, String>((render_one(&deep_doc)?, render_one(&shallow_doc)?))
                })
                .map_err(|e| e.to_string())?;
            render.join().map_err(|_| "render thread panicked".to_string())?
        })?;
        // exactly MAX_DEPTH (64) spans wrap the text; the deeper subtree is flattened
        let expected = format!("{}x{}", "*".repeat(MAX_DEPTH), "*".repeat(MAX_DEPTH));
        assert_eq!(deep_out, expected);
        // formatting below the cap is kept
        assert_eq!(shallow_out, "a*b_c_*d");
        Ok(())
    }

    #[test]
    fn paragraphs_bold_attribute_alignment_and_breaks() -> TestResult {
        let xml = wrap(
            r#"<text><content>
              <p style="text-align: center">  Title  </p>
              <p bold="true">Heavy</p>
              <p style="font-weight:bold">*Already*</p>
              <p>line one<br/><br/></p>
              <p><br/>lead<br/></p>
            </content></text>"#,
        );
        let d = doc(&xml)?;
        let text = d.descendants().find(|n| n.has_tag_name("text")).ok_or("no text")?;
        let mut im = InlineMath::default();
        let got = paragraphs(text, &mut im);
        let bodies: Vec<&str> = got.iter().map(|(b, _)| b.as_str()).collect();
        // a body already starting with `*` is not wrapped again; its text is escaped
        assert_eq!(bodies, vec!["Title", "*Heavy*", "*\\*Already\\**", "line one", "lead"]);
        assert_eq!(got.first().map(|(_, st)| st.clone()), Some(css_of(&[("text-align", "center")])));
        assert_eq!(got.get(1).map(|(_, st)| st.clone()), Some(css_of(&[("font-weight", "bold")])));
        Ok(())
    }

    #[test]
    fn paragraphs_uses_text_element_without_content_child() -> TestResult {
        let xml = wrap("<text><p>one</p><div><p>nested, ignored</p></div><p>two</p></text>");
        let d = doc(&xml)?;
        let text = d.descendants().find(|n| n.has_tag_name("text")).ok_or("no text")?;
        let mut im = InlineMath::default();
        let bodies: Vec<String> = paragraphs(text, &mut im).into_iter().map(|(b, _)| b).collect();
        assert_eq!(bodies, vec!["one".to_string(), "two".to_string()]);
        Ok(())
    }

    #[test]
    fn paragraphs_in_no_namespace_document() -> TestResult {
        let d = doc("<worksheet><text><content><p>plain</p></content></text></worksheet>")?;
        let text = d.descendants().find(|n| n.has_tag_name("text")).ok_or("no text")?;
        let mut im = InlineMath::default();
        let got = paragraphs(text, &mut im);
        assert_eq!(got.len(), 1);
        assert_eq!(got.first().map(|(b, _)| b.as_str()), Some("plain"));
        Ok(())
    }

    #[test]
    fn para_block_alignment_size_and_font() {
        let region = RegionFont { family: "Cambria Math".to_string(), size: "10".to_string() };
        let st = css_of(&[("text-align", "justify"), ("font-size", "12.50px"), ("font-family", "Arial")]);
        assert_eq!(para_block("body", &st, &region), "{.justify size=12.5 font=\"Arial\"}\nbody");
        // same size and family as the region: no attributes
        let same = css_of(&[("font-size", "10pt"), ("font-family", "Cambria Math")]);
        assert_eq!(para_block("body", &same, &region), "body");
        // size with no fractional part keeps its text; left alignment adds nothing
        let whole = css_of(&[("text-align", "left"), ("font-size", "14")]);
        assert_eq!(para_block("b", &whole, &region), "{size=14}\nb");
        // "10.0" equals "10" numerically
        let eq = css_of(&[("font-size", "10.0")]);
        assert_eq!(para_block("b", &eq, &region), "b");
        // no region size: no size attribute
        let no_size = RegionFont { family: String::new(), size: String::new() };
        assert_eq!(para_block("b", &css_of(&[("font-size", "9")]), &no_size), "b");
    }

    #[test]
    fn para_block_non_numeric_sizes_compare_as_strings() {
        let region = RegionFont { family: String::new(), size: "10".to_string() };
        let st = css_of(&[("font-size", "big")]);
        assert_eq!(para_block("b", &st, &region), "{size=big}\nb");
        let same = RegionFont { family: String::new(), size: "big".to_string() };
        assert_eq!(para_block("b", &st, &same), "b");
    }

    #[test]
    fn plain_strips_markup() {
        assert_eq!(plain("*2.1* Bending {.center}"), "2.1 Bending");
        assert_eq!(plain(r"a\*b\_c \[x\]"), "abc x");
        assert_eq!(plain("  _Figure_ 1 - x  "), "Figure 1 - x");
        assert_eq!(plain("[*bold*]{color=red}"), "bold");
    }

    #[test]
    fn heading_matches() {
        assert_eq!(heading("2.1 Bending"), Some(("2.1".to_string(), "Bending".to_string())));
        assert_eq!(heading("3. Loads"), Some(("3".to_string(), "Loads".to_string())));
        assert_eq!(heading("*4.2.1*  Deep"), Some(("4.2.1".to_string(), "Deep".to_string())));
        assert_eq!(heading("1.2.3 x\n"), Some(("1.2.3".to_string(), "x".to_string())));
    }

    #[test]
    fn heading_non_matches() {
        assert_eq!(heading("Bending"), None);
        assert_eq!(heading("2.1"), None);
        assert_eq!(heading("2.1Bending"), None);
        assert_eq!(heading(" 2.1 Bending"), None);
        assert_eq!(heading("2. "), None);
    }

    #[test]
    fn caption_matches() {
        assert_eq!(
            caption("Figure 2 - Moments"),
            Some(("Figure".to_string(), "2".to_string(), "Moments".to_string()))
        );
        assert_eq!(
            caption("tabela 3 — Cargas"),
            Some(("tabela".to_string(), "3".to_string(), "Cargas".to_string()))
        );
        assert_eq!(
            caption("GRÁFICO 10 – x"),
            Some(("GRÁFICO".to_string(), "10".to_string(), "x".to_string()))
        );
        assert_eq!(caption("Fig. 1-  a b"), Some(("Fig.".to_string(), "1".to_string(), "a b".to_string())));
        assert_eq!(caption("Chart 4 - z"), Some(("Chart".to_string(), "4".to_string(), "z".to_string())));
    }

    #[test]
    fn caption_non_matches() {
        assert_eq!(caption("Figure 2"), None);
        assert_eq!(caption("Figure two - x"), None);
        assert_eq!(caption("Figura2 -"), None);
        assert_eq!(caption("Picture 2 - x"), None);
        // `\s*` backtracks, so a lone space is the caption text (as in Python)
        assert_eq!(caption("Figure 2 - "), Some(("Figure".to_string(), "2".to_string(), " ".to_string())));
        assert_eq!(caption("Figure 2 -"), None);
        assert_eq!(caption("xFigure 2 - y"), None);
    }
}
