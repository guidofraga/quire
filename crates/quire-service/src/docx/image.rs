//! The pictures a Word file can hold, and their pixel size (for keeping a logo's proportions).

/// `png`, `jpeg` or `gif`, by the file's first bytes; `None` for anything Word can't show as
/// it is (SVG, WebP), which the app draws to PNG first.
pub(super) fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(*b.get(at)?) << 8 | u32::from(*b.get(at + 1)?))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(be16(b, at)? << 16 | be16(b, at + 2)?)
}

/// Width and height in pixels.
pub(super) fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match kind(bytes)? {
        "png" => Some((be32(bytes, 16)?, be32(bytes, 20)?)),
        "gif" => {
            let le = |at: usize| Some(u32::from(*bytes.get(at)?) | u32::from(*bytes.get(at + 1)?) << 8);
            Some((le(6)?, le(8)?))
        }
        _ => jpeg_dimensions(bytes),
    }
}

/// A JPEG's size, from its first start-of-frame marker.
fn jpeg_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 9 < b.len() {
        if *b.get(at)? != 0xFF {
            return None;
        }
        let marker = *b.get(at + 1)?;
        let len = be16(b, at + 2)? as usize;
        // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            return Some((be16(b, at + 7)?, be16(b, at + 5)?));
        }
        at += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_size_of_png_gif_and_jpeg() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 1, 44, 0, 0, 0, 200]);
        assert_eq!(dimensions(&png), Some((300, 200)));
        assert_eq!(dimensions(b"GIF89a\x10\x00\x20\x00"), Some((16, 32)));
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 50, 0, 80, 3, 0, 0];
        assert_eq!(dimensions(&jpeg), Some((80, 50)));
        assert_eq!(kind(b"<svg"), None);
    }
}
