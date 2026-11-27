//! Version compatibility between the Chrome extension and the Desktop app.
//!
//! The wire protocol number (`PROTOCOL_VERSION`) is a hard gate: a different number is rejected
//! with `protocol_mismatch`. Chrome updates the extension on its own schedule and customers update
//! the Desktop app by hand, so the two routinely run different *releases* that share a protocol
//! number. Each side therefore also declares the oldest release of the other side it supports.
//! Bump these only for a behavioural break that the protocol number does not capture.

/// Oldest extension release this Desktop build works correctly with.
pub const MIN_EXTENSION_VERSION: &str = "0.1.0";

/// Oldest Desktop release the extension in this repository works correctly with. Mirrored by
/// `MIN_DESKTOP_VERSION` in `apps/extension/src/compat.ts`; `scripts/compat-constants.test.mjs`
/// fails if the two drift apart.
pub const MIN_DESKTOP_VERSION: &str = "0.1.0";

/// `(major, minor, patch)` of a `MAJOR.MINOR.PATCH[-prerelease][+build]` string.
pub fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let core = raw.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// `Some(true)` when `version` is older than `minimum`; `None` when either cannot be parsed
/// (unknown versions are never reported as outdated).
pub fn is_older_than(version: &str, minimum: &str) -> Option<bool> {
    Some(parse_version(version)? < parse_version(minimum)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_and_prerelease_versions() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("v0.3.0-rc.1"), Some((0, 3, 0)));
        assert_eq!(parse_version("0.3.0+build5"), Some((0, 3, 0)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("abc"), None);
    }

    #[test]
    fn older_than_compares_numerically_and_never_flags_unknown_versions() {
        assert_eq!(is_older_than("0.9.0", "0.10.0"), Some(true));
        assert_eq!(is_older_than("0.10.0", "0.9.0"), Some(false));
        assert_eq!(is_older_than("1.0.0", "1.0.0"), Some(false));
        assert_eq!(is_older_than("dev", "1.0.0"), None);
    }
}
