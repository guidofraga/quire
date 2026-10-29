//! The SMath importer must never panic: every input gives `Ok` or `Err`.
//!
//! Inline hostile fixtures, plus, when the corpus exists (`QUIRE_SMATH_EXAMPLES` or
//! `<workspace>/examples`), every corpus file cut at 64 positions and mutated 200 times.
//! Set `QUIRE_SMATH_PANIC_DIR` to save each panicking input there for reproduction.

use std::any::Any;
use std::error::Error;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

type TestResult = Result<(), Box<dyn Error>>;

const OPEN: &str = r#"<regions xmlns="http://smath.info/schemas/worksheet/1.0"><settings/>"#;
const CLOSE: &str = "</regions>";

const TEXT_REGION: &str =
    r#"<region left="0" top="0" width="200" height="20"><text><p>Hello</p></text></region>"#;
const MATH_REGION: &str = r#"<region left="0" top="40" width="200" height="30"><math><input><e type="operand">x</e><e type="operand">2</e><e type="operator" args="2">:</e></input></math></region>"#;

fn math_with(tokens: &str) -> String {
    format!(
        r#"<region left="0" top="0" width="100" height="20"><math><input>{tokens}</input></math></region>"#
    )
}

fn doc(body: &str) -> String {
    format!("{OPEN}{body}{CLOSE}")
}

fn fixtures() -> Vec<(&'static str, String)> {
    let valid = doc(&format!("{TEXT_REGION}{MATH_REGION}"));
    let mut nested = String::new();
    for _ in 0..200 {
        nested.push_str(r#"<region left="0" top="0" width="10" height="10"><area>"#);
    }
    nested.push_str(TEXT_REGION);
    for _ in 0..200 {
        nested.push_str("</area></region>");
    }

    vec![
        ("valid_text_and_math", valid.clone()),
        ("empty_string", String::new()),
        ("not_xml", "not xml".to_string()),
        ("truncated_xml", valid[..valid.len() / 2].to_string()),
        ("only_the_root_element", CLOSE.to_string()),
        (
            "operator_args_5_with_one_operand",
            doc(&math_with(r#"<e type="operand">x</e><e type="operator" args="5">:</e>"#)),
        ),
        (
            "operator_args_minus_one",
            doc(&math_with(r#"<e type="operand">x</e><e type="operator" args="-1">:</e>"#)),
        ),
        (
            "operator_args_huge",
            doc(&math_with(r#"<e type="operand">x</e><e type="operator" args="999999999999">:</e>"#)),
        ),
        ("operator_with_no_operands", doc(&math_with(r#"<e type="operator" args="2">+</e>"#))),
        ("unknown_token_type", doc(&math_with(r#"<e type="bogus">q</e><e type="operand">1</e>"#))),
        ("empty_math", doc(&math_with(""))),
        (
            "non_numeric_geometry",
            doc(
                r#"<region left="abc" top="xyz" width="w" height="h"><math><input><e type="operand">1</e></input></math></region>"#,
            ),
        ),
        (
            "picture_with_invalid_base64",
            doc(
                r#"<region left="0" top="0" width="10" height="10"><picture>!!!@@@ not-base64 ***</picture></region>"#,
            ),
        ),
        ("deeply_nested_areas_200", doc(&nested)),
        (
            "huge_numbers",
            doc(
                r#"<region left="1e308" top="99999999999999999999999999" width="-1" height="1e400"><math><input><e type="operand">99999999999999999999999999999999999999999999999999999999999</e><e type="operand">1e999999</e><e type="operator" args="2">*</e></input></math></region>"#,
            ),
        ),
        ("bom_prefixed", format!("\u{feff}{valid}")),
        ("bom_only", "\u{feff}".to_string()),
    ]
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

/// Runs the importer on `input`; `Err` carries the panic message.
fn convert_guarded(input: &str) -> Result<(), String> {
    catch_unwind(AssertUnwindSafe(|| {
        let _ = quire_smath::convert(input);
    }))
    .map_err(|payload| panic_message(payload.as_ref()))
}

/// Writes a panicking input under `QUIRE_SMATH_PANIC_DIR`, if that is set.
fn save_panic(label: &str, input: &str) -> String {
    let Some(dir) = std::env::var_os("QUIRE_SMATH_PANIC_DIR") else {
        return String::new();
    };
    let dir = PathBuf::from(dir);
    let safe: String = label.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.sm"));
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(&path, input);
    format!(" (input saved to {})", path.display())
}

#[test]
fn importer_never_panics_on_inline_fixtures() -> TestResult {
    let mut failures = Vec::new();
    for (name, input) in fixtures() {
        // Printed first so an abort (a stack overflow cannot be caught) names the fixture.
        eprintln!("checking fixture `{name}`");
        if let Err(message) = convert_guarded(&input) {
            let saved = save_panic(name, &input);
            failures.push(format!("fixture `{name}` panicked: {message}{saved}"));
        }
    }
    assert!(failures.is_empty(), "{} panic(s) on inline fixtures:\n{}", failures.len(), failures.join("\n"));
    Ok(())
}

#[test]
fn valid_fixture_converts_to_a_document() -> TestResult {
    let input = doc(&format!("{TEXT_REGION}{MATH_REGION}"));
    match quire_smath::convert(&input) {
        Ok(imported) => {
            assert!(imported.document.is_object(), "the document should be a JSON object");
            Ok(())
        }
        Err(e) => Err(format!("a valid worksheet should convert, got: {e}").into()),
    }
}

fn corpus_dir() -> PathBuf {
    match std::env::var_os("QUIRE_SMATH_EXAMPLES") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples"),
    }
}

fn sm_files(dir: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "sm") && path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

/// Deterministic xorshift64 PRNG, seeded per file so failures reproduce.
struct XorShift(u64);

impl XorShift {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
}

fn seed_for(name: &str) -> u64 {
    // FNV-1a, so each file gets its own nonzero seed.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h | 1
}

const MUTATION_CHARS: [char; 10] = ['<', '>', '"', '&', '=', '/', '0', ' ', '-', '9'];

#[test]
fn importer_never_panics_on_corpus_prefixes_and_mutations() -> TestResult {
    let dir = corpus_dir();
    if !dir.is_dir() {
        eprintln!("note: no SMath corpus at {} (set QUIRE_SMATH_EXAMPLES); skipping fuzzing", dir.display());
        return Ok(());
    }
    let mut failures = Vec::new();
    let mut calls = 0usize;
    for sm in sm_files(&dir)? {
        let name = sm.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let text = String::from_utf8_lossy(&fs::read(&sm)?).into_owned();
        let n = text.len();

        // (a) Prefixes at 64 evenly spaced byte positions, moved back to a char boundary.
        for i in 0..=64usize {
            let mut cut = n * i / 64;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            let Some(prefix) = text.get(..cut) else { continue };
            calls += 1;
            let label = format!("{name} prefix {cut}/{n}");
            if let Err(message) = convert_guarded(prefix) {
                let saved = save_panic(&label, prefix);
                failures.push(format!("{label} panicked: {message}{saved}"));
            }
        }

        // (b) 200 mutations: replace one char, or delete a range of up to 32 chars.
        let chars: Vec<char> = text.chars().collect();
        if chars.is_empty() {
            continue;
        }
        let mut rng = XorShift(seed_for(&name));
        for m in 0..200usize {
            let mut mutated = chars.clone();
            let len = mutated.len();
            let description = if rng.next_u64().is_multiple_of(2) {
                let idx = rng.below(len);
                let ch = MUTATION_CHARS[rng.below(MUTATION_CHARS.len())];
                if let Some(slot) = mutated.get_mut(idx) {
                    *slot = ch;
                }
                format!("replace char {idx} with {ch:?}")
            } else {
                let start = rng.below(len);
                let span = 1 + rng.below(32);
                let end = (start + span).min(len);
                mutated.drain(start..end);
                format!("delete chars {start}..{end}")
            };
            let input: String = mutated.iter().collect();
            calls += 1;
            let label = format!("{name} mutation {m} ({description})");
            if let Err(message) = convert_guarded(&input) {
                let saved = save_panic(&label, &input);
                failures.push(format!("{label} panicked: {message}{saved}"));
            }
        }
    }
    eprintln!("SMath robustness: {calls} corpus inputs run, {} panic(s)", failures.len());
    assert!(failures.is_empty(), "{} panic(s) on corpus inputs:\n{}", failures.len(), failures.join("\n"));
    Ok(())
}
