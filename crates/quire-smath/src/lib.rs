//! Import SMath Studio worksheets (`.sm`, XML) as Quire documents, so the app opens them
//! directly. A port of the reference importer `tools/sm2quire.py`: same document, same
//! region ids, same canonical JSON (docs/02-file-format.md).
//!
//! ```text
//! let imported = quire_smath::import(&std::fs::read("calc.sm")?, Path::new("calc.sm"))?;
//! quire_smath::write_bundle(&imported, Path::new("calc.quire"))?;
//! ```

mod canon;
mod math;
mod sheets;
mod text;

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;
use roxmltree::Node as XNode;
use serde_json::{Map, Value as Json, json};
use sha1::Digest;

pub use canon::dump;
use math::{Kind, expr, fmt_id, to_linear};
use text::{CAPTION_RE, Css, HEADING_RE, Inline, esc, para_block, plain};

/// A converted worksheet.
#[derive(Debug, Default)]
pub struct Imported {
    /// `document.json`.
    pub document: Json,
    /// Results SMath had saved, by region id (`results.json`): the regression oracle.
    pub results: Map<String, Json>,
    /// Images and unconverted regions: (`assets/<sha>.<ext>`, bytes).
    pub assets: Vec<(String, Vec<u8>)>,
    /// What could not be converted exactly.
    pub warnings: Vec<String>,
    /// Region kinds met, and other counts.
    pub stats: BTreeMap<String, usize>,
}

/// Child element by local name (SMath's namespace, or none in 0.55-era files).
pub(crate) fn child<'a, 'i>(el: XNode<'a, 'i>, name: &str) -> Option<XNode<'a, 'i>> {
    el.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

pub(crate) fn children<'a, 'i>(el: XNode<'a, 'i>, name: &'a str) -> impl Iterator<Item = XNode<'a, 'i>> + 'a {
    el.children().filter(move |c| c.is_element() && c.tag_name().name() == name)
}

fn attr<'a>(el: XNode<'a, '_>, name: &str) -> Option<&'a str> {
    el.attribute(name)
}

fn int(el: XNode, name: &str) -> i64 {
    el.attribute(name).and_then(|v| v.trim().parse::<f64>().ok()).map_or(0, |v| v as i64)
}

/// `10` → 10, `10.5` → 10.5 (Python's `num`).
fn num(s: &str) -> Json {
    match s.trim().parse::<f64>() {
        Ok(f) if f.fract() == 0.0 => json!(f as i64),
        Ok(f) => json!(f),
        Err(_) => json!(s),
    }
}

const LANG: &[(&str, Option<&str>)] = &[
    ("eng", Some("en")),
    ("rus", Some("ru")),
    ("por", Some("pt")),
    ("deu", Some("de")),
    ("fra", Some("fr")),
    ("spa", Some("es")),
    ("ita", Some("it")),
    ("cpp", None),
];

/// `LANG.get(lang, lang)`: a known code's short form (`None` for cpp), else the code.
fn lang_of(lang: Option<&str>) -> Option<String> {
    let l = lang?;
    match LANG.iter().find(|(k, _)| *k == l) {
        Some((_, v)) => v.map(String::from),
        None => Some(l.to_string()),
    }
}

/// Counts that remember the order keys first appeared (Python's `Counter.most_common`).
#[derive(Default)]
struct Tally<K: PartialEq>(Vec<(K, usize)>);

impl<K: PartialEq> Tally<K> {
    fn add(&mut self, k: K) {
        match self.0.iter_mut().find(|(x, _)| *x == k) {
            Some((_, n)) => *n += 1,
            None => self.0.push((k, 1)),
        }
    }
    fn most(&self) -> Option<&K> {
        let best = self.0.iter().map(|(_, n)| *n).max()?;
        self.0.iter().find(|(_, n)| *n == best).map(|(k, _)| k)
    }
}

/// `big` (big-endian bytes) divided by 7, in place.
fn div7(big: &mut [u8]) {
    let mut rem = 0u32;
    for b in big.iter_mut() {
        let cur = rem * 256 + u32::from(*b);
        *b = (cur / 7) as u8;
        rem = cur % 7;
    }
}

struct Converter<'s> {
    name: String,
    dir: Option<&'s Path>,
    source: &'s str,
    assets: Vec<(String, String, Vec<u8>)>, // (sha, name, bytes)
    results: Map<String, Json>,
    ids: HashSet<String>,
    seq: u64,
    stats: BTreeMap<String, usize>,
    warnings: Vec<String>,
    math_sizes: Tally<String>,
    text_fonts: Tally<(String, String)>,
}

impl Converter<'_> {
    fn stat(&mut self, k: &str, n: usize) {
        *self.stats.entry(k.to_string()).or_default() += n;
    }

    /// A short permanent id, derived like the Python importer's (sha1 of a sequence number
    /// and a hint), so both give the same ids.
    fn new_id(&mut self, hint: &str) -> String {
        const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
        self.seq += 1;
        let mut h: Vec<u8> = sha1::Sha1::digest(format!("{}:{hint}", self.seq).as_bytes()).to_vec();
        loop {
            let low = u32::from_be_bytes([h[16], h[17], h[18], h[19]]);
            let rid: String = (0..6).map(|i| ALPHABET[((low >> (5 * i)) & 31) as usize] as char).collect();
            if self.ids.insert(rid.clone()) {
                return rid;
            }
            div7(&mut h);
        }
    }

    fn asset(&mut self, data: Vec<u8>, ext: &str) -> String {
        let sha = format!("{:x}", sha2::Sha256::digest(&data));
        let name = format!("assets/{}.{ext}", &sha[..16]);
        if !self.assets.iter().any(|(s, ..)| *s == sha) {
            self.assets.push((sha, name.clone(), data));
        }
        name
    }

    fn run(&mut self, root: XNode) -> Json {
        let settings = child(root, "settings");
        let mut doc = Map::new();
        doc.insert("format".into(), json!("quire/1"));
        doc.insert("meta".into(), self.meta(settings));
        doc.insert("settings".into(), self.calc_settings(settings));
        let page = self.page(settings);
        doc.insert("page".into(), Json::Object(page));
        let regions_el =
            if root.tag_name().name() == "regions" { Some(root) } else { child(root, "regions") };
        let mut regions = regions_el.map(|r| self.region_list(r, (0, 0))).unwrap_or_default();
        self.attach_captions(&mut regions);
        let styles = self.styles();
        Self::strip_default_fonts(&mut regions, &styles);
        doc.insert("styles".into(), styles);
        let data = self.data_files(&regions);
        doc.insert("regions".into(), Json::Array(regions));
        if !data.is_empty() {
            doc.insert("data".into(), Json::Object(data));
        }
        if doc["page"].as_object().is_some_and(Map::is_empty) {
            doc.remove("page");
        }
        let deps = self.dependencies(settings);
        if !deps.is_empty() {
            doc.insert("requires".into(), json!(deps));
        }
        Json::Object(doc)
    }

    fn meta(&mut self, settings: Option<XNode>) -> Json {
        let mut meta = Map::new();
        let (mut authors, mut titles, mut langs): (Vec<String>, Map<String, Json>, Vec<Option<String>>) =
            (Vec::new(), Map::new(), Vec::new());
        if let Some(s) = settings {
            for m in children(s, "metadata") {
                let lang = attr(m, "lang");
                if let Some(a) = child(m, "author").and_then(|a| a.text())
                    && !authors.iter().any(|x| x == a)
                {
                    authors.push(a.to_string());
                }
                if let Some(t) = child(m, "title").and_then(|t| t.text()) {
                    let key = lang_of(lang).or(lang.map(String::from)).unwrap_or_else(|| "null".into());
                    titles.insert(key, json!(t));
                }
                langs.push(lang.map(String::from));
            }
        }
        if !titles.is_empty() {
            let t = if titles.len() == 1 {
                titles.values().next().unwrap().clone()
            } else {
                Json::Object(titles)
            };
            meta.insert("title".into(), t);
        }
        if !authors.is_empty() {
            meta.insert("authors".into(), json!(authors));
        }
        if let Some(id) = settings.and_then(|s| child(s, "identity")).and_then(|i| child(i, "id")) {
            meta.insert("id".into(), id.text().map_or(Json::Null, |t| json!(t)));
        }
        if langs.iter().any(|l| l.as_deref() == Some("por")) {
            meta.insert("lang".into(), json!("pt-BR"));
        }
        meta.insert("source".into(), json!({ "app": "SMath Studio", "file": self.name }));
        Json::Object(meta)
    }

    fn calc_settings(&mut self, settings: Option<XNode>) -> Json {
        // SMath keeps a formula that reads a name defined further down
        let mut out = Map::new();
        out.insert("calc".into(), json!({ "definitions": "smath" }));
        let Some(calc) = settings.and_then(|s| child(s, "calculation")) else { return Json::Object(out) };
        let g = |n: &str| child(calc, n).and_then(|c| c.text()).filter(|t| !t.is_empty());
        let mut c = Map::new();
        if let Some(p) = g("precision").and_then(|p| p.trim().parse::<i64>().ok()) {
            c.insert("decimals".into(), json!(p));
        }
        if let Some(p) = g("exponentialThreshold").and_then(|p| p.trim().parse::<i64>().ok()) {
            c.insert("exponentialThreshold".into(), json!(p));
        }
        if g("trailingZeros") == Some("true") {
            c.insert("trailingZeros".into(), json!(true));
        }
        if let Some(f) = g("fractions")
            && f != "decimal"
        {
            c.insert("fractions".into(), json!(f));
        }
        if let Some(p) = g("approximateEqualAccuracy").and_then(|p| p.trim().parse::<i64>().ok()) {
            c.insert("approxEqualDigits".into(), json!(p));
        }
        out.insert("display".into(), Json::Object(c));
        Json::Object(out)
    }

    fn page(&mut self, settings: Option<XNode>) -> Map<String, Json> {
        let mut page = Map::new();
        let Some(pm) = settings.and_then(|s| child(s, "pageModel")) else { return page };
        page.insert(
            "view".into(),
            json!(if attr(pm, "active") == Some("true") { "pages" } else { "canvas" }),
        );
        if let Some(paper) = child(pm, "paper") {
            let named = match int(paper, "id") {
                9 => Some("A4"),
                1 => Some("Letter"),
                5 => Some("Legal"),
                8 => Some("A3"),
                11 => Some("A5"),
                _ => None,
            };
            let p = match named {
                Some(n) => json!(n),
                None => json!([
                    format!("{:.1}mm", int(paper, "width") as f64 * 0.254),
                    format!("{:.1}mm", int(paper, "height") as f64 * 0.254)
                ]),
            };
            page.insert("paper".into(), p);
            if attr(paper, "orientation").unwrap_or("Portrait").to_lowercase() != "portrait" {
                page.insert("orientation".into(), json!("landscape"));
            }
        }
        if let Some(mg) = child(pm, "margins") {
            // Stored in hundredths of an inch, but SMath lays pages out at 72 dpi against
            // 96-px region coordinates, so the effective margin is 3/4 of the nominal one.
            let mm = |k: &str| format!("{:.1}mm", int(mg, k) as f64 * 0.254 * 0.75).replace(".0mm", "mm");
            page.insert(
                "margins".into(),
                json!({ "top": mm("top"), "right": mm("right"), "bottom": mm("bottom"), "left": mm("left") }),
            );
        }
        for which in ["header", "footer"] {
            if let Some(h) = child(pm, which)
                && h.text().is_some_and(|t| !t.trim().is_empty())
            {
                page.insert(which.into(), header_footer(h));
            }
        }
        if let Some(bgs) = child(pm, "backgrounds") {
            let mut out = Vec::new();
            for img in children(bgs, "image") {
                let raw: String = img.text().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
                let data = base64::engine::general_purpose::STANDARD.decode(raw).unwrap_or_default();
                let ext = if data.starts_with(b"\x89PNG") { "png" } else { "jpg" };
                let src = self.asset(data, ext);
                let fit = if attr(img, "fullPage") == Some("true") { "page" } else { "margins" };
                out.push(json!({ "pages": attr(img, "page").unwrap_or("all"), "src": src, "fit": fit }));
                self.stat("background", 1);
            }
            if !out.is_empty() {
                page.insert("backgrounds".into(), json!(out));
            }
        }
        page
    }

    fn dependencies(&self, settings: Option<XNode>) -> Vec<String> {
        const KNOWN: &[&str] = &["SMath Core", "MathRegion", "TextRegion", "PictureRegion", "AreaRegion"];
        let Some(deps) = settings.and_then(|s| child(s, "dependencies")) else { return Vec::new() };
        children(deps, "assembly")
            .filter(|a| !KNOWN.contains(&attr(*a, "name").unwrap_or("")))
            .map(|a| {
                format!(
                    "smath:{}@{}",
                    attr(a, "name").unwrap_or("None"),
                    attr(a, "version").unwrap_or("None")
                )
            })
            .collect()
    }

    // -- regions ------------------------------------------------------------

    fn region_list(&mut self, parent: XNode, origin: (i64, i64)) -> Vec<Json> {
        let mut out = Vec::new();
        for r in children(parent, "region") {
            out.extend(self.region(r, origin));
        }
        out.sort_by_key(|r| (r["at"][1].as_i64().unwrap_or(0), r["at"][0].as_i64().unwrap_or(0)));
        out
    }

    fn base(&mut self, r: XNode, origin: (i64, i64), kind: &str) -> Map<String, Json> {
        let x = int(r, "left") - origin.0;
        let y = int(r, "top") - origin.1;
        let hint =
            attr(r, "id").filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| format!("{x},{y}"));
        let mut reg = Map::new();
        reg.insert("id".into(), json!(self.new_id(&hint)));
        reg.insert("kind".into(), json!(kind));
        reg.insert("at".into(), json!([x, y]));
        if attr(r, "isBreakable") == Some("false") {
            reg.insert("keep".into(), json!(true));
        }
        if attr(r, "enabled") == Some("false") {
            reg.insert("disabled".into(), json!(true));
        }
        let bg = attr(r, "bgColor").unwrap_or("").to_lowercase();
        if !bg.is_empty() && !matches!(bg.as_str(), "#ffffff" | "white" | "transparent") {
            reg.insert("background".into(), json!(bg));
        }
        if attr(r, "border") == Some("true") {
            reg.insert("border".into(), json!(true));
        }
        let color = attr(r, "color").unwrap_or("#000000").to_lowercase();
        if color != "#000000" {
            reg.insert("color".into(), json!(color));
        }
        reg
    }

    fn region(&mut self, r: XNode, origin: (i64, i64)) -> Vec<Json> {
        let kids: Vec<XNode> =
            r.children().filter(|c| c.is_element() && c.tag_name().name() != "region").collect();
        let Some(&body) = kids.first() else { return Vec::new() };
        let t = body.tag_name().name().to_string();
        self.stat(&t, 1);
        let done: Result<Vec<Json>, String> = match t.as_str() {
            "math" => self.math(r, body, origin).map(|x| vec![x]),
            "text" => self.text(r, &kids, origin),
            "picture" => self.picture(r, body, origin).map(|x| vec![x]),
            "area" => Ok(self.area(r, body, origin)),
            "table" => Ok(vec![self.table(r, body, origin)]),
            "plot" => self.plot(r, body, origin).map(|x| vec![x]),
            "pagebreak" => Ok(vec![Json::Object(self.base(r, origin, "pagebreak"))]),
            "radiobuttonlist" => self.radio(r, body, origin).map(|x| vec![x]),
            "writer" => Ok(vec![self.writer(r, body, origin)]),
            "image" => self.image_plugin(r, body, origin).map(|x| vec![x]),
            "xyplot" => self.xyplot(r, body, origin).map(|x| vec![x]),
            _ => Err(String::new()),
        };
        match done {
            Ok(v) => v,
            Err(e) => {
                // never lose content: keep the original XML
                if !e.is_empty() {
                    self.warnings
                        .push(format!("region at top={}: {t}: {e}", attr(r, "top").unwrap_or("None")));
                }
                vec![self.legacy(r, &t, origin)]
            }
        }
    }

    fn legacy(&mut self, r: XNode, t: &str, origin: (i64, i64)) -> Json {
        self.stat(&format!("legacy:{t}"), 1);
        let mut reg = self.base(r, origin, "legacy");
        reg.insert("size".into(), json!([int(r, "width"), int(r, "height")]));
        let raw = self.source[r.range()].as_bytes().to_vec();
        let src = self.asset(raw, "xml");
        reg.insert("legacy".into(), json!({ "format": format!("smath:{t}"), "src": src }));
        Json::Object(reg)
    }

    fn math(&mut self, r: XNode, m: XNode, origin: (i64, i64)) -> Result<Json, String> {
        let mut reg = self.base(r, origin, "math");
        // 0.55-era files keep the tokens directly under <math>
        let ast = expr(Some(child(m, "input").unwrap_or(m)))?.ok_or("empty math")?;
        reg.insert("expr".into(), json!(to_linear(&ast, false)));
        let mut fmt = Map::new();
        let contract = expr(child(m, "contract"))?;
        if let Some(c) = &contract {
            fmt.insert("unit".into(), json!(to_linear(c, true)));
        }
        if let Some(d) = attr(m, "decimalPlaces").filter(|d| !d.is_empty()) {
            fmt.insert("decimals".into(), json!(d.trim().parse::<i64>().map_err(|e| e.to_string())?));
        }
        if let Some(result) = child(m, "result") {
            let show = if attr(result, "action") == Some("symbolic") { "symbolic" } else { "value" };
            reg.insert("show".into(), json!(show));
            if let Some(val) = expr(Some(result))? {
                let mut shown = to_linear(&val, false);
                if let Some(c) = &contract {
                    // `2.06*10^5 'mm^3` would read as 10^(5 mm³): only a plain number takes a space
                    let plain_number = !shown.is_empty()
                        && shown.trim_start_matches('-').chars().all(|ch| ch.is_ascii_digit() || ch == '.');
                    shown.push_str(if plain_number { " " } else { "*" });
                    shown.push_str(&to_linear(c, false));
                }
                self.results.insert(reg["id"].as_str().unwrap().to_string(), json!(shown));
            }
        }
        if !fmt.is_empty() {
            reg.insert("display".into(), Json::Object(fmt));
        }
        match attr(m, "optimize") {
            Some("1") => {
                reg.insert("mode".into(), json!("symbolic"));
            }
            Some("2") => {
                reg.insert("mode".into(), json!("numeric"));
            }
            _ => {}
        }
        if attr(r, "showInputData").unwrap_or("").to_lowercase() == "false" && reg.contains_key("show") {
            reg.insert("hideInput".into(), json!(true));
        }
        if let Some(desc) = child(m, "description")
            && attr(desc, "active") == Some("true")
        {
            let note: Vec<String> = Inline::default()
                .paragraphs(desc)
                .into_iter()
                .map(|(b, _)| b)
                .filter(|b| !b.is_empty())
                .collect();
            if !note.is_empty() {
                reg.insert("note".into(), json!(note.join("\n\n")));
                let pos = attr(desc, "position").unwrap_or("Right");
                if pos != "Right" {
                    reg.insert("notePosition".into(), json!(pos.to_lowercase()));
                }
            }
        }
        self.math_sizes.add(attr(r, "fontSize").unwrap_or("10").to_string());
        Ok(Json::Object(reg))
    }

    /// Spreadsheets named in importData(…) and found next to the .sm, read into the document.
    fn data_files(&mut self, regions: &[Json]) -> Map<String, Json> {
        static IMPORT: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"importData(?:\.\w+)?\("([^"]+)""#).unwrap());
        fn walk(rs: &[Json], wanted: &mut Vec<String>) {
            for r in rs {
                for m in IMPORT.captures_iter(r["expr"].as_str().unwrap_or("")) {
                    if !wanted.iter().any(|w| *w == m[1]) {
                        wanted.push(m[1].to_string());
                    }
                }
                if let Some(inner) = r["regions"].as_array() {
                    walk(inner, wanted);
                }
            }
        }
        let mut wanted = Vec::new();
        walk(regions, &mut wanted);
        let mut data = Map::new();
        if wanted.is_empty() {
            return data;
        }
        // the .sm's folder first, then up to two folders above it (a shared table)
        let start = self.dir.map(|d| if d.as_os_str().is_empty() { Path::new(".") } else { d });
        let start = start.and_then(|d| std::fs::canonicalize(d).ok());
        let folders: Vec<BTreeMap<String, std::path::PathBuf>> = start
            .iter()
            .flat_map(|d| d.ancestors().take(3))
            .map(|d| {
                std::fs::read_dir(d)
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path()))
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect();
        for name in wanted {
            let base = name.rsplit(['\\', '/']).next().unwrap_or(&name).to_string();
            let found = folders
                .iter()
                .enumerate()
                .find_map(|(up, f)| f.get(&base.to_lowercase()).map(|p| (up, p.clone())));
            let Some((up, path)) = found else {
                self.warnings
                    .push(format!("importData: {base} is not next to {}; its tables stay empty", self.name));
                continue;
            };
            if up > 0 {
                // canonicalize gives Windows' \\?\ form; show the ordinary path
                let shown = path.display().to_string();
                self.warnings
                    .push(format!("importData: {base} read from {}", shown.trim_start_matches(r"\\?\")));
            }
            let path = &path;
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let read =
                if ext == "csv" || ext == "txt" { sheets::read_csv(path) } else { sheets::read_xlsx(path) };
            match read {
                Ok(v) => {
                    data.insert(base, v);
                }
                // a damaged or old .xls file: say so, keep going
                Err(e) => self.warnings.push(format!("importData: cannot read {base}: {e}")),
            }
        }
        data
    }

    /// SMath's option list, defining the variable in <input>. output="Default": the number
    /// of the chosen option (from 1); output="Element": the chosen row's element in column
    /// outputColumn of the table named by the input attribute. The options go in the note.
    fn radio(&mut self, r: XNode, rb: XNode, origin: (i64, i64)) -> Result<Json, String> {
        let mut reg = self.base(r, origin, "math");
        let var = expr(child(rb, "input"))?
            .filter(|v| v.kind == Kind::Id)
            .ok_or("option list without a variable")?;
        let chosen = attr(rb, "selected").and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(1);
        let mut value = chosen.to_string();
        if attr(rb, "output") == Some("Element")
            && let Some(source) = attr(rb, "input").filter(|s| !s.is_empty())
        {
            let col = attr(rb, "outputColumn").and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(1);
            value = format!("{}[{chosen}, {col}]", fmt_id(source));
        }
        reg.insert("expr".into(), json!(format!("{} := {value}", to_linear(&var, false))));
        let items: Vec<String> = child(rb, "ul")
            .map(|ul| children(ul, "li").map(|li| unescape_sm(li.text().unwrap_or(""))).collect())
            .unwrap_or_default();
        // a Djot list, the chosen option in bold
        let note: Vec<String> = items
            .iter()
            .enumerate()
            .map(|(k, item)| {
                let k = k as i64 + 1;
                if k == chosen {
                    format!("- *{k} = {}* ✓", esc(item))
                } else {
                    format!("- {k} = {}", esc(item))
                }
            })
            .collect();
        reg.insert("note".into(), json!(note.join("\n")));
        Ok(Json::Object(reg))
    }

    /// SMath's Image region: the picture kept in base64 inside <imagefile>.
    fn image_plugin(&mut self, r: XNode, im: XNode, origin: (i64, i64)) -> Result<Json, String> {
        let f = child(im, "imagefile").ok_or("image without data")?;
        let b64: String = f.text().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        if b64.is_empty() {
            return Err("image without data".into());
        }
        let data = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        let mut reg = self.base(r, origin, "image");
        let from_name = attr(f, "filename")
            .and_then(|n| Path::new(n).extension())
            .map(|e| e.to_string_lossy().into_owned());
        let ext = attr(f, "renderExt")
            .filter(|e| !e.is_empty())
            .map(String::from)
            .or(from_name)
            .unwrap_or_else(|| "png".into())
            .trim_start_matches('.')
            .to_lowercase();
        let src = self.asset(data, &ext);
        reg.insert("src".into(), json!(src));
        let dim =
            |a: &str, b: &str| attr(f, a).filter(|v| !v.is_empty()).map_or_else(|| int(r, b), |_| int(f, a));
        reg.insert("size".into(), json!([dim("width", "width"), dim("height", "height")]));
        Ok(Json::Object(reg))
    }

    /// SMath's Writer region (rich text kept as HTML) → a text region.
    fn writer(&mut self, r: XNode, w: XNode, origin: (i64, i64)) -> Json {
        let mut reg = self.base(r, origin, "text");
        let html: String = w.children().filter_map(|c| c.text()).collect();
        let (paras, (family, size)) = text::writer_paragraphs(&html);
        let blocks: Vec<String> = paras
            .iter()
            .filter(|(b, _)| !b.is_empty())
            .map(|(b, st)| para_block(b, st, &family, &size))
            .collect();
        reg.insert("text".into(), json!(blocks.join("\n\n")));
        if let Some(w) = attr(r, "width").filter(|s| !s.is_empty()) {
            reg.insert("width".into(), json!(w.trim().parse::<f64>().map_or(0, |v| v as i64)));
        }
        reg.insert("font".into(), json!({ "family": family, "size": size }));
        self.text_fonts.add((family, size));
        Json::Object(reg)
    }

    /// SMath's XY plot: series from <input> (a sys(…) of point matrices or vectors), the
    /// traces' colours and styles, axis labels and limits, grid, legend and title.
    fn xyplot(&mut self, r: XNode, x: XNode, origin: (i64, i64)) -> Result<Json, String> {
        static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]+$").unwrap());
        let mut reg = self.base(r, origin, "plot2d");
        reg.insert("size".into(), json!([int(r, "width"), int(r, "height")]));
        let mut items: Vec<math::Node> = Vec::new();
        if let Some(ast) = expr(child(x, "input"))? {
            let sys = ast.kind == Kind::Call && ast.value == "sys";
            items = if sys { ast.args.clone() } else { vec![ast] };
            if sys && items.len() > 2 {
                items.truncate(items.len() - 2); // sys(..., rows, cols)
            }
        }
        let traces: Vec<XNode> =
            child(x, "traces").map(|t| children(t, "trace").collect()).unwrap_or_default();
        let mut series = Vec::new();
        for (k, item) in items.iter().enumerate() {
            let mut s = Map::new();
            s.insert("y".into(), json!(to_linear(item, false)));
            if let Some(t) = traces.get(k) {
                if let Some(name) = attr(*t, "seriesname").filter(|n| !n.is_empty()) {
                    s.insert("label".into(), json!(name));
                }
                let mut style = Map::new();
                let color = attr(*t, "linecolor").unwrap_or("").trim();
                if NAME.is_match(color) {
                    style.insert("color".into(), json!(color.to_lowercase()));
                }
                let lines = attr(*t, "plotmethod").unwrap_or("Lines") != "Points";
                let marks = attr(*t, "symboltype").unwrap_or("None") != "None" || !lines;
                let draw = if lines && marks {
                    "line+points"
                } else if marks {
                    "points"
                } else {
                    "line"
                };
                style.insert("draw".into(), json!(draw));
                let dash = match attr(*t, "linepattern").unwrap_or("") {
                    "Dash" | "DashDot" => Some("dashed"),
                    "Dot" => Some("dotted"),
                    _ => None,
                };
                if let Some(d) = dash {
                    style.insert("dash".into(), json!(d));
                }
                s.insert("style".into(), Json::Object(style));
            }
            series.push(Json::Object(s));
        }
        reg.insert("series".into(), json!(series));
        let g = child(x, "grid");
        let grid = g.is_none_or(|g| attr(g, "isxgrid") == Some("true") || attr(g, "isygrid") == Some("true"));
        reg.insert("grid".into(), json!(grid));
        let lab = child(x, "xylabel");
        let mut axes = Map::new();
        for (a, el) in [("x", child(x, "xaxes")), ("y", child(x, "yaxes"))] {
            let mut spec = Map::new();
            if let Some(l) = lab.and_then(|l| attr(l, &format!("{a}label"))).filter(|l| !l.is_empty()) {
                spec.insert("label".into(), json!(l));
            }
            if let Some(el) = el
                && let (Some(lo), Some(hi)) = (
                    attr(el, &format!("{a}min")).filter(|v| !v.is_empty()),
                    attr(el, &format!("{a}max")).filter(|v| !v.is_empty()),
                )
            {
                spec.insert("min".into(), num(lo));
                spec.insert("max".into(), num(hi));
            }
            if !spec.is_empty() {
                axes.insert(a.into(), Json::Object(spec));
            }
        }
        if !axes.is_empty() {
            reg.insert("axes".into(), Json::Object(axes));
        }
        if child(x, "legend").is_some_and(|l| attr(l, "islegendvisible") == Some("false")) {
            reg.insert("legend".into(), json!("none"));
        }
        if let Some(title) =
            child(x, "title2d").and_then(|t| attr(t, "title")).map(str::trim).filter(|t| !t.is_empty())
        {
            reg.insert("caption".into(), json!({ "text": esc(title), "position": "above" }));
        }
        Ok(Json::Object(reg))
    }

    fn text(&mut self, r: XNode, variants: &[XNode], origin: (i64, i64)) -> Result<Vec<Json>, String> {
        let mut reg = self.base(r, origin, "text");
        let texts: Vec<XNode> = variants.iter().copied().filter(|v| v.tag_name().name() == "text").collect();
        let first = *texts.first().ok_or("no text")?;
        // embedded math regions become inline math; anything else is hoisted below
        let mut inline = Inline::default();
        let mut cached = BTreeMap::new();
        for v in &texts {
            if let Some(sub) = child(*v, "regions") {
                for e in children(sub, "region") {
                    let m = child(e, "math");
                    let Some(inp) = m.and_then(|m| child(m, "input")) else { continue };
                    let (Ok(Some(ast)), Some(id)) =
                        (expr(Some(inp)), attr(e, "id").filter(|s| !s.is_empty()))
                    else {
                        continue;
                    };
                    let result = m.and_then(|m| child(m, "result"));
                    let shown = result.is_some();
                    inline.math.insert(
                        id.to_string(),
                        format!("$`{}{}`", to_linear(&ast, false), if shown { " =" } else { "" }),
                    );
                    if let Some(Ok(Some(val))) = result.map(|r| expr(Some(r))) {
                        cached.insert(id.to_string(), to_linear(&val, false));
                    }
                }
            }
        }
        let mut family = attr(first, "fontFamily").filter(|s| !s.is_empty()).unwrap_or("Arial").to_string();
        let mut size = attr(first, "fontSize")
            .filter(|s| !s.is_empty())
            .or(attr(r, "fontSize").filter(|s| !s.is_empty()))
            .unwrap_or("10")
            .to_string();
        let mut by_lang: Vec<(String, String)> = Vec::new();
        for v in &texts {
            let paras: Vec<(String, Css)> = inline.paragraphs(*v);
            // promote a uniformly-sized single paragraph's font size to the region
            let mut sizes: Vec<String> = paras
                .iter()
                .map(|p| p.1.get("font-size").cloned().unwrap_or_default().replace("px", ""))
                .filter(|s| !s.is_empty())
                .collect();
            sizes.sort();
            sizes.dedup();
            if sizes.len() == 1 {
                size = sizes.pop().unwrap();
            }
            let mut fams: Vec<String> =
                paras.iter().filter_map(|p| p.1.get("font-family").cloned()).collect();
            fams.sort();
            fams.dedup();
            if fams.len() == 1 {
                family = fams.pop().unwrap();
            }
            let blocks: Vec<String> = paras
                .iter()
                .filter(|(b, _)| !b.is_empty())
                .map(|(b, st)| para_block(b, st, &family, &size))
                .collect();
            let lang = lang_of(attr(*v, "lang")).unwrap_or_else(|| "und".into());
            let body = blocks.join("\n\n");
            match by_lang.iter_mut().find(|(l, _)| *l == lang) {
                Some(slot) => slot.1 = body,
                None => by_lang.push((lang, body)),
            }
        }
        let distinct: HashSet<&String> = by_lang.iter().map(|(_, b)| b).collect();
        let text_value = if distinct.len() <= 1 {
            json!(by_lang.first().map(|(_, b)| b.clone()).unwrap_or_default())
        } else {
            Json::Object(by_lang.iter().map(|(l, b)| (l.clone(), json!(b))).collect())
        };
        reg.insert("text".into(), text_value);
        // inline math ids follow their order in the (first) text: <region id>:m<n>
        let order: Vec<String> = inline.order[..inline.order.len() / texts.len().max(1)].to_vec();
        let rid = reg["id"].as_str().unwrap().to_string();
        for (n, src_id) in order.iter().enumerate() {
            if let Some(c) = cached.get(src_id) {
                self.results.insert(format!("{rid}:m{n}"), json!(c));
            }
        }
        self.stat("inline-math", order.len());
        if let Some(w) = attr(first, "width").filter(|s| !s.is_empty()) {
            reg.insert("width".into(), json!(w.trim().parse::<f64>().map_err(|e| e.to_string())? as i64));
        }
        reg.insert("font".into(), json!({ "family": family, "size": size }));
        self.text_fonts.add((family.clone(), size.clone()));
        // heading detection: "1. ASSUMPTIONS" / "*7. CONCLUSION*" -> auto-numbered heading
        static ATTR_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\{[^}\n]*\}\n").unwrap());
        if let Some(t) = reg["text"].as_str().map(String::from) {
            let body = ATTR_LINE.replace(&t, "").into_owned();
            if !body.contains('\n')
                && let Some(m) = HEADING_RE.captures(&plain(&body))
                && body.starts_with('*')
                && m[2].chars().count() < 80
            {
                let level = m[1].matches('.').count() + 1;
                reg.insert("text".into(), json!(format!("{} {}", "#".repeat(level), esc(m[2].trim()))));
                self.stat("heading", 1);
            }
        }
        let empty = match &reg["text"] {
            Json::String(s) => s.is_empty(),
            Json::Object(m) => m.is_empty(),
            _ => true,
        };
        let mut out = vec![Json::Object(reg)];
        // other regions embedded in text are hoisted to siblings at absolute positions
        for v in &texts {
            if let Some(sub) = child(*v, "regions") {
                let inner_origin = (origin.0 - int(r, "left"), origin.1 - int(r, "top"));
                for e in children(sub, "region") {
                    if !attr(e, "id").is_some_and(|id| inline.math.contains_key(id)) {
                        out.extend(self.region(e, inner_origin));
                        self.stat("hoisted", 1);
                    }
                }
            }
        }
        if empty && out.len() > 1 {
            out.remove(0);
        }
        Ok(out)
    }

    fn picture(&mut self, r: XNode, p: XNode, origin: (i64, i64)) -> Result<Json, String> {
        let mut reg = self.base(r, origin, "image");
        let raw = child(p, "raw").ok_or("picture without data")?;
        let b64: String = raw.text().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
        let data = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        let src = self.asset(data, attr(raw, "format").unwrap_or("png"));
        reg.insert("src".into(), json!(src));
        reg.insert("size".into(), json!([int(r, "width"), int(r, "height")]));
        Ok(Json::Object(reg))
    }

    fn area(&mut self, r: XNode, a: XNode, origin: (i64, i64)) -> Vec<Json> {
        if attr(a, "terminator") == Some("true") {
            return Vec::new();
        }
        let mut reg = self.base(r, origin, "area");
        let top = int(r, "top");
        reg["at"][0] = json!(0);
        if let Some(title) = child(a, "title") {
            let t: Vec<String> = Inline::default()
                .paragraphs(title)
                .into_iter()
                .map(|(b, _)| b)
                .filter(|b| !b.is_empty())
                .collect();
            if !t.is_empty() {
                reg.insert("title".into(), json!(t.join("\n\n")));
            }
        }
        if attr(a, "collapsed") == Some("true") {
            reg.insert("collapsed".into(), json!(true));
        }
        if attr(a, "locked") == Some("true") {
            reg.insert("locked".into(), json!(true));
        }
        let term: Vec<XNode> = children(r, "region")
            .filter(|c| child(*c, "area").is_some_and(|ar| attr(ar, "terminator") == Some("true")))
            .collect();
        if let Some(last) = term.last() {
            reg.insert("height".into(), json!(int(*last, "top") - top));
        }
        let inner = self.region_list(r, (origin.0, top));
        reg.insert("regions".into(), Json::Array(inner));
        vec![Json::Object(reg)]
    }

    fn table(&mut self, r: XNode, t: XNode, origin: (i64, i64)) -> Json {
        let mut reg = self.base(r, origin, "table");
        reg.insert("size".into(), json!([int(r, "width"), int(r, "height")]));
        let body = child(t, "regions").and_then(|l| child(l, "body"));
        let bound: Vec<&str> = child(t, "inputs")
            .map(|i| {
                children(i, "e")
                    .filter(|e| attr(*e, "regions") == Some("rows"))
                    .filter_map(|e| e.text())
                    .collect()
            })
            .unwrap_or_default();
        reg.insert("source".into(), bound.first().map_or(Json::Null, |b| json!(b)));
        if let Some(body) = body {
            // SMath tables display a matrix variable; the matrix's first row/column act as
            // headers. Cell values are recomputed live, never stored.
            let first = body.descendants().find(|n| n.is_element() && n.tag_name().name() == "tr");
            let tds: Vec<XNode> = first.map(|f| children(f, "td").collect()).unwrap_or_default();
            let column = !tds.is_empty() && tds[0].text().unwrap_or("").trim().is_empty();
            reg.insert("header".into(), json!({ "row": true, "column": column }));
            let numbers = attr(body, "numbers").filter(|s| !s.is_empty()).unwrap_or("Default,2");
            let decimals: i64 = numbers.split(',').nth(1).and_then(|d| d.trim().parse().ok()).unwrap_or(2);
            reg.insert("display".into(), json!({ "decimals": decimals }));
            let cells = body.descendants().filter(|n| n.is_element() && n.tag_name().name() == "td").count();
            self.stat("table-cells-dropped", cells);
        } else {
            self.stat("table-cells-dropped", 0);
        }
        Json::Object(reg)
    }

    fn plot(&mut self, r: XNode, p: XNode, origin: (i64, i64)) -> Result<Json, String> {
        let kind = if attr(p, "type") == Some("3d") { "plot3d" } else { "plot2d" };
        let mut reg = self.base(r, origin, kind);
        reg.insert("size".into(), json!([int(r, "width"), int(r, "height")]));
        let mut series = Vec::new();
        if let Some(ast) = expr(child(p, "input"))? {
            let sys = ast.kind == Kind::Call && ast.value == "sys";
            let mut items: Vec<math::Node> = if sys { ast.args.clone() } else { vec![ast] };
            if sys && items.len() > 2 {
                items.truncate(items.len() - 2); // sys(..., rows, cols)
            }
            // a 3D plot's input is a height: z(x, y) or a matrix
            let key = if kind == "plot3d" { "z" } else { "y" };
            series = items.iter().map(|i| json!({ key: to_linear(i, false) })).collect();
        }
        reg.insert("series".into(), json!(series));
        reg.insert("grid".into(), json!(attr(p, "grid") == Some("true")));
        reg.insert("axes".into(), json!(attr(p, "axes") == Some("true")));
        if let Some(render) = attr(p, "render").filter(|r| !r.is_empty() && *r != "lines") {
            reg.insert("render".into(), json!(render));
        }
        Ok(Json::Object(reg))
    }

    // -- post-processing ----------------------------------------------------

    fn attach_captions(&mut self, regions: &mut Vec<Json>) {
        static ATTR_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\{[^}\n]*\}\n").unwrap());
        let mut k = 0;
        while k < regions.len() {
            let tr = &regions[k];
            let Some(text) = tr["text"].as_str().filter(|_| tr["kind"] == "text").map(String::from) else {
                k += 1;
                continue;
            };
            let body = ATTR_LINE.replace(&text, "");
            let caption = (!body.contains('\n'))
                .then(|| {
                    CAPTION_RE.captures(&plain(&text)).map(|m| (m[1].to_lowercase(), m[3].trim().to_string()))
                })
                .flatten();
            let Some((label, caption_text)) = caption else {
                k += 1;
                continue;
            };
            let want_table = label.starts_with("tab");
            let ty = tr["at"][1].as_i64().unwrap_or(0);
            let mut best: Option<(i64, usize)> = None;
            for (i, f) in regions.iter().enumerate() {
                let fk = f["kind"].as_str().unwrap_or("");
                if !matches!(fk, "image" | "table" | "plot2d" | "plot3d")
                    || (fk == "table") != want_table
                    || f.get("caption").is_some()
                {
                    continue;
                }
                let (fy, fh) = (f["at"][1].as_i64().unwrap_or(0), f["size"][1].as_i64().unwrap_or(0));
                let gap = (ty - (fy + fh)).abs().min((fy - ty - 20).abs());
                if gap <= 60 && best.is_none_or(|(g, _)| gap < g) {
                    best = Some((gap, i));
                }
            }
            if let Some((_, i)) = best {
                let position = if ty < regions[i]["at"][1].as_i64().unwrap_or(0) { "above" } else { "below" };
                regions[i]["caption"] = json!({ "text": esc(&caption_text), "position": position });
                regions.remove(k);
                self.stat("caption", 1);
                continue;
            }
            k += 1;
        }
        for r in regions.iter_mut() {
            if r["kind"] == "area"
                && let Some(Json::Array(inner)) = r.get_mut("regions")
            {
                self.attach_captions(inner);
            }
        }
    }

    fn styles(&self) -> Json {
        let (fam, size) = self.text_fonts.most().cloned().unwrap_or(("Arial".into(), "10".into()));
        let msize = self.math_sizes.most().cloned().unwrap_or("10".into());
        json!({
            "body": { "font": fam, "size": num(&size) },
            "math": { "font": "STIX Two Math", "size": num(&msize) },
            "numbering": { "headings": "1.1", "figures": "Figura {n} –", "tables": "Tabela {n} –" }
        })
    }

    fn strip_default_fonts(regions: &mut [Json], styles: &Json) {
        for r in regions.iter_mut() {
            if let Some(Json::Object(f)) = r.as_object_mut().and_then(|m| m.remove("font")) {
                let mut over = Map::new();
                let family = f["family"].as_str().unwrap_or("");
                if Some(family) != styles["body"]["font"].as_str() {
                    over.insert("font".into(), json!(family));
                }
                let size = num(f["size"].as_str().unwrap_or("10"));
                if size.as_f64() != styles["body"]["size"].as_f64() {
                    over.insert("size".into(), size);
                }
                if !over.is_empty() {
                    r["style"] = Json::Object(over);
                }
            }
            if r["kind"] == "area"
                && let Some(Json::Array(inner)) = r.get_mut("regions")
            {
                Self::strip_default_fonts(inner, styles);
            }
        }
    }
}

fn header_footer(h: XNode) -> Json {
    static FIELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&\[([A-Z]+)\]").unwrap());
    static GAP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {3,}").unwrap());
    let field = |f: &str| match f {
        "DATE" => Some("{date}"),
        "TIME" => Some("{time}"),
        "FILENAME" => Some("{file}"),
        "PAGENUM" => Some("{page}"),
        "COUNT" => Some("{pages}"),
        "AUTHOR" => Some("{author}"),
        "COMPANY" => Some("{company}"),
        "TITLE" => Some("{title}"),
        _ => None,
    };
    let text = FIELD.replace_all(h.text().unwrap_or(""), |c: &regex::Captures| {
        field(&c[1]).map_or(c[0].to_string(), String::from)
    });
    // SMath users right-align with runs of spaces; split them into real slots
    let parts: Vec<&str> = GAP.split(&text).map(str::trim).filter(|p| !p.is_empty()).collect();
    let align = attr(h, "alignment").unwrap_or("Center").to_lowercase();
    let mut out = Map::new();
    match parts.as_slice() {
        [one] => {
            out.insert(align, json!(one));
        }
        [l, r] => {
            out.insert("left".into(), json!(l));
            out.insert("right".into(), json!(r));
        }
        [l, mid @ .., r] => {
            out.insert("left".into(), json!(l));
            out.insert("center".into(), json!(mid.join(" ")));
            out.insert("right".into(), json!(r));
        }
        [] => {}
    }
    if let Some(c) = attr(h, "color").filter(|c| !c.is_empty()) {
        out.insert("color".into(), json!(c.to_lowercase()));
    }
    Json::Object(out)
}

/// SMath option text: `"Classe\0020\6x19"` → `Classe 6x19` (`\hhhh\` is a character).
fn unescape_sm(s: &str) -> String {
    static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([0-9A-Fa-f]{4})\\").unwrap());
    let s = s.trim();
    let s = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') { &s[1..s.len() - 1] } else { s };
    HEX.replace_all(s, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map_or(c[0].to_string(), String::from)
    })
    .into_owned()
}

/// Convert an SMath worksheet. `path` names the file (for the document's source and to
/// find the spreadsheets importData reads, next to it).
pub fn import(bytes: &[u8], path: &Path) -> Result<Imported, String> {
    let source = std::str::from_utf8(bytes)
        .map(str::to_string)
        .or_else(|_| Ok::<_, String>(String::from_utf8_lossy(bytes).into_owned()))?;
    let source = source.trim_start_matches('\u{feff}');
    let opts = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let xml = roxmltree::Document::parse_with_options(source, opts)
        .map_err(|e| format!("not an SMath worksheet: {e}"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut c = Converter {
        name,
        dir: path.parent(),
        source,
        assets: Vec::new(),
        results: Map::new(),
        ids: HashSet::new(),
        seq: 0,
        stats: BTreeMap::new(),
        warnings: Vec::new(),
        math_sizes: Tally::default(),
        text_fonts: Tally::default(),
    };
    let document = c.run(xml.root_element());
    Ok(Imported {
        document,
        results: c.results,
        assets: c.assets.into_iter().map(|(_, n, d)| (n, d)).collect(),
        warnings: c.warnings,
        stats: c.stats,
    })
}

/// Write `document.json`, `results.json` (when SMath saved results) and `assets/`.
pub fn write_bundle(imported: &Imported, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("document.json"), dump(&imported.document) + "\n")?;
    if !imported.results.is_empty() {
        let res = json!({ "format": "quire-results/1", "producer": "SMath Studio (imported)", "results": imported.results });
        std::fs::write(dir.join("results.json"), dump(&res) + "\n")?;
    }
    for (name, data) in &imported.assets {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(p, data)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<worksheet xmlns="http://smath.info/schemas/worksheet/1.0">
  <settings><metadata lang="por"><title>Teste</title><author>Eng.</author></metadata></settings>
  <regions>
    <region left="20" top="10"><math><input><e type="operand">L</e><e type="operand">5.1</e><e type="operand" style="unit">m</e><e type="operator" args="2">*</e><e type="operator" args="2">:</e></input></math></region>
    <region left="20" top="40"><math><input><e type="operand">L</e></input><result action="numeric"><e type="operand">5.1</e><e type="operand" style="unit">m</e><e type="operator" args="2">*</e></result></math></region>
    <region left="20" top="70"><text lang="por"><p><span style="font-weight: bold">1. CARGAS</span></p></text></region>
    <region left="20" top="100"><radiobuttonlist input="Tipo" selected="2" output="Default"><ul><li>"A\0020\1"</li><li>"B"</li></ul><input><e type="operand">Tipo</e></input></radiobuttonlist></region>
    <region left="20" top="130"><unknownregion/></region>
  </regions>
</worksheet>"#;

    #[test]
    fn converts_a_small_worksheet() {
        let im = import(SM.as_bytes(), Path::new("t.sm")).unwrap();
        let d = &im.document;
        assert_eq!(d["meta"]["title"], "Teste");
        assert_eq!(d["meta"]["lang"], "pt-BR");
        assert_eq!(d["settings"]["calc"]["definitions"], "smath");
        let r = d["regions"].as_array().unwrap();
        assert_eq!(r[0]["expr"], "L := 5.1 'm");
        assert_eq!(r[1]["show"], "value");
        assert_eq!(im.results[r[1]["id"].as_str().unwrap()], "5.1 'm");
        assert_eq!(r[2]["text"], "# CARGAS", "a bold numbered line is a heading");
        assert_eq!(r[3]["expr"], "Tipo := 2");
        assert_eq!(r[3]["note"], "- 1 = A 1\n- *2 = B* ✓");
        assert_eq!(r[4]["kind"], "legacy", "nothing is lost");
        assert_eq!(im.assets.len(), 1);
        let ids: HashSet<&str> = r.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 5);
        assert!(dump(d).starts_with("{\n  \"format\": \"quire/1\",\n  \"meta\": {"));
    }

    #[test]
    fn writer_xyplot_and_image_regions() {
        let sm = r#"<worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>
<region left="10" top="10" width="300"><writer lang="eng"><![CDATA[<span style="font-family: 'Arial'; font-size: 10pt; color: windowtext">
<div style="text-align: center"><span style="font-size: 12pt"><strong>AN&#193;LISE</strong></span> de <em>tubos</em></div>
<div>linha 1<br>linha 2</div></span>]]></writer></region>
<region left="10" top="60" width="400" height="200"><xyplot><grid isxgrid="true" isygrid="false"/>
<xaxes xmin="0" xmax="10"/><yaxes ymin="-1" ymax="5.5"/><title2d title="S-N"/>
<xylabel xlabel="N" ylabel="S"/><legend islegendvisible="false"/>
<traces><trace seriesname="a" plotmethod="Lines" linecolor="Blue" symboltype="Circle" linepattern="Dash"/></traces>
<input><e type="operand">P</e><e type="operand">Q</e><e type="operand">2</e><e type="operand">1</e><e type="function" args="4">sys</e></input></xyplot></region>
<region left="10" top="300" width="40" height="30"><image><imagefile filename="t.png" width="20" height="10" renderExt=".png">iVBORw0KGgo=</imagefile></image></region>
</regions></worksheet>"#;
        let im = import(sm.as_bytes(), Path::new("w.sm")).unwrap();
        let r = im.document["regions"].as_array().unwrap();
        assert_eq!(r[0]["text"], "{.center size=12}\n*ANÁLISE* de _tubos_\n\nlinha 1\\\nlinha 2");
        assert_eq!(r[0]["width"], 300);
        let p = &r[1];
        assert_eq!(p["kind"], "plot2d");
        assert_eq!(
            p["series"],
            json!([{ "y": "P", "label": "a", "style": { "color": "blue", "draw": "line+points", "dash": "dashed" } }, { "y": "Q" }])
        );
        assert_eq!(
            p["axes"],
            json!({ "x": { "label": "N", "min": 0, "max": 10 }, "y": { "label": "S", "min": -1, "max": 5.5 } })
        );
        assert_eq!(
            (p["grid"].clone(), p["legend"].clone(), p["caption"]["text"].clone()),
            (json!(true), json!("none"), json!("S-N"))
        );
        assert_eq!((r[2]["kind"].clone(), r[2]["size"].clone()), (json!("image"), json!([20, 10])));
        assert!(im.stats.keys().all(|k| !k.starts_with("legacy")));
    }

    #[test]
    fn ids_are_stable() {
        let a = import(SM.as_bytes(), Path::new("t.sm")).unwrap();
        let b = import(SM.as_bytes(), Path::new("t.sm")).unwrap();
        assert_eq!(dump(&a.document), dump(&b.document));
    }
}
