//! First-run pairing with the stable extension identity: a customer who installs the Desktop app
//! and the extension must be paired by "Kiểm tra lại" alone, without typing an extension ID.

use std::sync::Arc;

use dealsonar_ai_bridge::MockAiProvider;
use dealsonar_core::dto::ChromeConnectOptions;
use dealsonar_core::{CoreConfig, CoreServiceBuilder, KNOWN_CHROME_EXTENSION_IDS};
use dealsonar_protocol::native_manifest::NativeHostManifest;
use dealsonar_store::Store;

fn start(tmp: &tempfile::TempDir) -> (dealsonar_core::CoreService, std::path::PathBuf) {
    let manifest_path = tmp
        .path()
        .join("NativeMessagingHosts/com.dealsonar.host.json");
    let bin = tmp.path().join("dealsonar-native-host");
    std::fs::write(&bin, b"stub").unwrap();
    let service = CoreServiceBuilder::new(Store::open_in_memory().expect("store"))
        .with_config(CoreConfig {
            data_dir: tmp.path().join("data"),
            spawn_background_workers: false,
            chrome_manifest_path: Some(manifest_path.clone()),
            native_host_binary_path: Some(bin),
            ..CoreConfig::default()
        })
        .with_ai_provider(Arc::new(MockAiProvider::new()))
        .start()
        .expect("start service");
    (service, manifest_path)
}

fn origins(path: &std::path::Path) -> Vec<String> {
    let raw = std::fs::read_to_string(path).expect("manifest written");
    serde_json::from_str::<NativeHostManifest>(&raw)
        .expect("valid manifest")
        .allowed_origins
}

/// The extension ID Chrome derives from `manifest.json` `"key"` (SHA-256 of the DER key, first 16
/// bytes mapped to a-p). Reimplemented here so the test fails if the manifest key and the
/// compiled-in default ever drift apart.
fn id_from_manifest_key() -> String {
    use sha2::{Digest, Sha256};
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/extension/public/manifest.json"
    ))
    .expect("extension manifest");
    let key = raw
        .split("\"key\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("manifest key");
    let der = base64_decode(key);
    let digest = Sha256::digest(der);
    digest[..16]
        .iter()
        .flat_map(|b| [(b >> 4) + b'a', (b & 0x0f) + b'a'])
        .map(char::from)
        .collect()
}

fn base64_decode(input: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in input.bytes().filter(|c| *c != b'=') {
        let v = ALPHABET.iter().position(|a| *a == c).expect("base64") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_run_pairing_allows_the_stable_extension_id_without_typing_it() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (service, manifest_path) = start(&tmp);

    let result = service.chrome_connect(None).expect("chrome_connect");
    assert!(result.native_host_installed);

    let allowed = origins(&manifest_path);
    let stable = id_from_manifest_key();
    assert_eq!(
        dealsonar_core::DEFAULT_CHROME_EXTENSION_ID,
        stable,
        "compiled-in default extension ID must match the manifest key"
    );
    for known in KNOWN_CHROME_EXTENSION_IDS {
        assert!(
            allowed.contains(&format!("chrome-extension://{known}/")),
            "{known} missing from {allowed:?}"
        );
    }
    service.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_developer_supplied_id_is_added_without_dropping_the_stable_one() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let (service, manifest_path) = start(&tmp);
    let dev_id = "abcdefghijklmnopabcdefghijklmnop";

    service
        .chrome_connect(Some(ChromeConnectOptions {
            extension_id: Some(dev_id.to_string()),
            resume_crawl: false,
        }))
        .expect("chrome_connect with explicit id");
    let allowed = origins(&manifest_path);
    assert_eq!(allowed[0], format!("chrome-extension://{dev_id}/"));
    assert!(allowed.contains(&format!(
        "chrome-extension://{}/",
        dealsonar_core::DEFAULT_CHROME_EXTENSION_ID
    )));

    // Startup refresh keeps both origins after the app moves or updates.
    service
        .refresh_native_host_manifest_if_paired()
        .expect("refresh");
    assert_eq!(origins(&manifest_path), allowed);
    service.shutdown().await.expect("shutdown");
}
