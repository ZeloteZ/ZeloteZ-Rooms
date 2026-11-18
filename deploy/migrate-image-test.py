#!/usr/bin/env python3
"""Offline migration-planner regression checks; no Docker daemon or containers used."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from unittest import TestCase, main, mock, skipUnless


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("rooms_migration", HERE / "migrate-image.py")
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


class DockerFixture:
    def __init__(self, template):
        self.calls = []
        self.compose_version, self.engine_version = "2.40.3", "28.5.1"
        self.project = "original-rooms"
        self.ids = {name: str(index) * 64 for index, name in enumerate(migration.SERVICES, 1)}
        self.containers = {}
        for name in migration.SERVICES:
            self.containers[name] = {"Config": {"Labels": {
                "com.docker.compose.project": self.project, "com.docker.compose.service": name,
            }, "Env": []}, "Mounts": [], "HostConfig": {"PortBindings": {}}, "State": {"Running": True}}
        self.containers["server"]["Config"]["Env"] = [
            "APP_DATA_DIR=/data", "WATCH_MEDIA_DIR=/watch-data", "PUBLIC_ORIGIN=https://rooms.example.test",
            "TRUST_PROXY_IP=1", "STREAM_INGEST_BASE=rtmps://ingest.example.test:21936",
            "UNRELATED_SECRET=DO_NOT_COPY_THIS_VALUE",
        ]
        self.containers["server"]["Mounts"] = [
            {"Type": "volume", "Destination": "/data", "Name": "keep-this-community", "RW": True},
            {"Type": "volume", "Destination": "/watch-data", "Name": "keep-this-watch-media", "RW": True},
        ]
        self.containers["gateway"]["Mounts"] = [{"Type": "bind", "Destination": "/srv/desktop-downloads",
                                                   "Source": "/srv/Old Room's downloads", "RW": False}]
        self.containers["mediamtx"]["Mounts"] = [{"Type": "bind", "Destination": "/tls",
                                                    "Source": "/srv/rooms tls", "RW": False}]
        self.containers["gateway"]["HostConfig"]["PortBindings"] = {
            "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "28080"}],
        }
        self.containers["mediamtx"]["HostConfig"]["PortBindings"] = {
            "1936/tcp": [{"HostIp": "0.0.0.0", "HostPort": "21936"}],
            "28189/udp": [{"HostIp": "192.0.2.2", "HostPort": "28189"}],
            "28189/tcp": [{"HostIp": "192.0.2.2", "HostPort": "28189"}],
        }
        self.containers["mediamtx"]["Config"]["Env"] = [
            "MTX_WEBRTCLOCALUDPADDRESS=:28189", "MTX_WEBRTCLOCALTCPADDRESS=:28189",
            "MTX_WEBRTCADDITIONALHOSTS=media.example.test", "MTX_RTMPENCRYPTION=strict",
        ]
        self.volume_names = ["keep-this-community", "keep-this-watch-media"]
        self.target_model = None

    def __call__(self, arguments):
        self.calls.append(arguments)
        if arguments == ["docker", "compose", "version", "--short"]:
            return self.compose_version
        if arguments[:2] == ["docker", "version"]:
            return self.engine_version
        if arguments[:3] == ["docker", "volume", "inspect"]:
            return json.dumps([{"Name": name} for name in self.volume_names])
        if arguments[:2] == ["docker", "inspect"]:
            return json.dumps(list(self.containers.values()))
        if "ps" in arguments:
            return self.ids[arguments[-1]]
        if arguments[-3:] == ["config", "--format", "json"]:
            if "compose.migration.yaml" not in " ".join(arguments):
                return json.dumps({"name": self.project, "services": {name: {} for name in migration.SERVICES}})
            self.target_model = json.loads(migration.command(arguments))
            return json.dumps(self.target_model)
        raise AssertionError("Unexpected/mutating Docker command: " + repr(arguments))


@skipUnless(shutil.which("docker"), "Docker Compose CLI needed for offline YAML rendering")
class PlannerTests(TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rooms-migrate-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.old = self.root / "old deployment"
        self.old.mkdir()
        (self.old / "compose.yaml").write_text("# synthetic old config\n")
        (self.old / ".env").write_text("UNRELATED_SECRET=DO_NOT_COPY_THIS_VALUE\n")
        self.target = self.root / "new deployment"
        self.template = self.root / "template.yaml"
        self.template.write_bytes((HERE / "compose.image.yaml").read_bytes())
        self.docker = DockerFixture(self.template)
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def prepare(self):
        return migration.prepare(self.old, self.old / "compose.yaml", self.old / ".env", self.target,
                                 self.template, image="example.test/rooms:1.2.3", run=self.docker)

    def test_preserves_actual_storage_runtime_settings_and_uses_only_read_only_commands(self):
        values = self.prepare()
        self.assertEqual(values["ROOMS_DATA_VOLUME"], "keep-this-community")
        self.assertEqual(values["ROOMS_WATCH_VOLUME"], "keep-this-watch-media")
        self.assertEqual(values["PUBLIC_ORIGIN"], "https://rooms.example.test")
        self.assertEqual(values["TRUST_PROXY_IP"], "1")
        self.assertEqual(values["WEB_PORT"], 28080)
        self.assertEqual(values["INGEST_PORT"], 21936)
        self.assertEqual(values["VOICE_ICE_PORT"], 28189)
        self.assertEqual(self.docker.target_model["services"]["rooms"]["image"], "example.test/rooms:1.2.3")
        for mount in self.docker.target_model["services"]["rooms"]["volumes"]:
            if mount["type"] == "bind":
                self.assertIs(mount["bind"]["create_host_path"], False)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o700)
        for file in self.target.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertNotIn("DO_NOT_COPY_THIS_VALUE", file.read_text())
        self.assertTrue(all("up" not in call and "stop" not in call and "pull" not in call and "run" not in call
                            for call in self.docker.calls))
        guide = (self.target / "MIGRATION.txt").read_text()
        self.assertIn("UID/GID 1000", guide)
        self.assertIn("watch-party media is temporary", guide)
        self.assertIn("restore", guide)
        self.assertIn("--entrypoint tar", guide)

    def test_existing_output_is_never_overwritten(self):
        self.target.mkdir()
        (self.target / "existing").write_text("keep")
        with self.assertRaisesRegex(migration.MigrationError, "already exists"):
            self.prepare()
        self.assertEqual((self.target / "existing").read_text(), "keep")
        self.assertEqual(self.docker.calls, [])

    def test_symlink_output_is_rejected(self):
        other = self.root / "must not be created"
        self.target.symlink_to(other)
        with self.assertRaisesRegex(migration.MigrationError, "already exists"):
            self.prepare()
        self.assertFalse(other.exists())

    def test_old_docker_or_compose_is_rejected_before_output(self):
        for attribute, version in [("engine_version", "27.5.0"), ("compose_version", "2.24.3")]:
            with self.subTest(attribute=attribute):
                old = getattr(self.docker, attribute)
                setattr(self.docker, attribute, version)
                with self.assertRaisesRegex(migration.MigrationError, "or later"):
                    self.prepare()
                self.assertFalse(self.target.exists())
                setattr(self.docker, attribute, old)

    def test_missing_legacy_container_rejected(self):
        self.docker.ids["server"] = ""
        with self.assertRaisesRegex(migration.MigrationError, "existing server container"):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_wrong_project_or_missing_volume_rejected(self):
        self.docker.containers["server"]["Config"]["Labels"]["com.docker.compose.project"] = "other"
        with self.assertRaisesRegex(migration.MigrationError, "different Compose project"):
            self.prepare()
        self.docker.containers["server"]["Config"]["Labels"]["com.docker.compose.project"] = self.docker.project
        self.docker.volume_names.pop()
        with self.assertRaisesRegex(migration.MigrationError, "volumes could not be verified"):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_port_collision_is_rejected(self):
        self.docker.containers["gateway"]["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostPort"] = "21936"
        with self.assertRaisesRegex(migration.MigrationError, "collide"):
            self.prepare()
        self.assertFalse(self.target.exists())

    def test_custom_media_binding_or_storage_is_rejected(self):
        self.docker.containers["mediamtx"]["HostConfig"]["PortBindings"]["28189/tcp"][0]["HostPort"] = "28190"
        with self.assertRaisesRegex(migration.MigrationError, "must match"):
            self.prepare()
        self.docker.containers["mediamtx"]["HostConfig"]["PortBindings"]["28189/tcp"][0]["HostPort"] = "28189"
        self.docker.containers["server"]["Mounts"][0]["Type"] = "bind"
        with self.assertRaisesRegex(migration.MigrationError, "existing volume mount"):
            self.prepare()

    def test_conflicting_exported_environment_does_not_silently_change_target(self):
        with mock.patch.dict(os.environ, {"PUBLIC_ORIGIN": "https://other.example.test"}):
            with self.assertRaisesRegex(migration.MigrationError, "exported PUBLIC_ORIGIN"):
                self.prepare()
        self.assertFalse(self.target.exists())

    def test_invalid_target_mapping_is_rejected_and_staging_removed(self):
        self.template.write_text(self.template.read_text().replace("community:/data", "community:/wrong-data"))
        with self.assertRaisesRegex(migration.MigrationError, "mount points"):
            self.prepare()
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.root.glob(".rooms-migration-*")), [])


if __name__ == "__main__":
    main(verbosity=2)
