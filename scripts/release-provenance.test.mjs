import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildProvenance, parseAuthenticode, parseCodesign, parseSpctl, platformOf, sha256File } from "./release-provenance.mjs";

const DEVELOPER_ID = `Executable=/Volumes/DealSonar/DealSonar.app/Contents/MacOS/dealsonar
Identifier=com.dealsonar.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
Authority=Developer ID Application: Example Co (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345`;
const ADHOC = `Executable=/Volumes/DealSonar/DealSonar.app/Contents/MacOS/dealsonar
CodeDirectory v=20400 size=500 flags=0x2(adhoc) hashes=10+7 location=embedded
Signature=adhoc
TeamIdentifier=not set`;

test("a Developer ID signature counts as signed, an ad-hoc one does not", () => {
  const signed = parseCodesign(DEVELOPER_ID);
  assert.equal(signed.signed, true);
  assert.equal(signed.signer, "Developer ID Application: Example Co (ABCDE12345)");
  assert.equal(signed.team_id, "ABCDE12345");
  const adhoc = parseCodesign(ADHOC);
  assert.equal(adhoc.signed, false);
  assert.equal(adhoc.adhoc, true);
  assert.equal(adhoc.team_id, null);
});

test("notarization is read from spctl's source line", () => {
  assert.deepEqual(parseSpctl("DealSonar.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example Co (ABCDE12345)"), { accepted: true, notarized: true });
  assert.deepEqual(parseSpctl("DealSonar.app: accepted\nsource=Developer ID"), { accepted: true, notarized: false });
  assert.deepEqual(parseSpctl("DealSonar.app: rejected"), { accepted: false, notarized: false });
});

test("only a Valid Authenticode status counts as signed", () => {
  assert.equal(parseAuthenticode('{"Status":"Valid","Subject":"CN=Example Co","Thumbprint":"AB12"}').signed, true);
  assert.equal(parseAuthenticode('{"Status":0,"Subject":"CN=Example Co","Thumbprint":"AB12"}').signed, true);
  const none = parseAuthenticode('{"Status":"NotSigned","Subject":null,"Thumbprint":null}');
  assert.deepEqual(none, { signed: false, signer: null, thumbprint: null });
  assert.equal(parseAuthenticode('{"Status":"HashMismatch","Subject":"CN=X","Thumbprint":"A"}').signed, false);
});

test("provenance records checksum, version, platform and the inspected signing state", () => {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const file = join(dir, "DealSonar-v1.2.3-aarch64-apple-darwin.dmg");
  writeFileSync(file, "installer-bytes");
  const record = buildProvenance({
    file, target: "aarch64-apple-darwin", tag: "v1.2.3",
    inspection: { signed: false, notarized: false, signer: null, note: null },
    env: { GITHUB_SHA: "abc123", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9", ImageOS: "macos15" },
  });
  assert.equal(record.sha256, sha256File(file));
  assert.equal(record.version, "1.2.3");
  assert.deepEqual([record.os, record.arch], ["macos", "arm64"]);
  assert.equal(record.signed, false);
  assert.equal(record.run_url, "https://github.com/o/r/actions/runs/9");
  assert.equal(record.runner.image, "macos15");
  assert.throws(() => platformOf("riscv64-unknown"), /Unsupported/);
});
