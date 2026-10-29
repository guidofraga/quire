//! `.quirez`: the same bundle tree in one ZIP file, for email and messaging (§2).
//! JSON is deflated; images are stored as they are, since they are compressed already.

use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
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
            let rel = path.strip_prefix(base).map_err(std::io::Error::other)?;
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

/// Write the bundle directory `dir` as the single file `path` (replaced atomically).
pub fn pack(dir: &Path, path: &Path) -> Result<(), DocError> {
    let mut names = Vec::new();
    files(dir, dir, &mut names).map_err(|e| err(dir, e))?;
    let mut entries = Vec::with_capacity(names.len());
    for rel in names {
        let name = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let bytes = std::fs::read(dir.join(&rel)).map_err(|e| err(&dir.join(&rel), e))?;
        entries.push((name, bytes));
    }
    let tmp = path.with_extension(format!("{SINGLE_FILE_EXT}.tmp"));
    {
        let file = File::create(&tmp).map_err(|e| err(&tmp, e))?;
        write_zip(file, entries).map_err(|e| err(path, e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| err(path, e))
}

/// Every file of a `.quirez` held in memory, as `(name, bytes)`: the browser has no files.
pub fn read_bytes(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, DocError> {
    let fail = |e: &dyn std::fmt::Display| DocError(format!("not a Quire document: {e}"));
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|e| fail(&e))?;
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| fail(&e))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else {
            return Err(fail(&format!("unsafe entry name in entry {i}")));
        };
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data).map_err(|e| fail(&e))?;
        out.push((name, data));
    }
    Ok(out)
}

/// A `.quirez` in memory from `(name, bytes)` entries.
pub fn write_bytes(entries: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, DocError> {
    let mut out = Cursor::new(Vec::new());
    write_zip(&mut out, entries).map_err(|e| DocError(e.to_string()))?;
    Ok(out.into_inner())
}

fn write_zip<W: Write + Seek>(w: W, mut entries: Vec<(String, Vec<u8>)>) -> zip::result::ZipResult<()> {
    // document.json first, so a reader can find it without the central directory
    entries.sort_by(|a, b| (a.0 != "document.json", &a.0).cmp(&(b.0 != "document.json", &b.0)));
    let mut zip = ZipWriter::new(w);
    for (name, bytes) in entries {
        let method =
            if name.ends_with(".json") { CompressionMethod::Deflated } else { CompressionMethod::Stored };
        zip.start_file(name, SimpleFileOptions::default().compression_method(method))?;
        zip.write_all(&bytes)?;
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_in_memory_with_the_document_first() -> Result<(), Box<dyn std::error::Error>> {
        let entries = vec![
            ("assets/0123456789abcdef.png".to_string(), vec![1, 2, 3]),
            ("document.json".to_string(), b"{\"format\":1}".to_vec()),
        ];
        let bytes = write_bytes(entries)?;
        let back = read_bytes(&bytes)?;
        let [first, second] = back.as_slice() else {
            return Err(format!("expected 2 entries, found {}", back.len()).into());
        };
        assert_eq!(first, &("document.json".to_string(), b"{\"format\":1}".to_vec()));
        assert_eq!(second, &("assets/0123456789abcdef.png".to_string(), vec![1, 2, 3]));
        assert!(read_bytes(b"not a zip").err().is_some_and(|e| e.0.starts_with("not a Quire document")));
        Ok(())
    }
}
