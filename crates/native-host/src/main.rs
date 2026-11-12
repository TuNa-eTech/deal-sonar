//! Chrome Native Messaging host binary (`com.dealsonar.host`).
//!
//! Relays length-prefixed JSON frames verbatim between Chrome `stdin`/`stdout`
//! and the DealSonar desktop local IPC server.

use std::process::ExitCode;

use dealsonar_native_host::{run_relay, RelayConfig};

fn main() -> ExitCode {
    let config = match RelayConfig::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("dealsonar-native-host: failed to resolve IPC endpoint: {err}");
            return ExitCode::FAILURE;
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("dealsonar-native-host: failed to start runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(run_relay(tokio::io::stdin(), tokio::io::stdout(), config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("dealsonar-native-host: relay terminated with error: {err}");
            ExitCode::FAILURE
        }
    }
}
