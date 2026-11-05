//! `quire-app --export-pdf <document.quire> <output.pdf>`: the export runs in a hidden window,
//! and must always end (issue #59). The page reports each step to [`export_step`]; a thread here
//! ends the process if the page never starts or a step never finishes. It runs in Rust because
//! a page that never loaded, or that the system has suspended, runs no JavaScript at all.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// How long the page may take to report its first step: it only has to load and start.
const START: Duration = Duration::from_secs(30);
/// How long the whole export may take, start to finish (the print job itself allows 120 s).
const WHOLE: Duration = Duration::from_secs(140);

/// The step the page reported last, and when.
pub struct Progress(Mutex<Option<String>>);

/// Called by the page as the export moves on ("opening the document", "printing the PDF"…).
#[tauri::command]
pub fn export_step(progress: tauri::State<'_, Progress>, step: String) {
    *progress.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(step);
}

/// Start watching a headless export. The process exits (with the reason on stderr) when the
/// page doesn't start within [`START`] or the export doesn't end within [`WHOLE`];
/// `finish_export` ends it normally before that.
pub fn watch(app: &AppHandle) {
    app.manage(Progress(Mutex::new(None)));
    #[cfg(target_os = "macos")]
    keep_running();
    let app = app.clone();
    let started = Instant::now();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let step =
                app.state::<Progress>().0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            let reason = match step {
                None if started.elapsed() > START => Some(
                    "the page never started. If you built the app yourself, run `npm --prefix app run build`, \
                     then build the app again"
                        .to_string(),
                ),
                Some(step) if started.elapsed() > WHOLE => {
                    Some(format!("gave up after {} s while {step}", WHOLE.as_secs()))
                }
                _ => None,
            };
            if let Some(reason) = reason {
                eprintln!("quire: export failed: {reason}");
                std::process::exit(1);
            }
        }
    });
}

/// Tell macOS the export is work the user asked for: the process has no visible window, so
/// otherwise App Nap may slow its timers to a crawl while the screen is locked or asleep.
#[cfg(target_os = "macos")]
fn keep_running() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let reason = NSString::from_str("Exporting a PDF");
    let activity = NSProcessInfo::processInfo()
        .beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &reason);
    // held until the process exits, which is when the export ends
    std::mem::forget(activity);
}
