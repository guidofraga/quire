fn main() {
    // A release build embeds the built front end (`npm run build` writes ../dist), but Cargo
    // doesn't know that: without this, a front end rebuilt after the app was compiled is
    // ignored and the app carries a stale or half-written page (issue #59). A missing folder
    // also counts as changed, so the first build after `npm run build` picks it up.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
