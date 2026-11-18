import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
import desktop_release_manifest as release

spec = importlib.util.spec_from_file_location("rooms_download_publisher", DEPLOY / "publish-desktop-downloads.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class DesktopReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rooms-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.keys = self.root / "operator"
        self.keys.mkdir(mode=0o700)
        self.private, self.public = self.key_pair("trusted")
        self.published = self.root / "downloads"

    def key_pair(self, name, *, algorithm="ED25519"):
        private, public = self.keys / (name + ".pem"), self.keys / (name + ".pub")
        command = [release.OPENSSL, "genpkey", "-algorithm", algorithm]
        if algorithm == "EC":
            command += ["-pkeyopt", "ec_paramgen_curve:prime256v1"]
        subprocess.run([*command, "-out", str(private)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        private.chmod(0o600)
        subprocess.run([release.OPENSSL, "pkey", "-in", str(private), "-pubout", "-out", str(public)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return private, public

    def source(self, version, suffix=b""):
        folder = self.root / ("incoming-" + version)
        folder.mkdir(exist_ok=True)
        for artifact in release.artifacts_for(version):
            magic = b"\x7fELF" if artifact["platform"] == "linux" else b"MZ"
            data = magic + b"synthetic local installer bytes\n" + suffix
            name = artifact["filename"]
            (folder / name).write_bytes(data)
            (folder / (name + ".sha256")).write_text(hashlib.sha256(data).hexdigest() + "  " + name + "\n")
        return folder

    def signed(self, version="0.1.33", suffix=b""):
        folder = self.source(version, suffix)
        release.sign_release(version, folder, self.private)
        return folder

    def publish(self, version, source):
        publisher.publish(version, source, self.published, self.public)

    def test_signed_release_publishes_exact_files_and_compatible_metadata(self):
        source = self.signed()
        manifest, data, signature = release.load_signed_release("0.1.33", source, self.public)
        self.assertEqual(len(signature), 64)
        self.assertEqual(manifest["schema"], 1)
        for artifact in manifest["artifacts"]:
            release.check_installer(source, artifact)
        self.publish("0.1.33", source)
        target = self.published / "0.1.33"
        self.assertEqual({item.name for item in target.iterdir()},
                         {release.MANIFEST_NAME, release.SIGNATURE_NAME, *[item["filename"] for item in manifest["artifacts"]]})
        self.assertEqual((target / release.MANIFEST_NAME).read_bytes(), data)
        self.assertEqual((target / release.SIGNATURE_NAME).read_bytes(), signature)
        current = json.loads((self.published / "current.json").read_bytes())
        descriptor = json.loads((self.published / "release.json").read_bytes())
        self.assertEqual(set(current), {"version", "downloads", "manifestUrl", "signatureUrl"})
        self.assertEqual(current["manifestUrl"], "/downloads/desktop/0.1.33/" + release.MANIFEST_NAME)
        self.assertEqual(current["signatureUrl"], "/downloads/desktop/0.1.33/" + release.SIGNATURE_NAME)
        self.assertEqual(set(descriptor), {"product", "protocol", "version", "artifacts"})
        self.assertEqual(descriptor["artifacts"], ["linux-x64", "windows-x64"])
        for item, artifact in zip(current["downloads"], manifest["artifacts"], strict=True):
            self.assertEqual(item["sha256"], artifact["sha256"])
            self.assertEqual(item["size"], artifact["size"])
            self.assertEqual((target / artifact["filename"]).read_bytes(), (source / artifact["filename"]).read_bytes())
        before = (self.published / "current.json").read_bytes()
        self.publish("0.1.33", source)
        self.assertEqual((self.published / "current.json").read_bytes(), before)

    def test_unsigned_or_wrong_key_inputs_cannot_publish(self):
        source = self.source("0.1.33")
        with self.assertRaises(OSError):
            self.publish("0.1.33", source)
        self.assertFalse(self.published.exists())
        release.sign_release("0.1.33", source, self.private)
        _, other_public = self.key_pair("other")
        with self.assertRaises(ValueError):
            publisher.publish("0.1.33", source, self.published, other_public)
        self.assertFalse(self.published.exists())
        incoming_key = source / "public.pem"
        incoming_key.write_bytes(self.public.read_bytes())
        with self.assertRaisesRegex(ValueError, "outside"):
            publisher.publish("0.1.33", source, self.published, incoming_key)

    def test_changed_artifact_and_checksum_leave_published_release_untouched(self):
        self.publish("0.1.33", self.signed())
        before = {name: (self.published / name).read_bytes() for name in ["current.json", "release.json"]}
        source = self.signed("0.1.34")
        name = release.artifacts_for("0.1.34")[1]["filename"]
        data = b"MZ" + b"a different synthetic fixture\n"
        (source / name).write_bytes(data)
        (source / (name + ".sha256")).write_text(hashlib.sha256(data).hexdigest() + "  " + name + "\n")
        with self.assertRaises(ValueError):
            self.publish("0.1.34", source)
        self.assertFalse((self.published / "0.1.34").exists())
        for name, expected in before.items():
            self.assertEqual((self.published / name).read_bytes(), expected)
        self.assertFalse(list(self.published.glob(".publish-*")))

    def test_signed_schema_is_strict_and_manifest_inputs_are_bounded(self):
        source = self.signed()
        original = json.loads((source / release.MANIFEST_NAME).read_bytes())
        edits = [lambda doc: doc.update(schema=True), lambda doc: doc.update(version="0.1.34"),
                 lambda doc: doc["artifacts"][0].update(filename="../installer"),
                 lambda doc: doc["artifacts"][0].update(size=True),
                 lambda doc: doc["artifacts"][0].update(size=release.MAX_INSTALLER + 1),
                 lambda doc: doc["artifacts"][0].update(platform="macos"),
                 lambda doc: doc["artifacts"].append(copy.deepcopy(doc["artifacts"][0]))]
        for edit in edits:
            document = copy.deepcopy(original)
            edit(document)
            data = release.canonical(document)
            (source / release.MANIFEST_NAME).write_bytes(data)
            (source / release.SIGNATURE_NAME).write_bytes(release.signature_for(data, source, self.private))
            with self.subTest(document=document), self.assertRaises(ValueError):
                release.load_signed_release("0.1.33", source, self.public)
        (source / release.MANIFEST_NAME).write_bytes(b" " * (release.MAX_MANIFEST + 1))
        with self.assertRaises(ValueError):
            release.load_signed_release("0.1.33", source, self.public)
        (source / release.MANIFEST_NAME).write_bytes(release.canonical(original))
        (source / release.SIGNATURE_NAME).write_bytes(b"s" * 65)
        with self.assertRaises(ValueError):
            release.load_signed_release("0.1.33", source, self.public)

    def test_immutable_versions_and_downgrade_check_preserve_current_release(self):
        self.publish("0.1.34", self.signed("0.1.34"))
        before = (self.published / "current.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "older"):
            self.publish("0.1.33", self.signed("0.1.33"))
        changed = self.signed("0.1.34", b"new fixture contents")
        with self.assertRaisesRegex(ValueError, "Signed installer"):
            self.publish("0.1.34", changed)
        self.assertEqual((self.published / "current.json").read_bytes(), before)

    def test_key_protection_algorithm_and_symlinks_are_checked(self):
        source = self.signed()
        ec_private, ec_public = self.key_pair("wrong-algorithm", algorithm="EC")
        with self.assertRaisesRegex(ValueError, "Ed25519"):
            release.sign_release("0.1.33", source, ec_private)
        with self.assertRaisesRegex(ValueError, "Ed25519"):
            release.load_signed_release("0.1.33", source, ec_public)
        self.private.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "protected"):
            release.sign_release("0.1.33", source, self.private)
        self.private.chmod(0o600)
        self.public.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "protected"):
            release.load_signed_release("0.1.33", source, self.public)
        self.public.chmod(0o644)
        alias = self.keys / "alias.pub"
        alias.symlink_to(self.public)
        with self.assertRaises(OSError):
            release.load_signed_release("0.1.33", source, alias)
        name = release.artifacts_for("0.1.33")[0]["filename"]
        artifact = source / name
        saved = self.root / "installer"
        artifact.rename(saved)
        artifact.symlink_to(saved)
        with self.assertRaises(OSError):
            self.publish("0.1.33", source)

    def test_cli_requires_explicit_trusted_key_and_verifies_signed_local_files(self):
        source = self.source("0.1.33")
        command = [sys.executable, str(DEPLOY / "desktop-release-signature.py")]
        signed = subprocess.run([*command, "sign", "0.1.33", "--source", str(source), "--private-key", str(self.private)],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(signed.returncode, 0, signed.stderr)
        verified = subprocess.run([*command, "verify", "0.1.33", "--source", str(source), "--trusted-key", str(self.public)],
                                  capture_output=True, text=True, timeout=20)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        rejected = subprocess.run([sys.executable, str(DEPLOY / "publish-desktop-downloads.py"), "0.1.33", "--source", str(source)],
                                  capture_output=True, text=True, timeout=20)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("--trusted-key", rejected.stderr)
        for result in [signed, verified, rejected]:
            self.assertNotIn("BEGIN PRIVATE KEY", result.stdout + result.stderr)

    def test_single_platform_verification_authenticates_the_complete_manifest(self):
        source = self.signed()
        linux = release.artifacts_for("0.1.33")[0]["filename"]
        (source / linux).unlink()
        command = [sys.executable, str(DEPLOY / "desktop-release-signature.py"), "verify", "0.1.33",
                   "--source", str(source), "--trusted-key", str(self.public)]
        selected = subprocess.run([*command, "--platform", "windows"], capture_output=True, text=True, timeout=20)
        self.assertEqual(selected.returncode, 0, selected.stderr)
        all_installers = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(all_installers.returncode, 0)
        with self.assertRaises(OSError):
            self.publish("0.1.33", source)
        self.assertFalse((self.published / "0.1.33").exists())
        document = json.loads((source / release.MANIFEST_NAME).read_bytes())
        document["artifacts"][0]["filename"] = "wrong-linux-name.AppImage"
        data = release.canonical(document)
        (source / release.MANIFEST_NAME).write_bytes(data)
        (source / release.SIGNATURE_NAME).write_bytes(release.signature_for(data, source, self.private))
        invalid_manifest = subprocess.run([*command, "--platform", "windows"], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(invalid_manifest.returncode, 0)


if __name__ == "__main__":
    unittest.main()
