//! Image assets: content-addressed files inside a bundle (`assets/<sha256:16>.<ext>`).
//! Images added to a document are staged in memory until it is saved, because an
//! unsaved document has no bundle directory yet.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

use crate::{Result, ServiceError};

static STAGED: Mutex<BTreeMap<String, Vec<u8>>> = Mutex::new(BTreeMap::new());

pub(crate) const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("webp", "image/webp"),
];

const MAX_IMAGE_BYTES: usize = 50 << 20;

pub(crate) fn mime(src: &str) -> Option<&'static str> {
    let ext = src.rsplit('.').next()?.to_ascii_lowercase();
    IMAGE_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// Stage image bytes; returns the asset path to reference from the document.
pub fn stage(bytes: Vec<u8>, ext: &str) -> Result<String> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let ext = if ext == "jpeg" { "jpg".to_string() } else { ext };
    if mime(&format!("x.{ext}")).is_none() {
        return Err(ServiceError(format!("unsupported image type .{ext} (use PNG, JPEG, GIF, SVG or WebP)")));
    }
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(ServiceError("the image is empty or larger than 50 MB".into()));
    }
    let hash = Sha256::digest(&bytes);
    let name =
        format!("assets/{}.{ext}", hash.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>());
    STAGED.lock().expect("asset staging lock").insert(name.clone(), bytes);
    Ok(name)
}

/// Stage an asset under the name it already has inside a bundle (a `.quirez` opened in memory).
pub(crate) fn stage_named(name: &str, bytes: Vec<u8>) -> Result<()> {
    crate::checked_asset(name)?;
    STAGED.lock().expect("asset staging lock").insert(name.to_string(), bytes);
    Ok(())
}

pub fn stage_file(path: &Path) -> Result<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_string();
    stage(std::fs::read(path)?, &ext)
}

pub fn stage_base64(data: &str, ext: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| ServiceError(format!("invalid image data: {e}")))?;
    stage(bytes, ext)
}

pub(crate) fn staged(src: &str) -> Option<Vec<u8>> {
    STAGED.lock().expect("asset staging lock").get(src).cloned()
}

/// Every asset path the document references (images, page backgrounds, legacy blobs).
pub(crate) fn referenced(doc: &Json) -> BTreeSet<String> {
    fn walk(v: &Json, out: &mut BTreeSet<String>) {
        match v {
            Json::Object(m) => {
                for (k, x) in m {
                    match (k.as_str(), x) {
                        ("src", Json::String(s)) if s.starts_with("assets/") => {
                            out.insert(s.clone());
                        }
                        _ => walk(x, out),
                    }
                }
            }
            Json::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = BTreeSet::new();
    walk(doc, &mut out);
    out
}

/// Make sure every referenced asset exists in `dir`: write staged ones and copy
/// the rest from the bundle the document was opened from (Save As).
pub(crate) fn write_into(dir: &Path, doc: &Json, from: Option<&Path>) -> Result<()> {
    for src in referenced(doc) {
        let target = dir.join(&src);
        if target.exists() || crate::checked_asset(&src).is_err() {
            continue;
        }
        std::fs::create_dir_all(target.parent().expect("assets/ has a parent"))?;
        if let Some(bytes) = staged(&src) {
            std::fs::write(&target, bytes)?;
        } else if let Some(old) = from.map(|f| f.join(&src)).filter(|p| p.exists()) {
            std::fs::copy(old, &target)?;
        }
    }
    Ok(())
}
