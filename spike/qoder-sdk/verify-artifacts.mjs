import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = process.env.QODER_SPIKE_PKG_DIR;
if (!PKG_DIR) {
  console.error(
    "QODER_SPIKE_PKG_DIR is required: a directory holding the npm tarball, the extracted package/, and the CLI artifacts.\n" +
      "Download URLs and digests are recorded in FINDINGS.md ('Artefak yang diperiksa').",
  );
  process.exit(2);
}
const SDK_VERSION = "1.0.49";
const CLI_VERSION = "1.1.62";
// Pinned so a re-download on another machine proves provenance against this repo, not just transport consistency.
const SDK_TARBALL_SHA512_BASE64 = "wtNfj0zMVpbNrqAH0JVCwGdKeZIAQImpC8hyTXmCrvX4eNDiu7bRWEbO0SGH7zwQeXW6IM3696NFYgR2Ic8ZLw==";

const EXPECTED = {
  "qodercli-windows-x64.zip": {
    sha256: "15978912bc9be48365c4ca254e307b0481c15e3dda6da111e54bf380ec72e5b5",
    source: "https://download.qoder.com/qodercli/channels/1.1.62/manifest.json (windows/amd64, runtime bun, variant standard, min_windows_build 17763)",
  },
  "qodercli-worker-runtime-win32-x64.tgz": {
    sha256: "c466805d318d2325417cef73a38f4271a167fc0f8b517ebb1fd63df766684bb1",
    source: "https://download.qoder.com/qodercli/releases/1.1.62/qodercli-worker-runtime-win32-x64.tgz.sha256 sidecar",
  },
};

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const sdkPkg = JSON.parse(readFileSync(join(PKG_DIR, "package/package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package/dist/runtime-manifest.json"), "utf8"));

console.log(`SDK package: ${sdkPkg.name}@${sdkPkg.version}`);
console.log(`  license: ${sdkPkg.license}`);
console.log(`  peerDependencies: ${JSON.stringify(sdkPkg.peerDependencies)}`);
console.log(`  dependencies: ${JSON.stringify(sdkPkg.dependencies)}`);
console.log(`  scripts.postinstall: ${sdkPkg.scripts.postinstall}`);
console.log(`  qoderCliVersion: ${sdkPkg.qoderCliVersion}, brand: ${sdkPkg.qoderSdkBrand}`);
console.log(`  exports: ${Object.keys(sdkPkg.exports).join(", ")}`);
assert(sdkPkg.version === SDK_VERSION, "SDK version pin");
assert(sdkPkg.qoderCliVersion === CLI_VERSION, "CLI version pin");
assert(manifest.defaultTransport === "worker", "default transport");

const tarball = join(PKG_DIR, "qoder-ai-qoder-agent-sdk-1.0.49.tgz");
const tarballSha512 = createHash("sha512").update(readFileSync(tarball)).digest("base64");
console.log(`\nnpm tarball: ${tarball}`);
console.log(`  sha512 (base64): ${tarballSha512}`);
console.log(`  expected (registry dist.integrity): ${SDK_TARBALL_SHA512_BASE64}`);
console.log(`  match: ${tarballSha512 === SDK_TARBALL_SHA512_BASE64 ? "OK" : "MISMATCH"}`);
console.log(`  size: ${statSync(tarball).size}`);
assert(tarballSha512 === SDK_TARBALL_SHA512_BASE64, "npm tarball sha512 vs registry integrity");

for (const [name, expected] of Object.entries(EXPECTED)) {
  const file = join(PKG_DIR, name);
  const actual = sha256File(file);
  const size = statSync(file).size;
  const ok = actual === expected.sha256;
  console.log(`\n${name}`);
  console.log(`  size: ${size}`);
  console.log(`  sha256: ${actual}`);
  console.log(`  expected: ${expected.sha256}`);
  console.log(`  match: ${ok ? "OK" : "MISMATCH"}`);
  console.log(`  digest source: ${expected.source}`);
  assert(ok, `${name} digest mismatch`);
}

console.log("\nAll pinned artifacts verified.");

function assert(cond, label) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${label}`);
    process.exitCode = 1;
  }
}
