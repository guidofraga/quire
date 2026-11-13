//! Small helpers for writing WordprocessingML by hand: escaping and unit conversions.

/// Text for an XML element or a double-quoted attribute. Characters XML 1.0 forbids (control
/// characters other than tab and line breaks) are dropped, since Word refuses the whole file
/// over one of them.
pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// Layout px (1/96 in) in twentieths of a point, Word's unit for lengths on the page.
pub fn twips(px: f64) -> i64 {
    (px * 15.0).round() as i64
}

/// Layout px in English Metric Units, DrawingML's unit (914 400 to the inch).
pub fn emu(px: f64) -> i64 {
    (px * 9525.0).round() as i64
}

/// Points in half-points, Word's unit for font sizes.
pub fn half_points(pt: f64) -> u32 {
    (pt * 2.0).round().clamp(2.0, 3276.0) as u32
}

/// A length as the file format writes it (`"20mm"`, `"0.5pt"`, a bare number of px) in px.
pub fn length_px(v: Option<&serde_json::Value>, fallback: f64) -> f64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(fallback),
        Some(serde_json::Value::String(s)) => parse_length(s).unwrap_or(fallback),
        _ => fallback,
    }
}

fn parse_length(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let scale = match unit.trim() {
        "" | "px" => 1.0,
        "mm" => 96.0 / 25.4,
        "cm" => 960.0 / 25.4,
        "in" => 96.0,
        "pt" => 96.0 / 72.0,
        _ => return None,
    };
    Some(n * scale)
}

/// A CSS hex colour (`#c00`, `#1a7f37`, `#1a7f37ff`) as Word's six hex digits.
pub fn hex_color(css: &str) -> Option<String> {
    let hex = css.trim().strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let six = match hex.len() {
        3 | 4 => hex.chars().take(3).flat_map(|c| [c, c]).collect(),
        6 | 8 => hex.chars().take(6).collect::<String>(),
        _ => return None,
    };
    Some(six.to_ascii_uppercase())
}

/// A name Word accepts for a bookmark: letters, digits and `_`, at most 40 characters.
pub fn bookmark(prefix: &str, id: &str) -> String {
    let clean: String = id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let mut name = format!("{prefix}{clean}");
    name.truncate(40);
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lengths_read_as_the_file_format_writes_them() {
        assert!((length_px(Some(&json!("25.4mm")), 0.0) - 96.0).abs() < 1e-9);
        assert!((length_px(Some(&json!("72pt")), 0.0) - 96.0).abs() < 1e-9);
        assert!((length_px(Some(&json!(30)), 0.0) - 30.0).abs() < 1e-9);
        assert!((length_px(Some(&json!("wide")), 7.0) - 7.0).abs() < 1e-9);
        assert_eq!(twips(96.0), 1440);
        assert_eq!(emu(96.0), 914_400);
    }

    #[test]
    fn colours_and_text_are_written_as_word_expects() {
        assert_eq!(hex_color("#c00").as_deref(), Some("CC0000"));
        assert_eq!(hex_color("#1a7f37").as_deref(), Some("1A7F37"));
        assert_eq!(hex_color("red"), None);
        assert_eq!(esc("a < b & \"c\"\u{1}"), "a &lt; b &amp; &quot;c&quot;");
        assert_eq!(bookmark("_Ref_", "ab:c"), "_Ref_ab_c");
    }
}
