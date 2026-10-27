//! `.quirez`: the same bundle tree in one ZIP file, for email and messaging (§2).
//! JSON is deflated; images are stored as they are, since they are compressed already.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::DocError;

pub const SINGLE_FILE_EXT: &str = "quirez";

/// Whether `path` names a single-file document (by extension; it may not exist yet).
pub fn is_single_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(SINGLE_FILE_EXT))
}

fn err(path: &Path, e: impl std::fmt::Display) -> DocError {
    DocError(format!("{}: {e}", path.display()))
}

/// One file from inside a `.quirez`, or `None` when it isn't there.
pub fn read_entry(path: &Path, name: &str) -> Result<Option<Vec<u8>>, DocError> {
    let file = File::open(path).map_err(|e| err(path, e))?;
    let mut zip = ZipArchive::new(file).map_err(|e| err(path, e))?;
    let mut entry = match zip.by_name(name) {
        Ok(e) => e,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(err(path, e)),
    };
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).map_err(|e| err(path, e))?;
    Ok(Some(bytes))
}

/// Extract a `.quirez` into `dir` (entries that would land outside it are refused).
pub fn unpack(path: &Path, dir: &Path) -> Result<(), DocError> {
    let file = File::open(path).map_err(|e| err(path, e))?;
    let mut zip = ZipArchive::new(file).map_err(|e| err(path, e))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| err(path, e))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(err(path, format!("unsafe entry name in entry {i}")));
        };
        let target = dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| err(&target, e))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err(parent, e))?;
        }
        let mut out = File::create(&target).map_err(|e| err(&target, e))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| err(&target, e))?;
    }
    Ok(())
}

fn files(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue; // .DS_Store, temporary files
        }
        if path.is_dir() {
            files(&path, base, out)?;
        } else {
            out.push(path.strip_prefix(base).expect("walked from base").to_path_buf());
        }
    }
    Ok(())
}

/// Write the bundle directory `dir` as the single file `path` (replaced atomically).
pub fn pack(dir: &Path, path: &Path) -> Result<(), DocError> {
    let mut entries = Vec::new();
    files(dir, dir, &mut entries).map_err(|e| err(dir, e))?;
    // document.json first, so a reader can find it without the central directory
    entries.sort_by_key(|p| (p != Path::new("document.json"), p.clone()));
    let tmp = path.with_extension(format!("{SINGLE_FILE_EXT}.tmp"));
    {
        let file = File::create(&tmp).map_err(|e| err(&tmp, e))?;
        let mut zip = ZipWriter::new(file);
        for rel in &entries {
            let name =
                rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            let method =
                if name.ends_with(".json") { CompressionMethod::Deflated } else { CompressionMethod::Stored };
            zip.start_file(name, SimpleFileOptions::default().compression_method(method))
                .map_err(|e| err(path, e))?;
            let bytes = std::fs::read(dir.join(rel)).map_err(|e| err(&dir.join(rel), e))?;
            zip.write_all(&bytes).map_err(|e| err(path, e))?;
        }
        zip.finish().map_err(|e| err(path, e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| err(path, e))
}
