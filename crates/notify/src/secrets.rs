use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Mutex, RwLock};
use thiserror::Error;

/// Default OS keyring service name (`04-data-model.md §4`).
pub const KEYRING_SERVICE: &str = "DealSonar";

/// Shared bot token account key used before/across per-channel assignment.
pub const TELEGRAM_BOT_TOKEN_KEY: &str = "telegram:bot_token";

/// Account key for a Telegram channel secret (`"telegram:<channel_id>"`).
pub fn telegram_channel_key(channel_id: &str) -> String {
    format!("telegram:{channel_id}")
}

/// Account key for a Webhook channel HMAC secret (`"webhook:<channel_id>"`).
pub fn webhook_channel_key(channel_id: &str) -> String {
    format!("webhook:{channel_id}")
}

/// Redacts all occurrences of `secret` inside `text` so credentials never leak into logs/errors.
pub fn redact_secret(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "[REDACTED]")
}

/// Wrapper around a sensitive string whose `Debug` and `Display` always emit `[REDACTED]`.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// Errors returned by secret storage backends.
#[derive(Debug, Error)]
pub enum SecretError {
    #[error("account key must not be empty")]
    EmptyKey,

    #[error("keyring backend error: {0}")]
    Backend(String),

    #[error("internal lock poisoned")]
    LockPoisoned,
}

/// Abstraction over OS keyring and deterministic in-memory test storage.
pub trait SecretStore: Send + Sync + fmt::Debug {
    fn get_secret(&self, key: &str) -> Result<Option<String>, SecretError>;
    fn set_secret(&self, key: &str, value: &str) -> Result<(), SecretError>;
    fn delete_secret(&self, key: &str) -> Result<(), SecretError>;
    fn delete_all_known(&self) -> Result<(), SecretError>;

    /// Deletes all secrets associated with the given `channel_ids` plus `telegram:bot_token`
    /// and any other tracked keys (used by `data_delete_all`).
    fn delete_all_for_channels(&self, channel_ids: &[String]) -> Result<(), SecretError> {
        self.delete_secret(TELEGRAM_BOT_TOKEN_KEY)?;
        for id in channel_ids {
            self.delete_secret(&telegram_channel_key(id))?;
            self.delete_secret(&webhook_channel_key(id))?;
        }
        self.delete_all_known()
    }
}

/// OS keyring implementation backed by the `keyring` crate (`service = "DealSonar"`).
pub struct KeyringSecretStore {
    service: String,
    known_keys: Mutex<HashSet<String>>,
}

impl KeyringSecretStore {
    /// Creates a `KeyringSecretStore` using the canonical `"DealSonar"` service name.
    pub fn new() -> Self {
        Self::with_service(KEYRING_SERVICE)
    }

    /// Creates a `KeyringSecretStore` with a custom service name (e.g. for isolated integration tests).
    pub fn with_service(service: impl Into<String>) -> Self {
        let mut initial = HashSet::new();
        initial.insert(TELEGRAM_BOT_TOKEN_KEY.to_string());
        Self {
            service: service.into(),
            known_keys: Mutex::new(initial),
        }
    }

    /// Pre-registers existing account keys (such as `"telegram:<id>"` or `"webhook:<id>"` loaded
    /// from SQLite `channels` at startup) so `delete_all_known()` will wipe them as well.
    pub fn register_known_keys<I, S>(&self, keys: I) -> Result<(), SecretError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut guard = self
            .known_keys
            .lock()
            .map_err(|_| SecretError::LockPoisoned)?;
        for key in keys {
            let k = key.into();
            if !k.is_empty() {
                guard.insert(k);
            }
        }
        Ok(())
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, SecretError> {
        if key.trim().is_empty() {
            return Err(SecretError::EmptyKey);
        }
        keyring::Entry::new(&self.service, key).map_err(|e| SecretError::Backend(e.to_string()))
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for KeyringSecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let key_count = self.known_keys.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("KeyringSecretStore")
            .field("service", &self.service)
            .field("known_key_count", &key_count)
            .field("secrets", &"[REDACTED]")
            .finish()
    }
}

impl SecretStore for KeyringSecretStore {
    fn get_secret(&self, key: &str) -> Result<Option<String>, SecretError> {
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(secret) => {
                if let Ok(mut guard) = self.known_keys.lock() {
                    guard.insert(key.to_string());
                }
                Ok(Some(secret))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    fn set_secret(&self, key: &str, value: &str) -> Result<(), SecretError> {
        let entry = self.entry(key)?;
        entry
            .set_password(value)
            .map_err(|e| SecretError::Backend(redact_secret(&e.to_string(), value)))?;
        let mut guard = self
            .known_keys
            .lock()
            .map_err(|_| SecretError::LockPoisoned)?;
        guard.insert(key.to_string());
        Ok(())
    }

    fn delete_secret(&self, key: &str) -> Result<(), SecretError> {
        let entry = self.entry(key)?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(SecretError::Backend(e.to_string())),
        }
        if let Ok(mut guard) = self.known_keys.lock() {
            guard.remove(key);
        }
        Ok(())
    }

    fn delete_all_known(&self) -> Result<(), SecretError> {
        let keys: Vec<String> = {
            let guard = self
                .known_keys
                .lock()
                .map_err(|_| SecretError::LockPoisoned)?;
            guard.iter().cloned().collect()
        };
        for key in keys {
            self.delete_secret(&key)?;
        }
        let mut guard = self
            .known_keys
            .lock()
            .map_err(|_| SecretError::LockPoisoned)?;
        guard.clear();
        guard.insert(TELEGRAM_BOT_TOKEN_KEY.to_string());
        Ok(())
    }
}

/// Deterministic in-memory `SecretStore` for unit and CI tests.
///
/// Its `Debug` implementation strictly redacts all stored secret values.
#[derive(Default)]
pub struct InMemorySecretStore {
    entries: RwLock<HashMap<String, String>>,
}

impl InMemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.read().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl fmt::Debug for InMemorySecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redacted_map: HashMap<String, &'static str> = self
            .entries
            .read()
            .map(|guard| guard.keys().map(|k| (k.clone(), "[REDACTED]")).collect())
            .unwrap_or_default();
        f.debug_struct("InMemorySecretStore")
            .field("entries", &redacted_map)
            .finish()
    }
}

impl SecretStore for InMemorySecretStore {
    fn get_secret(&self, key: &str) -> Result<Option<String>, SecretError> {
        if key.trim().is_empty() {
            return Err(SecretError::EmptyKey);
        }
        let guard = self.entries.read().map_err(|_| SecretError::LockPoisoned)?;
        Ok(guard.get(key).cloned())
    }

    fn set_secret(&self, key: &str, value: &str) -> Result<(), SecretError> {
        if key.trim().is_empty() {
            return Err(SecretError::EmptyKey);
        }
        let mut guard = self
            .entries
            .write()
            .map_err(|_| SecretError::LockPoisoned)?;
        guard.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete_secret(&self, key: &str) -> Result<(), SecretError> {
        if key.trim().is_empty() {
            return Err(SecretError::EmptyKey);
        }
        let mut guard = self
            .entries
            .write()
            .map_err(|_| SecretError::LockPoisoned)?;
        guard.remove(key);
        Ok(())
    }

    fn delete_all_known(&self) -> Result<(), SecretError> {
        let mut guard = self
            .entries
            .write()
            .map_err(|_| SecretError::LockPoisoned)?;
        guard.clear();
        Ok(())
    }
}
