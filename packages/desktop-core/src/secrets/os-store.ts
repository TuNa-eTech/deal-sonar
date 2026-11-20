// Native credential adapters that read and write the entries the Tauri build created with the
// Rust `keyring` 2.3 crate (service "DealSonar", account = secret key such as
// "telegram:bot_token", "telegram:<channel_id>", "webhook:<channel_id>"):
//
//   macOS   login Keychain generic password: service="DealSonar", account=<key>, UTF-8 bytes.
//   Windows Credential Manager CRED_TYPE_GENERIC: TargetName="<key>.DealSonar", UserName=<key>,
//           CredentialBlob = UTF-16LE of the secret, Persist=ENTERPRISE.
//   Linux   Secret Service item with attributes {service:"DealSonar", username:<key>} (the
//           Rust writer also sets application="rust-keyring"; lookups match on service+username
//           only so entries written with or without the legacy `application` attribute are found).
//
// No native addon: the OS tools are spawned without a shell. Secrets are only passed on stdin
// (never argv or env) and every error message is passed through `redactSecret`.

import {
  BaseSecretStore,
  KEYRING_SERVICE,
  SecretError,
  TELEGRAM_BOT_TOKEN_KEY,
  redactSecret,
} from "./types";
import { type CommandRunner, type RunResult, defaultRunner } from "./runner";

/** A keychain/credential prompt can wait on the user. */
const INTERACTIVE_TIMEOUT_MS = 120_000;

abstract class OsSecretStore extends BaseSecretStore {
  protected readonly knownKeys = new Set<string>([TELEGRAM_BOT_TOKEN_KEY]);

  constructor(
    protected readonly service: string,
    protected readonly run: CommandRunner,
  ) {
    super();
  }

  /** Pre-register keys (e.g. from SQLite `channels`) so `deleteAllKnown` wipes them too. */
  registerKnownKeys(keys: Iterable<string>): void {
    for (const k of keys) if (k !== "") this.knownKeys.add(k);
  }

  protected assertKey(key: string): void {
    if (key.trim() === "") throw new SecretError("empty_key", "account key must not be empty");
    if (key.includes("\0")) throw new SecretError("invalid_key", "account key contains a NUL byte");
  }

  protected abstract read(key: string): Promise<string | null>;
  protected abstract write(key: string, value: string): Promise<void>;
  protected abstract remove(key: string): Promise<void>;

  async getSecret(key: string): Promise<string | null> {
    this.assertKey(key);
    const value = await this.read(key);
    if (value !== null) this.knownKeys.add(key);
    return value;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.assertKey(key);
    await this.write(key, value);
    this.knownKeys.add(key);
  }

  async deleteSecret(key: string): Promise<void> {
    this.assertKey(key);
    await this.remove(key);
    this.knownKeys.delete(key);
  }

  async deleteAllKnown(): Promise<void> {
    for (const key of [...this.knownKeys]) await this.deleteSecret(key);
    this.knownKeys.clear();
    this.knownKeys.add(TELEGRAM_BOT_TOKEN_KEY);
  }

  toJSON(): Record<string, unknown> {
    return { service: this.service, known_key_count: this.knownKeys.size, secrets: "[REDACTED]" };
  }

  protected spawnFailure(tool: string, r: RunResult): SecretError | null {
    if (r.spawnError) {
      const missing = r.spawnError.code === "ENOENT";
      return new SecretError(
        missing ? "unavailable" : "backend",
        missing ? `${tool} is not installed` : `${tool} could not be started: ${r.spawnError.code ?? "error"}`,
        false,
      );
    }
    if (r.timedOut) return new SecretError("locked", `${tool} timed out waiting for the keychain`, true);
    return null;
  }
}

// ── macOS ──────────────────────────────────────────────────────────────────────────────────

/** `security` exit codes/messages meaning "needs the user": locked, denied or cancelled. */
const MAC_RETRYABLE = /user interaction is not allowed|user canceled|authorization.*denied|passphrase you entered is not correct|errSecAuthFailed|errSecInteractionNotAllowed|-25308|-25293|-128/i;
const MAC_NOT_FOUND = /could not be found in the keychain|errSecItemNotFound|-25300/i;

/**
 * Parse the `password:` line printed by `security find-generic-password -g` (stderr). It is
 * `password: "text"` for printable data or `password: 0xHEX  "text\000"` otherwise. Using `-g`
 * rather than `-w` avoids `-w`'s hex-vs-text ambiguity (a hex-looking secret is not decoded).
 */
export function parseSecurityPassword(stderr: string): string | null {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith("password:"));
  if (!line) return null;
  const rest = line.slice("password:".length).trim();
  if (rest === "<NULL>" || rest === "") return rest === "" ? "" : null;
  const hex = /^0x([0-9A-Fa-f]*)/.exec(rest);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
  if (rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  return null;
}

export class MacKeychainStore extends OsSecretStore {
  constructor(service: string = KEYRING_SERVICE, run: CommandRunner = defaultRunner, private readonly securityPath = "/usr/bin/security") {
    super(service, run);
  }

  private async security(args: string[], input?: string): Promise<RunResult> {
    const r = await this.run(this.securityPath, args, { input, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    const failed = this.spawnFailure("security", r);
    if (failed) throw failed;
    return r;
  }

  protected async read(key: string): Promise<string | null> {
    const r = await this.security(["find-generic-password", "-s", this.service, "-a", key, "-g"]);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      const secret = parseSecurityPassword(r.stderr);
      if (secret === null) throw new SecretError("backend", "keychain returned an unreadable password");
      return secret;
    }
    if (r.code === 44 || MAC_NOT_FOUND.test(text)) return null;
    throw this.macError(r);
  }

  protected async write(key: string, value: string): Promise<void> {
    // `-X` takes hex, so the secret needs no shell/quote handling. The command goes through
    // `security -i` on stdin so the secret never appears in the process argument list.
    const hex = Buffer.from(value, "utf8").toString("hex");
    const quoted = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const line = `add-generic-password -U -s ${quoted(this.service)} -a ${quoted(key)} -X ${hex}\n`;
    const r = await this.security(["-i"], line);
    if (r.code !== 0 || /^security:|error|SecKeychain/i.test(r.stderr)) throw this.macError(r, value);
  }

  protected async remove(key: string): Promise<void> {
    const r = await this.security(["delete-generic-password", "-s", this.service, "-a", key]);
    if (r.code === 0 || r.code === 44 || MAC_NOT_FOUND.test(`${r.stdout}\n${r.stderr}`)) return;
    throw this.macError(r);
  }

  private macError(r: RunResult, secret?: string): SecretError {
    let message = (r.stderr || r.stdout || `security exited with ${r.code}`).trim();
    if (secret) message = redactSecret(message, secret);
    return MAC_RETRYABLE.test(message) || r.code === 36 || r.code === 51
      ? new SecretError("locked", `keychain access needs your attention: ${message}`, true)
      : new SecretError("backend", message);
  }
}

// ── Windows ────────────────────────────────────────────────────────────────────────────────

const WIN_CRED_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DsCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buf);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return null;
      throw new Exception("CredRead failed: " + e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string comment, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.Comment = comment; c.UserName = user; c.Persist = 3;
    c.CredentialBlobSize = (uint)blob.Length;
    IntPtr mem = Marshal.AllocHGlobal(blob.Length == 0 ? 1 : blob.Length);
    try {
      if (blob.Length > 0) Marshal.Copy(blob, 0, mem, blob.Length);
      c.CredentialBlob = mem;
      if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(mem); }
  }
  public static bool Delete(string target) {
    if (CredDelete(target, 1, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == 1168) return false;
    throw new Exception("CredDelete failed: " + e);
  }
}
'@
function Dec([string]$b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
`;

/** Credential Manager target name used by keyring 2.x: `<username>.<service>`. */
export const windowsTargetName = (service: string, key: string): string => `${key}.${service}`;

export class WindowsCredentialStore extends OsSecretStore {
  constructor(service: string = KEYRING_SERVICE, run: CommandRunner = defaultRunner, private readonly powershell = "powershell.exe") {
    super(service, run);
  }

  private b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

  private async ps(body: string): Promise<RunResult> {
    // Script goes over stdin so secrets embedded as base64 never reach the process arguments.
    const r = await this.run(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { input: `${WIN_CRED_PREAMBLE}\n${body}\n`, timeoutMs: 60_000 },
    );
    const failed = this.spawnFailure("PowerShell", r);
    if (failed) throw failed;
    return r;
  }

  protected async read(key: string): Promise<string | null> {
    const target = windowsTargetName(this.service, key);
    const r = await this.ps(
      `$r = [DsCred]::Read((Dec '${this.b64(target)}')); if ($r -eq $null) { 'NONE' } else { 'OK:' + $r }`,
    );
    if (r.code !== 0) throw new SecretError("backend", (r.stderr || r.stdout).trim());
    const out = r.stdout.trim();
    if (out === "NONE") return null;
    if (!out.startsWith("OK:")) throw new SecretError("backend", "unexpected Credential Manager response");
    return Buffer.from(out.slice(3), "base64").toString("utf16le");
  }

  protected async write(key: string, value: string): Promise<void> {
    const blob = Buffer.from(value, "utf16le").toString("base64");
    const target = windowsTargetName(this.service, key);
    const comment = `Password for ${key} on ${this.service}`;
    const r = await this.ps(
      `[DsCred]::Write((Dec '${this.b64(target)}'), (Dec '${this.b64(key)}'), (Dec '${this.b64(comment)}'), [Convert]::FromBase64String('${blob}'))`,
    );
    if (r.code !== 0) throw new SecretError("backend", redactSecret((r.stderr || r.stdout).trim(), value));
  }

  protected async remove(key: string): Promise<void> {
    const target = windowsTargetName(this.service, key);
    const r = await this.ps(`[void][DsCred]::Delete((Dec '${this.b64(target)}'))`);
    if (r.code !== 0) throw new SecretError("backend", (r.stderr || r.stdout).trim());
  }
}

// ── Linux ──────────────────────────────────────────────────────────────────────────────────

const LINUX_LOCKED = /locked|unlock|prompt dismissed|cancel|org\.freedesktop\.Secret\.Error\.IsLocked/i;
const LINUX_NO_SERVICE = /org\.freedesktop\.DBus\.Error\.(ServiceUnknown|NoServer)|cannot autolaunch|no such secret collection|not provided by any \.service files/i;

export class LinuxSecretServiceStore extends OsSecretStore {
  constructor(service: string = KEYRING_SERVICE, run: CommandRunner = defaultRunner, private readonly secretTool = "secret-tool") {
    super(service, run);
  }

  private async tool(args: string[], input?: string): Promise<RunResult> {
    const r = await this.run(this.secretTool, args, { input, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    const failed = this.spawnFailure("secret-tool (libsecret-tools)", r);
    if (failed) throw failed;
    return r;
  }

  private linuxError(r: RunResult, secret?: string): SecretError {
    let message = (r.stderr || r.stdout || `secret-tool exited with ${r.code}`).trim();
    if (secret) message = redactSecret(message, secret);
    if (LINUX_NO_SERVICE.test(message)) return new SecretError("unavailable", message, true);
    if (LINUX_LOCKED.test(message)) return new SecretError("locked", message, true);
    return new SecretError("backend", message);
  }

  protected async read(key: string): Promise<string | null> {
    const r = await this.tool(["lookup", "service", this.service, "username", key]);
    if (r.code === 0) return r.stdout;
    // `lookup` exits 1 with no output when nothing matches.
    if (r.code === 1 && r.stderr.trim() === "" && r.stdout === "") return null;
    throw this.linuxError(r);
  }

  protected async write(key: string, value: string): Promise<void> {
    const r = await this.tool(
      [
        "store",
        `--label=Password for ${key} on ${this.service}`,
        "application",
        "rust-keyring",
        "service",
        this.service,
        "username",
        key,
      ],
      value,
    );
    if (r.code !== 0) throw this.linuxError(r, value);
  }

  protected async remove(key: string): Promise<void> {
    const r = await this.tool(["clear", "service", this.service, "username", key]);
    if (r.code === 0 || (r.code === 1 && r.stderr.trim() === "")) return;
    throw this.linuxError(r);
  }
}

export interface SecretStoreOptions {
  platform?: NodeJS.Platform;
  service?: string;
  runner?: CommandRunner;
}

/** Store backed by the running OS' native credential facility. */
export function createOsSecretStore(options: SecretStoreOptions = {}): OsSecretStore {
  const platform = options.platform ?? process.platform;
  const service = options.service ?? KEYRING_SERVICE;
  const run = options.runner ?? defaultRunner;
  switch (platform) {
    case "darwin":
      return new MacKeychainStore(service, run);
    case "win32":
      return new WindowsCredentialStore(service, run);
    default:
      return new LinuxSecretServiceStore(service, run);
  }
}

export type { OsSecretStore };
