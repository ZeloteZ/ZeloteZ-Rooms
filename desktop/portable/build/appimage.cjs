"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { verifyAppImageLauncher } = require("./appimage-policy.cjs");

const run = promisify(execFile);

// The pinned builder generates a launcher that conditionally disables Chromium's
// sandbox. Reassemble its finished AppDir with our explicit launcher, using the
// same pinned runtime, filesystem tools and embedded blockmap implementation.
module.exports = async function safeAppImage(context) {
  const artifacts = context.artifactPaths.filter(file => file.endsWith(".AppImage"));
  if (!artifacts.length) return [];
  const { Arch } = require("builder-util");
  const { getAppImageTools } = require("app-builder-lib/out/toolsets/linux");
  const { appendBlockmap } = require("app-builder-lib/out/targets/differentialUpdateInfoBuilder");
  const manifest = require("../package.json");
  for (const artifact of artifacts) {
    if (!artifact.endsWith("-x86_64.AppImage")) throw new Error("The checked AppImage assembly currently supports Linux x64 only");
    const tools = await getAppImageTools("0.0.0", Arch.x64);
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "rooms-safe-appdir-"));
    const temporary = artifact + "." + randomUUID() + ".new";
    try {
      await fs.cp(path.join(context.outDir, "linux-unpacked"), stage, { recursive: true, verbatimSymlinks: true });
      await fs.chmod(stage, 0o755);
      await fs.cp(tools.runtimeLibraries, path.join(stage, "usr", "lib"), { recursive: true });
      const launcher = await fs.readFile(path.join(__dirname, "AppRun"), "utf8");
      const entry = ["[Desktop Entry]", "Name=ZeloteZ Rooms", "Exec=AppRun %U", "Terminal=false", "Type=Application",
        "Icon=zelotez-rooms-desktop", "StartupWMClass=de.zelotez.rooms", "X-AppImage-Version=" + manifest.version,
        "Comment=ZeloteZ Rooms desktop client", "MimeType=x-scheme-handler/zelotez-rooms;", "Categories=Network;", ""].join("\n");
      verifyAppImageLauncher(launcher, entry);
      await fs.writeFile(path.join(stage, "AppRun"), launcher, { mode: 0o755 });
      await fs.writeFile(path.join(stage, "de.zelotez.rooms.desktop"), entry);
      const relativeIcon = "usr/share/icons/hicolor/512x512/apps/zelotez-rooms-desktop.png";
      await fs.mkdir(path.dirname(path.join(stage, relativeIcon)), { recursive: true });
      await fs.copyFile(path.join(context.outDir, "linux-unpacked/resources/app.asar.unpacked/ui/icon.png"), path.join(stage, relativeIcon));
      await fs.symlink(relativeIcon, path.join(stage, "zelotez-rooms-desktop.png"));
      await fs.symlink(relativeIcon, path.join(stage, ".DirIcon"));
      const runtime = await fs.readFile(tools.runtime);
      await run(tools.mksquashfs, [stage, temporary, "-offset", String(runtime.length), "-all-root", "-noappend",
        "-no-progress", "-quiet", "-no-xattrs", "-no-fragments"], { cwd: stage, maxBuffer: 1024 * 1024 });
      const file = await fs.open(temporary, "r+");
      try { await file.write(runtime, 0, runtime.length, 0); } finally { await file.close(); }
      await fs.chmod(temporary, 0o755);
      await appendBlockmap(temporary);
      await fs.rename(temporary, artifact);
    } catch (error) {
      // A failed post-build safety step must not leave the upstream artifact
      // looking like a usable release candidate.
      await fs.rm(artifact, { force: true });
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  return [];
};
