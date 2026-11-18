"use strict";

const providerMarker = "X-ZeloteZ-Vault-Managed=v2";

function pythonMenuEntry(manager, image) {
  if (!["nautilus", "caja"].includes(manager)) throw new Error("Unknown Vault menu provider.");
  const namespace = manager === "nautilus" ? "Nautilus" : "Caja";
  const versions = manager === "nautilus" ? ["4.1", "4.0", "3.0"] : ["2.0"];
  return `# ${providerMarker}
# This user-level provider adds one direct file-selection action.
import os
import subprocess
import gi
for _version in ${JSON.stringify(versions)}:
    try:
        gi.require_version(${JSON.stringify(namespace)}, _version)
        break
    except ValueError:
        pass
from gi.repository import GObject, ${namespace}

_APPIMAGE = ${JSON.stringify(image)}
_LABEL = "Share securely via Vault"

def _local_paths(files):
    if not files or len(files) > 256:
        return None
    result = []
    for info in files:
        location = info.get_location()
        if not location or not location.is_native() or location.get_uri_scheme() != "file":
            return None
        value = location.get_path()
        if (not isinstance(value, str) or not os.path.isabs(value)
                or len(value) > 32768 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)):
            return None
        value = os.path.abspath(value)
        if value not in result:
            result.append(value)
    return tuple(result)

class ZeloteZVault${namespace}Provider(GObject.GObject, ${namespace}.MenuProvider):
    def get_file_items(self, *args):
        # API 3/Caja pass (window, files); Nautilus 4 passes (files).
        paths = _local_paths(args[-1] if args else None)
        if not paths or not os.path.isfile(_APPIMAGE) or not os.access(_APPIMAGE, os.X_OK):
            return ()
        item = ${namespace}.MenuItem(name="ZeloteZVault::share", label=_LABEL,
            tip="Share files securely using ZeloteZ Vault", icon="folder-locked")
        item.connect("activate", self._share, paths)
        return (item,)

    def _share(self, _item, paths):
        try:
            subprocess.Popen([_APPIMAGE, "--vault-share", "--", *paths],
                cwd=os.path.dirname(paths[0]), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                close_fds=True, start_new_session=True)
        except OSError:
            # A moved/removed AppImage is repaired by reinstalling the integration.
            pass
`;
}

const dependencyProbe = `import glob,importlib,json,os,sys
manager=sys.argv[1]
namespace,versions=("Nautilus",("4.1","4.0","3.0")) if manager=="nautilus" else ("Caja",("2.0",))
python=False
try:
 import gi
 for version in versions:
  try:
   gi.require_version(namespace,version)
   importlib.import_module("gi.repository."+namespace)
   python=True
   break
  except (ImportError,ValueError,AttributeError): pass
except ImportError: pass
patterns=["/usr/lib*/"+manager+"/extensions-*/*"+manager+"*python*.so", "/usr/lib/*-linux-gnu/"+manager+"/extensions-*/*"+manager+"*python*.so", "/usr/local/lib*/"+manager+"/extensions-*/*"+manager+"*python*.so"]
loader=any(os.path.isfile(file) for pattern in patterns for file in glob.glob(pattern))
print(json.dumps({"python":python,"loader":loader}))
`;

async function detectPythonProvider(manager, env, execute) {
  const clean = { ...env };
  for (const name of ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "GI_TYPELIB_PATH",
    "GIO_MODULE_DIR", "GIO_EXTRA_MODULES", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GSETTINGS_SCHEMA_DIR"]) delete clean[name];
  try {
    const { stdout } = await execute("/usr/bin/python3", ["-I", "-c", dependencyProbe, manager],
      { env: clean, timeout: 5000, maxBuffer: 16384, windowsHide: true });
    const result = JSON.parse(stdout);
    return { python: result?.python === true, loader: result?.loader === true };
  } catch { return { python: false, loader: false }; }
}

module.exports = { providerMarker, pythonMenuEntry, detectPythonProvider };
