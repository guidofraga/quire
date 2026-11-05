//! `quire-app --export-pdf <document.quire> <output.pdf>`: the export runs in a hidden window,
//! and must always end (issue #59). The page reports each step to [`export_step`]; a thread here
//! ends the process if the page never starts or a step never finishes. It runs in Rust because
//! a page that never loaded, or that the system has suspended, runs no JavaScript at all.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// How long the page may take to report its first step: it only has to load and start, which
/// takes a few seconds, but WebKitGTK on a busy CI machine is slow.
const START: Duration = Duration::from_secs(60);
/// How long the whole export may take, start to finish (the print job itself allows 120 s).
const WHOLE: Duration = Duration::from_secs(140);

/// When the export started, and the step the page reported last.
pub struct Progress {
    started: Instant,
    step: Mutex<Option<String>>,
}

/// Called by the page as the export moves on ("opening the document", "printing the PDF"…).
/// Each step goes to stderr with its time, so a slow or stuck export shows where it spent it.
#[tauri::command]
pub fn export_step(progress: tauri::State<'_, Progress>, step: String) {
    eprintln!("quire: {:.1} s: {step}", progress.started.elapsed().as_secs_f64());
    *progress.step.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(step);
}

/// Start watching a headless export. The process exits (with the reason on stderr) when the
/// page doesn't start within [`START`] or the export doesn't end within [`WHOLE`];
/// `finish_export` ends it normally before that.
pub fn watch(app: &AppHandle) {
    let started = Instant::now();
    app.manage(Progress { started, step: Mutex::new(None) });
    #[cfg(target_os = "macos")]
    keep_running();
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let step = app
                .state::<Progress>()
                .step
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
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
