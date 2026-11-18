#!/usr/bin/env python3
"""Prepare a read-only migration plan from the legacy Rooms stack to one image."""

import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


DEFAULT_IMAGE = "ghcr.io/zelotez/zelotez-rooms:latest"
SERVICES = ("server", "gateway", "mediamtx")
VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")


class MigrationError(ValueError):
    pass


def command(arguments):
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MigrationError(f"Could not run {arguments[0]} (or it timed out).") from error
    if result.returncode:
        # Docker errors/configuration can contain environment values. Do not print them.
        raise MigrationError(f"Read-only Docker/Compose check failed (exit {result.returncode}). "
                             "Check Docker access, the legacy project name, and its Compose configuration.")
    return result.stdout.strip()


def document(run, arguments):
    try:
        return json.loads(run(arguments))
    except json.JSONDecodeError as error:
        raise MigrationError("Docker/Compose returned an unexpected response.") from error


def require_version(value, minimum, description):
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", value)
    if not match or tuple(map(int, match.groups())) < minimum:
        raise MigrationError(f"{description} {'.'.join(map(str, minimum))} or later is required.")


def environment(container):
    result = {}
    for entry in container.get("Config", {}).get("Env", []):
        key, separator, value = entry.partition("=")
        if separator:
            result[key] = value
    return result


def mount(container, target, kind):
    matches = [entry for entry in container.get("Mounts", []) if entry.get("Destination") == target]
    if len(matches) != 1 or matches[0].get("Type") != kind:
        raise MigrationError(f"The legacy mount at {target} must be one existing {kind} mount; "
                             "custom storage layouts need a manual migration.")
    return matches[0]


def port(container, target):
    bindings = container.get("HostConfig", {}).get("PortBindings", {}).get(target, []) or []
    if len(bindings) != 1:
        raise MigrationError(f"Expected one explicit legacy port binding for {target}.")
    try:
        number = int(bindings[0]["HostPort"])
        if not 1 <= number <= 65535:
            raise ValueError()
        host = str(ipaddress.ip_address(bindings[0].get("HostIp") or "0.0.0.0"))
    except (KeyError, ValueError) as error:
        raise MigrationError(f"The legacy binding for {target} must use a fixed port and IP address.") from error
    return host, number


def addresses_overlap(left, right):
    left, right = ipaddress.ip_address(left), ipaddress.ip_address(right)
    return left == right or (left.version == right.version and (left.is_unspecified or right.is_unspecified))


def dotenv(value):
    value = str(value)
    if any(ord(character) < 32 or ord(character) == 127 for character in value) or "\\'" in value:
        raise MigrationError("A legacy setting cannot be represented safely in .env; prepare it manually.")
    return "'" + value.replace("'", "\\'") + "'"


def shell(arguments):
    return shlex.join(map(str, arguments))


def inspect_legacy(compose, image, run):
    require_version(run(["docker", "compose", "version", "--short"]), (2, 24, 4), "Docker Compose")
    require_version(run(["docker", "version", "--format", "{{.Server.Version}}"]), (28, 0, 0), "Docker Engine")
    config = document(run, compose + ["config", "--format", "json"])
    if not set(SERVICES).issubset(config.get("services", {})):
        raise MigrationError("Expected the legacy server, gateway and mediamtx Compose services.")
    ids = []
    for service in SERVICES:
        found = run(compose + ["ps", "--all", "--quiet", service]).split()
        if len(found) != 1 or not re.fullmatch(r"[a-f0-9]{12,64}", found[0]):
            raise MigrationError(f"Expected exactly one existing {service} container. "
                                 "Keep the old containers and specify their original --project-name if needed.")
        ids.append(found[0])
    containers = document(run, ["docker", "inspect", *ids])
    by_service = {}
    for container in containers:
        labels = container.get("Config", {}).get("Labels", {}) or {}
        if labels.get("com.docker.compose.project") != config.get("name"):
            raise MigrationError("An inspected container belongs to a different Compose project.")
        service = labels.get("com.docker.compose.service")
        if service not in SERVICES or service in by_service:
            raise MigrationError("The legacy container service labels are ambiguous.")
        by_service[service] = container
    if set(by_service) != set(SERVICES):
        raise MigrationError("The legacy container set is incomplete.")
    server, gateway, media = (by_service[name] for name in SERVICES)
    server_env, media_env = environment(server), environment(media)
    if server_env.get("APP_DATA_DIR") != "/data" or server_env.get("WATCH_MEDIA_DIR") != "/watch-data":
        raise MigrationError("Custom legacy data paths need a manual migration.")
    if media_env.get("MTX_RTMPENCRYPTION", "strict") == "no":
        raise MigrationError("This planner targets the production RTMPS stack; development RTMP needs manual configuration.")
    data, watch = mount(server, "/data", "volume"), mount(server, "/watch-data", "volume")
    names = [data.get("Name", ""), watch.get("Name", "")]
    if any(not VOLUME_NAME.fullmatch(name) for name in names) or names[0] == names[1]:
        raise MigrationError("Expected two distinct, existing named Docker volumes.")
    volumes = document(run, ["docker", "volume", "inspect", *names])
    if {entry.get("Name") for entry in volumes} != set(names):
        raise MigrationError("The existing data/media volumes could not be verified.")
    downloads, tls = mount(gateway, "/srv/desktop-downloads", "bind"), mount(media, "/tls", "bind")
    for entry in [downloads, tls]:
        if not isinstance(entry.get("Source"), str) or not Path(entry["Source"]).is_absolute():
            raise MigrationError("Expected absolute existing download/TLS bind paths.")
    web_ip, web_port = port(gateway, "8080/tcp")
    if web_ip != "127.0.0.1":
        raise MigrationError("The image template expects a loopback web binding (127.0.0.1); "
                             "custom legacy gateway exposure needs an explicit manual override.")
    ingest_ip, ingest_port = port(media, "1936/tcp")
    udp = re.fullmatch(r":([0-9]{1,5})", media_env.get("MTX_WEBRTCLOCALUDPADDRESS", ":8189"))
    tcp = re.fullmatch(r":([0-9]{1,5})", media_env.get("MTX_WEBRTCLOCALTCPADDRESS", ":8189"))
    if not udp or not tcp or udp[1] != tcp[1]:
        raise MigrationError("Custom WebRTC listener settings need a manual migration.")
    ice_ip, ice_port = port(media, udp[1] + "/udp")
    ice_tcp_ip, ice_tcp_port = port(media, tcp[1] + "/tcp")
    if (ice_ip, ice_port) != (ice_tcp_ip, ice_tcp_port) or ice_port != int(udp[1]):
        raise MigrationError("The legacy WebRTC TCP/UDP host and container ports must match.")
    bindings = [(web_ip, web_port), (ingest_ip, ingest_port), (ice_ip, ice_port)]
    for index, (host, number) in enumerate(bindings):
        if any(number == other_number and addresses_overlap(host, other_host)
               for other_host, other_number in bindings[:index]):
            raise MigrationError("The legacy published TCP ports would collide in the image deployment.")
    origin = server_env.get("PUBLIC_ORIGIN", "")
    if not origin or server_env.get("TRUST_PROXY_IP") not in ("0", "1"):
        raise MigrationError("The legacy canonical origin/proxy settings are missing.")
    host_literal = lambda value: "[" + value + "]" if ":" in value else value
    values = {
        "ROOMS_IMAGE": image, "ROOMS_DATA_VOLUME": names[0], "ROOMS_WATCH_VOLUME": names[1],
        "PUBLIC_ORIGIN": origin, "TRUST_PROXY_IP": server_env["TRUST_PROXY_IP"], "WEB_PORT": web_port,
        "INGEST_IP": host_literal(ingest_ip), "INGEST_PORT": ingest_port,
        "STREAM_INGEST_BASE": server_env.get("STREAM_INGEST_BASE", ""),
        "VOICE_ICE_HOST": media_env.get("MTX_WEBRTCADDITIONALHOSTS", "127.0.0.1"),
        "VOICE_ICE_IP": host_literal(ice_ip), "VOICE_ICE_PORT": ice_port,
        "RTMPS_CERT_DIR": tls["Source"], "ROOMS_DESKTOP_DOWNLOADS_DIR": downloads["Source"],
    }
    # Refuse values we cannot preserve literally; never copy unrelated environment fields.
    for value in values.values():
        dotenv(value)
    return values, config["name"], [name for name, container in by_service.items() if container.get("State", {}).get("Running")]


def instructions(source, target, values, project, running):
    compose = ["docker", "compose", "--env-file", str(target / ".env"), "-f", str(target / "compose.yaml"),
               "-f", str(target / "compose.migration.yaml")]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = target.parent / (project + "-backup-" + stamp)
    lines = [
        "Rooms: prepared one-image migration (no running system was changed)", "",
        "Review .env and both Compose files. PUBLIC_ORIGIN is preserved exactly.",
        "The two existing Docker volumes are external: a typo must fail instead of creating an empty database.",
        "Do not run old and new servers against these volumes at the same time.",
        "Legacy running services at inspection: " + (", ".join(running) or "none"), "",
        "1. Check/download the target image while the old stack is still available:", shell(compose + ["pull"]), "",
        "2. Stop the legacy stack manually. Keep its containers and images for rollback:", shell(source + ["stop"]), "",
        "3. Make consistent, separate offline backups of BOTH volumes before the first new start:",
        "BACKUP_DIR=" + shlex.quote(str(backup)), 'mkdir -m 700 -- "$BACKUP_DIR"',
    ]
    for variable, archive in [("ROOMS_DATA_VOLUME", "community.tar.gz"), ("ROOMS_WATCH_VOLUME", "watch-media.tar.gz")]:
        lines.append(shell(["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                            "--entrypoint", "tar", "--mount", "type=volume,src=" + values[variable] + ",dst=/source,readonly"])
                     + ' --mount "type=bind,src=$BACKUP_DIR,dst=/backup" '
                     + shell([values["ROOMS_IMAGE"], "-C", "/source", "-czf", "/backup/" + archive, "."]))
    lines += [
        "Also retain the old Compose files, instance configuration and TLS material in a private backup.",
        "The planner does not read private keys, copy live database files, change ownership, or test a restore.", "",
        "4. RTMPS: /tls/fullchain.pem and /tls/privkey.pem must be readable by container UID/GID 1000.",
        "Use a restricted group or ACL where needed; this planner never edits permissions.",
        "Run Compose without conflicting exported deployment variables overriding the generated .env.",
        shell(compose + ["up", "-d", "--wait"]), "",
        "5. Verify the existing account, rooms and encrypted history at the unchanged origin.",
        "Desktop downloads retain the same existing host directory and files.",
        "Active calls/streams/watch parties end during restart. Uploaded watch-party media is temporary;",
        "the server intentionally removes old watch-video files at startup even when its volume is retained.", "",
        "Later updates are operator-controlled: pull the image, then up -d --wait with these same files.",
        "Back up before each update. No automatic production rollout was configured.", "",
        "Rollback: stop the image deployment first:", shell(compose + ["stop"]),
        "Check release/database migration compatibility before restarting an older server.",
        "If needed, restore the tested offline volume backups with BOTH stacks stopped; never mix writers.",
        "Then restart the retained old containers (without rebuilding):", shell(source + ["start"]), "",
    ]
    return "\n".join(lines)


def prepare(project_directory, compose_file, env_file, output, template, image=DEFAULT_IMAGE, project_name=None, run=command):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]*", image):
        raise MigrationError("Use a Docker image reference without whitespace or interpolation.")
    project_directory, compose_file, env_file, template = [
        Path(item).expanduser().resolve() for item in (project_directory, compose_file, env_file, template)
    ]
    output = Path(output).expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise MigrationError("The output directory already exists; choose a new directory. Nothing was overwritten.")
    if not compose_file.is_file() or not env_file.is_file() or not template.is_file():
        raise MigrationError("The legacy Compose/.env files and image template must already exist.")
    if not output.parent.is_dir():
        raise MigrationError("The output parent directory must already exist.")
    source = ["docker", "compose", "--project-directory", str(project_directory), "--env-file", str(env_file), "-f", str(compose_file)]
    if project_name:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project_name):
            raise MigrationError("Invalid legacy Compose project name.")
        source += ["--project-name", project_name]
    values, project, running = inspect_legacy(source, image, run)
    for name, value in values.items():
        if name in os.environ and os.environ[name] != str(value):
            raise MigrationError(f"An exported {name} would override the prepared settings. Unset it and rerun.")
    temporary = Path(tempfile.mkdtemp(prefix=".rooms-migration-", dir=output.parent))
    try:
        files = {
            ".env": "\n".join(name + "=" + dotenv(value) for name, value in values.items()) + "\n",
            "compose.yaml": template.read_text(encoding="utf-8"),
            "compose.migration.yaml": json.dumps({
                "services": {"rooms": {"volumes": [
                    {"type": "bind", "source": "${ROOMS_DESKTOP_DOWNLOADS_DIR}", "target": "/srv/desktop-downloads",
                     "read_only": True, "bind": {"create_host_path": False}},
                    {"type": "bind", "source": "${RTMPS_CERT_DIR}", "target": "/tls",
                     "read_only": True, "bind": {"create_host_path": False}},
                ]}},
                "volumes": {
                    "community": {"external": True, "name": "${ROOMS_DATA_VOLUME}"},
                    "watch-media": {"external": True, "name": "${ROOMS_WATCH_VOLUME}"},
                },
            }, indent=2) + "\n",
            "MIGRATION.txt": instructions(source, output, values, project, running),
        }
        for name, content in files.items():
            file = temporary / name
            with file.open("x", encoding="utf-8") as stream:
                stream.write(content)
            file.chmod(0o600)
        target = ["docker", "compose", "--project-directory", str(temporary), "--env-file", str(temporary / ".env"),
                  "-f", str(temporary / "compose.yaml"), "-f", str(temporary / "compose.migration.yaml")]
        normalized = document(run, target + ["config", "--format", "json"])
        if set(normalized.get("services", {})) != {"rooms"}:
            raise MigrationError("The target template must contain exactly the single rooms service.")
        for key, variable in [("community", "ROOMS_DATA_VOLUME"), ("watch-media", "ROOMS_WATCH_VOLUME")]:
            volume = normalized.get("volumes", {}).get(key, {})
            if volume.get("name") != values[variable] or volume.get("external") is not True:
                raise MigrationError("The target Compose configuration did not preserve the external data volumes.")
        rooms = normalized["services"]["rooms"]
        target_env = rooms.get("environment", {})
        for key in ["PUBLIC_ORIGIN", "TRUST_PROXY_IP", "STREAM_INGEST_BASE", "VOICE_ICE_HOST", "VOICE_ICE_PORT"]:
            if str(target_env.get(key, "")).replace("$$", "$") != str(values[key]):
                raise MigrationError(f"The target template did not preserve {key}.")
        if rooms.get("image") != image:
            raise MigrationError("The target template did not preserve the requested image.")
        target_mounts = {entry.get("target"): entry for entry in rooms.get("volumes", [])}
        for target_path, source_key in [("/data", "community"), ("/watch-data", "watch-media")]:
            entry = target_mounts.get(target_path, {})
            if entry.get("type") != "volume" or entry.get("source") != source_key:
                raise MigrationError("The target template did not preserve data/media mount points.")
        for target_path, variable in [("/tls", "RTMPS_CERT_DIR"), ("/srv/desktop-downloads", "ROOMS_DESKTOP_DOWNLOADS_DIR")]:
            entry = target_mounts.get(target_path, {})
            if (entry.get("type") != "bind" or not entry.get("read_only") or
                    entry.get("bind", {}).get("create_host_path") is not False or
                    str(entry.get("source", "")).replace("$$", "$") != values[variable]):
                raise MigrationError("The target template did not preserve read-only TLS/download bindings.")
        actual_ports = {(entry.get("host_ip"), str(entry.get("published")), int(entry.get("target", 0)), entry.get("protocol", "tcp"))
                        for entry in rooms.get("ports", [])}
        expected_ports = {("127.0.0.1", str(values["WEB_PORT"]), 8080, "tcp"),
                          (values["INGEST_IP"].strip("[]"), str(values["INGEST_PORT"]), 1936, "tcp"),
                          (values["VOICE_ICE_IP"].strip("[]"), str(values["VOICE_ICE_PORT"]), values["VOICE_ICE_PORT"], "udp"),
                          (values["VOICE_ICE_IP"].strip("[]"), str(values["VOICE_ICE_PORT"]), values["VOICE_ICE_PORT"], "tcp")}
        if actual_ports != expected_ports:
            raise MigrationError("The target template did not preserve the exact legacy port bindings.")
        temporary.rename(output)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-directory", type=Path, default=Path.cwd(), help="original legacy deployment directory")
    parser.add_argument("--compose-file", type=Path, help="old Compose file (default: PROJECT/compose.yaml)")
    parser.add_argument("--env-file", type=Path, help="old .env (default: PROJECT/.env)")
    parser.add_argument("--project-name", help="original Compose project name, if explicitly chosen")
    parser.add_argument("--output", type=Path, required=True, help="new, non-existing directory for the plan/configuration")
    parser.add_argument("--image", default=DEFAULT_IMAGE, help="operator-selected image tag or digest")
    parser.add_argument("--template", type=Path, default=Path(__file__).with_name("compose.image.yaml"))
    args = parser.parse_args()
    try:
        prepare(args.project_directory, args.compose_file or args.project_directory / "compose.yaml",
                args.env_file or args.project_directory / ".env", args.output, args.template, args.image, args.project_name)
    except (OSError, MigrationError) as error:
        parser.exit(1, f"Migration plan not prepared: {error}\n")
    print(f"Prepared {args.output.resolve()}. No containers, volumes or live configuration were changed.")
    print("Review MIGRATION.txt before the manual stop, backup and start steps.")


if __name__ == "__main__":
    main()
