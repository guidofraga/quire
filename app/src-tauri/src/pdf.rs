//! Finish the PDF WebKit writes so it reads like a report, not a printout:
//!
//! - **Details**: title, authors, subject, keywords, company and language, and the title
//!   shown in the viewer's title bar instead of the file name.
//! - **Bookmarks** for the headings, numbered and nested, and page labels that match the
//!   page numbers printed in the footer.
//! - **Links** that jump within the file. WebKit keeps web links, but turns a cross-reference
//!   (`#ref:<id>`) into a link back into the app, and contents-list rows are not links at
//!   all; the page view tells us where every target landed.
//! - **Smaller photos**: WebKit stores every image as a lossless bitmap, even when the source
//!   was a JPEG, so one photo can weigh megabytes. Opaque 8-bit images that JPEG compresses
//!   to well under half their size are re-encoded; drawings, screenshots of text and
//!   anything with transparency stay lossless.
//!
//! lopdf (already here for the images) rewrites the file once, after all of these.

use std::io::Read;
use std::path::Path;

use flate2::read::ZlibDecoder;
use jpeg_encoder::{ColorType, Encoder};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary, text_string};

use crate::print::{Heading, PdfInfo, Spot};

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

/// Re-encode photo-like images in place.
fn compress_images(doc: &mut Document) {
    let ids: Vec<_> = doc.objects.keys().copied().collect();
    for id in ids {
        let Some(jpeg) =
            doc.objects.get(&id).and_then(|o| o.as_stream().ok()).and_then(|s| recompress(doc, s))
        else {
            continue;
        };
        if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
            s.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
            s.set_content(jpeg);
        }
    }
}

/// Add the details, bookmarks and links to the PDF at `path`, and shrink its photos when
/// `compress` is set.
pub fn finish(path: &Path, info: &PdfInfo, compress: bool) -> Result<(), String> {
    let mut doc = Document::load(path).map_err(|e| e.to_string())?;
    if compress {
        compress_images(&mut doc);
    }
    annotate(&mut doc, info)?;
    doc.save(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Everything but the images.
fn annotate(doc: &mut Document, info: &PdfInfo) -> Result<(), String> {
    let pages: Vec<ObjectId> = doc.page_iter().collect();
    details(doc, info)?;
    links(doc, &pages, info);
    let outline = outline(doc, &pages, &info.outline);

    // /Lang and /DisplayDocTitle need PDF 1.4; Quartz writes 1.3
    if doc.version.as_str() < "1.4" {
        doc.version = "1.4".into();
    }
    let catalog = doc.catalog_mut().map_err(|e| e.to_string())?;
    if let Some(root) = outline {
        catalog.set("Outlines", root);
        catalog.set("PageMode", "UseOutlines");
    }
    if !info.lang.trim().is_empty() {
        catalog.set("Lang", text_string(info.lang.trim()));
    }
    if !info.title.trim().is_empty() {
        catalog.set("ViewerPreferences", dictionary! { "DisplayDocTitle" => true });
    }
    if let Some(n) = info.first_page.filter(|&n| n > 1) {
        let label = dictionary! { "S" => "D", "St" => n };
        catalog.set("PageLabels", dictionary! { "Nums" => vec![0.into(), label.into()] });
    }
    Ok(())
}

/// The document information dictionary. Quartz fills in the dates and names itself as the
/// producer; the title it writes is the print job's (the file name).
fn details(doc: &mut Document, info: &PdfInfo) -> Result<(), String> {
    let id = match doc.trailer.get(b"Info").and_then(Object::as_reference) {
        Ok(id) => id,
        Err(_) => {
            let id = doc.add_object(Dictionary::new());
            doc.trailer.set("Info", id);
            id
        }
    };
    let d = doc.get_dictionary_mut(id).map_err(|e| e.to_string())?;
    for (key, value) in [
        ("Title", &info.title),
        ("Author", &info.author),
        ("Subject", &info.subject),
        ("Keywords", &info.keywords),
        // not a standard key, but Office writes it and viewers list it with the others
        ("Company", &info.company),
    ] {
        if !value.trim().is_empty() {
            d.set(key, text_string(value.trim()));
        }
    }
    d.set("Creator", text_string(&format!("Quire {}", env!("CARGO_PKG_VERSION"))));
    if !d.has(b"ModDate")
        && let Ok(created) = d.get(b"CreationDate").cloned()
    {
        d.set("ModDate", created);
    }
    Ok(())
}

/// Top of a page's paper in PDF coordinates (the media box may be inherited).
fn page_top(doc: &Document, page: ObjectId) -> f32 {
    let mut id = page;
    for _ in 0..32 {
        let Ok(d) = doc.get_dictionary(id) else { break };
        let media = d
            .get(b"MediaBox")
            .ok()
            .and_then(|o| doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_array().ok());
        if let Some(top) = media.and_then(|b| b.get(3)).and_then(|o| o.as_float().ok()) {
            return top;
        }
        match d.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => id = parent,
            Err(_) => break,
        }
    }
    842.0
}

/// An explicit destination: that page, scrolled so `at` is at the top, zoom unchanged.
fn destination(doc: &Document, pages: &[ObjectId], at: Spot) -> Option<Object> {
    let page = *pages.get(at.page)?;
    let y = page_top(doc, page) - at.top as f32;
    Some(vec![page.into(), "XYZ".into(), Object::Null, y.into(), Object::Null].into())
}

/// The region a WebKit link points at, when it is a cross-reference (`…#ref:<id>`).
fn reference_target(doc: &Document, annot: &Object) -> Option<String> {
    let (_, annot) = doc.dereference(annot).ok()?;
    let annot = annot.as_dict().ok()?;
    if annot.get(b"Subtype").and_then(Object::as_name).ok()? != b"Link" {
        return None;
    }
    let (_, action) = doc.dereference(annot.get(b"A").ok()?).ok()?;
    let action = action.as_dict().ok()?;
    if action.get(b"S").and_then(Object::as_name).ok()? != b"URI" {
        return None;
    }
    let (_, uri) = doc.dereference(action.get(b"URI").ok()?).ok()?;
    let uri = String::from_utf8_lossy(uri.as_str().ok()?).into_owned();
    uri.split_once("#ref:").map(|(_, id)| id.to_owned())
}

/// Point cross-references at their targets in this file, and add the links WebKit does not
/// make (contents-list rows).
fn links(doc: &mut Document, pages: &[ObjectId], info: &PdfInfo) {
    for (index, &page) in pages.iter().enumerate() {
        let top = page_top(doc, page);
        let (annots, array_id) = match doc.get_dictionary(page).and_then(|d| d.get(b"Annots")) {
            Ok(Object::Reference(id)) => {
                (doc.get_object(*id).and_then(Object::as_array).cloned().unwrap_or_default(), Some(*id))
            }
            Ok(Object::Array(a)) => (a.clone(), None),
            _ => (Vec::new(), None),
        };
        let mut kept = Vec::with_capacity(annots.len());
        let mut changed = false;
        for annot in annots {
            let Some(id) = reference_target(doc, &annot) else {
                kept.push(annot);
                continue;
            };
            changed = true;
            let dest = info.targets.get(&id).and_then(|at| destination(doc, pages, *at));
            match (annot, dest) {
                (Object::Reference(r), Some(dest)) => {
                    if let Ok(d) = doc.get_dictionary_mut(r) {
                        d.remove(b"A");
                        d.set("Dest", dest);
                    }
                    kept.push(Object::Reference(r));
                }
                (Object::Dictionary(mut d), Some(dest)) => {
                    d.remove(b"A");
                    d.set("Dest", dest);
                    kept.push(Object::Dictionary(d));
                }
                // what it pointed to is gone: the text reads "missing reference", unlinked
                (Object::Reference(r), None) => {
                    doc.objects.remove(&r);
                }
                _ => {}
            }
        }
        for link in info.links.iter().filter(|l| l.page == index) {
            let Some(dest) = info.targets.get(&link.to).and_then(|at| destination(doc, pages, *at)) else {
                continue;
            };
            let (x, y) = (link.left as f32, top - link.top as f32);
            let rect: Vec<Object> =
                vec![x.into(), (y - link.height as f32).into(), (x + link.width as f32).into(), y.into()];
            let annot = dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => rect,
                "Border" => vec![0.into(), 0.into(), 0.into()],
                "Dest" => dest,
            };
            kept.push(doc.add_object(annot).into());
            changed = true;
        }
        if !changed {
            continue;
        }
        match array_id {
            Some(id) => {
                doc.objects.insert(id, Object::Array(kept));
            }
            None => {
                if let Ok(d) = doc.get_dictionary_mut(page) {
                    d.set("Annots", kept);
                }
            }
        }
    }
}

/// Bookmarks for the headings, nested by level: chapters start open, so their sections
/// show, and deeper levels closed. Returns the outline root.
fn outline(doc: &mut Document, pages: &[ObjectId], headings: &[Heading]) -> Option<ObjectId> {
    let items: Vec<(&Heading, Object)> =
        headings.iter().filter_map(|h| Some((h, destination(doc, pages, h.at)?))).collect();
    if items.is_empty() {
        return None;
    }
    // a heading's parent is the closest one before it with a lower level
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); items.len()];
    let mut top = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for (i, (h, _)) in items.iter().enumerate() {
        while open.last().is_some_and(|&p| items[p].0.level >= h.level) {
            open.pop();
        }
        match open.last() {
            Some(&p) => children[p].push(i),
            None => top.push(i),
        }
        open.push(i);
    }
    let ids: Vec<ObjectId> = items.iter().map(|_| doc.new_object_id()).collect();
    let root = doc.new_object_id();
    let tree = Tree { items: &items, children: &children, ids: &ids };
    let visible = tree.write(doc, &top, root, true);
    let (Some(&top_first), Some(&top_last)) = (top.first(), top.last()) else { return None };
    let (first, last) = (*ids.get(top_first)?, *ids.get(top_last)?);
    let dict = dictionary! { "Type" => "Outlines", "First" => first, "Last" => last, "Count" => visible };
    doc.objects.insert(root, dict.into());
    Some(root)
}

struct Tree<'a> {
    items: &'a [(&'a Heading, Object)],
    children: &'a [Vec<usize>],
    ids: &'a [ObjectId],
}

impl Tree<'_> {
    /// Write the bookmarks `siblings` under `parent`, open or closed; returns how many
    /// lines they take while the parent is open.
    fn write(&self, doc: &mut Document, siblings: &[usize], parent: ObjectId, open: bool) -> i64 {
        let mut lines = 0;
        for (j, &i) in siblings.iter().enumerate() {
            let (heading, dest) = &self.items[i];
            let mut d = dictionary! {
                "Title" => text_string(heading.title.trim()),
                "Parent" => parent,
                "Dest" => dest.clone(),
            };
            if j > 0 {
                d.set("Prev", self.ids[siblings[j - 1]]);
            }
            if let Some(&next) = siblings.get(j + 1) {
                d.set("Next", self.ids[next]);
            }
            let kids = &self.children[i];
            let mut below = 0;
            if let (Some(&first), Some(&last)) = (kids.first(), kids.last()) {
                below = self.write(doc, kids, self.ids[i], false);
                d.set("First", self.ids[first]);
                d.set("Last", self.ids[last]);
                // a closed item counts its hidden lines as negative
                d.set("Count", if open { below } else { -below });
            }
            doc.objects.insert(self.ids[i], d.into());
            lines += 1 + if open { below } else { 0 };
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use lopdf::decode_text_string;

    use super::*;
    use crate::print::LinkBox;

    type TestResult<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

    const HEIGHT: f32 = 800.0;

    fn link(uri: &str) -> Dictionary {
        let action = dictionary! { "S" => "URI", "URI" => Object::string_literal(uri) };
        dictionary! { "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![10.into(), 10.into(), 50.into(), 20.into()], "A" => action }
    }

    /// Three pages as Quartz writes them: PDF 1.3, an inherited media box, an info
    /// dictionary with the job title, and WebKit's links on the first page.
    fn printed() -> Document {
        let mut doc = Document::with_version("1.3");
        let pages = doc.new_object_id();
        let annots: Vec<Object> =
            ["tauri://localhost#ref:h21", "https://example.com/en", "tauri://localhost#ref:gone"]
                .into_iter()
                .map(|u| doc.add_object(link(u)).into())
                .collect();
        let annots = doc.add_object(annots);
        let mut kids = Vec::new();
        for k in 0..3 {
            let mut page = dictionary! { "Type" => "Page", "Parent" => pages };
            if k == 0 {
                page.set("Annots", annots);
            }
            kids.push(doc.add_object(page).into());
        }
        let media: Vec<Object> = vec![0.into(), 0.into(), 600.into(), (HEIGHT as i64).into()];
        doc.objects.insert(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 3, "MediaBox" => media }.into(),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let info = dictionary! {
            "Title" => Object::string_literal("beam.quire"),
            "CreationDate" => Object::string_literal("D:20261028120000Z00'00'"),
        };
        let info = doc.add_object(info);
        doc.trailer.set("Info", info);
        doc
    }

    fn heading(title: &str, level: u8, page: usize, top: f64) -> Heading {
        Heading { title: title.into(), level, at: Spot { page, top } }
    }

    fn report() -> PdfInfo {
        PdfInfo {
            title: "Footbridge — deck check".into(),
            author: "A. Engineer, B. Checker".into(),
            keywords: "steel, footbridge".into(),
            company: "Example Ltd".into(),
            lang: "en-GB".into(),
            first_page: Some(3),
            outline: vec![
                heading("1 Loads", 1, 0, 100.0),
                heading("2 Checks", 1, 1, 50.0),
                heading("2.1 Bending", 2, 1, 300.0),
                heading("2.1.1 Elastic", 3, 1, 400.0),
                heading("2.2 Deflection", 2, 2, 60.0),
                // a heading on a page that did not print is left out
                heading("3 Lost", 1, 9, 0.0),
            ],
            targets: HashMap::from([
                ("h21".into(), Spot { page: 1, top: 300.0 }),
                ("h1".into(), Spot { page: 0, top: 100.0 }),
            ]),
            links: vec![LinkBox {
                page: 0,
                left: 72.0,
                top: 200.0,
                width: 400.0,
                height: 12.0,
                to: "h1".into(),
            }],
            ..Default::default()
        }
    }

    /// Run the post-processing and read the result back as a viewer would.
    fn finished(info: &PdfInfo) -> TestResult<Document> {
        let mut doc = printed();
        annotate(&mut doc, info)?;
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes)?;
        Ok(Document::load_mem(&bytes)?)
    }

    fn text(doc: &Document, dict: &Dictionary, key: &[u8]) -> TestResult<String> {
        let (_, o) = doc.dereference(dict.get(key)?)?;
        Ok(decode_text_string(o)?)
    }

    fn get<'a>(doc: &'a Document, dict: &Dictionary, key: &[u8]) -> TestResult<&'a Dictionary> {
        Ok(doc.get_dictionary(dict.get(key)?.as_reference()?)?)
    }

    /// (page index, y) of an explicit /XYZ destination.
    fn target(doc: &Document, dest: &Object) -> TestResult<(usize, f32)> {
        let dest = dest.as_array()?;
        let pages: Vec<ObjectId> = doc.page_iter().collect();
        let dest_page = dest.first().ok_or("an empty destination")?.as_reference()?;
        let page = pages
            .iter()
            .position(|&p| p == dest_page)
            .ok_or("the destination page is not in the document")?;
        assert_eq!(dest[1].as_name()?, b"XYZ");
        Ok((page, dest[3].as_float()?))
    }

    #[test]
    fn writes_the_document_details() -> TestResult {
        let doc = finished(&report())?;
        let info = doc.get_dictionary(doc.trailer.get(b"Info")?.as_reference()?)?;
        assert_eq!(text(&doc, info, b"Title")?, "Footbridge — deck check");
        assert_eq!(text(&doc, info, b"Author")?, "A. Engineer, B. Checker");
        assert_eq!(text(&doc, info, b"Keywords")?, "steel, footbridge");
        assert_eq!(text(&doc, info, b"Company")?, "Example Ltd");
        assert_eq!(text(&doc, info, b"Creator")?, format!("Quire {}", env!("CARGO_PKG_VERSION")));
        assert_eq!(text(&doc, info, b"ModDate")?, "D:20261028120000Z00'00'");
        assert!(!info.has(b"Subject"), "empty fields are left out");

        let catalog = doc.catalog()?;
        assert_eq!(doc.version, "1.4");
        assert_eq!(text(&doc, catalog, b"Lang")?, "en-GB");
        assert_eq!(catalog.get(b"PageMode")?.as_name()?, b"UseOutlines");
        let prefs = catalog.get(b"ViewerPreferences")?.as_dict()?;
        assert!(prefs.get(b"DisplayDocTitle")?.as_bool()?);
        let labels = catalog.get(b"PageLabels")?.as_dict()?.get(b"Nums")?.as_array()?;
        assert_eq!(labels[0].as_i64()?, 0);
        assert_eq!(labels[1].as_dict()?.get(b"St")?.as_i64()?, 3);
        Ok(())
    }

    #[test]
    fn nests_the_headings_as_bookmarks() -> TestResult {
        let doc = finished(&report())?;
        let catalog = doc.catalog()?;
        let root = get(&doc, catalog, b"Outlines")?;
        // chapters open: 1, 2, 2.1, 2.2 show; 2.1.1 is inside the closed 2.1
        assert_eq!(root.get(b"Count")?.as_i64()?, 4);

        let loads = get(&doc, root, b"First")?;
        assert_eq!(text(&doc, loads, b"Title")?, "1 Loads");
        assert_eq!(target(&doc, loads.get(b"Dest")?)?, (0, HEIGHT - 100.0));
        assert!(!loads.has(b"First") && !loads.has(b"Prev"));

        let checks = get(&doc, loads, b"Next")?;
        assert_eq!(text(&doc, checks, b"Title")?, "2 Checks");
        assert_eq!(loads.get(b"Next")?, root.get(b"Last")?, "the lost heading is not listed");
        assert!(!checks.has(b"Next"));
        assert_eq!(checks.get(b"Count")?.as_i64()?, 2);

        let bending = get(&doc, checks, b"First")?;
        assert_eq!(text(&doc, bending, b"Title")?, "2.1 Bending");
        assert_eq!(target(&doc, bending.get(b"Dest")?)?, (1, HEIGHT - 300.0));
        assert_eq!(bending.get(b"Count")?.as_i64()?, -1, "deeper levels start closed");
        assert_eq!(text(&doc, get(&doc, bending, b"First")?, b"Title")?, "2.1.1 Elastic");

        let deflection = get(&doc, bending, b"Next")?;
        assert_eq!(text(&doc, deflection, b"Title")?, "2.2 Deflection");
        assert_eq!(deflection.get(b"Parent")?, bending.get(b"Parent")?);
        assert_eq!(target(&doc, deflection.get(b"Dest")?)?.0, 2);
        Ok(())
    }

    #[test]
    fn links_jump_within_the_file() -> TestResult {
        let doc = finished(&report())?;
        let page = doc.page_iter().next().ok_or("no page")?;
        let annots = doc.get_page_annotations(page)?;
        assert_eq!(annots.len(), 3, "the reference to a deleted region is gone, the row link added");

        // the cross-reference now goes to section 2.1 instead of back into the app
        assert!(!annots[0].has(b"A"));
        assert_eq!(target(&doc, annots[0].get(b"Dest")?)?, (1, HEIGHT - 300.0));

        // web links are left as they were
        let action = annots[1].get(b"A")?;
        let (_, action) = doc.dereference(action)?;
        let uri = action.as_dict()?.get(b"URI")?.as_str()?;
        assert_eq!(uri, b"https://example.com/en");

        // the contents row: points from the top-left corner become PDF coordinates
        let row = annots[2];
        let rect: Vec<f32> = row
            .get(b"Rect")?
            .as_array()?
            .iter()
            .map(|o| o.as_float())
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(rect, vec![72.0, HEIGHT - 212.0, 472.0, HEIGHT - 200.0]);
        assert_eq!(target(&doc, row.get(b"Dest")?)?, (0, HEIGHT - 100.0));
        Ok(())
    }

    #[test]
    fn a_plain_document_gets_details_only() -> TestResult {
        let info = PdfInfo { title: "Notes".into(), ..Default::default() };
        let doc = finished(&info)?;
        let catalog = doc.catalog()?;
        assert!(!catalog.has(b"Outlines") && !catalog.has(b"PageMode") && !catalog.has(b"PageLabels"));
        assert!(!catalog.has(b"Lang"));
        // with nothing to point at, cross-references are unlinked rather than left pointing into the app
        let page = doc.page_iter().next().ok_or("no page")?;
        let annots = doc.get_page_annotations(page)?;
        assert_eq!(annots.len(), 1);
        assert!(annots[0].has(b"A"));
        Ok(())
    }

    #[test]
    fn photos_are_still_reencoded() -> TestResult {
        // a smooth picture with sensor-like noise: zlib does poorly, JPEG well
        let (w, h) = (256u16, 256u16);
        let mut seed = 7u32;
        let mut pixels = Vec::with_capacity(w as usize * h as usize * 3);
        for y in 0..h as u32 {
            for x in 0..w as u32 {
                for c in 0..3u32 {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    let noise = (seed >> 16) % 9;
                    pixels.push(((x + y * c + 40 * c) / 3 + noise) as u8);
                }
            }
        }
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut z, &pixels)?;
        let image = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => "FlateDecode",
            },
            z.finish()?,
        );
        let mut doc = printed();
        let id = doc.add_object(image);
        let path = std::env::temp_dir().join(format!("quire-pdf-test-{}.pdf", std::process::id()));
        doc.save(&path)?;
        finish(&path, &report(), true)?;
        let doc = Document::load(&path)?;
        std::fs::remove_file(&path).ok();
        let image = doc.get_object(id)?.as_stream()?;
        assert_eq!(image.dict.get(b"Filter")?.as_name()?, b"DCTDecode");
        assert!(doc.catalog()?.has(b"Outlines"));
        Ok(())
    }
}
