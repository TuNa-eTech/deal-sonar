// The release workflow sets DEALSONAR_VERSION to the tag (without the leading "v") so the app,
// the extension manifest and the bundle all report the same release. Rebuild when it changes.
fn main() {
    println!("cargo:rerun-if-env-changed=DEALSONAR_VERSION");
}
