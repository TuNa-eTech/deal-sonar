// Tauri bundle overrides generated for a release build. Signing is opt-in through the environment
// so that builds without the project owner's certificates still work (and are then labelled as
// internal trial builds by scripts/release-manifest.mjs).
export function buildDesktopConfig(version, env = process.env) {
  const appleIdentity = env.APPLE_SIGNING_IDENTITY?.trim();
  const windowsThumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
  // Certificates issued since 2023-06-01 keep their private key in an HSM/token and cannot be
  // exported as a PFX; those are signed through a provider CLI invoked as `<command> "%1"`.
  const windowsSignCommand = env.WINDOWS_SIGN_COMMAND?.trim();
  return {
    version,
    bundle: {
      externalBin: ["binaries/dealsonar-native-host"],
      createUpdaterArtifacts: false,
      // "-" is a local ad-hoc signature (required to run on Apple Silicon). It is not a publisher
      // identity and is never treated as signed.
      macOS: { signingIdentity: appleIdentity || "-" },
      windows: {
        certificateThumbprint: windowsThumbprint || null,
        digestAlgorithm: "sha256",
        timestampUrl: env.WINDOWS_TIMESTAMP_URL?.trim() || "http://timestamp.digicert.com",
        signCommand: windowsSignCommand || null,
      },
    },
  };
}
