//! Djot → HTML for text regions. Documents are untrusted input, so raw HTML
//! passthrough is dropped and only http(s)/mailto/fragment links survive.

use std::borrow::Cow;

use jotdown::{Container, Event};

/// Earlier versions wrote text colours unquoted (`[x]{color=#c00}`), which Djot does not
/// accept as an attribute value; quote them so those documents keep their colours.
fn quote_colors(src: &str) -> Cow<'_, str> {
    if !src.contains("color=#") {
        return Cow::Borrowed(src);
    }
    let mut out = String::with_capacity(src.len() + 8);
    let mut rest = src;
    while let Some(i) = rest.find("color=#") {
        // `i + 6` is the '#', an ASCII byte, so this split is always on a character boundary
        let Some((head, value)) = rest.split_at_checked(i + 6) else { break };
        let bytes = value.as_bytes();
        let hex = bytes.iter().skip(1).take_while(|b| b.is_ascii_hexdigit()).count();
        let ends = matches!(bytes.get(1 + hex), Some(b' ' | b'}'));
        out.push_str(head);
        match value.split_at_checked(1 + hex) {
            Some((color, tail)) if (3..=8).contains(&hex) && ends => {
                out.push('"');
                out.push_str(color);
                out.push('"');
                rest = tail;
            }
            _ => rest = value,
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn safe_link(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with('#')
}

/// Inline math in a text region (`` $`expr` ``), in reading order. These are live:
/// they are evaluated with the worksheet as `<region id>:m<n>`.
pub fn inline_math(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for e in jotdown::Parser::new(&quote_colors(src)) {
        match e {
            Event::Start(Container::Math { .. }, _) => current = Some(String::new()),
            Event::End(Container::Math { .. }) => out.extend(current.take()),
            Event::Str(s) => {
                if let Some(c) = current.as_mut() {
                    c.push_str(&s);
                }
            }
            _ => {}
        }
    }
    out
}

pub fn render_djot(src: &str) -> String {
    render(src, None)
}

/// HTML for the rich-text editor: inline math keeps its source as
/// `<span class="qmath" data-expr="…">` so the editor can show and edit it.
pub fn render_djot_editable(src: &str) -> String {
    let exprs = inline_math(src);
    let html = render(src, Some(""));
    let mut out = String::with_capacity(html.len());
    let mut rest = html.as_str();
    let marker = "<span class=\"qmath\" data-math=\":m";
    while let Some((head, after)) = rest.split_once(marker) {
        out.push_str(head);
        let end = after.find('"').unwrap_or(0);
        let n: usize = after.get(..end).and_then(|d| d.parse().ok()).unwrap_or(0);
        let expr = exprs.get(n).map(String::as_str).unwrap_or_default();
        let escaped =
            expr.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");
        out.push_str(&format!("<span class=\"qmath\" data-expr=\"{escaped}\""));
        rest = after.get(end + 1..).unwrap_or_default();
    }
    out.push_str(rest);
    out
}

/// Like [`render_djot`], but inline math becomes `<span class="qmath" data-math="<id>:m<n>">`
/// placeholders that the editor fills with the evaluated, typeset expression.
pub fn render_djot_with_math(src: &str, region_id: &str) -> String {
    render(src, Some(region_id))
}

fn render(src: &str, math_prefix: Option<&str>) -> String {
    let cleaned;
    let src = if src.contains('\u{0}') {
        cleaned = src.replace('\u{0}', "");
        cleaned.as_str()
    } else {
        src
    };
    let src = quote_colors(src);
    let mut raw_depth = 0usize;
    let mut math_index = 0usize;
    let mut in_math = false;
    let events = jotdown::Parser::new(&src).filter_map(|e| {
        match &e {
            Event::Start(Container::RawBlock { .. } | Container::RawInline { .. }, _) => {
                raw_depth += 1;
                return None;
            }
            Event::End(Container::RawBlock { .. } | Container::RawInline { .. }) => {
                raw_depth -= 1;
                return None;
            }
            _ if raw_depth > 0 => return None,
            Event::Start(Container::Math { .. }, _) if math_prefix.is_some() => {
                // a sentinel survives HTML escaping; it is swapped for the placeholder below
                in_math = true;
                let sentinel = format!("\u{0}{math_index}\u{0}");
                math_index += 1;
                return Some(Event::Str(sentinel.into()));
            }
            Event::End(Container::Math { .. }) if math_prefix.is_some() => {
                in_math = false;
                return None;
            }
            Event::Str(_) if in_math => return None,
            Event::Start(Container::Link(url, ty), attrs) if !safe_link(url) => {
                return Some(Event::Start(Container::Link("#".into(), *ty), attrs.clone()));
            }
            Event::End(Container::Link(url, ty)) if !safe_link(url) => {
                return Some(Event::End(Container::Link("#".into(), *ty)));
            }
            _ => {}
        }
        Some(e)
    });
    let html = jotdown::html::render_to_string(events);
    match math_prefix {
        Some(id) => replace_sentinels(&html, id),
        None => html,
    }
}

fn replace_sentinels(html: &str, id: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut parts = html.split('\u{0}');
    out.push_str(parts.next().unwrap_or_default());
    while let (Some(n), Some(rest)) = (parts.next(), parts.next()) {
        out.push_str(&format!("<span class=\"qmath\" data-math=\"{id}:m{n}\"></span>"));
        out.push_str(rest);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::render_djot;

    #[test]
    fn formatting() {
        assert_eq!(render_djot("*bold* and _it_"), "<p><strong>bold</strong> and <em>it</em></p>\n");
        assert!(render_djot("[Carga:]{.underline} x").contains("<span class=\"underline\">Carga:</span>"));
        assert!(render_djot("{.center}\nTítulo").contains("<p class=\"center\">Título</p>"));
        assert_eq!(
            render_djot("# Assumptions"),
            "<section id=\"Assumptions\">\n<h1>Assumptions</h1>\n</section>\n"
        );
    }

    #[test]
    fn colours_quoted_or_not() {
        let want = "<p><span color=\"#c00\" size=\"9\">red</span></p>\n";
        assert_eq!(render_djot("[red]{color=\"#c00\" size=9}"), want);
        assert_eq!(render_djot("[red]{color=#c00 size=9}"), want);
        assert!(render_djot("[u]{.underline color=#1a2b3c}").contains("color=\"#1a2b3c\""));
        assert_eq!(render_djot("a color=#zz b"), "<p>a color=#zz b</p>\n");
    }

    #[test]
    fn cross_references_are_empty_fragment_links() {
        assert_eq!(render_djot("See [](#ref:b12b)."), "<p>See <a href=\"#ref:b12b\"></a>.</p>\n");
        assert_eq!(
            render_djot("on [](#ref:t1){.page}"),
            "<p>on <a href=\"#ref:t1\" class=\"page\"></a></p>\n"
        );
    }

    #[test]
    fn inline_math_becomes_live_placeholders() {
        let src = "*$`C := 5.1 'm`  X $`L := 2 'm =`*";
        assert_eq!(super::inline_math(src), ["C := 5.1 'm", "L := 2 'm ="]);
        let h = super::render_djot_with_math(src, "abc");
        assert!(h.contains(r#"<span class="qmath" data-math="abc:m0"></span>  X <span class="qmath" data-math="abc:m1"></span>"#), "{h}");
    }

    #[test]
    fn editable_html_keeps_inline_math_source() {
        let h = super::render_djot_editable("Area $`A := 2 m*3 m =` ok");
        assert!(h.contains(r#"<span class="qmath" data-expr="A := 2 m*3 m ="></span>"#), "{h}");
    }

    #[test]
    fn untrusted_content_is_neutralized() {
        let h = render_djot(
            "`<script>alert(1)</script>`{=html} ok\n\n```=html\n<img src=x onerror=alert(1)>\n```\n",
        );
        assert!(!h.contains("script") && !h.contains("onerror"), "{h}");
        assert!(h.contains("ok"));
        let l = render_djot("[x](javascript:alert(1))");
        assert!(!l.contains("javascript"), "{l}");
        assert!(render_djot("<b>hi</b>").contains("&lt;b&gt;"));
    }
}
