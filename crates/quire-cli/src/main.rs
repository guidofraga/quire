use std::path::{Path, PathBuf};
use std::process::ExitCode;

use quire_ast::{parse, print};
use quire_cli::{Verdict, compare, evaluate};
use quire_eval::{DisplaySettings, DisplaySpec, MathInput, Worksheet};
use quire_smath::Imported;
use serde_json::json;

mod serve;

const USAGE: &str = "\
quire — headless Quire worksheet engine

usage:
  quire eval <doc.quire>          evaluate a worksheet and print a calculation listing
  quire check <doc.quire>         compare results with the bundle's results.json (exit 1 on mismatch)
  quire fmt --check <path>...     verify every expression round-trips through the parser
  quire calc <expr> [--in <unit>] [--decimals <n>]
                                  evaluate one expression, e.g. quire calc \"2 'm + 30 'cm\" --in mm
  quire import <file.sm> [out.quire]
                                  convert an SMath Studio worksheet into a .quire bundle
  quire serve [--port <n>]        editor backend on localhost for UI development (default port 7878)
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("eval") if args.len() == 2 => cmd_eval(&args[1]),
        Some("check") if args.len() == 2 => cmd_check(&args[1]),
        Some("fmt") if args.len() >= 3 && args[1] == "--check" => cmd_fmt_check(&args[2..]),
        Some("calc") if args.len() >= 2 => cmd_calc(&args[1..]),
        Some("import") if (2..=3).contains(&args.len()) => cmd_import(args.get(1..).unwrap_or_default()),
        Some("serve") => cmd_serve(&args[1..]),
        Some("--version" | "-V") => {
            println!("quire {}", env!("CARGO_PKG_VERSION"));
            Ok(true)
        }
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

type CmdResult = Result<bool, Box<dyn std::error::Error>>;

fn width(s: &str) -> usize {
    s.chars().count()
}

/// One line, at most `max` characters.
fn clip(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if width(&one_line) <= max {
        return one_line;
    }
    let mut t: String = one_line.chars().take(max - 1).collect();
    t.push('…');
    t
}

fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(width(s))))
}

fn cmd_eval(path: &str) -> CmdResult {
    let bundle = quire_doc::load(path)?;
    let ev = evaluate(&bundle.document);
    for (name, msg) in &ev.unit_errors {
        println!("✗ unit {name}: {msg}");
    }
    let exprs: Vec<String> = ev
        .inputs
        .iter()
        .map(|i| match (&i.table, &i.plot) {
            (Some(t), _) => {
                let size = format!("{}×{}", t.rows.len(), t.rows.iter().map(Vec::len).max().unwrap_or(0));
                t.name.as_ref().map_or(format!("table {size}"), |n| format!("table {n} ({size})"))
            }
            (_, Some(p)) => {
                let ys: Vec<&str> = p.series.iter().map(|s| s.y.as_str()).collect();
                clip(&format!("plot {}", ys.join(", ")), 64)
            }
            _ => clip(&i.expr, 64),
        })
        .collect();
    let w = exprs.iter().map(|e| width(e)).max().unwrap_or(0);
    let mut errors = 0;
    for (expr, o) in exprs.iter().zip(&ev.outcomes) {
        match (&o.error, &o.shown) {
            (Some(err), _) => {
                errors += 1;
                println!("✗ {}  ⟶ {err}", pad(expr, w));
            }
            (None, Some(shown)) => println!("  {}  = {shown}", pad(expr, w)),
            (None, None) => println!("  {expr}"),
        }
    }
    println!(
        "\n{} math regions · {} ok · {} with errors · evaluated in {:.2} ms",
        ev.outcomes.len(),
        ev.outcomes.len() - errors,
        errors,
        ev.elapsed_ms
    );
    Ok(true)
}

fn cmd_check(path: &str) -> CmdResult {
    let bundle = quire_doc::load(path)?;
    let Some(results) = &bundle.results else {
        return Err(format!("{} has no results.json to check against", bundle.path.display()).into());
    };
    let ev = evaluate(&bundle.document);
    let rows = compare(results, &ev);
    let producer = results.producer.as_deref().unwrap_or("reference");
    let exprs: Vec<String> = rows.iter().map(|r| clip(&r.expr, 48)).collect();
    let we = exprs.iter().map(|e| width(e)).max().unwrap_or(0);
    let wr = rows.iter().map(|r| width(&r.reference)).max().unwrap_or(0).max(9);
    println!("  {}  {}  Quire", pad("expression", we), pad("reference", wr));
    let (mut exact, mut close, mut bad) = (0, 0, 0);
    for (r, expr) in rows.iter().zip(&exprs) {
        let ours = r.ours.as_deref().unwrap_or("—");
        let (mark, note) = match &r.verdict {
            Verdict::Exact => {
                exact += 1;
                ("✓", String::new())
            }
            Verdict::WithinRounding => {
                close += 1;
                ("≈", "  (equal within displayed precision)".to_string())
            }
            Verdict::Mismatch(m) | Verdict::Failed(m) => {
                bad += 1;
                ("✗", format!("  ⟶ {m}"))
            }
        };
        println!("{mark} {}  {}  {ours}{note}", pad(expr, we), pad(&r.reference, wr));
    }
    let total = rows.len();
    println!(
        "\n{}/{total} results match {producer} ({exact} exact, {close} within display rounding, {bad} mismatched)",
        exact + close
    );
    Ok(bad == 0)
}

fn find_documents(path: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if path.is_file() {
        out.push(path.to_path_buf());
    } else if path.join("document.json").is_file() {
        out.push(path.join("document.json"));
    } else if path.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok().map(|e| e.path())).collect();
        entries.sort();
        for e in entries.iter().filter(|e| e.is_dir()) {
            find_documents(e, out)?;
        }
    }
    Ok(())
}

fn cmd_fmt_check(paths: &[String]) -> CmdResult {
    let mut docs = Vec::new();
    for p in paths {
        find_documents(Path::new(p), &mut docs)?;
    }
    let (mut total, mut failures) = (0, Vec::new());
    for doc_path in &docs {
        let bundle = quire_doc::load(doc_path)?;
        for p in bundle.document.flatten() {
            let Some(expr) = &p.region.expr else { continue };
            total += 1;
            let label = format!("{} #{}", doc_path.parent().unwrap_or(doc_path).display(), p.region.id);
            match parse(expr) {
                Err(e) => failures.push(format!("{label}: {e}\n    {}", clip(expr, 100))),
                Ok(ast) => {
                    let printed = print(&ast);
                    if &printed != expr {
                        failures.push(format!(
                            "{label}: not canonical\n    have {}\n    want {}",
                            clip(expr, 100),
                            clip(&printed, 100)
                        ));
                    } else if parse(&printed).ok().as_ref() != Some(&ast) {
                        failures.push(format!("{label}: re-parsing the printed text gives a different tree"));
                    }
                }
            }
        }
    }
    for f in failures.iter().take(40) {
        println!("✗ {f}");
    }
    if failures.len() > 40 {
        println!("… and {} more", failures.len() - 40);
    }
    println!(
        "{} expressions in {} documents: {} round-trip, {} failed",
        total,
        docs.len(),
        total - failures.len(),
        failures.len()
    );
    Ok(failures.is_empty())
}

fn cmd_calc(args: &[String]) -> CmdResult {
    let mut expr = None;
    let mut display = DisplaySpec::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--in" => display.unit = Some(it.next().ok_or("--in needs a unit")?.clone()),
            "--decimals" => display.decimals = Some(it.next().ok_or("--decimals needs a number")?.parse()?),
            _ if expr.is_none() => expr = Some(a.clone()),
            _ => return Err(format!("unexpected argument {a}").into()),
        }
    }
    let expr = expr.ok_or("missing expression")?;
    let input =
        MathInput { id: "calc".into(), expr, show: true, display, table: None, plot: None, symbolic: false };
    let out = Worksheet::new(DisplaySettings::default()).run(&[input]).remove(0);
    match (out.error, out.shown) {
        (Some(e), _) => {
            eprintln!("✗ {e}");
            Ok(false)
        }
        (None, Some(s)) => {
            println!("{s}");
            Ok(true)
        }
        (None, None) => Ok(true),
    }
}

/// `quire import <file.sm> [out.quire]`: the same bundle, and the same summary, as tools/sm2quire.py.
fn cmd_import(args: &[String]) -> CmdResult {
    let src = PathBuf::from(args.first().ok_or("usage: quire import <file.sm> [out.quire]")?);
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("the file has no name")?;
    // the bundle is named after the worksheet, without its .sm suffix
    let stem = name.split_once(".sm").map_or(name.as_str(), |(stem, _)| stem);
    let out = match args.get(1) {
        Some(out) => PathBuf::from(out),
        None => src.with_file_name(format!("{stem}.quire")),
    };
    let bytes = std::fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    let imported = quire_service::import_smath(&bytes, src.file_name().and_then(|n| n.to_str()))
        .map_err(|e| format!("{}: {e}", src.display()))?;
    let skipped = write_import(&imported, &out)?;
    let summary: Vec<String> = imported.stats.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let results = imported.results.as_object().map_or(0, |m| m.len());
    println!(
        "{name} -> {}  [{}] assets={} results={results}",
        out.display(),
        summary.join(", "),
        imported.assets.len()
    );
    for w in imported.warnings.iter().chain(skipped.iter()) {
        println!("  warning: {w}");
    }
    Ok(true)
}

/// Writes `document.json`, `results.json` (only when SMath cached results) and the assets.
/// An asset whose path is not a bundle asset name is skipped; the returned warnings say so.
fn write_import(imported: &Imported, out: &Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(out)?;
    let doc = quire_service::canonical::to_string(&imported.document);
    std::fs::write(out.join("document.json"), doc)?;
    if imported.results.as_object().is_some_and(|m| !m.is_empty()) {
        let results = json!({
            "format": "quire-results/1",
            "producer": "SMath Studio (imported)",
            "results": imported.results,
        });
        std::fs::write(out.join("results.json"), quire_service::canonical::to_string(&results))?;
    }
    let mut skipped = Vec::new();
    for asset in &imported.assets {
        // the path comes from the worksheet's XML: write only names the bundle would accept
        if quire_service::checked_asset(&asset.path).is_err() {
            skipped.push(format!("skipped image {:?}: not a bundle asset name", asset.path));
            continue;
        }
        let target = out.join(&asset.path);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(target, &asset.data)?;
    }
    Ok(skipped)
}

fn cmd_serve(args: &[String]) -> CmdResult {
    let port = match args {
        [] => 7878,
        [flag, p] if flag == "--port" => p.parse()?,
        _ => return Err("usage: quire serve [--port <n>]".into()),
    };
    serve::serve(port)?;
    Ok(true)
}
