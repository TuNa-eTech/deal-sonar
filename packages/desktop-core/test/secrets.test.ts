import { describe, expect, it } from "vitest";

import {
  InMemorySecretStore,
  LinuxSecretServiceStore,
  MacKeychainStore,
  SecretError,
  TELEGRAM_BOT_TOKEN_KEY,
  WindowsCredentialStore,
  createOsSecretStore,
  parseSecurityPassword,
  redactSecret,
  telegramChannelKey,
  webhookChannelKey,
  windowsTargetName,
} from "../src/secrets";
import type { CommandRunner, RunOptions, RunResult } from "../src/secrets";

interface Call {
  command: string;
  args: string[];
  input?: string;
}

function fakeRunner(responder: (call: Call) => Partial<RunResult>): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options: RunOptions) => {
    const call = { command, args, input: options.input };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...responder(call) };
  };
  return { run, calls };
}

const SECRET = "123456:AAH-s3cret/Tok=en é";

describe("key naming and redaction", () => {
  it("matches the Rust account keys", () => {
    expect(TELEGRAM_BOT_TOKEN_KEY).toBe("telegram:bot_token");
    expect(telegramChannelKey("01ABC")).toBe("telegram:01ABC");
    expect(webhookChannelKey("01ABC")).toBe("webhook:01ABC");
    expect(redactSecret("fail for tok and tok", "tok")).toBe("fail for [REDACTED] and [REDACTED]");
    expect(redactSecret("x", "")).toBe("x");
  });
});

describe("InMemorySecretStore", () => {
  it("stores, deletes channel secrets and never renders values", async () => {
    const s = new InMemorySecretStore();
    await s.setSecret(TELEGRAM_BOT_TOKEN_KEY, SECRET);
    await s.setSecret(telegramChannelKey("c1"), "a");
    await s.setSecret("other", "b");
    expect(await s.getSecret("other")).toBe("b");
    expect(JSON.stringify(s)).not.toContain(SECRET);
    await expect(s.getSecret(" ")).rejects.toMatchObject({ kind: "empty_key" });
    await s.deleteAllForChannels(["c1"]);
    expect(s.size).toBe(0);
  });
});

describe("macOS Keychain adapter", () => {
  it("parses `security -g` output for text and hex passwords", () => {
    expect(parseSecurityPassword('keychain: "x"\npassword: "abc def"\n')).toBe("abc def");
    expect(parseSecurityPassword(`password: 0x${Buffer.from("héllo", "utf8").toString("hex")}  "h\\303\\251llo"`)).toBe("héllo");
    expect(parseSecurityPassword("password: ")).toBe("");
    expect(parseSecurityPassword("nothing here")).toBeNull();
  });

  it("reads service=DealSonar account=<key> and treats not-found as null", async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args.includes("telegram:bot_token")
        ? { stderr: 'class: "genp"\npassword: "tok"\n' }
        : { code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" },
    );
    const store = new MacKeychainStore("DealSonar", run);
    expect(await store.getSecret("telegram:bot_token")).toBe("tok");
    expect(await store.getSecret("webhook:nope")).toBeNull();
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/security",
      args: ["find-generic-password", "-s", "DealSonar", "-a", "telegram:bot_token", "-g"],
    });
  });

  it("writes through stdin as hex so the secret is never in argv", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    const store = new MacKeychainStore("DealSonar", run);
    await store.setSecret("telegram:abc", SECRET);
    const call = calls[0];
    expect(call.args).toEqual(["-i"]);
    expect(call.args.join(" ")).not.toContain(SECRET);
    expect(call.input).toBe(
      `add-generic-password -U -s "DealSonar" -a "telegram:abc" -X ${Buffer.from(SECRET, "utf8").toString("hex")}\n`,
    );
  });

  it("flags locked/denied keychains as retryable without leaking the secret", async () => {
    const { run } = fakeRunner(() => ({
      code: 36,
      stderr: `security: SecKeychainItemCreate: User interaction is not allowed. while saving ${SECRET}`,
    }));
    const err = await new MacKeychainStore("DealSonar", run).setSecret("k", SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(err).toMatchObject({ kind: "locked", retryable: true });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("deletes known keys and tolerates missing items", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 44 }));
    const store = new MacKeychainStore("DealSonar", run);
    await store.setSecret("webhook:w1", "x").catch(() => undefined);
    await store.deleteAllForChannels(["c1"]);
    const deleted = calls.filter((c) => c.args[0] === "delete-generic-password").map((c) => c.args[4]);
    expect(deleted).toEqual(expect.arrayContaining(["telegram:bot_token", "telegram:c1", "webhook:c1"]));
  });
});

describe("Linux Secret Service adapter", () => {
  it("looks up by service+username only (legacy items with or without `application`)", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: SECRET }));
    const store = new LinuxSecretServiceStore("DealSonar", run);
    expect(await store.getSecret("telegram:bot_token")).toBe(SECRET);
    expect(calls[0]).toMatchObject({
      command: "secret-tool",
      args: ["lookup", "service", "DealSonar", "username", "telegram:bot_token"],
    });
  });

  it("returns null when nothing matches", async () => {
    const { run } = fakeRunner(() => ({ code: 1 }));
    expect(await new LinuxSecretServiceStore("DealSonar", run).getSecret("x")).toBeNull();
  });

  it("stores with the rust-keyring attribute set and the secret on stdin", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    await new LinuxSecretServiceStore("DealSonar", run).setSecret("webhook:w", SECRET);
    expect(calls[0].args).toEqual([
      "store",
      "--label=Password for webhook:w on DealSonar",
      "application",
      "rust-keyring",
      "service",
      "DealSonar",
      "username",
      "webhook:w",
    ]);
    expect(calls[0].input).toBe(SECRET);
    expect(calls[0].args.join(" ")).not.toContain(SECRET);
  });

  it("reports a missing Secret Service / locked collection as retryable", async () => {
    const dbus = fakeRunner(() => ({ code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }));
    await expect(new LinuxSecretServiceStore("DealSonar", dbus.run).getSecret("k")).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
    });
    const locked = fakeRunner(() => ({ code: 1, stderr: `collection is locked ${SECRET}` }));
    const err = await new LinuxSecretServiceStore("DealSonar", locked.run).setSecret("k", SECRET).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "locked", retryable: true });
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("reports a missing secret-tool binary as unavailable", async () => {
    const { run } = fakeRunner(() => ({ code: null, spawnError: Object.assign(new Error("nope"), { code: "ENOENT" }) }));
    await expect(new LinuxSecretServiceStore("DealSonar", run).getSecret("k")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("Windows Credential Manager adapter", () => {
  it("uses target `<key>.DealSonar` and a UTF-16LE blob, piping the script via stdin", async () => {
    expect(windowsTargetName("DealSonar", "telegram:bot_token")).toBe("telegram:bot_token.DealSonar");
    const { run, calls } = fakeRunner(() => ({}));
    const store = new WindowsCredentialStore("DealSonar", run);
    await store.setSecret("telegram:bot_token", SECRET);
    const call = calls[0];
    expect(call.args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    expect(call.args.join(" ")).not.toContain(SECRET);
    const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
    expect(call.input).toContain(b64("telegram:bot_token.DealSonar"));
    expect(call.input).toContain(Buffer.from(SECRET, "utf16le").toString("base64"));
    expect(call.input).toContain("c.Type = 1;"); // CRED_TYPE_GENERIC
    expect(call.input).toContain("c.Persist = 3;"); // CRED_PERSIST_ENTERPRISE
  });

  it("decodes the UTF-16LE credential blob and treats ERROR_NOT_FOUND as null", async () => {
    const found = fakeRunner(() => ({ stdout: `OK:${Buffer.from(SECRET, "utf16le").toString("base64")}\r\n` }));
    expect(await new WindowsCredentialStore("DealSonar", found.run).getSecret("k")).toBe(SECRET);
    const none = fakeRunner(() => ({ stdout: "NONE\r\n" }));
    expect(await new WindowsCredentialStore("DealSonar", none.run).getSecret("k")).toBeNull();
  });

  it("redacts the secret from write errors", async () => {
    const { run } = fakeRunner(() => ({ code: 1, stderr: `CredWrite failed for ${SECRET}` }));
    const err = await new WindowsCredentialStore("DealSonar", run).setSecret("k", SECRET).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("factory", () => {
  it("selects the adapter by platform", () => {
    expect(createOsSecretStore({ platform: "darwin" })).toBeInstanceOf(MacKeychainStore);
    expect(createOsSecretStore({ platform: "win32" })).toBeInstanceOf(WindowsCredentialStore);
    expect(createOsSecretStore({ platform: "linux" })).toBeInstanceOf(LinuxSecretServiceStore);
  });
});
