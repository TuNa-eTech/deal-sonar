use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::types::AiError;

/// RAII per-call temporary directory (`0700` on Unix) that deletes itself on `Drop`.
#[derive(Debug)]
pub struct ScopedTempDir {
    path: PathBuf,
}

impl ScopedTempDir {
    pub fn new(prefix: &str) -> std::io::Result<Self> {
        let base = std::env::temp_dir();
        let mut rng = rand::thread_rng();
        for _ in 0..64 {
            let token: u64 = rng.gen();
            let pid = std::process::id();
            let candidate = base.join(format!("{prefix}{pid}-{token:016x}"));
            match create_private_dir(&candidate) {
                Ok(()) => return Ok(Self { path: candidate }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "exhausted attempts creating ScopedTempDir",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir(path)
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Raw output of a completed subprocess invocation.
#[derive(Debug, Clone)]
pub struct SubprocessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration: Duration,
}

/// Builds an expanded `PATH` including common CLI installation locations missed by GUI launches
/// (`06-ai-bridge.md §3.1`).
pub fn expanded_path_env(base_path: Option<&OsStr>, home_override: Option<&Path>) -> OsString {
    let home = home_override
        .map(Path::to_path_buf)
        .or_else(detect_home_dir);

    let mut seen = HashSet::<PathBuf>::new();
    let mut dirs = Vec::<PathBuf>::new();

    let mut push_unique = |p: PathBuf| {
        if !p.as_os_str().is_empty() && seen.insert(p.clone()) {
            dirs.push(p);
        }
    };

    // 1. Existing PATH entries first so explicit caller/test overrides take priority.
    if let Some(existing) = base_path {
        for p in std::env::split_paths(existing) {
            push_unique(p);
        }
    }

    // 2. User-scoped CLI manager directories.
    if let Some(ref h) = home {
        push_unique(h.join(".local/bin"));
        push_unique(h.join(".cargo/bin"));
        push_unique(h.join(".npm-global/bin"));
        push_unique(h.join(".volta/bin"));
        push_unique(h.join("Library/pnpm"));
        push_unique(h.join(".local/share/pnpm"));
        push_unique(h.join(".bun/bin"));
        push_unique(h.join(".fnm/current/bin"));
        push_unique(h.join(".local/share/fnm/aliases/default/bin"));
        push_unique(h.join("Library/Application Support/fnm/aliases/default/bin"));

        // Discover nvm node versions (newest first).
        let nvm_versions = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            let mut version_bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| e.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            version_bins.sort_by(|a, b| b.cmp(a));
            for bin_dir in version_bins {
                push_unique(bin_dir);
            }
        }

        #[cfg(windows)]
        {
            push_unique(h.join("AppData/Roaming/npm"));
            push_unique(h.join("AppData/Local/pnpm"));
        }
    }

    // 3. System-wide package manager & standard Unix paths.
    #[cfg(unix)]
    {
        for sys in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            push_unique(PathBuf::from(sys));
        }
    }

    std::env::join_paths(dirs).unwrap_or_else(|_| base_path.unwrap_or_default().to_os_string())
}

fn detect_home_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    #[cfg(windows)]
    if let Some(up) = std::env::var_os("USERPROFILE") {
        if !up.is_empty() {
            return Some(PathBuf::from(up));
        }
    }
    None
}

/// Checks whether `path` is a regular executable file.
pub fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Locates `binary` either as an explicit path or within `expanded_path`.
pub fn resolve_binary_in_path(binary: &Path, expanded_path: &OsStr) -> Option<PathBuf> {
    let bin_str = binary.to_string_lossy();
    if binary.is_absolute() || bin_str.contains('/') || bin_str.contains('\\') {
        return is_executable_file(binary).then(|| binary.to_path_buf());
    }

    for dir in std::env::split_paths(expanded_path) {
        let candidate = dir.join(binary);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = dir.join(format!("{bin_str}.{ext}"));
                if is_executable_file(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }

    None
}

/// Ensures `workdir` exists and is completely empty so CLI agents never load project
/// instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude`, `.codex`, etc.) (`06-ai-bridge.md §3.1, §6`).
pub fn ensure_empty_workdir(workdir: &Path) -> Result<(), AiError> {
    std::fs::create_dir_all(workdir).map_err(|e| AiError::Process {
        code: -1,
        stderr: format!("failed to create ai-workdir '{}': {e}", workdir.display()),
    })?;

    let entries = std::fs::read_dir(workdir).map_err(|e| AiError::Process {
        code: -1,
        stderr: format!("failed to inspect ai-workdir '{}': {e}", workdir.display()),
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| AiError::Process {
            code: -1,
            stderr: format!("failed reading ai-workdir entry: {e}"),
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| AiError::Process {
            code: -1,
            stderr: format!("failed stat in ai-workdir '{}': {e}", path.display()),
        })?;
        let remove_res = if file_type.is_dir() && !file_type.is_symlink() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        remove_res.map_err(|e| AiError::Process {
            code: -1,
            stderr: format!("failed cleaning ai-workdir entry '{}': {e}", path.display()),
        })?;
    }

    Ok(())
}

#[cfg(unix)]
struct ProcessGroupGuard {
    pgid: Option<i32>,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    fn new(pid: Option<u32>) -> Self {
        let pgid = pid.and_then(|p| i32::try_from(p).ok()).filter(|&p| p > 0);
        Self { pgid }
    }

    fn kill_group(&self) {
        if let Some(pgid) = self.pgid {
            // SAFETY: `pgid` was created via `process_group(0)` for our direct child process,
            // so its PGID equals its positive PID. `killpg` sends SIGKILL to all members of that group.
            unsafe {
                let _ = libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        // Kill any surviving processes in the child's dedicated process group on timeout,
        // cancellation, or orphaned background grandchild.
        self.kill_group();
    }
}

/// Executes a CLI binary directly via `tokio::process::Command` (never a shell),
/// inside an empty `workdir`, feeding `stdin_bytes` via stdin, and enforcing a hard
/// process-group timeout (`06-ai-bridge.md §3.1, §6`).
pub async fn run_cli_subprocess(
    binary: &Path,
    args: &[String],
    stdin_bytes: Option<&[u8]>,
    workdir: &Path,
    expanded_path: &OsStr,
    extra_env: &[(String, String)],
    timeout: Duration,
) -> Result<SubprocessOutput, AiError> {
    let resolved_bin =
        resolve_binary_in_path(binary, expanded_path).ok_or(AiError::NotInstalled)?;
    ensure_empty_workdir(workdir)?;

    let mut cmd = Command::new(&resolved_bin);
    cmd.args(args)
        .current_dir(workdir)
        .env("PATH", expanded_path)
        .stdin(if stdin_bytes.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    #[cfg(unix)]
    {
        // Put the CLI into its own process group so timeout/drop kills the whole tree.
        cmd.process_group(0);
    }

    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AiError::NotInstalled
        } else {
            AiError::Process {
                code: -1,
                stderr: format!("failed to spawn '{}': {e}", resolved_bin.display()),
            }
        }
    })?;

    #[cfg(unix)]
    let pg_guard = ProcessGroupGuard::new(child.id());

    let mut child_stdin = child.stdin.take();
    let mut child_stdout = child.stdout.take().expect("stdout piped");
    let mut child_stderr = child.stderr.take().expect("stderr piped");
    let input_buf = stdin_bytes.map(|b| b.to_vec());

    let io_task = async {
        let write_fut = async move {
            if let (Some(mut stdin), Some(data)) = (child_stdin.take(), input_buf) {
                // Ignore BrokenPipe if child exits early (e.g. invalid flag or immediate auth error)
                // so we still collect its exit status and stderr cleanly.
                let _ = stdin.write_all(&data).await;
                let _ = stdin.flush().await;
                drop(stdin);
            }
        };

        let stdout_fut = async {
            let mut buf = Vec::new();
            child_stdout.read_to_end(&mut buf).await.map(|_| buf)
        };

        let stderr_fut = async {
            let mut buf = Vec::new();
            child_stderr.read_to_end(&mut buf).await.map(|_| buf)
        };

        let (_, stdout_res, stderr_res) = tokio::join!(write_fut, stdout_fut, stderr_fut);
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, stdout_res?, stderr_res?))
    };

    match tokio::time::timeout(timeout, io_task).await {
        Ok(Ok((status, stdout_bytes, stderr_bytes))) => {
            #[cfg(unix)]
            pg_guard.kill_group();

            let duration = started.elapsed();
            let exit_code = status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
            let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

            Ok(SubprocessOutput {
                exit_code,
                stdout,
                stderr,
                duration,
            })
        }
        Ok(Err(io_err)) => {
            #[cfg(unix)]
            pg_guard.kill_group();
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(AiError::Process {
                code: -1,
                stderr: format!("I/O error communicating with CLI: {io_err}"),
            })
        }
        Err(_elapsed) => {
            #[cfg(unix)]
            pg_guard.kill_group();
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(AiError::Timeout)
        }
    }
}
