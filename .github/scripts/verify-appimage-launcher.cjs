"use strict";

const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const portable = path.resolve(__dirname, "../../desktop/portable");
const projectRequire = createRequire(path.join(portable, "package.json"));
const { getPath7za } = projectRequire("app-builder-lib/out/toolsets/7zip");
const { verifyAppImageLauncher } = require(path.join(portable, "build/appimage-policy.cjs"));

(async () => {
  const artifact = process.argv[2];
  if (!artifact?.endsWith(".AppImage")) throw new Error("Specify the actual AppImage artifact");
  const tool = await getPath7za();
  const read = name => execFileSync(tool, ["x", "-so", path.resolve(artifact), name], { encoding: "utf8", maxBuffer: 128 * 1024 });
  verifyAppImageLauncher(read("AppRun"), read("de.zelotez.rooms.desktop"));
  console.log("Verified actual AppImage launcher and URI arguments without executing the AppImage");
})().catch(error => { console.error(error); process.exitCode = 1; });
