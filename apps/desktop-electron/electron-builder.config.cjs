"use strict";
// Candidate packaging. Identity (appId, product name, data dir) comes from config/identity.json so a
// candidate can be installed next to a production DealSonar without sharing its profile, login item,
// tray registration or single-instance lock. Unsigned publisher policy: no Windows certificate, no
// notarization; macOS is ad-hoc signed (`identity: "-"`).
const identity = process.env.DEALSONAR_DESKTOP_CHANNEL === "production"
  ? require("./config/production-identity.json")
  : require("./config/identity.json");

const buildVersion = process.env.DEALSONAR_DESKTOP_VERSION?.trim();

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: identity.appId,
  // The DEB target derives its /opt directory from this name.
  productName: process.platform === "linux" ? identity.executableName : identity.productName,
  copyright: "DealSonar",
  artifactName: `${identity.artifactPrefix}-\${version}-\${os}-\${arch}.\${ext}`,
  directories: { output: "release" },
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  files: ["dist/**/*", "package.json"],
  extraMetadata: {
    desktopName: `${identity.executableName}.desktop`,
    ...(buildVersion ? { version: buildVersion } : {}),
  },
  // Everything the shell executes or serves lives outside ASAR (real executable bit for the native
  // helper, native modules of the backend load without unpacking).
  extraResources: [
    { from: "stage/backend", to: "backend" },
    { from: "stage/native-host", to: "native-host" },
    { from: "stage/ui", to: "ui" },
    { from: "stage/icons", to: "icons" },
  ],
  mac: {
    category: "public.app-category.business",
    icon: "../desktop/icons/icon.icns",
    target: [{ target: "dmg" }],
    identity: "-", // ad-hoc
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
  },
  dmg: { sign: false },
  win: {
    icon: "../desktop/icons/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: identity.productName,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  linux: {
    icon: "../desktop/icons/icon.png",
    category: "Office",
    desktop: { entry: { Name: identity.productName } },
    syncDesktopName: true,
    executableName: identity.executableName,
    maintainer: "DealSonar <support@dealsonar.invalid>",
    synopsis: "DealSonar candidate",
    description: "DealSonar lead radar and personal CRM (Electron candidate build).",
    target: [
      { target: "deb", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
  },
  deb: { packageName: identity.executableName },
};
