/**
 * Graceful-exit coordinator (port of `tray.rs::ExitCoordinator`).
 *
 * Every quit path (tray "Thoát DealSonar", Cmd+Q / Dock quit, OS session end, SIGTERM/SIGINT,
 * smoke runner) calls `requestQuit()`. The first call runs `shutdown()` (backend handshake, tray
 * teardown) once, then `exit()`. Later calls return the same promise, so concurrent signals never
 * start two shutdowns. `before-quit` consults `allowExit` to let the final `app.exit` through.
 */
export class ExitCoordinator {
  private started = false;
  private allow = false;
  private done: Promise<void> | null = null;

  constructor(
    private readonly shutdown: () => Promise<void>,
    private readonly exit: (code: number) => void,
    private readonly hardTimeoutMs = 15_000,
    private readonly log: (message: string) => void = () => {}
  ) {}

  get shuttingDown(): boolean {
    return this.started;
  }

  get allowExit(): boolean {
    return this.allow;
  }

  requestQuit(code = 0): Promise<void> {
    if (this.done) return this.done;
    this.started = true;
    this.done = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hard = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.hardTimeoutMs);
      });
      try {
        const outcome = await Promise.race([this.shutdown().then(() => "done" as const), hard]);
        if (outcome === "timeout") this.log(`graceful shutdown exceeded ${this.hardTimeoutMs}ms; exiting anyway`);
      } catch (err) {
        this.log(`error during graceful shutdown: ${String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
        this.allow = true;
        this.exit(code);
      }
    })();
    return this.done;
  }
}
