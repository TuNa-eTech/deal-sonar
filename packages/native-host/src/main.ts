/**
 * Process entry bundled into the standalone helper (Node SEA). Kept tiny: all logic lives in
 * `cli.ts` so it is unit-testable.
 */
import { runCli, userArgs } from "./cli.js";

// Chrome closes the pipe on exit; EPIPE must end the process quietly, not with a stack trace.
process.stdout.on("error", () => process.exit(1));

runCli(userArgs(process.argv, process.execPath), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
    // Sockets/timers are already closed; exit explicitly so a stray handle cannot hang Chrome.
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`dealsonar-native-host: fatal: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
