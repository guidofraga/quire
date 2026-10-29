//! SMath text: XHTML-ish paragraphs → Djot. Mirrors `tools/sm2quire.py` (`inline_djot`,
//! `paragraphs`, `para_block`, `plain`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use roxmltree::Node as XNode;

/// CSS of a `style` attribute: property (lower case) → value.
pub type Css = BTreeMap<String, String>;

static DJOT_ESCAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([\\*_\[\]{}`~^$<])").unwrap());
/// SMath embeds math in text as `\[REGION[<id>]]\` markers.
static REGION_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\\[REGION\[([0-9A-Za-z]+)\]\]\\").unwrap());
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\n\s*").unwrap());
pub static HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*?(\d+(?:\.\d+)*)\.?\*?\s+(.+)$").unwrap());
pub static CAPTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(Figura|Figure|Fig\.|Tabela|Table|Gráfico|Chart)\s*(\d+)\s*[–—-]\s*(.+)$").unwrap()
});

pub fn esc(s: &str) -> String {
    DJOT_ESCAPE.replace_all(s, r"\$1").into_owned()
}

pub fn css(style: Option<&str>) -> Css {
    let mut out = Css::new();
    for part in style.unwrap_or("").split(';') {
        if let Some((k, v)) = part.split_once(':') {
            out.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }
    out
}

fn strip_start(s: &str) -> &str {
    s.trim_start_matches(char::is_whitespace)
}

pub fn wrap_inline(text: &str, st: &Css) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    let lead = &text[..text.len() - strip_start(text).len()];
    let trail = &text[text.trim_end().len()..];
    let mut core = text.trim().to_string();
    let mut attrs = Vec::new();
    let get = |k: &str| st.get(k).map(String::as_str).unwrap_or("");
    if get("text-decoration") == "underline" {
        attrs.push(".underline".to_string());
    }
    if get("text-decoration") == "line-through" {
        attrs.push(".strike".to_string());
    }
    let color = get("color").to_lowercase();
    if !color.is_empty() && color != "#000000" && color != "black" {
        attrs.push(format!("color={color}"));
    }
    if get("font-style") == "italic" {
        core = format!("_{core}_");
    }
    if get("font-weight") == "bold" {
        core = format!("*{core}*");
    }
    if !attrs.is_empty() {
        core = format!("[{core}]{{{}}}", attrs.join(" "));
    }
    format!("{lead}{core}{trail}")
}

/// XML pretty-print whitespace (runs containing a newline) is not content.
fn ws(s: &str) -> String {
    if s.trim().is_empty() && s.contains('\n') {
        return String::new();
    }
    WS.replace_all(s, " ").into_owned()
}

/// Inline math found in the text being converted: SMath region id → Djot inline math,
/// and the order the markers were met.
#[derive(Default)]
pub struct Inline {
    pub math: BTreeMap<String, String>,
    pub order: Vec<String>,
}

impl Inline {
    fn esc_text(&mut self, s: &str) -> String {
        let mut out = String::new();
        let mut pos = 0;
        for m in REGION_MARKER.captures_iter(s) {
            let whole = m.get(0).unwrap();
            out.push_str(&esc(&s[pos..whole.start()]));
            let id = &m[1];
            if let Some(math) = self.math.get(id) {
                out.push_str(math);
                self.order.push(id.to_string());
            }
            pos = whole.end();
        }
        out.push_str(&esc(&s[pos..]));
        out
    }

    /// The children of a `<p>`/`<span>` as Djot inline text.
    fn inline_djot(&mut self, el: XNode) -> String {
        let mut parts = String::new();
        for c in el.children() {
            if c.is_text() {
                parts.push_str(&self.esc_text(&ws(c.text().unwrap_or(""))));
            } else if c.is_element() {
                match c.tag_name().name() {
                    "br" => parts.push_str("\\\n"),
                    "span" => {
                        let inner = self.inline_djot(c);
                        parts.push_str(&wrap_inline(&inner, &css(c.attribute("style"))));
                    }
                    _ => {
                        let inner = self.inline_djot(c);
                        parts.push_str(&inner);
                    }
                }
            }
        }
        parts
    }

    /// One `<text>` (or `<title>`, `<description>`) → (Djot paragraph, its CSS) per `<p>`.
    pub fn paragraphs(&mut self, text_el: XNode) -> Vec<(String, Css)> {
        static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\\\n)+").unwrap());
        static TRAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:\\\n)+$").unwrap());
        static INDENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n +").unwrap());
        let holder = crate::child(text_el, "content").unwrap_or(text_el);
        let mut out = Vec::new();
        for p in crate::children(holder, "p") {
            let mut st = css(p.attribute("style"));
            if p.attribute("bold") == Some("true") {
                // 0.55-era attribute
                st.insert("font-weight".into(), "bold".into());
            }
            let body = self.inline_djot(p);
            let body = body.trim_matches(' ');
            // drop leading indentation hacks and trailing hard breaks
            let body = LEAD.replace(body, "");
            let body = TRAIL.replace(&body, "").trim().to_string();
            let mut body = INDENT.replace_all(&body, "\n").into_owned();
            if st.get("font-weight").map(String::as_str) == Some("bold")
                && !body.is_empty()
                && !body.starts_with('*')
            {
                let mut b = Css::new();
                b.insert("font-weight".into(), "bold".into());
                body = wrap_inline(&body, &b);
            }
            out.push((body, st));
        }
        out
    }
}

/// A paragraph with its alignment, size and font when they differ from the region's.
pub fn para_block(body: &str, st: &Css, family: &str, size: &str) -> String {
    let mut attrs = Vec::new();
    if let Some(align) = st.get("text-align")
        && matches!(align.as_str(), "center" | "right" | "justify")
    {
        attrs.push(format!(".{align}"));
    }
    let own = st.get("font-size").map(|s| s.replace("px", "").replace("pt", "")).unwrap_or_default();
    if !own.is_empty()
        && !size.is_empty()
        && let (Ok(a), Ok(b)) = (own.parse::<f64>(), size.parse::<f64>())
        && a != b
    {
        let shown =
            if own.contains('.') { own.trim_end_matches('0').trim_end_matches('.').to_string() } else { own };
        attrs.push(format!("size={shown}"));
    }
    if let Some(fam) = st.get("font-family")
        && fam != family
    {
        attrs.push(format!("font=\"{fam}\""));
    }
    if attrs.is_empty() { body.to_string() } else { format!("{{{}}}\n{body}", attrs.join(" ")) }
}

/// `&#193;`, `&amp;`… in SMath's Writer HTML.
fn unentity(s: &str) -> String {
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);").unwrap());
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            let ch = if let Some(h) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
                u32::from_str_radix(h, 16).ok().and_then(char::from_u32)
            } else if let Some(d) = e.strip_prefix('#') {
                d.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                Some(match e {
                    "amp" => '&',
                    "lt" => '<',
                    "gt" => '>',
                    "quot" => '"',
                    "apos" => '\'',
                    _ => '\u{a0}',
                })
            };
            ch.map_or(c[0].to_string(), String::from)
        })
        .into_owned()
}

/// SMath's Writer region (rich text kept as HTML: div/p paragraphs, span styles, strong…)
/// → (Djot paragraph, its CSS) per paragraph, and the region's (family, size).
pub fn writer_paragraphs(src: &str) -> (Vec<(String, Css)>, (String, String)) {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<(/?)([a-zA-Z0-9]+)([^>]*?)(/?)>").unwrap());
    static STYLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"style="([^"]*)""#).unwrap());
    let mut family = "Arial".to_string();
    let mut size = "10".to_string();
    let mut paras: Vec<(String, Css)> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut sizes: Vec<String> = Vec::new();
    let mut stack: Vec<(String, Css)> = Vec::new();
    let mut para_css = Css::new();
    let mut first_span = true;
    let style = |stack: &[(String, Css)]| {
        let mut st = Css::new();
        for (t, c) in stack {
            st.extend(c.clone());
            match t.as_str() {
                "strong" | "b" => {
                    st.insert("font-weight".into(), "bold".into());
                }
                "em" | "i" => {
                    st.insert("font-style".into(), "italic".into());
                }
                "u" => {
                    st.insert("text-decoration".into(), "underline".into());
                }
                _ => {}
            }
        }
        st
    };
    let flush =
        |cur: &mut Vec<String>, sizes: &mut Vec<String>, para_css: &Css, paras: &mut Vec<(String, Css)>| {
            let body = cur.concat().trim().to_string();
            if !body.is_empty() {
                let mut st = para_css.clone();
                // the largest size in the paragraph (the first of equals, as Python's max)
                let mut best: Option<&String> = None;
                for s in sizes.iter() {
                    let v = s.parse::<f64>().unwrap_or(0.0);
                    if best.is_none_or(|b| v > b.parse::<f64>().unwrap_or(0.0)) {
                        best = Some(s);
                    }
                }
                if let Some(b) = best {
                    st.insert("font-size".into(), b.clone());
                }
                paras.push((body, st));
            }
            cur.clear();
            sizes.clear();
        };
    let text = |t: &str, stack: &[(String, Css)], cur: &mut Vec<String>, sizes: &mut Vec<String>| {
        let t = ws(&unentity(t));
        if t.is_empty() {
            return;
        }
        let st = style(stack);
        let mut run = Css::new();
        for k in ["font-weight", "font-style", "text-decoration"] {
            if let Some(v) = st.get(k) {
                run.insert(k.into(), v.clone());
            }
        }
        let color = st.get("color").map(|c| c.to_lowercase()).unwrap_or_default();
        if !color.is_empty() && !matches!(color.as_str(), "windowtext" | "black" | "#000000") {
            run.insert("color".into(), color);
        }
        if !t.trim().is_empty() {
            let s = st
                .get("font-size")
                .map(|s| s.replace("pt", "").replace("px", "").trim().to_string())
                .unwrap_or_default();
            if !s.is_empty() {
                sizes.push(s);
            }
        }
        cur.push(wrap_inline(&esc(&t), &run));
    };
    let mut pos = 0;
    for m in TAG.captures_iter(src) {
        let whole = m.get(0).unwrap();
        text(&src[pos..whole.start()], &stack, &mut cur, &mut sizes);
        pos = whole.end();
        let (closing, name, attrs, selfclose) = (&m[1] == "/", m[2].to_lowercase(), &m[3], &m[4] == "/");
        if name == "br" {
            cur.push("\\\n".into());
            continue;
        }
        if closing {
            while let Some((t, _)) = stack.pop() {
                if t == name {
                    break;
                }
            }
            if name == "div" || name == "p" {
                flush(&mut cur, &mut sizes, &para_css, &mut paras);
            }
            continue;
        }
        let c = css(STYLE.captures(attrs).map(|s| s.get(1).unwrap().as_str()));
        if name == "span" && first_span {
            first_span = false;
            if let Some(f) = c.get("font-family") {
                family = f.trim_matches(['\'', '"']).to_string();
            }
            if let Some(s) = c.get("font-size") {
                size = s.replace("pt", "").replace("px", "").trim().to_string();
            }
        }
        if !selfclose {
            stack.push((name.clone(), c));
        }
        if name == "div" || name == "p" {
            flush(&mut cur, &mut sizes, &para_css, &mut paras);
            para_css = style(&stack).into_iter().filter(|(k, v)| k == "text-align" && v != "left").collect();
        }
    }
    text(&src[pos..], &stack, &mut cur, &mut sizes);
    flush(&mut cur, &mut sizes, &para_css, &mut paras);
    (paras, (family, size))
}

/// Djot without its markup, for pattern matching.
pub fn plain(djot: &str) -> String {
    static ATTRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{[^}]*\}").unwrap());
    static ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
    let s = ATTRS.replace_all(djot, "");
    let s = ESCAPED.replace_all(&s, "$1");
    s.replace(['*', '_', '[', ']'], "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paras(xml: &str) -> Vec<String> {
        let doc = roxmltree::Document::parse(xml).unwrap();
        Inline::default().paragraphs(doc.root_element()).into_iter().map(|(b, _)| b).collect()
    }

    #[test]
    fn paragraphs_become_djot() {
        let p = paras(
            r#"<text><p>Plain <span style="font-weight: bold">bold</span> and *star*</p>
            <p style="font-weight: bold">Title</p><p>a<br/>b<br/></p></text>"#,
        );
        assert_eq!(p, vec!["Plain *bold* and \\*star\\*", "*Title*", "a\\\nb"]);
        let mut st = Css::new();
        st.insert("text-align".into(), "center".into());
        st.insert("font-size".into(), "12".into());
        assert_eq!(para_block("x", &st, "Arial", "10"), "{.center size=12}\nx");
        assert_eq!(plain("{.center}\n*1. Title*"), "1. Title");
        assert!(CAPTION_RE.is_match("figura 2 – Vista"));
    }
}
