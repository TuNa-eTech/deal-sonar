use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/default.json");
    println!("cargo:rerun-if-changed=icons/icon.png");

    // Ensure `ui/dist/index.html` exists so `tauri::generate_context!()` always succeeds in fresh
    // Cargo check/clippy/test runs (`dist` is gitignored; `pnpm --filter @dealsonar/desktop-ui build`
    // overwrites this directory with the production bundle).
    let dist_index = Path::new("ui/dist/index.html");
    if !dist_index.exists() {
        if let Some(parent) = dist_index.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            dist_index,
            "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>DealSonar</title></head><body><div id=\"root\"></div></body></html>\n",
        );
    }

    tauri_build::build();
}
