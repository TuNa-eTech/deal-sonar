//! Cross-platform local IPC endpoint resolution and async transport (`01-protocol.md §1`).
//!
//! Default endpoints:
//! - macOS: `~/Library/Application Support/DealSonar/ipc.sock`
//! - Linux: `$XDG_RUNTIME_DIR/dealsonar/ipc.sock` (fallback `~/.local/share/dealsonar/ipc.sock`)
//! - Windows: `\\.\pipe\dealsonar-<username>`
//! - Environment override (all platforms, useful for tests): `DEALSONAR_IPC_PATH`

use std::env;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, ReadHalf, WriteHalf};

use crate::framing::{
    read_frame_async, write_envelope_async, write_frame_async, FrameError, MAX_EXT_TO_HOST_BYTES,
    MAX_HOST_TO_EXT_BYTES,
};
use crate::Envelope;

/// Environment variable overriding the local IPC socket / named pipe path.
pub const DEALSONAR_IPC_PATH_ENV: &str = "DEALSONAR_IPC_PATH";

/// Operating system selector for deterministic path resolution tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcPlatform {
    MacOs,
    Linux,
    Windows,
}

impl IpcPlatform {
    /// Detect the current compile-target platform.
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Local IPC endpoint address (Unix domain socket path or Windows named pipe).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IpcEndpoint(PathBuf);

impl IpcEndpoint {
    /// Construct an `IpcEndpoint` from an explicit socket path or Windows pipe string.
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    /// Underlying filesystem / named-pipe path.
    pub fn as_path(&self) -> &Path {
        &self.0
    }

    /// Lossy UTF-8 string view for logging and diagnostics.
    pub fn to_string_lossy(&self) -> std::borrow::Cow<'_, str> {
        self.0.to_string_lossy()
    }
}

impl fmt::Display for IpcEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.to_string_lossy())
    }
}

impl From<PathBuf> for IpcEndpoint {
    fn from(value: PathBuf) -> Self {
        Self(value)
    }
}

impl From<&Path> for IpcEndpoint {
    fn from(value: &Path) -> Self {
        Self(value.to_path_buf())
    }
}

fn sanitize_pipe_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".to_owned()
    } else {
        cleaned
    }
}

/// Pure, deterministic IPC endpoint resolver accepting explicit environment values.
pub fn resolve_ipc_endpoint_with(
    platform: IpcPlatform,
    ipc_override: Option<&Path>,
    home_dir: Option<&Path>,
    xdg_runtime_dir: Option<&Path>,
    windows_user: Option<&str>,
) -> io::Result<IpcEndpoint> {
    if let Some(custom) = ipc_override {
        if !custom.as_os_str().is_empty() {
            if platform == IpcPlatform::Windows {
                let raw = custom.to_string_lossy();
                if raw.starts_with(r"\\.\pipe\") {
                    return Ok(IpcEndpoint::from_path(PathBuf::from(raw.as_ref())));
                }
                let name = sanitize_pipe_component(&raw);
                return Ok(IpcEndpoint::from_path(PathBuf::from(format!(
                    r"\\.\pipe\dealsonar-{name}"
                ))));
            }
            return Ok(IpcEndpoint::from_path(custom.to_path_buf()));
        }
    }

    match platform {
        IpcPlatform::MacOs => {
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "HOME directory is required to resolve macOS IPC path",
                    )
                })?;
            Ok(IpcEndpoint::from_path(
                home.join("Library")
                    .join("Application Support")
                    .join("DealSonar")
                    .join("ipc.sock"),
            ))
        }
        IpcPlatform::Linux => {
            if let Some(xdg) = xdg_runtime_dir.filter(|p| !p.as_os_str().is_empty()) {
                return Ok(IpcEndpoint::from_path(
                    xdg.join("dealsonar").join("ipc.sock"),
                ));
            }
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "neither XDG_RUNTIME_DIR nor HOME is set to resolve Linux IPC path",
                    )
                })?;
            Ok(IpcEndpoint::from_path(
                home.join(".local")
                    .join("share")
                    .join("dealsonar")
                    .join("ipc.sock"),
            ))
        }
        IpcPlatform::Windows => {
            let user = windows_user
                .filter(|u| !u.trim().is_empty())
                .map(sanitize_pipe_component)
                .unwrap_or_else(|| "default".to_owned());
            Ok(IpcEndpoint::from_path(PathBuf::from(format!(
                r"\\.\pipe\dealsonar-{user}"
            ))))
        }
    }
}

/// Resolve the active IPC endpoint, honoring `DEALSONAR_IPC_PATH` if set and non-empty.
pub fn resolve_ipc_endpoint() -> io::Result<IpcEndpoint> {
    let override_path = env::var_os(DEALSONAR_IPC_PATH_ENV).map(PathBuf::from);
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let xdg_runtime = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let win_user = env::var("USERNAME").or_else(|_| env::var("USER")).ok();

    resolve_ipc_endpoint_with(
        IpcPlatform::current(),
        override_path.as_deref(),
        home.as_deref(),
        xdg_runtime.as_deref(),
        win_user.as_deref(),
    )
}

/// Resolve the OS default IPC endpoint without consulting `DEALSONAR_IPC_PATH`.
pub fn default_ipc_endpoint() -> io::Result<IpcEndpoint> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let xdg_runtime = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let win_user = env::var("USERNAME").or_else(|_| env::var("USER")).ok();

    resolve_ipc_endpoint_with(
        IpcPlatform::current(),
        None,
        home.as_deref(),
        xdg_runtime.as_deref(),
        win_user.as_deref(),
    )
}

/// Pure resolver for the DealSonar application data directory (`03-desktop.md §2.1`).
pub fn default_data_dir_with(
    platform: IpcPlatform,
    home_dir: Option<&Path>,
    appdata_dir: Option<&Path>,
) -> io::Result<PathBuf> {
    match platform {
        IpcPlatform::MacOs => {
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "HOME directory is not set")
                })?;
            Ok(home
                .join("Library")
                .join("Application Support")
                .join("DealSonar"))
        }
        IpcPlatform::Linux => {
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "HOME directory is not set")
                })?;
            Ok(home.join(".local").join("share").join("dealsonar"))
        }
        IpcPlatform::Windows => {
            if let Some(appdata) = appdata_dir.filter(|p| !p.as_os_str().is_empty()) {
                return Ok(appdata.join("DealSonar"));
            }
            let home = home_dir
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "APPDATA / USERPROFILE directory is not set",
                    )
                })?;
            Ok(home.join("AppData").join("Roaming").join("DealSonar"))
        }
    }
}

/// Resolve the DealSonar application data directory for the current OS (`03-desktop.md §2.1`).
pub fn default_data_dir() -> io::Result<PathBuf> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let appdata = env::var_os("APPDATA").map(PathBuf::from);
    default_data_dir_with(IpcPlatform::current(), home.as_deref(), appdata.as_deref())
}

/// Ensure the parent directory of a Unix socket exists with mode `0700` (`01-protocol.md §1`).
#[cfg(unix)]
pub fn ensure_secure_socket_dir(dir: &Path) -> io::Result<()> {
    use std::fs::{self, DirBuilder, Permissions};
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    if !dir.exists() {
        let mut builder = DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(dir)?;
    }
    fs::set_permissions(dir, Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
pub fn ensure_secure_socket_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}

// ── Async IPC Transport ─────────────────────────────────────────────────────

#[cfg(unix)]
type InnerStream = tokio::net::UnixStream;

#[cfg(windows)]
enum InnerStream {
    Client(tokio::net::windows::named_pipe::NamedPipeClient),
    Server(tokio::net::windows::named_pipe::NamedPipeServer),
}

#[cfg(windows)]
impl AsyncRead for InnerStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Client(c) => Pin::new(c).poll_read(cx, buf),
            Self::Server(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

#[cfg(windows)]
impl AsyncWrite for InnerStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Client(c) => Pin::new(c).poll_write(cx, buf),
            Self::Server(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Client(c) => Pin::new(c).poll_flush(cx),
            Self::Server(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Client(c) => Pin::new(c).poll_shutdown(cx),
            Self::Server(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Bidirectional async IPC stream between `dealsonar-native-host` and the desktop app.
pub struct IpcStream {
    inner: InnerStream,
}

impl fmt::Debug for IpcStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IpcStream").finish_non_exhaustive()
    }
}

/// Read half of a split [`IpcStream`].
pub struct IpcReadHalf {
    inner: ReadHalf<IpcStream>,
}

/// Write half of a split [`IpcStream`].
pub struct IpcWriteHalf {
    inner: WriteHalf<IpcStream>,
}

impl IpcStream {
    /// Connect as a client to `endpoint`.
    pub async fn connect(endpoint: &IpcEndpoint) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let stream = tokio::net::UnixStream::connect(endpoint.as_path()).await?;
            Ok(Self { inner: stream })
        }

        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ClientOptions;
            let client = ClientOptions::new().open(endpoint.as_path())?;
            Ok(Self {
                inner: InnerStream::Client(client),
            })
        }
    }

    /// Connect as a client to the active IPC endpoint (`resolve_ipc_endpoint()`).
    pub async fn connect_default() -> io::Result<Self> {
        let endpoint = resolve_ipc_endpoint()?;
        Self::connect(&endpoint).await
    }

    /// Split into independent read and write halves for concurrent full-duplex I/O.
    pub fn into_split(self) -> (IpcReadHalf, IpcWriteHalf) {
        let (read_half, write_half) = tokio::io::split(self);
        (
            IpcReadHalf { inner: read_half },
            IpcWriteHalf { inner: write_half },
        )
    }

    /// Read one length-prefixed frame up to `max_bytes` (`Ok(None)` on clean EOF).
    pub async fn read_frame(&mut self, max_bytes: usize) -> Result<Option<Vec<u8>>, FrameError> {
        read_frame_async(self, max_bytes).await
    }

    /// Write one length-prefixed frame up to `max_bytes` and flush.
    pub async fn write_frame(
        &mut self,
        payload: &[u8],
        max_bytes: usize,
    ) -> Result<(), FrameError> {
        write_frame_async(self, payload, max_bytes).await
    }

    /// Desktop helper: read an incoming Extension -> Desktop frame (`<= 64 MiB`).
    pub async fn read_ext_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
        self.read_frame(MAX_EXT_TO_HOST_BYTES).await
    }

    /// Desktop helper: serialize and write a Desktop -> Extension `Envelope` (`<= 1 MiB`).
    pub async fn write_host_envelope(&mut self, envelope: &Envelope) -> Result<(), FrameError> {
        write_envelope_async(self, envelope, MAX_HOST_TO_EXT_BYTES).await
    }
}

impl AsyncRead for IpcStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for IpcStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl IpcReadHalf {
    /// Read one length-prefixed frame up to `max_bytes` (`Ok(None)` on clean EOF).
    pub async fn read_frame(&mut self, max_bytes: usize) -> Result<Option<Vec<u8>>, FrameError> {
        read_frame_async(&mut self.inner, max_bytes).await
    }

    /// Desktop helper: read an Extension -> Desktop frame (`<= 64 MiB`).
    pub async fn read_ext_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
        self.read_frame(MAX_EXT_TO_HOST_BYTES).await
    }

    /// Client/relay helper: read a Desktop -> Extension frame (`<= 1 MiB`).
    pub async fn read_host_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
        self.read_frame(MAX_HOST_TO_EXT_BYTES).await
    }
}

impl AsyncRead for IpcReadHalf {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl IpcWriteHalf {
    /// Write one length-prefixed frame up to `max_bytes` and flush.
    pub async fn write_frame(
        &mut self,
        payload: &[u8],
        max_bytes: usize,
    ) -> Result<(), FrameError> {
        write_frame_async(&mut self.inner, payload, max_bytes).await
    }

    /// Relay/client helper: write an Extension -> Desktop frame (`<= 64 MiB`).
    pub async fn write_ext_frame(&mut self, payload: &[u8]) -> Result<(), FrameError> {
        self.write_frame(payload, MAX_EXT_TO_HOST_BYTES).await
    }

    /// Desktop helper: write a Desktop -> Extension frame (`<= 1 MiB`).
    pub async fn write_host_frame(&mut self, payload: &[u8]) -> Result<(), FrameError> {
        self.write_frame(payload, MAX_HOST_TO_EXT_BYTES).await
    }

    /// Desktop helper: serialize and write a Desktop -> Extension `Envelope` (`<= 1 MiB`).
    pub async fn write_host_envelope(&mut self, envelope: &Envelope) -> Result<(), FrameError> {
        write_envelope_async(&mut self.inner, envelope, MAX_HOST_TO_EXT_BYTES).await
    }

    /// Client helper: serialize and write an Extension -> Desktop `Envelope` (`<= 64 MiB`).
    pub async fn write_ext_envelope(&mut self, envelope: &Envelope) -> Result<(), FrameError> {
        write_envelope_async(&mut self.inner, envelope, MAX_EXT_TO_HOST_BYTES).await
    }
}

impl AsyncWrite for IpcWriteHalf {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Local IPC listener bound by the desktop app to accept connections from one or more
/// `dealsonar-native-host` processes (one per Chrome profile).
pub struct IpcListener {
    endpoint: IpcEndpoint,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(unix)]
    bound_inode: Option<u64>,
    #[cfg(unix)]
    lock_socket_path: PathBuf,
    #[cfg(unix)]
    _lock_socket: std::os::unix::net::UnixDatagram,
    #[cfg(windows)]
    next_server: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
}

impl fmt::Debug for IpcListener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IpcListener")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

#[cfg(unix)]
fn lock_path_for_socket(sock_path: &Path) -> PathBuf {
    let mut os = sock_path.as_os_str().to_os_string();
    os.push(".lock");
    PathBuf::from(os)
}

impl IpcListener {
    /// Bind a listener at `endpoint`, creating the parent socket directory with `0700`
    /// permissions on Unix and cleaning up stale crashed sockets safely without
    /// perturbing any active listener's accept queue.
    pub fn bind(endpoint: &IpcEndpoint) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::fs::{self, Permissions};
            use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
            use std::os::unix::net::UnixDatagram;

            let sock_path = endpoint.as_path();
            if let Some(parent) = sock_path.parent() {
                if !parent.as_os_str().is_empty() {
                    ensure_secure_socket_dir(parent)?;
                }
            }

            let lock_socket_path = lock_path_for_socket(sock_path);
            if let Ok(lock_meta) = fs::symlink_metadata(&lock_socket_path) {
                if !lock_meta.file_type().is_socket() {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!(
                            "refusing to overwrite non-socket lock file at {}",
                            lock_socket_path.display()
                        ),
                    ));
                }
                let probe = UnixDatagram::unbound()?;
                if probe.connect(&lock_socket_path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        format!(
                            "an active DealSonar IPC server is already listening at {}",
                            sock_path.display()
                        ),
                    ));
                }
                let _ = fs::remove_file(&lock_socket_path);
            }

            if let Ok(meta) = fs::symlink_metadata(sock_path) {
                if !meta.file_type().is_socket() {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!(
                            "refusing to overwrite non-socket file at {}",
                            sock_path.display()
                        ),
                    ));
                }
                match std::os::unix::net::UnixStream::connect(sock_path) {
                    Ok(_live) => {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            format!(
                                "an active IPC socket is already listening at {}",
                                sock_path.display()
                            ),
                        ));
                    }
                    Err(_) => {
                        let _ = fs::remove_file(sock_path);
                    }
                }
            }

            let lock_socket = UnixDatagram::bind(&lock_socket_path)?;
            fs::set_permissions(&lock_socket_path, Permissions::from_mode(0o600))?;

            let listener = match tokio::net::UnixListener::bind(sock_path) {
                Ok(l) => l,
                Err(err) => {
                    drop(lock_socket);
                    let _ = fs::remove_file(&lock_socket_path);
                    return Err(err);
                }
            };
            fs::set_permissions(sock_path, Permissions::from_mode(0o600))?;
            let bound_inode = fs::symlink_metadata(sock_path).ok().map(|m| m.ino());

            Ok(Self {
                endpoint: endpoint.clone(),
                listener,
                bound_inode,
                lock_socket_path,
                _lock_socket: lock_socket,
            })
        }

        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(endpoint.as_path())?;
            Ok(Self {
                endpoint: endpoint.clone(),
                next_server: Some(server),
            })
        }
    }

    /// Bind a listener on the active IPC endpoint (`resolve_ipc_endpoint()`).
    pub fn bind_default() -> io::Result<Self> {
        let endpoint = resolve_ipc_endpoint()?;
        Self::bind(&endpoint)
    }

    /// Bound IPC endpoint address.
    pub fn endpoint(&self) -> &IpcEndpoint {
        &self.endpoint
    }

    /// Accept the next incoming native-host IPC client stream.
    pub async fn accept(&mut self) -> io::Result<IpcStream> {
        #[cfg(unix)]
        {
            let (stream, _addr) = self.listener.accept().await?;
            Ok(IpcStream { inner: stream })
        }

        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let server = self.next_server.take().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "named pipe listener closed")
            })?;
            server.connect().await?;
            let replacement = ServerOptions::new().create(self.endpoint.as_path())?;
            self.next_server = Some(replacement);
            Ok(IpcStream {
                inner: InnerStream::Server(server),
            })
        }
    }
}

#[cfg(unix)]
impl Drop for IpcListener {
    fn drop(&mut self) {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let sock_path = self.endpoint.as_path();
        if let Ok(meta) = std::fs::symlink_metadata(sock_path) {
            let same_inode = self
                .bound_inode
                .map(|ino| meta.ino() == ino)
                .unwrap_or(true);
            if meta.file_type().is_socket() && same_inode {
                let _ = std::fs::remove_file(sock_path);
                let _ = std::fs::remove_file(&self.lock_socket_path);
            }
        }
    }
}
