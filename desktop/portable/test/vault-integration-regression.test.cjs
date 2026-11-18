"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const { createVaultIntegration, linuxFiles, legacyLinuxFiles, marker, providerMarker } = require("../vault-integration.cjs");
const { pythonMenuEntry, detectPythonProvider } = require("../vault-menu-provider.cjs");
const execute = promisify(execFile);
const ready = async () => ({ python: true, loader: true });

async function fixture(t, managers = ["nautilus", "caja"]) {
  const root = await mkdtemp(path.join(tmpdir(), "rooms-direct-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const env = { HOME: root, XDG_DATA_HOME: path.join(root, "share"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: bin,
    APPIMAGE: path.join(root, "Rooms's $literal `text` 100%.AppImage") };
  await writeFile(env.APPIMAGE, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const manager of managers) await writeFile(path.join(bin, manager), "", { mode: 0o700 });
  return { root, env, integration: createVaultIntegration({ platform: "linux", env, providerStatus: ready }) };
}

test("direct Nautilus and Caja providers migrate only marked Scripts entries and remove cleanly", async t => {
  const f = await fixture(t), files = linuxFiles(f.env), old = legacyLinuxFiles(f.env);
  for (const file of Object.values(old)) await mkdir(path.dirname(file), { recursive: true });
  await writeFile(old.nautilus, "#!/bin/sh\n# " + marker + "\nexec old-version\n", { mode: 0o700 });
  const foreignScript = "#!/bin/sh\n# My own unrelated script\necho keep\n";
  await writeFile(old.caja, foreignScript, { mode: 0o700 });
  await mkdir(path.dirname(files.nautilus), { recursive: true });
  const foreignProvider = path.join(path.dirname(files.nautilus), "my_other_extension.py");
  await writeFile(foreignProvider, "# another user extension\n");
  const before = await f.integration.status();
  assert.deepEqual(before.migrationManagers, ["nautilus"]);
  assert.equal(before.anyInstalled, true);
  assert.deepEqual(before.installedManagers, []);
  const after = await f.integration.install();
  assert.equal(after.installed, true);
  assert.deepEqual(after.installedManagers, ["nautilus", "caja"]);
  assert.deepEqual(after.migrationManagers, []);
  for (const manager of ["nautilus", "caja"]) {
    const body = await readFile(files[manager], "utf8");
    assert.ok(body.startsWith("# " + providerMarker + "\n"));
    assert.ok(body.includes("MenuProvider"));
    assert.ok(body.includes("def get_file_items(self, *args):"));
    assert.equal((await stat(files[manager])).mode & 0o777, 0o600);
  }
  await assert.rejects(readFile(old.nautilus), { code: "ENOENT" });
  assert.equal(await readFile(old.caja, "utf8"), foreignScript);
  await f.integration.remove();
  for (const file of Object.values(files).slice(0, 2)) await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal(await readFile(old.caja, "utf8"), foreignScript);
  assert.equal(await readFile(foreignProvider, "utf8"), "# another user extension\n");
});

test("missing Python loaders are reported and never fall back to a Scripts submenu", async t => {
  const f = await fixture(t, ["nautilus"]), old = legacyLinuxFiles(f.env).nautilus;
  await mkdir(path.dirname(old), { recursive: true });
  await writeFile(old, "#!/bin/sh\n# " + marker + "\n", { mode: 0o700 });
  const integration = createVaultIntegration({ platform: "linux", env: f.env,
    providerStatus: async () => ({ python: true, loader: false }) });
  const status = await integration.status();
  assert.deepEqual(status.managers, ["nautilus"]);
  assert.deepEqual(status.availableManagers, []);
  assert.equal(status.supported, false);
  assert.equal(status.anyInstalled, true);
  assert.deepEqual(status.missingDependencies, [{ manager: "nautilus", component: "nautilus-python", python: true, loader: false }]);
  await assert.rejects(integration.install());
  await assert.rejects(readFile(linuxFiles(f.env).nautilus), { code: "ENOENT" });
  assert.ok((await readFile(old, "utf8")).includes(marker));
  await integration.remove();
  await assert.rejects(readFile(old), { code: "ENOENT" });
  const absentManagerScript = legacyLinuxFiles(f.env).caja;
  await mkdir(path.dirname(absentManagerScript), { recursive: true });
  await writeFile(absentManagerScript, "#!/bin/sh\n# " + marker + "\n");
  const absent = await integration.status();
  assert.equal(absent.anyInstalled, true);
  assert.deepEqual(absent.migrationManagers, []);
  await integration.remove();
  await assert.rejects(readFile(absentManagerScript), { code: "ENOENT" });
});

test("a foreign provider is neither replaced nor removed", async t => {
  const f = await fixture(t, ["nautilus"]), file = linuxFiles(f.env).nautilus;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "# foreign provider: do not overwrite\n");
  assert.deepEqual((await f.integration.status()).conflicts, ["nautilus"]);
  await assert.rejects(f.integration.install());
  await f.integration.remove();
  assert.equal(await readFile(file, "utf8"), "# foreign provider: do not overwrite\n");
});

test("moving to a new AppImage version offers an update for every managed file manager", async t => {
  const names = ["nautilus", "nemo", "caja", "dolphin", "thunar"], f = await fixture(t, names);
  const files = linuxFiles(f.env), unrelated = "<action><name>Keep my action</name><command>echo keep</command></action>";
  await mkdir(path.dirname(files.thunar), { recursive: true });
  await writeFile(files.thunar, "<actions>\n" + unrelated + "\n</actions>\n");
  await f.integration.install();
  assert.equal((await f.integration.status()).installed, true);
  const oldImage = f.env.APPIMAGE;
  const newImage = path.join(f.root, "Rooms-new-version.AppImage");
  await writeFile(newImage, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  f.env.APPIMAGE = newImage;
  const stale = await f.integration.status();
  assert.equal(stale.installed, false);
  assert.equal(stale.anyInstalled, true);
  assert.deepEqual(stale.migrationManagers, names);
  const updated = await f.integration.install();
  assert.equal(updated.installed, true);
  assert.deepEqual(updated.migrationManagers, []);
  for (const file of Object.values(files)) {
    const body = await readFile(file, "utf8");
    assert.ok(body.includes(newImage));
    assert.ok(!body.includes(oldImage));
  }
  assert.ok((await readFile(files.thunar, "utf8")).includes(unrelated));
  for (const manager of names.filter(name => name !== "nautilus")) await rm(path.join(f.env.PATH, manager));
  f.env.APPIMAGE = path.join(f.root, "Rooms-next-version.AppImage");
  await writeFile(f.env.APPIMAGE, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.deepEqual((await f.integration.status()).migrationManagers, ["nautilus"]);
  const onlyNautilus = await f.integration.install();
  assert.equal(onlyNautilus.installed, true);
  assert.deepEqual(onlyNautilus.migrationManagers, []);
  assert.deepEqual(onlyNautilus.configuredManagers, names);
  await f.integration.remove();
  for (const manager of names.filter(name => name !== "thunar")) await assert.rejects(readFile(files[manager]), { code: "ENOENT" });
  assert.ok((await readFile(files.thunar, "utf8")).includes(unrelated));
});

const providerHarness = String.raw`import importlib.util,json,sys,types
calls=[]
manager,version=sys.argv[2:4]
namespace="Nautilus" if manager=="nautilus" else "Caja"
versions=[]
gi=types.ModuleType("gi")
def require_version(name,value):
 versions.append(value)
 if value!=version: raise ValueError("not installed")
gi.require_version=require_version
repository=types.ModuleType("gi.repository")
class GObject: pass
class MenuProvider: pass
class MenuItem:
 def __init__(self,**kwargs): self.kwargs=kwargs
 def connect(self,event,callback,*args): self.callback=callback;self.args=args
 def activate(self): self.callback(self,*self.args)
repository.GObject=types.SimpleNamespace(GObject=GObject)
setattr(repository,namespace,types.SimpleNamespace(MenuProvider=MenuProvider,MenuItem=MenuItem))
sys.modules["gi"]=gi;sys.modules["gi.repository"]=repository
spec=importlib.util.spec_from_file_location("tested_vault_provider",sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.subprocess.Popen=lambda args,**kwargs:calls.append([args,kwargs])
class Location:
 def __init__(self,path,native=True,scheme="file"):self.path=path;self.native=native;self.scheme=scheme
 def is_native(self):return self.native
 def get_uri_scheme(self):return self.scheme
 def get_path(self):return self.path
class File:
 def __init__(self,path,native=True,scheme="file"):self.location=Location(path,native,scheme)
 def get_location(self):return self.location
provider=getattr(module,"ZeloteZVault"+namespace+"Provider")()
paths=json.loads(sys.argv[4]);files=[File(value) for value in paths]
for args in [(files,), (None,files)]:
 items=provider.get_file_items(*args)
 assert len(items)==1 and items[0].kwargs["label"]=="Share securely via Vault"
 items[0].activate()
assert provider.get_file_items([])==()
for files in [[File(None)],[File("relative")],[File("/tmp/control\nname")],[File("/tmp/remote",native=False)],[File("/tmp/remote",scheme="smb")],[File("/tmp/a")]*257]:
 assert provider.get_file_items(files)==()
print(json.dumps({"calls":calls,"versions":versions}))
`;

test("native providers support old/new APIs and pass literal absolute selections without a shell", async t => {
  const f = await fixture(t);
  const supplied = ["/tmp/a space", "/tmp/$(touch NEVER)", "/tmp/a'quote", "/tmp/a\"quote", "/tmp/back\\slash", "/tmp/文件"];
  for (const [manager, version] of [["nautilus", "4.1"], ["nautilus", "3.0"], ["caja", "2.0"]]) {
    const file = path.join(f.root, manager + ".py");
    await writeFile(file, pythonMenuEntry(manager, f.env.APPIMAGE));
    const result = JSON.parse((await execute("/usr/bin/python3", ["-I", "-c", providerHarness, file, manager, version, JSON.stringify(supplied)])).stdout);
    assert.equal(result.calls.length, 2);
    for (const [argv, options] of result.calls) {
      assert.deepEqual(argv, [f.env.APPIMAGE, "--vault-share", "--", ...supplied]);
      assert.equal(options.shell, undefined);
      assert.equal(options.cwd, "/tmp");
      assert.equal(options.close_fds, true);
      assert.equal(options.start_new_session, true);
    }
    assert.deepEqual(result.versions, manager === "caja" ? ["2.0"] : version === "4.1" ? ["4.1"] : ["4.1", "4.0", "3.0"]);
  }
});

test("dependency probes use isolated system Python without AppImage library overrides", async () => {
  let called = false;
  const result = await detectPythonProvider("nautilus", { PATH: "/usr/bin", HOME: "/tmp", LD_LIBRARY_PATH: "/tmp/AppDir/lib",
    PYTHONHOME: "/tmp/AppDir/python", GI_TYPELIB_PATH: "/tmp/AppDir/gi" }, async (file, args, options) => {
    called = true; assert.equal(file, "/usr/bin/python3"); assert.equal(args[0], "-I"); assert.equal(args.at(-1), "nautilus");
    assert.equal(options.env.LD_LIBRARY_PATH, undefined); assert.equal(options.env.PYTHONHOME, undefined); assert.equal(options.env.GI_TYPELIB_PATH, undefined);
    return { stdout: '{"python":true,"loader":true}\n' };
  });
  assert.equal(called, true);
  assert.deepEqual(result, { python: true, loader: true });
  assert.deepEqual(await detectPythonProvider("caja", {}, async () => { throw new Error("missing Python"); }), { python: false, loader: false });
});
