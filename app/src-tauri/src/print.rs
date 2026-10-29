//! Printing and PDF export through WebKit's own print engine.
//!
//! The editor's page view already lays the document out as paper-sized sheets, so the
//! print operation uses the exact paper size with zero margins and no scaling: what is
//! on screen is what lands in the PDF. On macOS a "save" print job writes the PDF directly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::WebviewWindow;

/// Paper size in PostScript points (1/72 in), already rotated for landscape.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub width_pt: f64,
    pub height_pt: f64,
}

/// A place on a page: page index from 0, and points from the top of the paper.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Spot {
    pub page: usize,
    pub top: f64,
}

/// A bookmark for a heading; `title` already carries its number ("2.1 Bending").
#[derive(Debug, Clone, Deserialize)]
pub struct Heading {
    pub title: String,
    pub level: u8,
    #[serde(flatten)]
    pub at: Spot,
}

/// A clickable box the print engine does not make itself (a contents-list row), in points
/// from the paper's top-left corner, that jumps to the region `to`.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkBox {
    pub page: usize,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub to: String,
}

/// What the page view knows and the print engine does not: the document's details, its
/// headings and where every cross-reference target landed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfInfo {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
    pub company: String,
    pub lang: String,
    /// The number printed on the first page.
    pub first_page: Option<i64>,
    pub outline: Vec<Heading>,
    /// Region id → where it starts.
    pub targets: HashMap<String, Spot>,
    pub links: Vec<LinkBox>,
}

#[cfg(target_os = "macos")]
unsafe fn start(
    webview: *mut std::ffi::c_void,
    window: *mut std::ffi::c_void,
    paper: Paper,
    save_to: Option<&Path>,
    title: &str,
) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
        NSWindow,
    };
    use objc2_foundation::{NSCopying, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    // SAFETY: Tauri hands us the live WKWebView and its NSWindow on the main thread.
    let (webview, window) = unsafe { (&*(webview as *const WKWebView), &*(window as *const NSWindow)) };

    let info = NSPrintInfo::sharedPrintInfo().copy();
    info.setPaperSize(NSSize::new(paper.width_pt, paper.height_pt));
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    info.setHorizontalPagination(NSPrintingPaginationMode::Clip);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);

    if let Some(path) = save_to {
        let path = path.to_str().ok_or("the PDF path is not valid UTF-8")?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        // SAFETY: the print-info dictionary takes NSString keys and object values.
        unsafe {
            let dict = info.dictionary();
            let disposition: &AnyObject = NSPrintSaveJob.as_ref();
            let url_obj: &AnyObject = url.as_ref();
            dict.insert(NSPrintJobDisposition, disposition);
            dict.insert(NSPrintJobSavingURL, url_obj);
        }
    }

    // SAFETY: printOperationWithPrintInfo: exists on macOS 11+, the app's minimum is 12.
    let op = unsafe { webview.printOperationWithPrintInfo(&info) };
    op.setShowsPrintPanel(save_to.is_none());
    op.setShowsProgressPanel(save_to.is_none());
    op.setJobTitle(Some(&NSString::from_str(title)));
    // WebKit prints blank pages unless the print view has a real frame.
    if let Some(view) = op.view() {
        view.setFrame(webview.frame());
    }
    // SAFETY: no delegate and no context pointer.
    unsafe {
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            None,
            None,
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run(window: &WebviewWindow, paper: Paper, save_to: Option<PathBuf>, title: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |wv| {
            // SAFETY: with_webview runs on the main thread with valid native handles.
            let r = unsafe { start(wv.inner(), wv.ns_window(), paper, save_to.as_deref(), &title) };
            let _ = tx.send(r);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// The print job finishes asynchronously; wait until the file exists and stops growing.
fn wait_for_file(path: &Path, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    let (mut last, mut stable_since) = (0u64, Instant::now());
    while start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(100));
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size == 0 || size != last {
            last = size;
            stable_since = Instant::now();
        } else if stable_since.elapsed() > Duration::from_millis(500) {
            return Ok(());
        }
    }
    Err(format!("timed out writing {}", path.display()))
}

pub fn print(window: &WebviewWindow, paper: Paper, title: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return run(window, paper, None, title);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paper, title);
        window.print().map_err(|e| e.to_string())
    }
}

pub fn export_pdf(
    window: &WebviewWindow,
    path: PathBuf,
    paper: Paper,
    title: String,
    compress: bool,
    info: PdfInfo,
) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        run(window, paper, Some(path.clone()), title)?;
        wait_for_file(&path, Duration::from_secs(120))?;
        // bookmarks, links and smaller images are a bonus; the PDF is already complete without them
        if let Err(e) = crate::pdf::finish(&path, &info, compress) {
            eprintln!("quire: could not finish {}: {e}", path.display());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, paper, title, compress, info, wait_for_file);
        Err("direct PDF export is macOS-only for now; use Print and choose a PDF printer".into())
    }
}
