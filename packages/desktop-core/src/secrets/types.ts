// Port of crates/notify/src/secrets.rs: SecretStore abstraction, key naming, redaction and the
// deterministic in-memory store used by tests. Adapters are async because the OS tools are
// spawned (a keychain prompt must never block the data-owner event loop).

/** Default OS keyring service name (04-data-model.md §4). */
export const KEYRING_SERVICE = "DealSonar";
/** Shared bot token account key used before/across per-channel assignment. */
export const TELEGRAM_BOT_TOKEN_KEY = "telegram:bot_token";

export const telegramChannelKey = (channelId: string): string => `telegram:${channelId}`;
export const webhookChannelKey = (channelId: string): string => `webhook:${channelId}`;

/** Replace every occurrence of `secret` in `text` so credentials never reach logs or errors. */
export function redactSecret(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[REDACTED]");
}

export type SecretErrorKind =
  | "empty_key"
  | "invalid_key"
  | "backend"
  | "locked"
  | "unavailable";

/**
 * `retryable` is true when the OS reported a locked keychain, a cancelled/denied prompt or a
 * missing Secret Service so the UI can offer "unlock and retry" without losing the request.
 */
export class SecretError extends Error {
  readonly kind: SecretErrorKind;
  readonly retryable: boolean;
  constructor(kind: SecretErrorKind, message: string, retryable = false) {
    super(message);
    this.name = "SecretError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  deleteAllKnown(): Promise<void>;
  /** Secrets of the given channels plus `telegram:bot_token` and every other tracked key. */
  deleteAllForChannels(channelIds: string[]): Promise<void>;
}

export abstract class BaseSecretStore implements SecretStore {
  abstract getSecret(key: string): Promise<string | null>;
  abstract setSecret(key: string, value: string): Promise<void>;
  abstract deleteSecret(key: string): Promise<void>;
  abstract deleteAllKnown(): Promise<void>;

  async deleteAllForChannels(channelIds: string[]): Promise<void> {
    await this.deleteSecret(TELEGRAM_BOT_TOKEN_KEY);
    for (const id of channelIds) {
      await this.deleteSecret(telegramChannelKey(id));
      await this.deleteSecret(webhookChannelKey(id));
    }
    await this.deleteAllKnown();
  }
}

export class InMemorySecretStore extends BaseSecretStore {
  private readonly entries = new Map<string, string>();

  private check(key: string): void {
    if (key.trim() === "") throw new SecretError("empty_key", "account key must not be empty");
  }
  async getSecret(key: string): Promise<string | null> {
    this.check(key);
    return this.entries.get(key) ?? null;
  }
  async setSecret(key: string, value: string): Promise<void> {
    this.check(key);
    this.entries.set(key, value);
  }
  async deleteSecret(key: string): Promise<void> {
    this.check(key);
    this.entries.delete(key);
  }
  async deleteAllKnown(): Promise<void> {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
  /** Values are never rendered. */
  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.entries.keys()].map((k) => [k, "[REDACTED]"]));
  }
}
