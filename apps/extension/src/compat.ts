// Version compatibility between this extension and the Desktop app.
//
// Chrome updates the extension on its own schedule while customers update the Desktop app by hand,
// so the two often run different releases. PROTOCOL_VERSION is the hard gate; MIN_DESKTOP_VERSION
// is the oldest Desktop release this extension works correctly with. Keep it equal to
// `MIN_DESKTOP_VERSION` in crates/protocol/src/compat.rs (checked by scripts/compat-constants.test.mjs).

export const MIN_DESKTOP_VERSION = "0.1.0";

export type CompatKind = "desktop_outdated" | "protocol_mismatch";

export type CompatGuidance = {
  kind: CompatKind;
  message: string;
  action: string;
};

export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True only when both versions parse and `version` is older; unknown versions are never flagged. */
export function isOlderThan(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

export function desktopOutdatedKind(desktopVersion: string | undefined): CompatKind | undefined {
  return desktopVersion && isOlderThan(desktopVersion, MIN_DESKTOP_VERSION) ? "desktop_outdated" : undefined;
}

/** Vietnamese guidance for the popup. Data on the Desktop is never affected by either case. */
export function compatGuidance(kind: CompatKind, desktopVersion?: string): CompatGuidance {
  if (kind === "desktop_outdated") {
    return {
      kind,
      message: `Ứng dụng DealSonar${desktopVersion ? ` (v${desktopVersion})` : ""} cũ hơn mức tiện ích cần (từ v${MIN_DESKTOP_VERSION}).`,
      action: "Tải bộ cài DealSonar mới nhất và cài đè lên bản đang dùng, rồi mở ứng dụng và bấm Kiểm tra lại. Dữ liệu và radar của bạn được giữ nguyên.",
    };
  }
  return {
    kind,
    message: "Tiện ích và ứng dụng DealSonar không khớp phiên bản giao thức, thường do chỉ một bên vừa được cập nhật.",
    action: "Cập nhật cả hai lên cùng bản phát hành: cài bộ cài DealSonar mới nhất và cập nhật tiện ích ở chrome://extensions, rồi bấm Thử lại. Dữ liệu và radar của bạn được giữ nguyên, không cần ghép nối lại từ đầu.",
  };
}
