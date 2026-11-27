use std::fs;
use std::path::Path;

fn track_dir_recursive(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            track_dir_recursive(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/default.json");
    println!("cargo:rerun-if-changed=icons/icon.png");

    // Ensure `ui/dist/index.html` exists so `tauri::generate_context!()` always succeeds in fresh
    // Cargo check/clippy/test runs (`dist` is gitignored; `pnpm --filter @dealsonar/desktop-ui build`
    // overwrites this directory with the production bundle).
    let dist_dir = Path::new("ui/dist");
    let dist_index = dist_dir.join("index.html");
    if !dist_index.exists() {
        let _ = fs::create_dir_all(dist_dir);
        let _ = fs::write(
            &dist_index,
            "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>DealSonar</title></head><body><div id=\"root\"></div></body></html>\n",
        );
    }
    track_dir_recursive(dist_dir);

    tauri_build::build();
}
