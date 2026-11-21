import { fork } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackendClient, BackendError, BackendSupervisor, type BackendChild } from "../src/main/backend-client";

const STUB = join(__dirname, "..", "scripts", "stub-backend.cjs");

/** Real child process speaking the protocol over Node IPC (the stub also runs under utilityProcess). */
function forkStub(env: Record<string, string> = {}): () => BackendChild {
  return () => {
    const child = fork(STUB, [], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return {
      postMessage: (m) => void child.send(m as never),
      kill: () => void child.kill("SIGKILL"),
      onMessage: (l) => child.on("message", l),
      onExit: (l) => child.on("exit", (code) => l(code)),
    };
  };
}

/** In-memory child for scripted protocol edge cases. */
class FakeChild implements BackendChild {
  sent: unknown[] = [];
  killed = false;
  private msg: Array<(m: unknown) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  postMessage(m: unknown): void {
    this.sent.push(m);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(null);
  }
  onMessage(l: (m: unknown) => void): void {
    this.msg.push(l);
  }
  onExit(l: (c: number | null) => void): void {
    this.exit.push(l);
  }
  emit(m: unknown): void {
    this.msg.forEach((l) => l(m));
  }
  emitExit(code: number | null): void {
    this.exit.forEach((l) => l(code));
  }
}

const clients: BackendClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.shutdown(500).catch(() => undefined)));
});
const track = (c: BackendClient): BackendClient => (clients.push(c), c);

describe("BackendClient with the stub backend process", () => {
  it("completes the startup handshake and answers requests", async () => {
    const c = track(new BackendClient({ spawn: forkStub() }));
    const ready = await c.start();
    expect(ready).toEqual({ protocol: 1, version: "stub-0" });
    expect(c.state).toBe("ready");
    const health = await c.request<{ facebook_session: string }>("health_get");
    expect(health.facebook_session).toBe("ok");
  });

  it("maps backend error replies to BackendError with code", async () => {
    const c = track(new BackendClient({ spawn: forkStub() }));
    await c.start();
    await expect(c.request("radar_list")).rejects.toMatchObject({ name: "BackendError", code: "stub_backend" });
  });

  it("correlates many concurrent requests", async () => {
    const c = track(new BackendClient({ spawn: forkStub() }));
    await c.start();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => c.request<{ n: number }>("echo", { n: i })));
    expect(results.map((r) => r.n)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("forwards pushes (health:changed after toggle)", async () => {
    const c = track(new BackendClient({ spawn: forkStub() }));
    await c.start();
    const seen: Array<[string, unknown]> = [];
    c.onPush((e, p) => seen.push([e, p]));
    const health = await c.request<{ crawl_paused: boolean }>("backend:toggle_crawl_paused");
    expect(health.crawl_paused).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map(([e]) => e)).toContain("health:changed");
  });

  it("rejects start with the fatal code when the backend cannot start", async () => {
    const c = track(new BackendClient({ spawn: forkStub({ DEALSONAR_STUB_FAIL_START: "1" }) }));
    await expect(c.start()).rejects.toMatchObject({ code: "store_error", message: "stub: simulated startup failure" });
  });

  it("times out a backend that never says ready", async () => {
    const c = track(new BackendClient({ spawn: forkStub({ DEALSONAR_STUB_READY_DELAY_MS: "5000" }), readyTimeoutMs: 150 }));
    await expect(c.start()).rejects.toMatchObject({ code: "backend_start_timeout" });
  });

  it("shutdown handshake: reply, clean exit code 0, later requests rejected", async () => {
    const c = track(new BackendClient({ spawn: forkStub() }));
    await c.start();
    const r = await c.shutdown(2_000);
    expect(r).toEqual({ clean: true, code: 0 });
    expect(c.state).toBe("stopped");
    await expect(c.request("health_get")).rejects.toMatchObject({ code: "shutting_down" });
  });

  it("marks the client failed on a crash and rejects later requests", async () => {
    const c = track(new BackendClient({ spawn: forkStub({ DEALSONAR_STUB_CRASH_AFTER_MS: "100" }) }));
    await c.start();
    const exits: Array<{ expected: boolean; code: number | null }> = [];
    c.onExit((i) => exits.push(i));
    await new Promise((r) => setTimeout(r, 400));
    expect(exits).toEqual([{ expected: false, code: 9 }]);
    await expect(c.request("health_get")).rejects.toMatchObject({ code: "backend_unavailable" });
  });
});

describe("BackendClient protocol edge cases (fake child)", () => {
  it("rejects a protocol version mismatch", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emit({ event: "backend:ready", payload: { protocol: 99 } });
    await expect(p).rejects.toMatchObject({ code: "backend_protocol_mismatch" });
    expect(fake.killed).toBe(true);
  });

  it("rejects start when the child exits before ready", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emitExit(1);
    await expect(p).rejects.toMatchObject({ code: "backend_exit" });
  });

  it("ignores malformed messages and unknown ids", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emit("garbage");
    fake.emit(null);
    fake.emit({ id: 999, ok: true, value: 1 });
    fake.emit({ event: "backend:ready", payload: { protocol: 1 } });
    await p;
    const req = c.request("health_get");
    fake.emit({ id: 1, ok: true, value: "fine" });
    await expect(req).resolves.toBe("fine");
  });

  it("sends {id, command, args} exactly", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emit({ event: "backend:ready", payload: { protocol: 1 } });
    await p;
    void c.request("radar_get", { id: "r1" }).catch(() => undefined);
    expect(fake.sent).toEqual([{ id: 1, command: "radar_get", args: { id: "r1" } }]);
  });

  it("kills a backend that ignores the shutdown request", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emit({ event: "backend:ready", payload: { protocol: 1 } });
    await p;
    const r = await c.shutdown(50); // kill deadline = 50ms + 2s
    expect(fake.killed).toBe(true);
    expect(r.clean).toBe(false);
  }, 10_000);

  it("request timeout rejects with backend_timeout", async () => {
    const fake = new FakeChild();
    const c = new BackendClient({ spawn: () => fake });
    const p = c.start();
    fake.emit({ event: "backend:ready", payload: { protocol: 1 } });
    await p;
    await expect(c.request("health_get", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(BackendError);
  });
});

describe("BackendSupervisor", () => {
  it("restarts after a crash and gives up in a crash loop", async () => {
    let spawns = 0;
    const factory = forkStub({ DEALSONAR_STUB_CRASH_AFTER_MS: "60" });
    const sup = new BackendSupervisor({
      createClient: () =>
        new BackendClient({
          spawn: () => {
            spawns += 1;
            return factory();
          },
        }),
      maxRestarts: 2,
      backoffMs: 10,
    });
    const gaveUp = new Promise<BackendError>((res) => sup.onGiveUp(res));
    await sup.start();
    const err = await gaveUp;
    expect(err.code).toBe("backend_crash_loop");
    expect(spawns).toBe(3); // initial + 2 restarts
    await sup.shutdown(200);
  }, 15_000);

  it("does not restart after shutdown", async () => {
    let spawns = 0;
    const factory = forkStub();
    const sup = new BackendSupervisor({
      createClient: () => new BackendClient({ spawn: () => (spawns++, factory()) }),
      backoffMs: 10,
    });
    await sup.start();
    expect(await sup.shutdown(2_000)).toEqual({ clean: true, code: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(spawns).toBe(1);
  });
});
