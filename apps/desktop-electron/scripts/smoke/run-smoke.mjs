#!/usr/bin/env node
// Packaging smoke runner. One invocation = one target on the machine it runs on.
//
//   node scripts/smoke/run-smoke.mjs --mode unpacked [--exe <path>]
//   node scripts/smoke/run-smoke.mjs --mode installed --artifact <dmg|exe|deb|AppImage> [--system-install]
//
// Everything runs against throwaway state: DEALSONAR_DATA_DIR, the Chromium profile and HOME point at a
// temp dir, autostart/browser spawning are disabled, and credentials are never read. The app under
// test writes a JSON report (see src/main/smoke.ts); this runner adds install/uninstall evidence and
// writes `<out>/smoke-<platform>-<arch>-<mode>.json`. Exit code 0 only if everything required passed.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..", "..");
const identity = JSON.parse(readFileSync(join(projectDir, "config", "identity.json"), "utf8"));

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "unpacked";
if (!["unpacked", "installed"].includes(mode)) die(`unknown --mode ${mode}`);
const platform = process.platform;
const outDir = resolve(args.out ?? join(projectDir, "release", "smoke"));
mkdirSync(outDir, { recursive: true });

const evidence = { schema: 1, mode, platform, arch: process.arch, node: process.version, steps: [], limits: [] };
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  return ok;
};

const work = mkdtempSync(join(tmpdir(), "dealsonar-smoke-"));
const dirs = { home: join(work, "home"), data: join(work, "data"), user: join(work, "user"), install: join(work, "install") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const reportPath = join(work, "report.json");

async function main() {
  let cleanup = async () => {};
  let launch;
  let ok = false;
  try {
    if (mode === "installed") {
      if (!args.artifact) die("--artifact is required for --mode installed");
      const artifact = resolve(args.artifact);
      if (!existsSync(artifact)) die(`artifact not found: ${artifact}`);
      evidence.artifact = { file: basename(artifact), bytes: statSync(artifact).size, sha256: sha256(artifact) };
      ({ launch, cleanup } = await install(artifact));
    } else {
      launch = unpackedLaunch();
    }
    if (!launch) throw new Error("no launchable executable after install");
    step("launch_target_exists", existsSync(launch.cmd), launch.cmd);

    ok = await runApp(launch);
  } catch (err) {
    step("runner_error", false, err instanceof Error ? err.message : String(err));
  }

  try {
    xvfb?.kill();
    await cleanup();
  } catch (err) {
    step("cleanup", false, err instanceof Error ? err.message : String(err));
  }

  evidence.ok = ok && evidence.steps.every((s) => s.ok);
  const resultFile = join(outDir, `smoke-${platform}-${process.arch}-${mode}.json`);
  writeFileSync(resultFile, JSON.stringify(evidence, null, 2));
  console.log(`\nresult: ${evidence.ok ? "PASS" : "FAIL"} -> ${resultFile}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(evidence.ok ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(message) {
  console.error(`smoke: ${message}`);
  process.exit(2);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", ...opts });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
}

function unpackedLaunch() {
  if (args.exe) return { cmd: resolve(args.exe), args: [], extraArgs: [] };
  const electronBin = join(projectDir, "node_modules", ".bin", platform === "win32" ? "electron.cmd" : "electron");
  evidence.limits.push("unpacked mode runs the Electron dev binary against dist/, not a packaged app");
  return { cmd: electronBin, args: [projectDir], extraArgs: platform === "linux" ? ["--no-sandbox"] : [] };
}

// ---- install per platform ------------------------------------------------------------------------

async function install(artifact) {
  const lower = artifact.toLowerCase();
  if (platform === "darwin" && lower.endsWith(".dmg")) return installDmg(artifact);
  if (platform === "win32" && lower.endsWith(".exe")) return installNsis(artifact);
  if (platform === "linux" && lower.endsWith(".deb")) return installDeb(artifact);
  if (platform === "linux" && lower.endsWith(".appimage")) return installAppImage(artifact);
  throw new Error(`artifact ${basename(artifact)} cannot be installed on ${platform}`);
}

function installDmg(dmg) {
  const mount = join(work, "mnt");
  mkdirSync(mount, { recursive: true });
  const attach = sh("hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount, dmg]);
  if (!step("dmg_mount", attach.code === 0, attach.out.slice(0, 300))) throw new Error("dmg mount failed");
  let app;
  try {
    app = readdirSync(mount).find((n) => n.endsWith(".app"));
    if (!step("dmg_contains_app", !!app, readdirSync(mount))) throw new Error("no .app in dmg");
    const apps = join(dirs.install, "Applications");
    mkdirSync(apps, { recursive: true });
    const copy = sh("ditto", [join(mount, app), join(apps, app)]);
    step("dmg_copy_app", copy.code === 0, copy.out.slice(0, 300));
  } finally {
    sh("hdiutil", ["detach", mount, "-force"]);
  }
  const appPath = join(dirs.install, "Applications", app);
  const verify = sh("codesign", ["--verify", "--deep", "--strict", appPath]);
  step("codesign_verify", verify.code === 0, verify.out.slice(0, 300));
  const info = sh("codesign", ["-dv", "--verbose=2", appPath]);
  step("codesign_adhoc", /Signature=adhoc/.test(info.out) || /flags=.*adhoc/.test(info.out), info.out.split("\n").filter((l) => /Signature|Identifier|flags/.test(l)).join(" | "));
  const exe = join(appPath, "Contents", "MacOS", identity.productName);
  evidence.limits.push("macOS: app copied with ditto (no com.apple.quarantine), so Gatekeeper first-launch prompt is not exercised");
  return { launch: { cmd: exe, args: [], extraArgs: [] }, cleanup: async () => {} };
}

function installNsis(setup) {
  const target = join(dirs.install, "app");
  // NSIS: /S silent, /D must be last and unquoted.
  const r = spawnSync(setup, ["/S", `/D=${target}`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 300_000 });
  step("nsis_silent_install", r.status === 0, `exit ${r.status}`);
  const exe = join(target, `${identity.productName}.exe`);
  step("nsis_installed_exe", existsSync(exe), exe);
  evidence.limits.push("Windows: installer is unsigned; SmartScreen/UAC publisher prompts are not exercised by /S");
  return {
    launch: { cmd: exe, args: [], extraArgs: [] },
    cleanup: async () => {
      const un = join(target, `Uninstall ${identity.productName}.exe`);
      if (!existsSync(un)) {
        step("nsis_uninstaller_present", false, un);
        return;
      }
      spawnSync(un, ["/S", `_?=${target}`], { windowsVerbatimArguments: true, timeout: 300_000 });
      step("nsis_uninstall_removed_exe", !existsSync(exe), exe);
    },
  };
}

function installDeb(deb) {
  const info = sh("dpkg-deb", ["--info", deb]);
  step("deb_metadata", info.code === 0 && /Package: /.test(info.out), info.out.split("\n").filter((l) => /Package:|Version:|Architecture:|Depends:/.test(l)).join(" | "));
  if (args["system-install"]) {
    const r = sh("sudo", ["dpkg", "-i", deb]);
    if (r.code !== 0) sh("sudo", ["apt-get", "-f", "install", "-y"]);
    const again = r.code === 0 ? r : sh("sudo", ["dpkg", "-i", deb]);
    step("deb_dpkg_install", again.code === 0, again.out.slice(-300));
    const exe = `/opt/${identity.productName}/${identity.executableName}`;
    step("deb_installed_exe", existsSync(exe), exe);
    return {
      launch: { cmd: exe, args: [], extraArgs: [] },
      cleanup: async () => {
        const rm = sh("sudo", ["dpkg", "-r", identity.executableName]);
        step("deb_dpkg_remove", rm.code === 0 && !existsSync(exe), rm.out.slice(-200));
      },
    };
  }
  const root = join(dirs.install, "deb-root");
  const x = sh("dpkg-deb", ["-x", deb, root]);
  step("deb_extract", x.code === 0, x.out.slice(0, 200));
  const exe = join(root, "opt", identity.productName, identity.executableName);
  step("deb_extracted_exe", existsSync(exe), exe);
  evidence.limits.push("deb: extracted with dpkg-deb -x (not dpkg -i) and run with --no-sandbox, because chrome-sandbox cannot be root-owned 4755 here; use --system-install on a runner with sudo for the real path");
  return { launch: { cmd: exe, args: [], extraArgs: ["--no-sandbox"] }, cleanup: async () => {} };
}

function installAppImage(image) {
  const copy = join(dirs.install, basename(image));
  cpSync(image, copy);
  chmodSync(copy, 0o755);
  step("appimage_executable", true, copy);
  evidence.limits.push("AppImage: run with APPIMAGE_EXTRACT_AND_RUN=1 and --no-sandbox (no FUSE/SUID on CI)");
  return { launch: { cmd: copy, args: [], extraArgs: ["--no-sandbox"], env: { APPIMAGE_EXTRACT_AND_RUN: "1" } }, cleanup: async () => {} };
}

// Linux CI has no display: start a private Xvfb and point DISPLAY at it.
let xvfb = null;
let display = null;
async function ensureDisplay() {
  if (platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  display = `:${90 + Math.floor(Math.random() * 9)}`;
  xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: "ignore" });
  xvfb.on("error", () => {});
  await sleep(1500);
  step("xvfb_started", xvfb.exitCode === null, display);
}

// ---- run the app ---------------------------------------------------------------------------------

function appEnv(extra = {}) {
  const env = {
    ...process.env,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_DATA_HOME: join(dirs.home, ".local", "share"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    DEALSONAR_DATA_DIR: dirs.data,
    DEALSONAR_SHELL_USER_DATA_DIR: dirs.user,
    DEALSONAR_SMOKE_REPORT: reportPath,
    DEALSONAR_SMOKE_HOLD_MS: "60000",
    DEALSONAR_DISABLE_AUTOSTART_SYNC: "1",
    DEALSONAR_DISABLE_BROWSER_SPAWN: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    ...(display ? { DISPLAY: display } : {}),
    ...extra,
  };
  if (platform === "win32") {
    env.APPDATA = join(dirs.home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(dirs.home, "AppData", "Local");
  }
  for (const k of ["DEALSONAR_LICENSE_KEY", "TELEGRAM_BOT_TOKEN"]) delete env[k];
  return env;
}

function spawnApp(l, extra = {}) {
  const argv = [...l.args, ...(l.extraArgs ?? [])];
  const child = spawn(l.cmd, argv, { env: appEnv(l.env), stdio: ["ignore", "pipe", "pipe"], ...extra });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  return { child, exited, log: () => log };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(everyMs);
  }
  return pred();
}

async function runApp(l) {
  await ensureDisplay();
  const first = spawnApp(l);
  let firstExit = null;
  first.exited.then((r) => (firstExit = r));
  const ready = await waitFor(() => existsSync(`${reportPath}.ready`) || firstExit !== null, 120_000);
  if (!step("app_reached_checks", ready && firstExit === null, firstExit ? `exited early ${JSON.stringify(firstExit)}` : "ready marker seen")) {
    evidence.app_log_tail = first.log().split("\n").slice(-40);
    if (firstExit === null) {
      first.child.kill("SIGKILL");
      await first.exited;
    }
    readReport();
    return false;
  }

  // Single-instance: a second launch with the same profile must exit 0 quickly.
  const second = spawnApp(l);
  const secondResult = await Promise.race([second.exited, sleep(30_000).then(() => "timeout")]);
  if (secondResult === "timeout") second.child.kill("SIGKILL");
  step("single_instance_second_exit", secondResult !== "timeout" && secondResult.code === 0, secondResult === "timeout" ? "timeout" : `exit ${secondResult.code}`);

  // Graceful shutdown: SIGTERM on unix; on Windows a plain kill is a hard stop, so the smoke hold timer
  // (60s) is shortened by the app only when asked. Use the hold override instead.
  if (platform === "win32") {
    evidence.limits.push("Windows: graceful quit is exercised by the in-app smoke hold timer, not by a signal");
  } else {
    process.kill(first.child.pid, "SIGTERM");
  }
  const result = await Promise.race([first.exited, sleep(platform === "win32" ? 90_000 : 45_000).then(() => "timeout")]);
  if (result === "timeout") {
    first.child.kill("SIGKILL");
    step("app_exit_after_quit", false, "did not exit");
  } else {
    step("app_exit_code", result.code === 0, `exit ${result.code} signal ${result.signal}`);
  }
  const rep = readReport();
  if (!rep) return false;
  for (const c of rep.checks) step(`app:${c.name}`, c.ok || !c.required, c.detail);
  evidence.report = { ok: rep.ok, backend_kind: rep.backend_kind, packaged: rep.packaged, electron: rep.electron, app_version: rep.app_version, app_id: rep.app_id, shutdown: rep.shutdown };
  if (rep.backend_kind === "stub") evidence.limits.push("backend is the marked stub, not the real Backend; real data paths untested");
  if (rep.packaged !== (mode === "installed")) step("packaged_flag_matches_mode", false, `packaged=${rep.packaged}`);
  return rep.ok === true;
}

function readReport() {
  if (!existsSync(reportPath)) {
    step("report_written", false, "no report file");
    return null;
  }
  const rep = JSON.parse(readFileSync(reportPath, "utf8"));
  step("report_written", true);
  return rep;
}

await main();
