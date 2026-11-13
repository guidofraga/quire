//! The parts of the `.docx` package around the body: styles, numbering, settings, headers and
//! footers, relationships and content types, zipped.

use std::io::{Cursor, Write};

use serde_json::Value as Json;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::xml::{esc, twips};
use super::{BULLET_NUM, DEFAULT_FONT, HEADING_NUM, Rel, Writer};
use crate::{Result, ServiceError, localized};

pub(super) const NAMESPACES: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"";

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub(super) const REL_IMAGE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
pub(super) const REL_HYPERLINK: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const REL_HEADER: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
const REL_FOOTER: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

fn rels_xml(rels: &[Rel]) -> String {
    let mut s = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
    );
    for r in rels {
        s.push_str(&format!(
            "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"{}/>",
            r.id,
            r.kind,
            esc(&r.target),
            if r.external { " TargetMode=\"External\"" } else { "" }
        ));
    }
    s.push_str("</Relationships>");
    s
}

fn styles_xml(font: &str, size: u32) -> String {
    let font = esc(font);
    let mut s = format!(
        "{XML_DECL}<w:styles {}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"{font}\" w:hAnsi=\"{font}\" w:eastAsia=\"{font}\" w:cs=\"{font}\"/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/><w:lang w:val=\"en-GB\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"0\" w:line=\"269\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>",
        super::package::NAMESPACES
    );
    s.push_str("<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>");
    s.push_str("<w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/><w:uiPriority w:val=\"1\"/><w:semiHidden/><w:unhideWhenUsed/></w:style>");
    s.push_str("<w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>");
    s.push_str("<w:style w:type=\"numbering\" w:default=\"1\" w:styleId=\"NoList\"><w:name w:val=\"No List\"/><w:semiHidden/><w:unhideWhenUsed/></w:style>");
    for level in 1..=6 {
        s.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\"><w:name w:val=\"heading {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr></w:style>",
            level - 1
        ));
    }
    s.push_str(&format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"10\"/><w:qFormat/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val=\"{0}\"/><w:szCs w:val=\"{0}\"/></w:rPr></w:style>",
        size * 9 / 5
    ));
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Caption\"><w:name w:val=\"caption\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"35\"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:before=\"60\" w:after=\"120\"/><w:jc w:val=\"center\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\" w:cs=\"Arial\"/><w:sz w:val=\"16\"/><w:szCs w:val=\"16\"/></w:rPr></w:style>");
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"TOCHeading\"><w:name w:val=\"TOC Heading\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"39\"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after=\"80\"/></w:pPr><w:rPr><w:b/><w:bCs/></w:rPr></w:style>");
    for level in 1..=6 {
        s.push_str(&format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"TOC{level}\"><w:name w:val=\"toc {level}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"39\"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after=\"30\"/></w:pPr></w:style>"
        ));
    }
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"TableofFigures\"><w:name w:val=\"table of figures\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after=\"30\"/></w:pPr></w:style>");
    s.push_str("<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:rPr><w:color w:val=\"2F6FDF\"/><w:u w:val=\"single\"/></w:rPr></w:style>");
    s.push_str("<w:style w:type=\"table\" w:styleId=\"QuireTable\"><w:name w:val=\"Quire Table\"/><w:basedOn w:val=\"TableNormal\"/><w:uiPriority w:val=\"59\"/><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9AA3AF\"/></w:tblBorders></w:tblPr></w:style>");
    s.push_str("</w:styles>");
    s
}

fn numbering_xml(ordered: &[(&str, &str, u64)]) -> String {
    let mut s = format!("{XML_DECL}<w:numbering {NAMESPACES}>");
    // headings: 1. / 1.1. / 1.1.1., the number followed by a space, as the page shows it
    s.push_str("<w:abstractNum w:abstractNumId=\"0\"><w:multiLevelType w:val=\"multilevel\"/>");
    for l in 0..9u32 {
        let text: Vec<String> = (1..=l + 1).map(|k| format!("%{k}")).collect();
        s.push_str(&format!(
            "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:suff w:val=\"space\"/><w:lvlText w:val=\"{}.\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"0\" w:firstLine=\"0\"/></w:pPr></w:lvl>",
            text.join(".")
        ));
    }
    s.push_str("</w:abstractNum>");
    s.push_str("<w:abstractNum w:abstractNumId=\"1\"><w:multiLevelType w:val=\"hybridMultilevel\"/>");
    for l in 0..9u32 {
        let bullet = ["•", "◦", "▪"][l as usize % 3];
        s.push_str(&format!(
            "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"{bullet}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"300\"/></w:pPr></w:lvl>",
            360 * (l + 1)
        ));
    }
    s.push_str("</w:abstractNum>");
    for (i, (fmt, text, start)) in ordered.iter().enumerate() {
        s.push_str(&format!(
            "<w:abstractNum w:abstractNumId=\"{}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>",
            i + 2
        ));
        for l in 0..9u32 {
            s.push_str(&format!(
                "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"{start}\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
                text.replace('%', &format!("%{}", l + 1)),
                360 * (l + 1)
            ));
        }
        s.push_str("</w:abstractNum>");
    }
    s.push_str(&format!("<w:num w:numId=\"{HEADING_NUM}\"><w:abstractNumId w:val=\"0\"/></w:num>"));
    s.push_str(&format!("<w:num w:numId=\"{BULLET_NUM}\"><w:abstractNumId w:val=\"1\"/></w:num>"));
    for i in 0..ordered.len() {
        s.push_str(&format!(
            "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"{}\"/></w:num>",
            BULLET_NUM as usize + 1 + i,
            i + 2
        ));
    }
    s.push_str("</w:numbering>");
    s
}

fn settings_xml(even_odd: bool) -> String {
    format!(
        "{XML_DECL}<w:settings {NAMESPACES}><w:defaultTabStop w:val=\"720\"/>{}<w:characterSpacingControl w:val=\"doNotCompress\"/><w:updateFields w:val=\"true\"/><w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat><m:mathPr><m:mathFont m:val=\"Cambria Math\"/><m:brkBin m:val=\"before\"/><m:smallFrac m:val=\"0\"/><m:dispDef/><m:lMargin m:val=\"0\"/><m:rMargin m:val=\"0\"/><m:defJc m:val=\"left\"/><m:wrapIndent m:val=\"1440\"/><m:intLim m:val=\"subSup\"/><m:naryLim m:val=\"undOvr\"/></m:mathPr></w:settings>",
        if even_odd { "<w:evenAndOddHeaders/>" } else { "" }
    )
}

/// Which pages a background is on, as far as Word's three kinds of header can say.
#[derive(PartialEq)]
enum On {
    All,
    First,
    Odd,
    Even,
}

fn background_pages(spec: Option<&str>) -> Option<On> {
    match spec.unwrap_or("all").trim().to_ascii_lowercase().as_str() {
        "all" => Some(On::All),
        "1" => Some(On::First),
        "odd" => Some(On::Odd),
        "even" => Some(On::Even),
        _ => None,
    }
}

struct PartOut {
    name: String,
    xml: String,
    rels: Vec<Rel>,
}

pub(super) fn assemble(w: &mut Writer, body: String) -> Result<Vec<u8>> {
    let body_rels = w.take_rels();
    let page = w.doc.extra.get("page").cloned().unwrap_or(Json::Null);
    let header = page.get("header").filter(|h| h.is_object());
    let footer = page.get("footer").filter(|h| h.is_object());
    let first = page.get("firstPage");
    let blank_first = |band: &str| first.and_then(|f| f.get(band)).and_then(Json::as_bool) == Some(false);
    let backgrounds: Vec<(On, Json)> = page
        .get("backgrounds")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| Some((background_pages(b.get("pages").and_then(Json::as_str))?, b.clone())))
                .collect()
        })
        .unwrap_or_default();
    let has_even = |b: Option<&Json>| b.is_some_and(|b| b.get("even").is_some_and(Json::is_object));
    let even_odd = has_even(header)
        || has_even(footer)
        || backgrounds.iter().any(|(on, _)| matches!(on, On::Odd | On::Even));
    let title_pg =
        blank_first("header") || blank_first("footer") || backgrounds.iter().any(|(on, _)| *on == On::First);

    let mut parts: Vec<PartOut> = Vec::new();
    let mut refs = String::new();
    let mut doc_rels = body_rels;
    let empty = Json::Object(serde_json::Map::new());
    for (is_header, band) in [(true, header), (false, footer)] {
        let bgs = |which: &[On]| -> Vec<Json> {
            if !is_header {
                return Vec::new();
            }
            backgrounds.iter().filter(|(on, _)| which.contains(on)).map(|(_, b)| b.clone()).collect()
        };
        if band.is_none() && bgs(&[On::All, On::First, On::Odd, On::Even]).is_empty() {
            continue;
        }
        let band_json = band.unwrap_or(&empty);
        let blank = blank_first(if is_header { "header" } else { "footer" });
        let mut kinds: Vec<(&str, Option<&Json>, Vec<Json>)> =
            vec![("default", band, bgs(if even_odd { &[On::All, On::Odd] } else { &[On::All] }))];
        if even_odd {
            let even = band.and_then(|b| b.get("even")).filter(|e| e.is_object()).or(band);
            kinds.push(("even", even, bgs(&[On::All, On::Even])));
        }
        if title_pg {
            let content = if blank { None } else { band };
            let mut first_bgs = bgs(&[On::All, On::First]);
            if even_odd {
                first_bgs.extend(bgs(&[On::Odd]));
            }
            kinds.push(("first", content, first_bgs));
        }
        for (kind, content, bgs) in kinds {
            let xml = w.band_part(is_header, band_json, content, &bgs);
            let rels = w.take_rels();
            let n = parts.len() + 1;
            let (tag, rel) = if is_header { ("header", REL_HEADER) } else { ("footer", REL_FOOTER) };
            let name = format!("{tag}{n}.xml");
            let id = format!("rIdPart{n}");
            refs.push_str(&format!("<w:{tag}Reference w:type=\"{kind}\" r:id=\"{id}\"/>"));
            doc_rels.push(Rel { id, kind: rel, target: name.clone(), external: false });
            parts.push(PartOut { name, xml: format!("{XML_DECL}{xml}"), rels });
        }
    }
    let g = w.geom;
    let landscape = g.paper_w > g.paper_h;
    let start = page.get("pageNumber").and_then(|p| p.get("start")).and_then(Json::as_u64);
    let fmt = match page.get("pageNumber").and_then(|p| p.get("style")).and_then(Json::as_str) {
        Some("roman") => Some("lowerRoman"),
        Some("Roman") => Some("upperRoman"),
        _ => None,
    };
    let pg_num = if start.is_some() || fmt.is_some() {
        format!(
            "<w:pgNumType{}{}/>",
            fmt.map(|f| format!(" w:fmt=\"{f}\"")).unwrap_or_default(),
            start.map(|s| format!(" w:start=\"{s}\"")).unwrap_or_default()
        )
    } else {
        String::new()
    };
    let sect = format!(
        "<w:sectPr>{refs}<w:pgSz w:w=\"{}\" w:h=\"{}\"{}/><w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"{}\" w:footer=\"{}\" w:gutter=\"0\"/>{pg_num}<w:cols w:space=\"720\"/>{}</w:sectPr>",
        twips(g.paper_w),
        twips(g.paper_h),
        if landscape { " w:orient=\"landscape\"" } else { "" },
        twips(g.top),
        twips(g.right),
        twips(g.bottom),
        twips(g.left),
        twips(w.band_offset(true, header)),
        twips(w.band_offset(false, footer)),
        if title_pg { "<w:titlePg/>" } else { "" }
    );
    let document = format!("{XML_DECL}<w:document {NAMESPACES}><w:body>{body}{sect}</w:body></w:document>");

    let font = w
        .doc
        .extra
        .get("styles")
        .and_then(|s| s.get("body"))
        .and_then(|b| b.get("font"))
        .and_then(Json::as_str)
        .unwrap_or(DEFAULT_FONT)
        .to_string();
    doc_rels.push(Rel {
        id: "rIdStyles".into(),
        kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
        target: "styles.xml".into(),
        external: false,
    });
    doc_rels.push(Rel {
        id: "rIdNumbering".into(),
        kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
        target: "numbering.xml".into(),
        external: false,
    });
    doc_rels.push(Rel {
        id: "rIdSettings".into(),
        kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
        target: "settings.xml".into(),
        external: false,
    });

    let lang = w.lang.clone().unwrap_or_default();
    let title = w
        .doc
        .meta
        .get("title")
        .and_then(|t| localized(t, w.lang.as_deref()))
        .filter(|t| !t.trim().is_empty())
        .map_or_else(|| w.opts.file.clone(), str::to_string);
    let author = match w.doc.meta.get("authors") {
        Some(Json::Array(a)) => a.iter().filter_map(Json::as_str).collect::<Vec<_>>().join("; "),
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    let core = format!(
        "{XML_DECL}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator>{}</cp:coreProperties>",
        esc(&title),
        esc(&author),
        if lang.is_empty() { String::new() } else { format!("<dc:language>{}</dc:language>", esc(&lang)) }
    );
    let company = w.doc.meta.get("company").and_then(Json::as_str).unwrap_or_default();
    let app = format!(
        "{XML_DECL}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Quire</Application><Company>{}</Company></Properties>",
        esc(company)
    );

    let mut types = format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpg\" ContentType=\"image/jpeg\"/><Default Extension=\"gif\" ContentType=\"image/gif\"/>"
    );
    let over = |name: &str, ct: &str| {
        format!(
            "<Override PartName=\"/{name}\" ContentType=\"application/vnd.openxmlformats-officedocument.{ct}\"/>"
        )
    };
    types.push_str(&over("word/document.xml", "wordprocessingml.document.main+xml"));
    types.push_str(&over("word/styles.xml", "wordprocessingml.styles+xml"));
    types.push_str(&over("word/numbering.xml", "wordprocessingml.numbering+xml"));
    types.push_str(&over("word/settings.xml", "wordprocessingml.settings+xml"));
    for p in &parts {
        let ct = if p.name.starts_with("header") {
            "wordprocessingml.header+xml"
        } else {
            "wordprocessingml.footer+xml"
        };
        types.push_str(&over(&format!("word/{}", p.name), ct));
    }
    types.push_str("<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>");
    types.push_str(&over("docProps/app.xml", "extended-properties+xml"));
    types.push_str("</Types>");

    let package_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>"
    );

    let mut files: Vec<(String, Vec<u8>)> = vec![
        ("[Content_Types].xml".into(), types.into_bytes()),
        ("_rels/.rels".into(), package_rels.into_bytes()),
        ("docProps/core.xml".into(), core.into_bytes()),
        ("docProps/app.xml".into(), app.into_bytes()),
        ("word/document.xml".into(), document.into_bytes()),
        ("word/_rels/document.xml.rels".into(), rels_xml(&doc_rels).into_bytes()),
        ("word/styles.xml".into(), styles_xml(&font, w.body_size).into_bytes()),
        ("word/numbering.xml".into(), numbering_xml(&w.ordered).into_bytes()),
        ("word/settings.xml".into(), settings_xml(even_odd).into_bytes()),
    ];
    for p in parts {
        if !p.rels.is_empty() {
            files.push((format!("word/_rels/{}.rels", p.name), rels_xml(&p.rels).into_bytes()));
        }
        files.push((format!("word/{}", p.name), p.xml.into_bytes()));
    }
    for (name, bytes) in std::mem::take(&mut w.media) {
        files.push((format!("word/{name}"), bytes));
    }
    zip_files(files)
}

fn zip_files(files: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>> {
    let fail = |e: &dyn std::fmt::Display| ServiceError(format!("could not write the Word file: {e}"));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        // pictures are compressed already
        let method = if name.starts_with("word/media/") {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        zip.start_file(name, SimpleFileOptions::default().compression_method(method))
            .map_err(|e| fail(&e))?;
        zip.write_all(&bytes).map_err(|e| fail(&e))?;
    }
    Ok(zip.finish().map_err(|e| fail(&e))?.into_inner())
}
