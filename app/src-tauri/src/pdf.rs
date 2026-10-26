//! Shrink the PDF WebKit writes: it stores every image as a lossless bitmap, even when
//! the source was a JPEG, so one photo can weigh megabytes. Opaque 8-bit images that
//! JPEG compresses to well under half their size are re-encoded; drawings, screenshots
//! of text and anything with transparency stay lossless.

use std::io::Read;
use std::path::Path;

use flate2::read::ZlibDecoder;
use jpeg_encoder::{ColorType, Encoder};
use lopdf::{Document, Object, Stream};

const QUALITY: u8 = 88;
/// Re-encode only when the JPEG is at most this fraction of the lossless stream.
const WORTH_IT: f64 = 0.5;
/// Images smaller than this are left alone.
const MIN_BYTES: usize = 32 * 1024;

fn name<'a>(dict: &'a lopdf::Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).ok().and_then(|o| o.as_name().ok())
}

/// Components of the image's colour space, when JPEG can carry it (gray or RGB).
fn components(doc: &Document, cs: &Object) -> Option<u8> {
    match cs {
        Object::Name(n) if n == b"DeviceRGB" => Some(3),
        Object::Name(n) if n == b"DeviceGray" => Some(1),
        Object::Reference(id) => components(doc, doc.get_object(*id).ok()?),
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let id = a.get(1)?.as_reference().ok()?;
            let n = doc.get_object(id).ok()?.as_stream().ok()?.dict.get(b"N").ok()?.as_i64().ok()?;
            matches!(n, 1 | 3).then_some(n as u8)
        }
        _ => None,
    }
}

fn recompress(doc: &Document, stream: &Stream) -> Option<Vec<u8>> {
    let d = &stream.dict;
    if name(d, b"Subtype") != Some(b"Image")
        || name(d, b"Filter") != Some(b"FlateDecode")
        || d.has(b"DecodeParms")
        || d.has(b"SMask")
        || d.has(b"Mask")
        || d.get(b"BitsPerComponent").ok()?.as_i64().ok()? != 8
        || stream.content.len() < MIN_BYTES
    {
        return None;
    }
    let n = components(doc, d.get(b"ColorSpace").ok()?)?;
    let w = u16::try_from(d.get(b"Width").ok()?.as_i64().ok()?).ok()?;
    let h = u16::try_from(d.get(b"Height").ok()?.as_i64().ok()?).ok()?;
    let mut pixels = Vec::new();
    ZlibDecoder::new(&stream.content[..]).read_to_end(&mut pixels).ok()?;
    if pixels.len() != w as usize * h as usize * n as usize {
        return None;
    }
    let mut jpeg = Vec::new();
    let color = if n == 3 { ColorType::Rgb } else { ColorType::Luma };
    Encoder::new(&mut jpeg, QUALITY).encode(&pixels, w, h, color).ok()?;
    ((jpeg.len() as f64) < stream.content.len() as f64 * WORTH_IT).then_some(jpeg)
}

/// Re-encode photo-like images in place. Leaves the file untouched when nothing changes.
pub fn compress_images(path: &Path) -> Result<(), String> {
    let mut doc = Document::load(path).map_err(|e| e.to_string())?;
    let mut changed = false;
    let ids: Vec<_> = doc.objects.keys().copied().collect();
    for id in ids {
        let Some(jpeg) =
            doc.objects.get(&id).and_then(|o| o.as_stream().ok()).and_then(|s| recompress(&doc, s))
        else {
            continue;
        };
        if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
            s.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            s.set_content(jpeg);
            changed = true;
        }
    }
    if changed {
        doc.save(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
