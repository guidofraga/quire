// Quire desktop app — GPL-3.0-or-later. The engine crates it calls are MIT OR Apache-2.0.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod pdf;
mod print;

use std::path::PathBuf;

use serde_json::{Value as Json, json};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, Wry};

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

/// Unsaved work, kept in the app's data folder so a crash or power cut loses little.
fn recovery_file(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recovery.json"))
}

#[tauri::command]
fn save_recovery(app: AppHandle, doc: Json, path: Option<String>) -> CmdResult<()> {
    let file = recovery_file(&app)?;
    let tmp = file.with_extension("json.tmp");
    let body = json!({ "path": path, "doc": doc });
    std::fs::write(&tmp, body.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The unsaved work left by the last session, if it ended without saving or discarding.
#[tauri::command]
fn take_recovery(app: AppHandle) -> CmdResult<Option<Json>> {
    let file = recovery_file(&app)?;
    let Ok(text) = std::fs::read_to_string(&file) else { return Ok(None) };
    Ok(serde_json::from_str(&text).ok())
}

#[tauri::command]
fn clear_recovery(app: AppHandle) -> CmdResult<()> {
    let file = recovery_file(&app)?;
    match std::fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn templates_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("templates"))
}

#[tauri::command]
fn list_templates(app: AppHandle) -> CmdResult<Vec<quire_service::templates::TemplateInfo>> {
    Ok(quire_service::templates::list(&templates_dir(&app)?))
}

#[tauri::command]
fn open_template(app: AppHandle, id: String) -> CmdResult<quire_service::templates::TemplateDocument> {
    quire_service::templates::document(&templates_dir(&app)?, &id).map_err(err)
}

#[tauri::command]
fn save_template(
    app: AppHandle,
    name: String,
    description: String,
    doc: Json,
    from: Option<PathBuf>,
) -> CmdResult<String> {
    quire_service::templates::save_as(&templates_dir(&app)?, &name, &description, &doc, from.as_deref())
        .map_err(err)
}

#[tauri::command]
fn delete_template(app: AppHandle, id: String) -> CmdResult<()> {
    quire_service::templates::delete(&templates_dir(&app)?, &id).map_err(err)
}

#[tauri::command]
fn library() -> quire_service::Library {
    quire_service::library()
}

/// A table's Export as CSV…: only ever writes a `.csv` file the user picked.
#[tauri::command]
fn export_csv(path: PathBuf, contents: String) -> CmdResult<()> {
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("csv")) {
        return Err("a table can only be exported to a .csv file".into());
    }
    std::fs::write(&path, contents).map_err(|e| format!("{}: {e}", path.display()))
}

/// Notebooks: list, create, rename, move, trash and search notes in a folder.
#[tauri::command]
fn notebook(op: String, args: Json) -> CmdResult<Json> {
    quire_service::notebook::call(&op, &args).map_err(err)
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
    info: Option<print::PdfInfo>,
) -> CmdResult<()> {
    print::export_pdf(&window, path, paper, title, compress, info.unwrap_or_default())
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

/// File ▸ Open Recent, refilled whenever the UI's list changes.
struct RecentMenu(Submenu<Wry>);

fn fill_recent(app: &AppHandle, menu: &Submenu<Wry>, paths: &[String]) -> tauri::Result<()> {
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    if paths.is_empty() {
        menu.append(&MenuItem::with_id(app, "recent_none", "No Recent Documents", false, None::<&str>)?)?;
        return Ok(());
    }
    for (i, p) in paths.iter().enumerate() {
        let path = std::path::Path::new(p.trim_end_matches(['/', '\\']));
        let name = path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
        // the folder disambiguates two documents with the same name
        let folder = path.parent().and_then(|d| d.file_name()).map(|d| d.to_string_lossy().into_owned());
        let label = match folder {
            Some(f) => format!("{name}  —  {f}"),
            None => name,
        };
        menu.append(&MenuItem::with_id(app, format!("recent:{i}"), label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "recent_clear", "Clear Menu", true, None::<&str>)?)?;
    Ok(())
}

#[tauri::command]
fn set_recent(app: AppHandle, paths: Vec<String>) -> CmdResult<()> {
    let menu = app.state::<RecentMenu>();
    fill_recent(&app, &menu.0, &paths).map_err(|e| e.to_string())
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
    let recent = Submenu::with_id(app, "recent", "Open Recent", true)?;
    fill_recent(app, &recent, &[])?;
    app.manage(RecentMenu(recent.clone()));
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "new", "New Note", Some("CmdOrCtrl+N"))?,
            &item(app, "new_section", "New Section", Some("CmdOrCtrl+Alt+N"))?,
            &item(app, "new_from_template", "New from Template…", Some("CmdOrCtrl+Shift+N"))?,
            &sep()?,
            &item(app, "new_notebook", "New Notebook…", None)?,
            &item(app, "open_notebook", "Open Notebook…", Some("CmdOrCtrl+Shift+O"))?,
            &sep()?,
            &item(app, "open", "Open…", Some("CmdOrCtrl+O"))?,
            &recent,
            &sep()?,
            &item(app, "save", "Save", Some("CmdOrCtrl+S"))?,
            &item(app, "save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
            &item(app, "save_template", "Save as Template…", None)?,
            &sep()?,
            &item(app, "export_pdf", "Export as PDF…", Some("CmdOrCtrl+E"))?,
            &item(app, "share_link", "Share Link…", None)?,
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
            &sep()?,
            &item(app, "find", "Find…", Some("CmdOrCtrl+F"))?,
            &item(app, "find_replace", "Find and Replace…", Some("CmdOrCtrl+Alt+F"))?,
            // Ctrl+G turns letters into Greek in math, so Windows and Linux use F3
            &item(app, "find_next", "Find Next", Some(if mac { "Cmd+G" } else { "F3" }))?,
            &item(app, "find_prev", "Find Previous", Some(if mac { "Cmd+Shift+G" } else { "Shift+F3" }))?,
        ],
    )?;
    let insert = Submenu::with_items(
        app,
        "Insert",
        true,
        &[
            &item(app, "insert_math", "Math", Some("CmdOrCtrl+Shift+M"))?,
            &item(app, "insert_text", "Text Region", Some("CmdOrCtrl+Shift+T"))?,
            &item(app, "insert_image", "Image…", Some("CmdOrCtrl+Shift+I"))?,
            &item(app, "insert_table", "Table", Some("CmdOrCtrl+Alt+T"))?,
            &item(app, "import_csv", "Table from CSV…", None)?,
            &item(app, "insert_plot", "Plot", Some("CmdOrCtrl+Alt+P"))?,
            &item(app, "insert_area", "Area", None)?,
            &sep()?,
            &item(app, "insert_toc", "Table of Contents", None)?,
            &item(app, "insert_figures", "List of Figures", None)?,
            &item(app, "insert_tables", "List of Tables", None)?,
            &item(app, "insert_checks", "Summary of Checks", None)?,
            &sep()?,
            &item(app, "insert_ref", "Cross-Reference…", Some("CmdOrCtrl+Shift+R"))?,
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
            &item(app, "command_palette", "Command Palette…", Some("CmdOrCtrl+K"))?,
            &item(app, "search_notebook", "Search Notebook…", Some("CmdOrCtrl+Shift+F"))?,
            &sep()?,
            &item(app, "toggle_sidebar", "Show Sidebar", Some("CmdOrCtrl+Backslash"))?,
            &item(app, "page_view", "Page View", Some("CmdOrCtrl+Shift+P"))?,
            &item(app, "toggle_inspector", "Show Inspector", Some("CmdOrCtrl+Alt+I"))?,
            &sep()?,
            &item(app, "zoom_in", "Zoom In", Some("CmdOrCtrl+="))?,
            &item(app, "zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?,
            &item(app, "zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?,
            &item(app, "zoom_fit_width", "Zoom to Width", None)?,
            &item(app, "zoom_fit_page", "Zoom to Page", None)?,
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
    let help_item = item(app, "help", "Quire Help", Some(if mac { "Cmd+Shift+/" } else { "F1" }))?;
    let updates = item(app, "check_updates", "Check for Updates…", None)?;
    if mac {
        let app_menu = Submenu::with_items(
            app,
            "Quire",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Quire"), Some(about))?,
                &updates,
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
        let help = Submenu::with_items(app, "Help", true, &[&help_item])?;
        return Menu::with_items(
            app,
            &[&app_menu, &file, &edit, &insert, &format, &arrange, &view, &window, &help],
        );
    }
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&help_item, &updates, &sep()?, &PredefinedMenuItem::about(app, Some("About Quire"), Some(about))?],
    )?;
    Menu::with_items(app, &[&file, &edit, &insert, &format, &arrange, &view, &window, &help])
}

/// Documents the system asked us to open (command line, Finder, Explorer) before the
/// UI was ready to take them; afterwards they go straight to the UI as `open-file` events.
#[derive(Default)]
struct OpenRequests {
    ready: bool,
    pending: Vec<String>,
}

type Requests = std::sync::Mutex<OpenRequests>;

fn is_document(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".quire") || p.ends_with(".quirez") || p.ends_with(".quire/") || p.ends_with("document.json")
}

fn request_open(app: &AppHandle, path: String) {
    let state = app.state::<Requests>();
    let mut r = state.lock().expect("open requests lock");
    if r.ready {
        let _ = app.emit("open-file", path);
    } else {
        r.pending.push(path);
    }
}

/// Called once by the UI when it can open documents: hands over what arrived before.
#[tauri::command]
fn take_open_requests(state: tauri::State<'_, Requests>) -> Vec<String> {
    let mut r = state.lock().expect("open requests lock");
    r.ready = true;
    std::mem::take(&mut r.pending)
}

fn main() {
    let job = export_job();
    // Windows and Linux pass a double-clicked document as an argument
    let launch_docs: Vec<String> = if job.is_some() {
        Vec::new()
    } else {
        std::env::args().skip(1).filter(|a| !a.starts_with('-') && is_document(a)).collect()
    };
    if std::env::args().any(|a| a == "--export-pdf") && job.is_none() {
        eprintln!("usage: quire-app --export-pdf <document.quire> <output.pdf>");
        std::process::exit(2);
    }
    let app = tauri::Builder::default()
        .manage::<Requests>(std::sync::Mutex::new(OpenRequests { ready: false, pending: launch_docs }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            list_templates,
            open_template,
            save_template,
            delete_template,
            djot_html,
            library,
            import_image,
            stage_image,
            print_document,
            export_pdf,
            finish_export,
            export_csv,
            notebook,
            take_open_requests,
            set_recent,
            save_recovery,
            take_recovery,
            clear_recovery
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Quire");
    app.run(|handle, event| {
        // macOS delivers Finder double-clicks and "Open With" as events, also at launch
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    request_open(handle, path.to_string_lossy().into_owned());
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event, request_open);
    });
}
