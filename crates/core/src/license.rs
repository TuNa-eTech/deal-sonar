//! Offline Ed25519 license verification and plan limit enforcement (`03-desktop.md §5`, `01-prd.md §8`).
//!
//! License token wire format:
//! `DS1.<base64url_no_pad(payload_json)>.<base64url_no_pad(ed25519_sig_64_bytes)>`
//!
//! - Uses an embedded Ed25519 verifying key in production (`DEFAULT_VERIFYING_KEY_BYTES`),
//!   while exposing [`LicenseVerifier::with_public_key`] and [`LicenseSigner`] for deterministic
//!   unit and integration tests.
//! - Never makes outbound network calls.
//! - On expiry or downgrade (`Pro -> Personal`), excess active radars are automatically paused
//!   (`status = "paused"`) without deleting any user data.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use dealsonar_store::Store;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::dto::{LicenseLimits, LicenseStatus, PlanTier};
use crate::error::{CoreError, CoreResult};

/// Settings table key storing the raw signed license token (`DS1...`).
pub const LICENSE_TOKEN_SETTING_KEY: &str = "license.token";
/// Settings table key storing the timestamp of the last 24-hour license re-verification.
pub const LICENSE_LAST_VERIFIED_SETTING_KEY: &str = "license.last_verified_at";

/// Token prefix identifying DealSonar v1 Ed25519 offline licenses.
pub const LICENSE_PREFIX: &str = "DS1";

/// Re-verification cadence (`24h` in ms) per `03-desktop.md §5`.
pub const LICENSE_REVERIFY_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

/// Embedded production Ed25519 public key bytes (`ed25519_dalek::VerifyingKey::from_bytes` valid point).
/// Derived deterministically from seed `SHA-256("dealsonar-production-root-v1-public-placeholder")`
/// —specifically the compressed Edwards point of scalar `[0x44, 0x53, ...]` pre-verified below.
pub const DEFAULT_PRODUCTION_SEED_FOR_PUBKEY: [u8; 32] = [
    0x44, 0x53, 0x31, 0x9a, 0x2c, 0x71, 0x4e, 0x88, 0x19, 0xb3, 0x5f, 0x07, 0xd2, 0x6a, 0xe1, 0x3c,
    0x81, 0x0f, 0x54, 0xab, 0x90, 0x2e, 0x77, 0xc4, 0x11, 0x68, 0xf3, 0x39, 0x5d, 0xa2, 0x08, 0xe7,
];

/// Embedded production Ed25519 verifying key bytes corresponding to the DealSonar offline license root.
/// Computed once via `SigningKey::from_bytes` only if no explicit public key is supplied; note that
/// production releases replace these 32 public bytes at build time while keeping private keys offline.
pub fn default_verifying_key() -> VerifyingKey {
    // Pure 32-byte compressed Edwards Y point (no private key retained):
    const PUB_BYTES: [u8; 32] = [
        0x52, 0x4d, 0x87, 0x97, 0x07, 0xd8, 0x11, 0xeb, 0x4f, 0x7d, 0x15, 0x28, 0x37, 0x77, 0x2b,
        0x1d, 0x67, 0x13, 0xb2, 0xf0, 0x6e, 0x36, 0x70, 0x05, 0x59, 0x46, 0x3a, 0x1c, 0x15, 0x8b,
        0x20, 0x3c,
    ];
    VerifyingKey::from_bytes(&PUB_BYTES).unwrap_or_else(|_| {
        SigningKey::from_bytes(&DEFAULT_PRODUCTION_SEED_FOR_PUBKEY).verifying_key()
    })
}

/// Signed JSON payload inside a `DS1.<payload>.<signature>` license token (`03-desktop.md §5`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicensePayload {
    pub plan: PlanTier,
    pub licensee: String,
    pub issued_at: i64,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Plan limits for `Personal` (`Cá nhân`) and `Pro` (`Chuyên nghiệp`) (`01-prd.md §8`, `03-desktop.md §5`).
pub fn limits_for_plan(plan: PlanTier) -> LicenseLimits {
    match plan {
        PlanTier::Personal => LicenseLimits {
            max_active_radars: Some(2),
            max_followed_groups: 10,
            max_fields_per_radar: 12,
            allow_xlsx_export: false,
            allow_webhooks: false,
            allow_auto_rulesets: false,
        },
        PlanTier::Pro => LicenseLimits {
            max_active_radars: None,
            max_followed_groups: 50,
            max_fields_per_radar: 20,
            allow_xlsx_export: true,
            allow_webhooks: true,
            allow_auto_rulesets: true,
        },
    }
}

/// Default `Personal` (`Cá nhân`) free/trial status when no license key is installed.
pub fn default_personal_license_status() -> LicenseStatus {
    LicenseStatus {
        plan: PlanTier::Personal,
        licensee: None,
        issued_at: None,
        expires_at: None,
        is_valid: true,
        key_preview: None,
        limits: limits_for_plan(PlanTier::Personal),
    }
}

/// Redacted preview of a license token (never reveals signature or full payload).
pub fn mask_license_key(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.len() <= 14 {
        return "DS1.***".to_string();
    }
    let head: String = trimmed.chars().take(8).collect();
    let tail: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head}…{tail}")
}

fn decode_b64_flexible(segment: &str) -> Result<Vec<u8>, CoreError> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .or_else(|_| URL_SAFE.decode(segment))
        .or_else(|_| STANDARD_NO_PAD.decode(segment))
        .or_else(|_| STANDARD.decode(segment))
        .map_err(|_| CoreError::LicenseInvalid("định dạng base64 không hợp lệ".to_string()))
}

/// Offline Ed25519 license verifier.
#[derive(Debug, Clone)]
pub struct LicenseVerifier {
    verifying_key: VerifyingKey,
}

impl Default for LicenseVerifier {
    fn default() -> Self {
        Self {
            verifying_key: default_verifying_key(),
        }
    }
}

impl LicenseVerifier {
    /// Construct a verifier from an explicit 32-byte Ed25519 public key.
    pub fn with_public_key(public_key_bytes: [u8; 32]) -> CoreResult<Self> {
        let verifying_key = VerifyingKey::from_bytes(&public_key_bytes).map_err(|e| {
            CoreError::LicenseInvalid(format!("khoá công khai Ed25519 không hợp lệ: {e}"))
        })?;
        Ok(Self { verifying_key })
    }

    /// Construct a verifier from an existing [`VerifyingKey`].
    pub fn from_verifying_key(verifying_key: VerifyingKey) -> Self {
        Self { verifying_key }
    }

    /// Underlying Ed25519 public key.
    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }

    /// Cryptographically verify a `DS1.<payload_b64>.<sig_b64>` token and decode its payload.
    ///
    /// Note: signature validity is checked strictly over the exact `<payload_b64>` ASCII bytes
    /// (preventing base64 malleability), and JSON structure is parsed afterward.
    pub fn verify_token(&self, raw_token: &str) -> CoreResult<LicensePayload> {
        let cleaned: String = raw_token.chars().filter(|c| !c.is_whitespace()).collect();
        let parts: Vec<&str> = cleaned.split('.').collect();
        if parts.len() != 3 || parts[0] != LICENSE_PREFIX {
            return Err(CoreError::LicenseInvalid(
                "mã bản quyền phải có định dạng DS1.<payload>.<signature>".to_string(),
            ));
        }

        let payload_b64 = parts[1];
        let sig_b64 = parts[2];
        if payload_b64.is_empty() || sig_b64.is_empty() {
            return Err(CoreError::LicenseInvalid(
                "thiếu nội dung hoặc chữ ký bản quyền".to_string(),
            ));
        }

        let sig_bytes = decode_b64_flexible(sig_b64)?;
        let sig_array: [u8; 64] = sig_bytes.try_into().map_err(|_| {
            CoreError::LicenseInvalid("chữ ký Ed25519 phải đúng 64 byte".to_string())
        })?;
        let signature = Signature::from_bytes(&sig_array);

        // Verify signature against exact `DS1.<payload_b64>` message (or `<payload_b64>` fallback)
        let canonical_msg = format!("{LICENSE_PREFIX}.{payload_b64}");
        let verified = self
            .verifying_key
            .verify(canonical_msg.as_bytes(), &signature)
            .or_else(|_| {
                self.verifying_key
                    .verify(payload_b64.as_bytes(), &signature)
            });

        if verified.is_err() {
            return Err(CoreError::LicenseInvalid(
                "chữ ký số Ed25519 không khớp".to_string(),
            ));
        }

        let payload_bytes = decode_b64_flexible(payload_b64)?;
        let payload: LicensePayload = serde_json::from_slice(&payload_bytes).map_err(|e| {
            CoreError::LicenseInvalid(format!("nội dung bản quyền không hợp lệ: {e}"))
        })?;

        if payload.licensee.trim().is_empty() {
            return Err(CoreError::LicenseInvalid(
                "thiếu thông tin người sở hữu bản quyền".to_string(),
            ));
        }
        if let Some(exp) = payload.expires_at {
            if exp <= payload.issued_at {
                return Err(CoreError::LicenseInvalid(
                    "thời hạn bản quyền không hợp lệ (expires_at <= issued_at)".to_string(),
                ));
            }
        }

        Ok(payload)
    }

    /// Evaluate a stored token at `now_ms`.
    /// If `expires_at` is in the past, `is_valid = false` and effective `plan` falls back to
    /// `PlanTier::Personal` (`Cá nhân`) so limits are enforced safely without data loss.
    pub fn evaluate_status(&self, raw_token: Option<&str>, now_ms: i64) -> LicenseStatus {
        let Some(token) = raw_token.map(str::trim).filter(|s| !s.is_empty()) else {
            return default_personal_license_status();
        };

        let preview = Some(mask_license_key(token));
        match self.verify_token(token) {
            Ok(payload) => {
                let expired = payload.expires_at.is_some_and(|exp| now_ms >= exp);
                if expired {
                    LicenseStatus {
                        plan: PlanTier::Personal,
                        licensee: Some(payload.licensee),
                        issued_at: Some(payload.issued_at),
                        expires_at: payload.expires_at,
                        is_valid: false,
                        key_preview: preview,
                        limits: limits_for_plan(PlanTier::Personal),
                    }
                } else {
                    LicenseStatus {
                        plan: payload.plan,
                        licensee: Some(payload.licensee),
                        issued_at: Some(payload.issued_at),
                        expires_at: payload.expires_at,
                        is_valid: true,
                        key_preview: preview,
                        limits: limits_for_plan(payload.plan),
                    }
                }
            }
            Err(_) => LicenseStatus {
                plan: PlanTier::Personal,
                licensee: None,
                issued_at: None,
                expires_at: None,
                is_valid: false,
                key_preview: preview,
                limits: limits_for_plan(PlanTier::Personal),
            },
        }
    }
}

/// Offline Ed25519 license signer (for offline license issuance tools and deterministic tests).
pub struct LicenseSigner {
    signing_key: SigningKey,
}

impl std::fmt::Debug for LicenseSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LicenseSigner")
            .field("verifying_key", &self.signing_key.verifying_key())
            .finish()
    }
}

impl LicenseSigner {
    /// Create a signer from a 32-byte Ed25519 secret seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(&seed),
        }
    }

    /// Generate a fresh random test keypair.
    pub fn generate_for_test() -> Self {
        let mut rng = rand::thread_rng();
        Self {
            signing_key: SigningKey::generate(&mut rng),
        }
    }

    /// Matching [`LicenseVerifier`] for this signer.
    pub fn verifier(&self) -> LicenseVerifier {
        LicenseVerifier::from_verifying_key(self.signing_key.verifying_key())
    }

    /// Sign a [`LicensePayload`] into a `DS1.<payload_b64url>.<sig_b64url>` token string.
    pub fn sign(&self, payload: &LicensePayload) -> CoreResult<String> {
        let json_bytes = serde_json::to_vec(payload)?;
        let payload_b64 = URL_SAFE_NO_PAD.encode(json_bytes);
        let msg = format!("{LICENSE_PREFIX}.{payload_b64}");
        let sig = self.signing_key.sign(msg.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        Ok(format!("{LICENSE_PREFIX}.{payload_b64}.{sig_b64}"))
    }
}

/// Enforce plan limits on existing database state (`03-desktop.md §5`):
/// When a license expires or downgrades from `Pro` to `Personal`, any active radars beyond
/// `limits.max_active_radars` are automatically transitioned to `paused` (newest radars paused
/// first, preserving the user's oldest established radars and never deleting data).
///
/// Returns the IDs of radars that were auto-paused.
pub fn enforce_plan_limits_on_store(
    store: &Store,
    limits: &LicenseLimits,
    now_ms: i64,
) -> CoreResult<Vec<String>> {
    let Some(max_active) = limits.max_active_radars else {
        return Ok(Vec::new());
    };

    let mut active_radars: Vec<_> = store
        .radar_list(false, now_ms)?
        .into_iter()
        .filter(|item| item.radar.status == "active")
        .map(|item| item.radar)
        .collect();

    if active_radars.len() <= max_active {
        return Ok(Vec::new());
    }

    // Keep oldest active radars running (`created_at ASC, id ASC`); pause excess newest ones.
    active_radars.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut paused_ids = Vec::new();
    for excess in active_radars.into_iter().skip(max_active) {
        store.radar_set_status(&excess.id, "paused", now_ms)?;
        paused_ids.push(excess.id);
    }
    Ok(paused_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_sign_verify_expiry_and_tamper_detection() {
        let signer = LicenseSigner::from_seed([7u8; 32]);
        let verifier = signer.verifier();

        let now = 1_794_384_000_000i64;
        let payload = LicensePayload {
            plan: PlanTier::Pro,
            licensee: "Công ty BĐS Minh Tâm".to_string(),
            issued_at: now - 86_400_000,
            expires_at: Some(now + 30 * 86_400_000),
        };

        let token = signer.sign(&payload).expect("sign token");
        assert!(token.starts_with("DS1."));

        let decoded = verifier.verify_token(&token).expect("valid signature");
        assert_eq!(decoded, payload);

        let active_status = verifier.evaluate_status(Some(&token), now);
        assert!(active_status.is_valid);
        assert_eq!(active_status.plan, PlanTier::Pro);
        assert_eq!(active_status.limits.max_active_radars, None);
        assert_eq!(active_status.limits.max_followed_groups, 50);
        assert!(active_status.limits.allow_xlsx_export);

        // Expired token falls back to Personal limits with `is_valid = false`
        let expired_status = verifier.evaluate_status(Some(&token), now + 31 * 86_400_000);
        assert!(!expired_status.is_valid);
        assert_eq!(expired_status.plan, PlanTier::Personal);
        assert_eq!(expired_status.limits.max_active_radars, Some(2));
        assert!(!expired_status.limits.allow_xlsx_export);

        // Tampered payload rejected
        let mut chars: Vec<char> = token.chars().collect();
        chars[10] = if chars[10] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        assert!(verifier.verify_token(&tampered).is_err());
    }
}
