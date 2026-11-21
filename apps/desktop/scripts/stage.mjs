// Assembles `stage/` (electron-builder `extraResources`, all outside ASAR):
//   stage/ui/            <- apps/desktop/ui/dist             (Vite build)
//   stage/backend/       <- $DEALSONAR_BACKEND_BUNDLE_DIR    (Backend task output; must contain main.cjs)
//   stage/native-host/   <- $DEALSONAR_NATIVE_HOST_SRC       (Host task output: one executable file)
//   stage/icons/tray.png <- apps/desktop/icons/32x32.png
//
// `--allow-stub` fills a missing backend/native helper with clearly marked stand-ins (a `STUB` marker
// file; the smoke report says `backend_kind: "stub"`). That exists to test the shell and installers
// before the real Backend/Host land. It must never be used for a release candidate.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "stage");
const allowStub = process.argv.includes("--allow-stub");
const isWin = process.env.DEALSONAR_STAGE_PLATFORM
  ? process.env.DEALSONAR_STAGE_PLATFORM === "win32"
  : process.platform === "win32";
const nativeName = isWin ? "dealsonar-native-host.exe" : "dealsonar-native-host";

function fail(message) {
  console.error(`stage: ${message}`);
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// UI
const uiDist = join(root, "ui", "dist");
if (!existsSync(join(uiDist, "index.html"))) fail(`UI build missing: run \`pnpm ui:build\` (${uiDist})`);
cpSync(uiDist, join(stage, "ui"), { recursive: true });

// Icons
mkdirSync(join(stage, "icons"), { recursive: true });
cpSync(join(root, "icons", "32x32.png"), join(stage, "icons", "tray.png"));

// Backend
const backendSrc = process.env.DEALSONAR_BACKEND_BUNDLE_DIR?.trim();
if (backendSrc) {
  if (!existsSync(join(resolve(backendSrc), "main.cjs"))) fail(`backend bundle has no main.cjs: ${backendSrc}`);
  cpSync(resolve(backendSrc), join(stage, "backend"), { recursive: true });
} else if (allowStub) {
  mkdirSync(join(stage, "backend"), { recursive: true });
  cpSync(join(root, "scripts", "stub-backend.cjs"), join(stage, "backend", "main.cjs"));
  writeFileSync(join(stage, "backend", "STUB"), "stand-in backend for shell/installer testing; not a release candidate\n");
} else {
  fail("set DEALSONAR_BACKEND_BUNDLE_DIR to the Backend bundle (dir with main.cjs), or pass --allow-stub");
}

// Native helper
const hostSrc = process.env.DEALSONAR_NATIVE_HOST_SRC?.trim();
mkdirSync(join(stage, "native-host"), { recursive: true });
const hostDest = join(stage, "native-host", nativeName);
if (hostSrc) {
  if (!existsSync(resolve(hostSrc))) fail(`native helper not found: ${hostSrc}`);
  cpSync(resolve(hostSrc), hostDest);
} else if (allowStub) {
  writeFileSync(hostDest, isWin ? "stub" : "#!/bin/sh\necho stub native host >&2\nexit 0\n");
  writeFileSync(join(stage, "native-host", "STUB"), "placeholder\n");
} else {
  fail("set DEALSONAR_NATIVE_HOST_SRC to the native helper executable, or pass --allow-stub");
}
if (!isWin) chmodSync(hostDest, 0o755);

console.log(`stage: ready at ${stage} (${hostSrc ? "real" : "stub"} native helper, ${backendSrc ? "real" : "stub"} backend)`);
