//! Stateless bidirectional frame relay between Chrome Native Messaging (`stdio`)
//! and the DealSonar desktop app over local IPC (`01-protocol.md §1, §7`).
//!
//! Behavior:
//! - Forwards length-prefixed JSON frames verbatim in both directions concurrently
//!   (`stdin` -> IPC up to 64 MiB, IPC -> `stdout` up to 1 MiB).
//! - When local IPC cannot connect at startup or disconnects mid-stream:
//!   - Replies to each incoming `stdin` frame immediately with a v2 `error`
//!     envelope (`code = "desktop_unavailable"`, `retryable = true`,
//!     `reply_to = incoming_id`).
//!   - Retries connecting to desktop IPC every `reconnect_interval` (default 5s).
//! - When `stdin` closes (clean EOF), closes the IPC connection cleanly, flushes
//!   `stdout`, and returns `Ok(())`.

use std::io;
use std::time::Duration;

use dealsonar_protocol::framing::{
    read_frame_async, write_frame_async, FrameError, MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES,
};
use dealsonar_protocol::ipc::{resolve_ipc_endpoint, IpcEndpoint, IpcStream, IpcWriteHalf};
use dealsonar_protocol::{extract_envelope_id, Envelope};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// Default background IPC reconnect interval (`01-protocol.md §1`: 5 seconds).
pub const DEFAULT_RECONNECT_INTERVAL: Duration = Duration::from_secs(5);

/// Human-readable diagnostic message returned when desktop IPC is unreachable.
pub const DESKTOP_UNAVAILABLE_MESSAGE: &str =
    "DealSonar desktop app is not running or local IPC is unavailable";

/// Configuration for [`run_relay`].
#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub endpoint: IpcEndpoint,
    pub reconnect_interval: Duration,
}

impl RelayConfig {
    /// Create a relay configuration targeting `endpoint` with the default 5-second
    /// reconnect interval.
    pub fn new(endpoint: IpcEndpoint) -> Self {
        Self {
            endpoint,
            reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
        }
    }

    /// Override the background IPC reconnect interval (useful for fast integration tests).
    pub fn with_reconnect_interval(mut self, interval: Duration) -> Self {
        self.reconnect_interval = interval;
        self
    }

    /// Resolve configuration from the environment (`DEALSONAR_IPC_PATH` or OS default).
    pub fn from_env() -> io::Result<Self> {
        let endpoint = resolve_ipc_endpoint()?;
        Ok(Self::new(endpoint))
    }
}

/// Build the serialized UTF-8 JSON bytes for a v2 `desktop_unavailable` error envelope
/// responding to `incoming_frame`, guaranteeing the result fits within `MAX_HOST_TO_EXT_BYTES`.
pub fn build_desktop_unavailable_bytes(incoming_frame: &[u8]) -> Result<Vec<u8>, FrameError> {
    let incoming_id = extract_envelope_id(incoming_frame);
    let env = Envelope::desktop_unavailable(incoming_id, DESKTOP_UNAVAILABLE_MESSAGE);
    let bytes = serde_json::to_vec(&env)?;
    if bytes.len() <= MAX_HOST_TO_EXT_BYTES {
        Ok(bytes)
    } else {
        // Fallback if an incoming message carried a pathologically huge `id` (> 1 MiB).
        let fallback = Envelope::desktop_unavailable(None, DESKTOP_UNAVAILABLE_MESSAGE);
        Ok(serde_json::to_vec(&fallback)?)
    }
}

struct ActiveIpc {
    writer: IpcWriteHalf,
    reader_task: JoinHandle<()>,
    disconnect_rx: oneshot::Receiver<()>,
}

impl ActiveIpc {
    fn spawn(stream: IpcStream, stdout_tx: mpsc::Sender<Vec<u8>>) -> Self {
        let (mut reader, writer) = stream.into_split();
        let (disconnect_tx, disconnect_rx) = oneshot::channel();

        let reader_task = tokio::spawn(async move {
            while let Ok(Some(frame)) = reader.read_host_frame().await {
                if stdout_tx.send(frame).await.is_err() {
                    break;
                }
            }
            let _ = disconnect_tx.send(());
        });

        Self {
            writer,
            reader_task,
            disconnect_rx,
        }
    }

    async fn shutdown(mut self) {
        self.reader_task.abort();
        let _ = self.writer.shutdown().await;
    }

    fn abort_disconnected(self) {
        self.reader_task.abort();
    }
}

/// Run the stateless bidirectional frame relay until `stdin` reaches clean EOF or
/// an unrecoverable stdio framing error occurs.
pub async fn run_relay<R, W>(
    mut stdin: R,
    mut stdout: W,
    config: RelayConfig,
) -> Result<(), FrameError>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Result<Vec<u8>, FrameError>>(64);
    let (stdout_tx, mut stdout_rx) = mpsc::channel::<Vec<u8>>(64);

    let stdin_reader_task = tokio::spawn(async move {
        loop {
            match read_frame_async(&mut stdin, MAX_EXT_TO_HOST_BYTES).await {
                Ok(Some(frame)) => {
                    if stdin_tx.send(Ok(frame)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    let _ = stdin_tx.send(Err(err)).await;
                    break;
                }
            }
        }
    });

    let stdout_writer_task: JoinHandle<Result<(), FrameError>> = tokio::spawn(async move {
        while let Some(frame) = stdout_rx.recv().await {
            write_frame_async(&mut stdout, &frame, MAX_HOST_TO_EXT_BYTES).await?;
        }
        stdout.flush().await?;
        Ok(())
    });

    // Attempt initial connection immediately upon launch.
    let mut active_ipc = match IpcStream::connect(&config.endpoint).await {
        Ok(stream) => Some(ActiveIpc::spawn(stream, stdout_tx.clone())),
        Err(_) => None,
    };
    let mut next_reconnect_at = if active_ipc.is_none() {
        Some(Instant::now() + config.reconnect_interval)
    } else {
        None
    };

    let mut relay_result: Result<(), FrameError> = Ok(());

    loop {
        if let Some(conn) = &mut active_ipc {
            tokio::select! {
                _ = &mut conn.disconnect_rx => {
                    if let Some(dead) = active_ipc.take() {
                        dead.abort_disconnected();
                    }
                    next_reconnect_at = Some(Instant::now() + config.reconnect_interval);
                }
                maybe_msg = stdin_rx.recv() => {
                    match maybe_msg {
                        Some(Ok(frame)) => {
                            if conn.writer.write_ext_frame(&frame).await.is_err() {
                                if let Some(dead) = active_ipc.take() {
                                    dead.abort_disconnected();
                                }
                                next_reconnect_at = Some(Instant::now() + config.reconnect_interval);
                                let err_bytes = build_desktop_unavailable_bytes(&frame)?;
                                if stdout_tx.send(err_bytes).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Some(Err(err)) => {
                            if let Some(live) = active_ipc.take() {
                                live.shutdown().await;
                            }
                            relay_result = Err(err);
                            break;
                        }
                        None => {
                            // Clean EOF on stdin: close IPC cleanly and exit.
                            if let Some(live) = active_ipc.take() {
                                live.shutdown().await;
                            }
                            break;
                        }
                    }
                }
            }
        } else {
            let deadline =
                next_reconnect_at.unwrap_or_else(|| Instant::now() + config.reconnect_interval);
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    match IpcStream::connect(&config.endpoint).await {
                        Ok(stream) => {
                            active_ipc = Some(ActiveIpc::spawn(stream, stdout_tx.clone()));
                            next_reconnect_at = None;
                        }
                        Err(_) => {
                            next_reconnect_at = Some(Instant::now() + config.reconnect_interval);
                        }
                    }
                }
                maybe_msg = stdin_rx.recv() => {
                    match maybe_msg {
                        Some(Ok(frame)) => {
                            let err_bytes = build_desktop_unavailable_bytes(&frame)?;
                            if stdout_tx.send(err_bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(Err(err)) => {
                            relay_result = Err(err);
                            break;
                        }
                        None => {
                            // Clean EOF on stdin while disconnected.
                            break;
                        }
                    }
                }
            }
        }
    }

    drop(stdout_tx);
    stdin_reader_task.abort();

    let writer_outcome = stdout_writer_task
        .await
        .map_err(|join_err| FrameError::Io(io::Error::other(join_err.to_string())))?;

    relay_result?;
    writer_outcome
}
