//! CLI adapter configuration and working directory handling.

use super::*;

/// Shared configuration for CLI-backed `AiProvider` adapters (`06-ai-bridge.md §3`).
#[derive(Debug, Clone)]
pub struct CliAdapterConfig {
    /// Executable name (searched in expanded `PATH`) or explicit binary path.
    pub binary_path: PathBuf,
    /// Dedicated empty directory used as `current_dir` for every CLI invocation.
    /// If `None`, the adapter creates and owns an isolated temporary `ai-workdir`.
    pub workdir: Option<PathBuf>,
    /// Tier-to-model mapping from user settings.
    pub model_tiers: ModelTierMap,
    /// Default mode used by `AiProvider::probe()`.
    pub default_probe_mode: ProbeMode,
    /// Timeout for `probe()` commands.
    pub probe_timeout: Duration,
    /// Optional explicit base `PATH` (mainly for hermetic tests).
    pub path_override: Option<OsString>,
    /// Whether to augment `PATH` with common user/system CLI directories (default `true`).
    pub expand_system_paths: bool,
    /// Extra environment variables passed to the CLI subprocess.
    pub extra_env: Vec<(String, String)>,
}

impl CliAdapterConfig {
    pub fn new(default_binary: &str) -> Self {
        Self {
            binary_path: PathBuf::from(default_binary),
            workdir: None,
            model_tiers: ModelTierMap::new(),
            default_probe_mode: ProbeMode::Full,
            probe_timeout: Duration::from_secs(30),
            path_override: None,
            expand_system_paths: true,
            extra_env: Vec::new(),
        }
    }

    pub fn with_binary_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary_path = path.into();
        self
    }

    pub fn with_workdir(mut self, workdir: impl Into<PathBuf>) -> Self {
        self.workdir = Some(workdir.into());
        self
    }

    pub fn with_model_tiers(mut self, tiers: ModelTierMap) -> Self {
        self.model_tiers = tiers;
        self
    }

    pub fn with_probe_mode(mut self, mode: ProbeMode) -> Self {
        self.default_probe_mode = mode;
        self
    }

    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    pub fn with_isolated_path(mut self, path: impl Into<OsString>) -> Self {
        self.path_override = Some(path.into());
        self.expand_system_paths = false;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), val.into()));
        self
    }

    pub(crate) fn effective_path(&self) -> OsString {
        let base = self
            .path_override
            .clone()
            .or_else(|| std::env::var_os("PATH"));
        if self.expand_system_paths {
            expanded_path_env(base.as_deref(), None)
        } else {
            base.unwrap_or_default()
        }
    }
}

/// Holds either a caller-configured `ai-workdir` path or an owned temporary directory.
#[derive(Debug)]
pub(crate) enum WorkdirHandle {
    Configured(PathBuf),
    Temp(ScopedTempDir),
}

impl WorkdirHandle {
    pub fn from_option(opt: Option<PathBuf>) -> Self {
        match opt {
            Some(p) => Self::Configured(p),
            None => {
                let td = ScopedTempDir::new("dealsonar-ai-workdir-")
                    .expect("create temporary ai-workdir");
                Self::Temp(td)
            }
        }
    }

    pub fn path(&self) -> &Path {
        match self {
            Self::Configured(p) => p.as_path(),
            Self::Temp(td) => td.path(),
        }
    }
}

pub(crate) type SharedWorkdir = Arc<WorkdirHandle>;
