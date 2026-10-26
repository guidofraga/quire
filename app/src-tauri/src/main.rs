// Quire desktop app — GPL-3.0-or-later. The engine crates it calls are MIT OR Apache-2.0.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod pdf;
mod print;

use std::path::PathBuf;

use serde_json::{Value as Json, json};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, WebviewWindow, WebviewWindowBuilder, Wry};

type CmdResult<T> = Result<T, String>;

fn err(e: quire_service::ServiceError) -> String {
    e.0
}

#[tauri::command]
fn report(doc: Json) -> CmdResult<quire_service::Report> {
    quire_service::report(&doc).map_err(err)
}

#[tauri::command]
fn open_document(path: PathBuf) -> CmdResult<Json> {
    quire_service::open(&path).map_err(err)
}

#[tauri::command]
fn save_document(path: PathBuf, doc: Json, from: Option<PathBuf>) -> CmdResult<()> {
    quire_service::save(&path, &doc, from.as_deref()).map_err(err)
}

#[tauri::command]
fn library() -> quire_service::Library {
    quire_service::library()
}

#[tauri::command]
fn djot_html(src: String) -> String {
    quire_service::render_djot_editable(&src)
}

#[tauri::command]
fn import_image(path: PathBuf) -> CmdResult<String> {
    quire_service::assets::stage_file(&path).map_err(err)
}

#[tauri::command]
fn stage_image(data: String, ext: String) -> CmdResult<String> {
    quire_service::assets::stage_base64(&data, &ext).map_err(err)
}

#[tauri::command]
fn read_asset(bundle: PathBuf, src: String) -> CmdResult<String> {
    quire_service::read_asset(&bundle, &src).map_err(err)
}

#[tauri::command]
fn new_document() -> Json {
    quire_service::new_document()
}

#[tauri::command]
async fn print_document(window: WebviewWindow, paper: print::Paper, title: String) -> CmdResult<()> {
    print::print(&window, paper, title)
}

#[tauri::command]
async fn export_pdf(
    window: WebviewWindow,
    path: PathBuf,
    paper: print::Paper,
    title: String,
    compress: bool,
) -> CmdResult<()> {
    print::export_pdf(&window, path, paper, title, compress)
}

/// End of a headless `--export-pdf` run.
#[tauri::command]
fn finish_export(app: AppHandle, error: Option<String>) {
    match error {
        None => app.exit(0),
        Some(e) => {
            eprintln!("quire: export failed: {e}");
            app.exit(1);
        }
    }
}

/// `quire-app --export-pdf <document.quire> <output.pdf>`: render without showing a window.
fn export_job() -> Option<Json> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--export-pdf")?;
    let (input, output) = (args.get(i + 1)?, args.get(i + 2)?);
    let cwd = std::env::current_dir().ok()?;
    let input = std::fs::canonicalize(cwd.join(input)).ok()?;
    Some(json!({ "open": input, "pdf": cwd.join(output) }))
}

fn item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, accel)
}

/// Native menu bar. Custom items are forwarded to the UI as `menu` events carrying the item id;
/// clipboard items are native so they work in text fields.
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata {
        comments: Some("Free-form engineering math notebook".into()),
        license: Some("GPL-3.0-or-later (engine: MIT OR Apache-2.0)".into()),
        ..Default::default()
    };
    // macOS keeps Settings and Quit in the app menu; elsewhere they live in File
    let mac = cfg!(target_os = "macos");
    let settings = item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "new", "New", Some("CmdOrCtrl+N"))?,
            &item(app, "open", "Open…", Some("CmdOrCtrl+O"))?,
            &sep()?,
            &item(app, "save", "Save", Some("CmdOrCtrl+S"))?,
            &item(app, "save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
            &sep()?,
            &item(app, "export_pdf", "Export as PDF…", Some("CmdOrCtrl+E"))?,
            &item(app, "print", "Print…", Some("CmdOrCtrl+P"))?,
            &sep()?,
            &item(app, "document_settings", "Document Settings…", Some("CmdOrCtrl+Alt+,"))?,
            &item(app, "page_setup", "Page Setup…", None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    if !mac {
        file.append_items(&[&sep()?, &settings, &sep()?, &PredefinedMenuItem::quit(app, Some("Quit"))?])?;
    }
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?,
            &item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &item(app, "duplicate", "Duplicate", Some("CmdOrCtrl+D"))?,
            &item(app, "delete", "Delete", None)?,
            &item(app, "select_all", "Select All", Some("CmdOrCtrl+A"))?,
        ],
    )?;
    let insert = Submenu::with_items(
        app,
        "Insert",
        true,
        &[
            &item(app, "insert_math", "Math Region", Some("CmdOrCtrl+Shift+M"))?,
            &item(app, "insert_text", "Text Region", Some("CmdOrCtrl+Shift+T"))?,
            &item(app, "insert_image", "Image…", Some("CmdOrCtrl+Shift+I"))?,
            &item(app, "insert_area", "Area", None)?,
            &sep()?,
            &item(app, "insert_toc", "Table of Contents", None)?,
            &item(app, "insert_figures", "List of Figures", None)?,
            &item(app, "insert_tables", "List of Tables", None)?,
        ],
    )?;
    let format = Submenu::with_items(
        app,
        "Format",
        true,
        &[
            &item(app, "fmt_bold", "Bold", Some("CmdOrCtrl+B"))?,
            &item(app, "fmt_italic", "Italic", Some("CmdOrCtrl+I"))?,
            &item(app, "fmt_underline", "Underline", Some("CmdOrCtrl+U"))?,
            &item(app, "fmt_strike", "Strikethrough", None)?,
            &sep()?,
            &item(app, "fmt_align_left", "Align Left", None)?,
            &item(app, "fmt_align_center", "Center", None)?,
            &item(app, "fmt_align_right", "Align Right", None)?,
            &item(app, "fmt_align_justify", "Justify", None)?,
            &sep()?,
            &item(app, "fmt_bullets", "Bulleted List", None)?,
            &item(app, "fmt_numbers", "Numbered List", None)?,
        ],
    )?;
    let arrange = Submenu::with_items(
        app,
        "Arrange",
        true,
        &[
            &item(app, "arrange_left", "Align Left Edges", None)?,
            &item(app, "arrange_hcenter", "Align Centres", None)?,
            &item(app, "arrange_right", "Align Right Edges", None)?,
            &sep()?,
            &item(app, "arrange_top", "Align Tops", None)?,
            &item(app, "arrange_vcenter", "Align Middles", None)?,
            &item(app, "arrange_bottom", "Align Bottoms", None)?,
            &sep()?,
            &item(app, "distribute_x", "Distribute Horizontally", None)?,
            &item(app, "distribute_y", "Distribute Vertically", None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "page_view", "Page View", Some("CmdOrCtrl+Shift+P"))?,
            &item(app, "toggle_inspector", "Show Inspector", Some("CmdOrCtrl+Alt+I"))?,
            &sep()?,
            &item(app, "zoom_in", "Zoom In", Some("CmdOrCtrl+="))?,
            &item(app, "zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?,
            &item(app, "zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?,
            &sep()?,
            &item(app, "next_error", "Next Error", Some("CmdOrCtrl+'"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    if mac {
        let app_menu = Submenu::with_items(
            app,
            "Quire",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Quire"), Some(about))?,
                &sep()?,
                &settings,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        return Menu::with_items(app, &[&app_menu, &file, &edit, &insert, &format, &arrange, &view, &window]);
    }
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&PredefinedMenuItem::about(app, Some("About Quire"), Some(about))?],
    )?;
    Menu::with_items(app, &[&file, &edit, &insert, &format, &arrange, &view, &window, &help])
}

fn main() {
    let job = export_job();
    if std::env::args().any(|a| a == "--export-pdf") && job.is_none() {
        eprintln!("usage: quire-app --export-pdf <document.quire> <output.pdf>");
        std::process::exit(2);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .setup(move |app| {
            let config = app.config().app.windows.first().cloned().expect("a window in tauri.conf.json");
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &config)?;
            if let Some(job) = &job {
                window =
                    window.visible(false).initialization_script(format!("window.__QUIRE_EXPORT__ = {job};"));
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            report,
            open_document,
            save_document,
            read_asset,
            new_document,
            djot_html,
            library,
            import_image,
            stage_image,
            print_document,
            export_pdf,
            finish_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quire");
}
