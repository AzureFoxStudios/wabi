#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import posixpath
import shlex
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import paramiko


REPO_ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIR_NAMES = {
    ".git",
    ".svelte-kit",
    "node_modules",
    "build",
    "data",
    "uploads",
    "__pycache__",
    ".local-data-test",
}
EXCLUDED_FILE_NAMES = {".env", ".wabi-profile", "wabi.config"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync the current Wabi worktree to a remote box over SSH without overwriting local state."
    )
    parser.add_argument("--host", required=True, help="Remote SSH host")
    parser.add_argument("--user", required=True, help="Remote SSH user")
    parser.add_argument("--password", required=True, help="Remote SSH password")
    parser.add_argument(
        "--remote-path",
        default=None,
        help="Remote repo path. Defaults to /var/home/<user>/Documents/wabi",
    )
    parser.add_argument(
        "--set",
        dest="overrides",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Override or append a key in remote wabi.config before launch. Repeat as needed.",
    )
    parser.add_argument(
        "--launch",
        action="store_true",
        help="Run scripts/launch.sh --reconfigure on the remote box after sync.",
    )
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help="Sync only locally changed/untracked files instead of packaging the full worktree.",
    )
    return parser.parse_args()


def should_exclude(rel_path: str, is_dir: bool) -> bool:
    parts = [part for part in rel_path.replace("\\", "/").split("/") if part and part != "."]
    if not parts:
        return False
    if any(part in EXCLUDED_DIR_NAMES for part in parts[:-1]):
        return True
    leaf = parts[-1]
    if is_dir and leaf in EXCLUDED_DIR_NAMES:
        return True
    if not is_dir and leaf in EXCLUDED_FILE_NAMES:
        return True
    return False


def build_archive() -> Path:
    temp_dir = Path(tempfile.mkdtemp(prefix="wabi-remote-sync-"))
    archive_path = temp_dir / "wabi-sync.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        for root, dir_names, file_names in os.walk(REPO_ROOT):
            root_path = Path(root)
            rel_root = root_path.relative_to(REPO_ROOT)
            dir_names[:] = [
                name
                for name in dir_names
                if not should_exclude(str(rel_root / name), is_dir=True)
            ]
            for file_name in file_names:
                rel_file = rel_root / file_name
                if should_exclude(str(rel_file), is_dir=False):
                    continue
                file_path = root_path / file_name
                try:
                    tar.add(file_path, arcname=str(rel_file).replace("\\", "/"))
                except PermissionError:
                    print(f"[deploy_remote] Skipping unreadable file: {rel_file}", file=sys.stderr)
    return archive_path


def list_changed_files() -> tuple[list[str], list[str]]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    entries = result.stdout.split(b"\0")
    uploads: list[str] = []
    deletes: list[str] = []
    seen_uploads: set[str] = set()
    seen_deletes: set[str] = set()

    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue

        status = entry[:2].decode("utf-8", errors="replace")
        path = entry[3:].decode("utf-8", errors="replace").replace("\\", "/")
        rename_target: str | None = None
        if "R" in status or "C" in status:
            if index < len(entries) and entries[index]:
                rename_target = entries[index].decode("utf-8", errors="replace").replace("\\", "/")
                index += 1

        if rename_target is not None:
            if not should_exclude(path, is_dir=False) and path not in seen_deletes:
                deletes.append(path)
                seen_deletes.add(path)
            path = rename_target

        if "D" in status:
            if not should_exclude(path, is_dir=False) and path not in seen_deletes:
                deletes.append(path)
                seen_deletes.add(path)
            continue

        local_path = REPO_ROOT / path
        if local_path.is_dir() or should_exclude(path, is_dir=False):
            continue
        if path not in seen_uploads:
            uploads.append(path)
            seen_uploads.add(path)

    return uploads, deletes


def connect_ssh(host: str, user: str, password: str) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    # Reject unknown host keys. Deployments must provision the target host key
    # in the user's known_hosts file instead of silently trusting first use.
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        hostname=host,
        username=user,
        password=password,
        timeout=15,
        banner_timeout=15,
        auth_timeout=15,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def run_remote(client: paramiko.SSHClient, command: str, timeout: int = 1200) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    exit_code = stdout.channel.recv_exit_status()
    return exit_code, out, err


def upload_archive(client: paramiko.SSHClient, archive_path: Path, remote_archive_path: str) -> None:
    sftp = client.open_sftp()
    try:
        sftp.put(str(archive_path), remote_archive_path)
    finally:
        sftp.close()


def sync_changed_files(client: paramiko.SSHClient, remote_path: str) -> tuple[int, int]:
    uploads, deletes = list_changed_files()
    created_dirs: set[str] = set()

    sftp = client.open_sftp()
    try:
        for rel_path in uploads:
            remote_file = posixpath.join(remote_path, rel_path.replace("\\", "/"))
            remote_dir = posixpath.dirname(remote_file)
            if remote_dir and remote_dir not in created_dirs:
                exit_code, _, err = run_remote(
                    client,
                    f"mkdir -p {shlex.quote(remote_dir)}",
                    timeout=120,
                )
                if exit_code != 0:
                    raise RuntimeError(f"Could not create remote dir {remote_dir}: {err.strip()}")
                created_dirs.add(remote_dir)
            sftp.put(str(REPO_ROOT / rel_path), remote_file)
            print(f"[deploy_remote] Uploaded {rel_path}")

        for rel_path in deletes:
            remote_file = posixpath.join(remote_path, rel_path.replace("\\", "/"))
            try:
                sftp.remove(remote_file)
                print(f"[deploy_remote] Removed {rel_path}")
            except FileNotFoundError:
                continue

    finally:
        sftp.close()

    return len(uploads), len(deletes)


def read_remote_text(client: paramiko.SSHClient, remote_path: str) -> str:
    sftp = client.open_sftp()
    try:
        with sftp.file(remote_path, "r") as handle:
            data = handle.read()
            if isinstance(data, bytes):
                return data.decode("utf-8", errors="replace")
            return data
    finally:
        sftp.close()


def write_remote_text(client: paramiko.SSHClient, remote_path: str, content: str) -> None:
    sftp = client.open_sftp()
    try:
        with sftp.file(remote_path, "w") as handle:
            handle.write(content)
    finally:
        sftp.close()


def apply_overrides(content: str, overrides: dict[str, str]) -> str:
    lines = content.splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            output.append(line)
            continue
        key, _ = line.split("=", 1)
        if key in overrides:
            output.append(f"{key}={overrides[key]}")
            seen.add(key)
        else:
            output.append(line)
    for key, value in overrides.items():
        if key not in seen:
            output.append(f"{key}={value}")
    return "\n".join(output).rstrip() + "\n"


def parse_overrides(values: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for entry in values:
        if "=" not in entry:
            raise ValueError(f"Invalid override {entry!r}; expected KEY=VALUE")
        key, value = entry.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid override {entry!r}; key is empty")
        overrides[key] = value
    return overrides


def main() -> int:
    args = parse_args()
    remote_path = args.remote_path or f"/var/home/{args.user}/Documents/wabi"
    remote_archive_path = "/tmp/wabi-sync.tar.gz"

    try:
        overrides = parse_overrides(args.overrides)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    client = connect_ssh(args.host, args.user, args.password)
    try:
        exit_code, out, err = run_remote(
            client,
            f"test -d {shlex.quote(remote_path)} && echo ok",
            timeout=60,
        )
        if exit_code != 0 or "ok" not in out:
            print(f"Remote path not found: {remote_path}", file=sys.stderr)
            if err.strip():
                print(err, file=sys.stderr)
            return 1

        if args.changed_only:
            uploads, deletes = sync_changed_files(client, remote_path)
            print(f"[deploy_remote] Synced {uploads} changed files and removed {deletes} deleted files.")
        else:
            archive_path = build_archive()
            print(f"[deploy_remote] Built archive: {archive_path}")
            upload_archive(client, archive_path, remote_archive_path)
            print(f"[deploy_remote] Uploaded archive to {args.host}:{remote_archive_path}")

            extract_command = (
                f"cd {shlex.quote(remote_path)}"
                f" && tar -xzf {shlex.quote(remote_archive_path)}"
                f" && rm -f {shlex.quote(remote_archive_path)}"
            )
            exit_code, out, err = run_remote(client, extract_command, timeout=1200)
            if exit_code != 0:
                print(out, end="")
                print(err, file=sys.stderr)
                return exit_code
            print("[deploy_remote] Extracted archive on remote.")

        if overrides:
            remote_config_path = posixpath.join(remote_path, "wabi.config")
            config_text = read_remote_text(client, remote_config_path)
            updated = apply_overrides(config_text, overrides)
            write_remote_text(client, remote_config_path, updated)
            print(f"[deploy_remote] Updated remote wabi.config keys: {', '.join(overrides)}")

        if args.launch:
            launch_command = (
                f"cd {shlex.quote(remote_path)}"
                " && chmod +x scripts/launch.sh"
                " && bash ./scripts/launch.sh --reconfigure"
            )
            exit_code, out, err = run_remote(client, launch_command, timeout=3600)
            print(out, end="")
            if err.strip():
                print(err, file=sys.stderr)
            if exit_code != 0:
                return exit_code

            status_command = (
                f"cd {shlex.quote(remote_path)}"
                " && (podman compose ps 2>/dev/null || docker compose ps 2>/dev/null || true)"
            )
            _, out, err = run_remote(client, status_command, timeout=300)
            if out.strip():
                print(out, end="")
            if err.strip():
                print(err, file=sys.stderr)

        print("[deploy_remote] Done.")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
