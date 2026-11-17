"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const portable = path.resolve(__dirname, "../../desktop/portable");
const projectRequire = createRequire(path.join(portable, "package.json"));
const { extractFile, getRawHeader } = projectRequire("@electron/asar");
const { getCurrentFuseWire, FuseV1Options } = projectRequire("@electron/fuses");
const manifest = projectRequire("./package.json");
const [platform, unpacked] = process.argv.slice(2);

function verifyWindowsExecutable(binary, description) {
  assert.equal(binary.toString("ascii", 0, 2), "MZ");
  const offset = binary.readUInt32LE(0x3c);
  assert.equal(binary.toString("ascii", offset, offset + 4), "PE\0\0");
  assert.equal(binary.readUInt16LE(offset + 4), 0x8664, `${description} must be Windows x64`);
}

async function verify() {
  assert(["linux", "win32"].includes(platform), "Specify linux or win32 and the unpacked application directory");
  assert(unpacked, "An unpacked application directory is required");
  const executable = path.join(unpacked, platform === "win32" ? "ZeloteZ Rooms.exe" : "zelotez-rooms-desktop");
  const binary = readFileSync(executable);
  const archive = path.join(unpacked, "resources/app.asar");
  const packaged = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(packaged.name, manifest.name);
  assert.equal(packaged.version, manifest.version);
  assert.equal(packaged.main, manifest.main);

  for (const entry of readdirSync(portable)) {
    if (entry.endsWith(".cjs")) assert.deepEqual(extractFile(archive, entry), readFileSync(path.join(portable, entry)), entry);
  }
  for (const entry of readdirSync(path.join(portable, "ui"))) {
    assert.deepEqual(extractFile(archive, "ui/" + entry), readFileSync(path.join(portable, "ui", entry)), "ui/" + entry);
  }

  const wire = await getCurrentFuseWire(executable);
  assert.equal(wire.version, "1");
  for (const option of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(wire[option], 0x30, FuseV1Options[option]);
  for (const option of [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseV1Options.OnlyLoadAppFromAsar]) {
    assert.equal(wire[option], 0x31, FuseV1Options[option]);
  }

  if (platform === "win32") {
    verifyWindowsExecutable(binary, "The application");
    const helper = path.resolve(unpacked, "resources/windows-audio/rooms-windows-audio.exe");
    const helperBinary = readFileSync(helper);
    verifyWindowsExecutable(helperBinary, "The audio helper");
    assert.deepEqual(helperBinary, readFileSync(path.join(portable, "windows-audio/rooms-windows-audio.exe")));
    if (process.platform === "win32") {
      assert.equal(execFileSync(helper, ["--version"], {
        encoding: "utf8", timeout: 5000, windowsHide: true,
      }).trim(), "rooms-windows-audio 1");
    }
    const { NtExecutable, NtExecutableResource } = projectRequire("resedit");
    const resources = NtExecutableResource.from(NtExecutable.from(binary));
    const integrity = resources.entries.find(entry => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR");
    assert(integrity, "Embedded ASAR integrity resource is required");
    const recorded = JSON.parse(Buffer.from(integrity.bin).toString("utf8"));
    const headerHash = createHash("sha256").update(getRawHeader(archive).headerString).digest("hex");
    const appIntegrity = recorded.filter(entry => entry.file === "resources\\app.asar");
    assert.deepEqual(appIntegrity, [{ file: "resources\\app.asar", alg: "SHA256", value: headerHash }]);
  } else {
    assert.deepEqual(binary.subarray(0, 5), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]));
    assert.equal(binary.readUInt16LE(18), 62, "The application must be Linux x64");
  }
  console.log(`Verified ${platform} x64 version ${packaged.version}, packaged sources, Electron fuses and ASAR integrity`);
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
