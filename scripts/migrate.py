"""
migrate.py -- export everything personal from this device into one
archive, and import it onto a fresh install (new drive, new board, or a
rebuild after a factory reset).

    python3 scripts/migrate.py export /mnt/backup/home-server.tar.gz
    python3 scripts/migrate.py verify /mnt/backup/home-server.tar.gz
    python3 scripts/migrate.py import /root/home-server.tar.gz [--host-ip 192.168.0.50]
    python3 scripts/migrate.py prepare-drive /dev/sdb   # new drive becomes a self-installing replacement

All three accept --dry-run (export/import: show the plan, change nothing).

What's in the archive:
  - every Docker named volume in this compose project (Mealie, Kanboard,
    Pi-hole, Syncthing data) -- under volumes/<name>/
  - the gitignored personal/config files in /root listed in
    PERSONAL_PATHS (.env, tokens, meal history, Streams library...) --
    under files/<path>
  - MANIFEST.json: sha256 of every file, plus source metadata

What's deliberately NOT in it:
  - the repo itself -- a fresh `git clone` is the source of truth
  - Docker images -- re-pulled fresh on import. This matters: the whole
    reason this script exists is the original USB root drive returning
    corrupted bytes on read (see storage_watchdog.py), and the image
    layers are exactly where that corruption has shown up. A disk-level
    clone (dd / Etcher / Win32DiskImager) would carry that corruption
    straight onto the new drive; a fresh install + data import doesn't.
  - host services outside this repo's control (Tailscale login, icecast2
    config) -- re-set those up by hand after a plain import. prepare-drive
    DOES carry them (staged next to the archive, restored by firstboot.sh).

Why every read is verified: on a drive that silently returns wrong
bytes, a plain `tar` can produce an archive that's corrupt with no error
anywhere. Export reads each 1 MiB chunk twice, evicting it from the page
cache between reads (posix_fadvise DONTNEED) so the second read really
comes from the drive, and only accepts it once two consecutive reads
agree. The finished archive is then re-read and checked against the
manifest, and import re-checks every hash both before touching anything
and after extracting -- so a bad copy at ANY hop (export, scp, a flaky
stick in between) is caught instead of silently restored.
"""
import argparse
import datetime
import glob
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reset_manager  # noqa: E402  (stdlib-only, safe to import without .env)

ROOT = reset_manager.ROOT
FORMAT_VERSION = 1
MANIFEST_NAME = "MANIFEST.json"
CHUNK = 1 << 20
MAX_READ_ATTEMPTS = 8

# Personal/config files that live in /root but aren't in git. Keep in sync
# with .gitignore's "Personal data" sections -- anything new added there
# that a user would miss after a rebuild belongs here too.
PERSONAL_PATHS = [
    ".env",
    "js/config.js",
    "nginx/certs",
    "dnsmasq-custom.conf",
    "scripts/mealie_token.txt",
    "scripts/meal_history.json",
    "scripts/kanboard_token.txt",
    "scripts/holiday_country.txt",
    "scripts/suggested_recipe_ids.json",
    "scripts/syncthing_config.json",
    "audiobooks/library.json",
    "audiobooks/profiles.json",
    "audiobooks/config.json",
    "audiobooks/local_progress.json",
    "audiobooks/local_shared.json",
    "audiobooks/state.json",
    "audiobooks/local_files",
]

# Same order/reasoning as updater.py's staggered restart: nginx depends on
# the others, mealie last since it's the heaviest to start.
START_ORDER = ("syncthing", "pihole", "kanboard", "mealie", "nginx")

SQLITE_SUFFIXES = (".db", ".sqlite", ".sqlite3")


class MigrateError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def _run(cmd, check=True, **kw):
    return subprocess.run(cmd, check=check, capture_output=True, text=True, cwd=ROOT, **kw)


def _human(n):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def _require_root():
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise MigrateError("must run as root (it reads/writes Docker volume directories)")


def _tree_size(path):
    if os.path.isfile(path) or os.path.islink(path):
        return os.lstat(path).st_size
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
    return total


def _confirm(prompt, assume_yes):
    if assume_yes:
        return True
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def compose_project_name():
    try:
        out = _run(["docker", "compose", "config", "--format", "json"])
        name = json.loads(out.stdout).get("name")
        if name:
            return name
    except Exception:
        pass
    return os.path.basename(ROOT.rstrip("/")) or "root"


def compose_volumes():
    """{compose volume name (e.g. 'mealie_data'): mountpoint on host}"""
    project = compose_project_name()
    out = _run(["docker", "volume", "ls", "-q",
                "--filter", f"label=com.docker.compose.project={project}"])
    volumes = {}
    for full_name in out.stdout.split():
        info = json.loads(_run(["docker", "volume", "inspect", full_name]).stdout)[0]
        short = (info.get("Labels") or {}).get("com.docker.compose.volume", full_name)
        volumes[short] = info["Mountpoint"]
    return volumes


# ------------------------------------------------------- verified reading

def _evict(fd, offset, length):
    try:
        os.posix_fadvise(fd, offset, length, os.POSIX_FADV_DONTNEED)
    except (AttributeError, OSError):
        pass


class VerifiedReader(io.RawIOBase):
    """File-like object that only ever returns bytes two consecutive reads
    (with a page-cache eviction between them) agreed on, and hashes what
    it returns. See module docstring for why."""

    def __init__(self, path, stats):
        super().__init__()
        self.path = path
        self.stats = stats
        self.fd = os.open(path, os.O_RDONLY)
        self.offset = 0
        self.sha = hashlib.sha256()
        self._buf = b""

    def _agreed_chunk(self):
        prev = os.pread(self.fd, CHUNK, self.offset)
        for _ in range(MAX_READ_ATTEMPTS):
            _evict(self.fd, self.offset, CHUNK)
            cur = os.pread(self.fd, CHUNK, self.offset)
            if cur == prev:
                return cur
            self.stats["mismatched_reads"] += 1
            prev = cur
        raise MigrateError(
            f"{self.path}: reads at offset {self.offset} never agreed after "
            f"{MAX_READ_ATTEMPTS} attempts -- this part of the drive may be unreadable")

    def readable(self):
        return True

    def read(self, n=-1):
        while n < 0 or len(self._buf) < n:
            chunk = self._agreed_chunk()
            if not chunk:
                break
            self.offset += len(chunk)
            self.sha.update(chunk)
            self._buf += chunk
        if n < 0:
            out, self._buf = self._buf, b""
        else:
            out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def close(self):
        if not self.closed:
            os.close(self.fd)
        super().close()


# ----------------------------------------------------------------- export

def _export_plan(exclude_volumes):
    volumes = {k: v for k, v in compose_volumes().items() if k not in exclude_volumes}
    files = [p for p in PERSONAL_PATHS if os.path.lexists(os.path.join(ROOT, p))]
    sizes = {f"volume {k}": _tree_size(v) for k, v in volumes.items()}
    sizes.update({f"file {p}": _tree_size(os.path.join(ROOT, p)) for p in files})
    return volumes, files, sizes


def _add_tree(tar, src, arc_prefix, manifest, stats):
    """Adds src (file or directory) under arc_prefix, verified."""
    entries = []
    if os.path.isdir(src) and not os.path.islink(src):
        for dirpath, dirs, files in os.walk(src):
            dirs.sort()
            for name in [dirpath] + [os.path.join(dirpath, f) for f in sorted(files)] \
                    + [os.path.join(dirpath, d) for d in dirs if os.path.islink(os.path.join(dirpath, d))]:
                entries.append(name)
    else:
        entries.append(src)

    for path in entries:
        rel = os.path.relpath(path, src).replace(os.sep, "/")
        arcname = arc_prefix if rel == "." else f"{arc_prefix}/{rel}"
        ti = tar.gettarinfo(path, arcname)
        if ti is None:  # sockets/fifos -- nothing to carry over
            continue
        if ti.islnk():  # store hardlinks as full copies; keeps import simple
            ti.type, ti.linkname, ti.size = tarfile.REGTYPE, "", os.stat(path).st_size
        if ti.isreg():
            reader = VerifiedReader(path, stats)
            try:
                tar.addfile(ti, reader)
                if reader.offset != ti.size:
                    raise MigrateError(f"{path} changed size while being read -- is something still writing to it?")
            finally:
                reader.close()
            manifest["files"][arcname] = reader.sha.hexdigest()
            stats["files"] += 1
            stats["bytes"] += ti.size
        else:
            tar.addfile(ti)


EXPORT_TIP = """
TIP -- moving to a new drive? Two ways to use this:

  Easiest (the new drive sets itself up):
    1. On your PC, flash Armbian onto the new drive.
    2. Plug it into this device and run:
         lsblk                      # find it, e.g. sdb
         python3 /root/scripts/migrate.py prepare-drive /dev/sdb
       (it writes a fresh export like this one + a first-boot installer
       onto the drive -- you don't need this archive for that path)
    3. poweroff, unplug the old drive, power on, wait ~20-40 min.

  With this archive:
    1. On the new device: SETUP.md steps 1-3 (OS, Docker, clone into /root).
    2. Copy {archive} over, then:
         python3 /root/scripts/migrate.py import <path-to-archive> --host-ip <new-ip>

  Full guide: dashboard -> Docs -> "Moving to a New Drive or Device",
  or docs/migration.md.
"""


def cmd_export(args):
    _require_root()
    dest = os.path.abspath(args.archive)
    dest_dir = os.path.dirname(dest)
    if not os.path.isdir(dest_dir):
        raise MigrateError(f"destination directory {dest_dir} doesn't exist (is the backup drive mounted?)")

    volumes, files, sizes = _export_plan(set(args.exclude_volume or []))
    total = sum(sizes.values())
    print("Will export:")
    for label, size in sizes.items():
        print(f"  {label:45s} {_human(size)}")
    print(f"  {'TOTAL (before compression)':45s} {_human(total)}")

    same_drive = os.stat(dest_dir).st_dev == os.stat(ROOT).st_dev
    if same_drive:
        msg = (f"{dest_dir} is on the same drive as {ROOT} -- the drive you're "
               f"presumably trying to get off of. Plug in a separate USB stick and "
               f"export there instead.")
        if not args.allow_same_drive:
            raise MigrateError(msg + " (Pass --allow-same-drive to do it anyway; import "
                                     "will still catch any corruption via the manifest.)")
        print("WARNING: " + msg)

    free = shutil.disk_usage(dest_dir).free
    if free < total:
        raise MigrateError(f"only {_human(free)} free at {dest_dir}, need up to {_human(total)}")

    if args.dry_run:
        print("\n[dry-run] would stop the stack, write the archive above to "
              f"{dest}, restart the stack, then verify the archive.")
        return

    print("\nStopping containers and the trigger service for a consistent snapshot "
          "(databases must not be written mid-copy)...")
    _run(["systemctl", "stop", "mealie-trigger.service"], check=False)
    _run(["docker", "compose", "stop"], check=False)
    _run(["sync"], check=False)

    manifest = {
        "format": FORMAT_VERSION,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "hostname": socket.gethostname(),
        "host_ip": reset_manager.read_current_host_ip(),
        "volumes": sorted(volumes),
        "personal_paths": files,
        "files": {},
    }
    stats = {"files": 0, "bytes": 0, "mismatched_reads": 0}
    tmp = dest + ".partial"
    started = time.time()
    try:
        # compresslevel=1: the S805X is slow, and most bulk data here
        # (recipe images, audio) is already compressed anyway.
        with tarfile.open(tmp, "w:gz", compresslevel=1) as tar:
            for name, mountpoint in sorted(volumes.items()):
                print(f"  volume {name} ...", flush=True)
                _add_tree(tar, mountpoint, f"volumes/{name}", manifest, stats)
            for rel in files:
                print(f"  file {rel} ...", flush=True)
                _add_tree(tar, os.path.join(ROOT, rel), f"files/{rel}", manifest, stats)
            data = json.dumps(manifest, indent=1, sort_keys=True).encode()
            ti = tarfile.TarInfo(MANIFEST_NAME)
            ti.size, ti.mtime, ti.mode = len(data), int(time.time()), 0o600
            tar.addfile(ti, io.BytesIO(data))
        with open(tmp, "rb+") as f:
            os.fsync(f.fileno())
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    finally:
        print("Restarting the stack...")
        _run(["docker", "compose", "start"], check=False)
        _run(["systemctl", "start", "mealie-trigger.service"], check=False)

    os.replace(tmp, dest)
    os.chmod(dest, 0o600)  # contains .env secrets and API tokens
    print(f"Wrote {dest}: {stats['files']} files, {_human(stats['bytes'])} in "
          f"{time.time() - started:.0f}s; {stats['mismatched_reads']} inconsistent "
          f"read(s) caught and re-read.")
    if stats["mismatched_reads"]:
        print("  (Non-zero confirms the source drive is returning bad data -- "
              "those chunks were re-read until consistent.)")

    print("Verifying the written archive...")
    verify_archive(dest, evict=True)
    print("Export complete and verified. The archive holds secrets -- keep it private.")
    if not getattr(args, "from_prepare_drive", False):
        print(EXPORT_TIP.format(archive=dest))


# ----------------------------------------------------------------- verify

def _iter_with_hashes(archive):
    """Yields (member, sha256-or-None) and finally the parsed manifest."""
    manifest = None
    with tarfile.open(archive, "r:gz") as tar:
        for m in tar:
            if m.name == MANIFEST_NAME:
                manifest = json.load(tar.extractfile(m))
                continue
            digest = None
            if m.isreg():
                h = hashlib.sha256()
                f = tar.extractfile(m)
                for chunk in iter(lambda: f.read(CHUNK), b""):
                    h.update(chunk)
                digest = h.hexdigest()
            yield m, digest
    yield None, manifest


def verify_archive(archive, evict=False):
    if evict:
        # Make sure we're checking what's actually on the destination
        # drive, not the copy still sitting in the page cache.
        fd = os.open(archive, os.O_RDONLY)
        _evict(fd, 0, 0)
        os.close(fd)
    seen = {}
    manifest = None
    try:
        for m, digest in _iter_with_hashes(archive):
            if m is None:
                manifest = digest
            elif digest is not None:
                seen[m.name] = digest
    except (tarfile.TarError, EOFError, OSError, ValueError) as e:
        raise MigrateError(f"{archive} is unreadable or truncated: {e}")
    if manifest is None:
        raise MigrateError(f"{archive} has no {MANIFEST_NAME} -- not a migrate.py archive, or truncated")
    if manifest.get("format") != FORMAT_VERSION:
        raise MigrateError(f"unsupported archive format {manifest.get('format')}")
    expected = manifest["files"]
    bad = [n for n, d in expected.items() if seen.get(n) != d]
    extra = [n for n in seen if n not in expected]
    if bad or extra:
        detail = "\n  ".join((bad + extra)[:20])
        raise MigrateError(f"{len(bad)} file(s) don't match the manifest, {len(extra)} unexpected:\n  {detail}")
    print(f"  OK: all {len(expected)} files match their checksums "
          f"(exported {manifest['created']} from {manifest['hostname']} / {manifest['host_ip']}).")
    return manifest


def cmd_verify(args):
    verify_archive(os.path.abspath(args.archive), evict=True)


# ----------------------------------------------------------------- import

def _safe_member(member, dest):
    """Our own, checksum-verified archive -- so trust ownership/modes
    exactly (pihole/mealie/syncthing files depend on their uid/gid), but
    still refuse anything that would land outside the destination."""
    name = member.name
    if name.startswith("/") or ".." in name.split("/"):
        raise MigrateError(f"refusing unsafe path in archive: {name}")
    return member


def _route(name, volume_mounts):
    """archive name -> (destination dir, path relative to it) or None."""
    parts = name.split("/", 2)
    if parts[0] == "volumes" and len(parts) >= 2:
        mount = volume_mounts.get(parts[1])
        if mount is None:
            return None
        return mount, parts[2] if len(parts) == 3 else "."
    if parts[0] == "files" and len(parts) >= 2:
        return ROOT, name[len("files/"):]
    return None


def _extract(archive, want, volume_mounts):
    with tarfile.open(archive, "r:gz") as tar:
        for m in tar:
            if m.name == MANIFEST_NAME or not want(m.name):
                continue
            routed = _route(m.name, volume_mounts)
            if routed is None:
                continue
            dest, rel = routed
            if rel == ".":
                continue  # a volume's root dir already exists
            m.name = rel
            tar.extract(m, dest, numeric_owner=True, filter=_safe_member)


def _clear_dir(path):
    for entry in os.listdir(path):
        full = os.path.join(path, entry)
        if os.path.isdir(full) and not os.path.islink(full):
            shutil.rmtree(full)
        else:
            os.remove(full)


def _replace_ip_in_file(path, old_ip, new_ip):
    if not os.path.isfile(path):
        return False
    with open(path) as f:
        text = f.read()
    if old_ip not in text:
        return False
    with open(path, "w") as f:
        f.write(text.replace(old_ip, new_ip))
    return True


def _sqlite_checks(volume_mounts):
    problems = []
    for name, mount in volume_mounts.items():
        for dirpath, _dirs, files in os.walk(mount):
            for f in files:
                if not f.endswith(SQLITE_SUFFIXES):
                    continue
                path = os.path.join(dirpath, f)
                # Check a throwaway copy: opening the real file as root
                # could leave root-owned -wal/-shm files the app's own
                # (non-root) user then can't write to.
                with tempfile.TemporaryDirectory() as tmp:
                    copy = os.path.join(tmp, f)
                    shutil.copy2(path, copy)
                    if os.path.exists(path + "-wal"):
                        shutil.copy2(path + "-wal", copy + "-wal")
                    try:
                        con = sqlite3.connect(copy)
                        result = con.execute("PRAGMA integrity_check").fetchone()[0]
                        con.close()
                    except sqlite3.DatabaseError as e:
                        result = str(e)
                status = "ok" if result == "ok" else f"PROBLEM: {result}"
                print(f"  {name}: {os.path.relpath(path, mount)} -- {status}")
                if result != "ok":
                    problems.append(path)
    return problems


def cmd_import(args):
    _require_root()
    archive = os.path.abspath(args.archive)
    if not os.path.exists(os.path.join(ROOT, "docker-compose.yml")):
        raise MigrateError(f"no docker-compose.yml in {ROOT} -- clone the repo there first (see SETUP.md step 3)")

    print("Verifying archive before touching anything...")
    manifest = verify_archive(archive, evict=True)

    old_ip = manifest["host_ip"]
    new_ip = args.host_ip or old_ip
    print("\nWill restore:")
    for v in manifest["volumes"]:
        print(f"  volume {v}  (existing contents REPLACED)")
    for p in manifest["personal_paths"]:
        print(f"  file   {p}")
    print(f"  host IP: {old_ip}" + (f" -> {new_ip}" if new_ip != old_ip else " (unchanged; pass --host-ip if this device's IP differs)"))

    if args.dry_run:
        print("\n[dry-run] nothing changed.")
        return
    if not _confirm("\nThis replaces this device's dashboard data. Continue?", args.yes):
        print("Aborted.")
        return

    print("\nStopping anything already running...")
    _run(["systemctl", "stop", "mealie-trigger.service"], check=False)
    _run(["docker", "compose", "down"], check=False)  # keeps volumes

    # Personal files (incl. .env and dnsmasq-custom.conf) go first: compose
    # needs .env to resolve ${HOST_IP} etc., and a bind-mounted file that
    # doesn't exist yet would get auto-created by Docker as an empty dir.
    print("Restoring config/personal files...")
    _extract(archive, lambda name: name.startswith("files/"), {})

    rewritten = set()  # deliberately edited -- excluded from the hash re-check
    if new_ip != old_ip:
        print(f"Switching host IP {old_ip} -> {new_ip}...")
        for rel in (".env", "dnsmasq-custom.conf"):
            if _replace_ip_in_file(os.path.join(ROOT, rel), old_ip, new_ip):
                rewritten.add(f"files/{rel}")
                print(f"  updated {rel}")

    print("Pulling images and creating volumes (fresh images, not copied ones)...")
    subprocess.run(["docker", "compose", "pull"], cwd=ROOT, check=True)
    subprocess.run(["docker", "compose", "create"], cwd=ROOT, check=True)
    volume_mounts = compose_volumes()
    missing = [v for v in manifest["volumes"] if v not in volume_mounts]
    if missing:
        print(f"WARNING: archive has volume(s) this docker-compose.yml no longer defines, skipping: {missing}")
    for v in manifest["volumes"]:
        if v in volume_mounts:
            _clear_dir(volume_mounts[v])

    print("Restoring volumes...")
    _extract(archive, lambda name: name.startswith("volumes/"), volume_mounts)

    print("Re-checking extracted files against the manifest...")
    bad = []
    for arcname, digest in manifest["files"].items():
        routed = _route(arcname, volume_mounts)
        if routed is None or arcname in rewritten:
            continue
        path = os.path.join(*routed)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(CHUNK), b""):
                h.update(chunk)
        if h.hexdigest() != digest:
            bad.append(path)
    if bad:
        raise MigrateError(f"{len(bad)} extracted file(s) don't match -- the NEW drive may be faulty too: {bad[:10]}")
    print(f"  OK: {len(manifest['files'])} files restored intact.")

    log = []
    reset_manager.write_js_config(new_ip, False, log)
    reset_manager.generate_self_signed_cert(new_ip, False, log)

    print("Checking restored databases...")
    problems = _sqlite_checks(volume_mounts)

    reset_manager.generate_docs(False, log)
    reset_manager.ensure_python_deps(False, log)
    reset_manager.install_systemd_service(False, log)  # enables + starts the trigger service

    print("Starting containers one at a time (each waits until healthy, max 5 min)...")
    for service in START_ORDER:
        print(f"  {service}")
        subprocess.run(["docker", "compose", "up", "-d", "--wait", "--wait-timeout", "300", service],
                       cwd=ROOT, check=False)
    subprocess.run(["docker", "compose", "up", "-d"], cwd=ROOT, check=False)  # anything not in START_ORDER

    print(f"\nImport complete. Dashboard: http://{new_ip}/")
    if problems:
        print("WARNING: these databases failed SQLite's integrity check. They were "
              "already damaged on the old drive when exported -- check the app, and "
              "if needed restore from Mealie's own backups (Settings -> Backups):")
        for p in problems:
            print(f"  {p}")
    print("Not part of the archive: Tailscale login, icecast2 config (prepare-drive restores those "
          "separately; after a plain import, set them up by hand if you use them).")


# ---------------------------------------------------------- prepare-drive
#
# One command that turns a freshly flashed Armbian drive into a
# self-installing replacement for this one. See docs/migration.md.

MIGRATION_DIR = "root/home-server-migration"   # relative to the new drive's /
RESTORE_UNIT = "home-server-restore.service"

FIRSTBOOT_SH = r'''#!/bin/bash
# Written by migrate.py prepare-drive. Runs once, on the first boot of the
# new drive, via home-server-restore.service. Progress: restore.log here.
set -euo pipefail
M=/root/home-server-migration
cd "$M"
source "$M/config.env"
log() { echo "[$(date '+%F %T')] $*"; }

if [ -f "$M/done" ]; then log "already restored -- nothing to do"; exit 0; fi
log "== Home Server first-boot restore starting =="

# Same SSH identity as the old drive, so known_hosts doesn't complain.
# Done here, not at prepare time, because Armbian's own first-run service
# deletes and regenerates host keys on first boot. That service is
# Type=simple, so this unit's After= only waits for it to START -- seen
# 2026-11-08: keys restored at :09, regenerated by armbian-firstrun at
# :14. So wait for it to actually finish, and re-apply at the very end
# too (restore_ssh_keys is called again after the import).
restore_ssh_keys() {
    compgen -G "$M/ssh_host_keys/ssh_host_*" >/dev/null || return 0
    cp -p "$M"/ssh_host_keys/ssh_host_* /etc/ssh/
    systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
    log "restored SSH host keys"
}
for _ in $(seq 1 60); do
    [ "$(systemctl show -p SubState --value armbian-firstrun 2>/dev/null)" = running ] || break
    sleep 5
done
restore_ssh_keys

# Recreate the old device's swap file (size recorded by prepare-drive).
# Measured 2026-11-08: ~1 GB of real memory demand on a 914 MB board with
# zram nearly full, so a fresh install without this overflow could start
# OOM-killing. Done first -- the Docker install and image pulls below are
# memory-hungry. Low priority (-2) so zram is still used first. On the old
# drive this file was a corruption risk; on a healthy new drive it's fine.
if [ -n "${SWAPFILE_MB:-}" ] && [ ! -e /swapfile ]; then
    log "creating ${SWAPFILE_MB}MB swap file"
    fallocate -l "${SWAPFILE_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAPFILE_MB" status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon -p -2 /swapfile || true
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw,pri=-2 0 0' >> /etc/fstab
fi

log "waiting for network..."
until curl -fsS -m 10 -o /dev/null https://github.com; do sleep 10; done

export DEBIAN_FRONTEND=noninteractive
missing=""
for pkg in git python3 openssl ca-certificates; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
if [ -n "$missing" ]; then
    log "installing:$missing"
    apt-get update -q && apt-get install -y -q $missing
fi
if ! docker compose version >/dev/null 2>&1; then
    log "installing Docker"
    curl -fsSL https://get.docker.com | sh
fi

if [ -n "${TIMEZONE:-}" ]; then timedatectl set-timezone "$TIMEZONE" || true; fi

# Host services that live outside the repo (staged by prepare-drive under
# host/ only if the old device had them). Failures here are logged, not
# fatal: they shouldn't block restoring the dashboard itself.
# Steps are chained with && on purpose: these functions are called as an
# `if` condition, where bash ignores `set -e`, so a failed step would
# otherwise fall through and get reported as success.
restore_tailscale() {
    { command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh; } &&
    { systemctl stop tailscaled || true; } &&
    mkdir -p /var/lib/tailscale && chmod 700 /var/lib/tailscale &&
    cp -a "$M/host/tailscale/." /var/lib/tailscale/ &&
    systemctl enable --now tailscaled
}
restore_icecast() {
    apt-get install -y -q icecast2 &&
    cp -a "$M/host/icecast2/." /etc/icecast2/ &&
    chown root:icecast /etc/icecast2/icecast.xml && chmod 640 /etc/icecast2/icecast.xml &&
    { systemctl enable icecast2 || true; } &&
    systemctl restart icecast2
}
if [ -d "$M/host/tailscale" ] && [ ! -f "$M/host/tailscale.done" ]; then
    log "restoring Tailscale (same node identity -- no re-login needed)"
    if restore_tailscale; then touch "$M/host/tailscale.done"; else log "WARNING: Tailscale restore failed -- run 'tailscale up' by hand"; fi
fi
if [ -d "$M/host/icecast2" ] && [ ! -f "$M/host/icecast2.done" ]; then
    log "restoring icecast2"
    if restore_icecast; then touch "$M/host/icecast2.done"; else log "WARNING: icecast2 restore failed"; fi
fi

log "fetching $REPO_URL ($REPO_BRANCH @ $REPO_COMMIT)"
cd /root
# /root isn't empty (.bashrc, this folder...), so `git clone .` would
# refuse -- init + fetch + checkout works in a non-empty directory.
[ -d /root/.git ] || git init -q
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REPO_URL"
git fetch -q origin "$REPO_BRANCH"
git checkout -q -f -B "$REPO_BRANCH" "$REPO_COMMIT"
git branch -q --set-upstream-to="origin/$REPO_BRANCH" "$REPO_BRANCH"

IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
log "this device's IP: ${IP:-unknown}"
python3 /root/scripts/migrate.py import "$M/backup.tar.gz" --yes ${IP:+--host-ip "$IP"}

restore_ssh_keys   # again, in case anything regenerated them meanwhile
touch "$M/done"
systemctl disable home-server-restore.service || true
log "== Restore complete: http://${IP:-<device-ip>}/ =="
log "Once you've confirmed everything works, delete $M/backup.tar.gz (it holds secrets)."
'''

RESTORE_UNIT_CONTENT = """[Unit]
Description=Home Server first-boot restore (migrate.py prepare-drive)
Wants=network-online.target
After=network-online.target armbian-firstrun.service armbian-resize-filesystem.service
ConditionPathExists=!/root/home-server-migration/done
StartLimitIntervalSec=4h
StartLimitBurst=6

[Service]
Type=oneshot
ExecStart=/bin/bash /root/home-server-migration/firstboot.sh
StandardOutput=append:/root/home-server-migration/restore.log
StandardError=append:/root/home-server-migration/restore.log
TimeoutStartSec=infinity
Restart=on-failure
RestartSec=120

[Install]
WantedBy=multi-user.target
"""


def _lsblk(dev):
    out = _run(["lsblk", "-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL,PKNAME", dev])
    return json.loads(out.stdout)["blockdevices"][0]


def _root_disk():
    src = _run(["findmnt", "-no", "SOURCE", "/"]).stdout.strip()
    pk = _run(["lsblk", "-no", "PKNAME", src]).stdout.strip()
    return f"/dev/{pk}" if pk else src


def _verified_bytes(path):
    r = VerifiedReader(path, {"mismatched_reads": 0})
    try:
        return r.read()
    finally:
        r.close()


def _write(path, data, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def _git(*a):
    return _run(["git", *a]).stdout.strip()


def _repo_info():
    """The new drive checks out exactly the code this device runs -- but
    only if that code is actually on GitHub for it to fetch."""
    url = _git("remote", "get-url", "origin")
    if "//" in url and "@" in url.split("//", 1)[1].split("/", 1)[0]:
        scheme, rest = url.split("//", 1)          # drop embedded credentials
        url = scheme + "//" + rest.split("@", 1)[1]
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    commit = _git("rev-parse", "HEAD")
    _run(["git", "fetch", "-q", "origin", branch], check=False)
    contains = _run(["git", "branch", "-r", "--contains", commit], check=False).stdout
    if f"origin/{branch}" not in contains:
        raise MigrateError(f"this device's code ({branch} @ {commit[:8]}) isn't on GitHub yet -- "
                           f"push it first, so the new drive can fetch the same version")
    return url, branch, commit


def stage_new_root(new_root, repo):
    """Everything except the archive itself: installer, login, network.
    Split out from cmd_prepare_drive so it can be tested against a plain
    directory standing in for the mounted drive."""
    if not os.path.exists(os.path.join(new_root, "etc", "os-release")):
        raise MigrateError(f"{new_root} doesn't look like a Linux root filesystem (no etc/os-release)")
    mdir = os.path.join(new_root, MIGRATION_DIR)
    url, branch, commit = repo
    tz = reset_manager.read_current_timezone()
    swap_mb = _swapfile_mb()
    _write(os.path.join(mdir, "config.env"),
           f"REPO_URL={shlex.quote(url)}\nREPO_BRANCH={shlex.quote(branch)}\n"
           f"REPO_COMMIT={shlex.quote(commit)}\nTIMEZONE={shlex.quote(tz)}\n"
           + (f"SWAPFILE_MB={swap_mb}\n" if swap_mb else ""), 0o600)
    if swap_mb:
        print(f"  new drive will recreate this device's {swap_mb}MB swap file on first boot")
    _write(os.path.join(mdir, "firstboot.sh"), FIRSTBOOT_SH, 0o700)

    unit = os.path.join(new_root, "etc/systemd/system", RESTORE_UNIT)
    _write(unit, RESTORE_UNIT_CONTENT, 0o644)
    wants = os.path.join(new_root, "etc/systemd/system/multi-user.target.wants")
    os.makedirs(wants, exist_ok=True)
    link = os.path.join(wants, RESTORE_UNIT)
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(f"/etc/systemd/system/{RESTORE_UNIT}", link)
    print("  installed first-boot restore service")

    # Same SSH host keys (applied by firstboot.sh -- see the comment there).
    for k in sorted(glob.glob(os.path.join(HOST_ETC, "ssh", "ssh_host_*"))):
        _write(os.path.join(mdir, "ssh_host_keys", os.path.basename(k)), _verified_bytes(k),
               os.stat(k).st_mode & 0o777)

    # Same root login: authorized_keys + password hash. Copying root's
    # whole shadow line (incl. last-changed date) also clears the
    # "must change password" flag fresh Armbian images ship with.
    ak = os.path.join(HOST_ROOT_HOME, ".ssh", "authorized_keys")
    if os.path.exists(ak):
        _write(os.path.join(new_root, "root/.ssh/authorized_keys"), _verified_bytes(ak), 0o600)
        os.chmod(os.path.join(new_root, "root/.ssh"), 0o700)
    old_shadow = os.path.join(HOST_ETC, "shadow")
    old_root_line = None
    if os.path.exists(old_shadow):
        old_root_line = next((l for l in _verified_bytes(old_shadow).decode().splitlines()
                              if l.startswith("root:")), None)
    new_shadow = os.path.join(new_root, "etc/shadow")
    if old_root_line and os.path.exists(new_shadow):
        with open(new_shadow) as f:
            lines = f.read().splitlines()
        lines = [old_root_line if l.startswith("root:") else l for l in lines]
        _write(new_shadow, "\n".join(lines) + "\n", 0o640)
    # Skip Armbian's interactive first-login wizard (password prompt, user
    # creation) -- login is already set up, and nobody's at a console.
    wizard = os.path.join(new_root, "root/.not_logged_in_yet")
    if os.path.exists(wizard):
        os.remove(wizard)
    print("  copied root login (password + SSH keys) and SSH host keys")

    # Same hostname and network config (Wi-Fi credentials, static IPs).
    _write(os.path.join(new_root, "etc/hostname"), socket.gethostname() + "\n", 0o644)
    copied = 0
    for pattern in ("netplan/*.yaml", "NetworkManager/system-connections/*"):
        for src in glob.glob(os.path.join(HOST_ETC, pattern)):
            if os.path.isfile(src):
                rel = os.path.relpath(src, HOST_ETC)
                _write(os.path.join(new_root, "etc", rel), _verified_bytes(src), 0o600)
                copied += 1
    print(f"  copied hostname + {copied} network config file(s)")

    # Host services outside the repo, restored by firstboot.sh. Tailscale's
    # state dir holds the node key, so the new drive comes back as the same
    # Tailscale device (same 100.x IP, no login). Logs are skipped.
    staged = []
    for name, src_dir, skip in (
        ("tailscale", os.path.join(HOST_VAR_LIB, "tailscale"), re.compile(r"\.log.*\.txt$|^tailscaled\.log")),
        ("icecast2", os.path.join(HOST_ETC, "icecast2"), None),
    ):
        if not os.path.isdir(src_dir):
            continue
        for dirpath, _dirs, files in os.walk(src_dir):
            for fn in files:
                if skip and skip.search(fn):
                    continue
                src = os.path.join(dirpath, fn)
                if os.path.islink(src) or not os.path.isfile(src):
                    continue
                rel = os.path.relpath(src, src_dir)
                _write(os.path.join(mdir, "host", name, rel), _verified_bytes(src),
                       os.stat(src).st_mode & 0o777)
        os.chmod(os.path.join(mdir, "host"), 0o700)
        staged.append(name)
    if staged:
        print(f"  staged host services for first boot: {', '.join(staged)}")


# Overridable for tests only.
HOST_VAR_LIB = "/var/lib"
HOST_ETC = "/etc"
HOST_ROOT_HOME = "/root"
HOST_PROC_SWAPS = "/proc/swaps"


def _swapfile_mb():
    """Total size of file-backed swap on this device (zram excluded), in MB."""
    total_kb = 0
    try:
        with open(HOST_PROC_SWAPS) as f:
            for line in f.read().splitlines()[1:]:
                cols = line.split()
                if len(cols) >= 3 and cols[1] == "file":
                    total_kb += int(cols[2])
    except (OSError, ValueError):
        return 0
    return total_kb // 1024


def cmd_prepare_drive(args):
    _require_root()
    repo = _repo_info()
    mounted_here = None
    if args.mounted_root:
        new_root = os.path.abspath(args.mounted_root)
        if os.stat(new_root).st_dev == os.stat("/").st_dev:
            raise MigrateError(f"{new_root} is on this device's own root drive")
    else:
        dev = args.device
        info = _lsblk(dev)
        if info["type"] != "disk":
            raise MigrateError(f"{dev} is a {info['type']}, not a whole disk (e.g. /dev/sdb, not /dev/sdb1)")
        if os.path.realpath(dev) == os.path.realpath(_root_disk()):
            raise MigrateError(f"{dev} is the drive this device is running from")
        parts = info.get("children") or []
        busy = [p["path"] for p in parts if p.get("mountpoint")]
        if busy:
            raise MigrateError(f"partitions are mounted: {busy} -- unmount them first (umount {' '.join(busy)})")
        print(f"Target: {dev}  {info.get('model') or ''}  {_human(int(info['size']))}")
        print("Its existing OS stays; this adds your data + a first-boot installer to it.")
        if not args.yes:
            if input(f"Type the device name ({dev}) to continue: ").strip() != dev:
                print("Aborted.")
                return

        # Find the flashed root partition.
        new_root = tempfile.mkdtemp(prefix="new-root-")
        part = None
        for p in parts:
            if p.get("fstype") != "ext4":
                continue
            _run(["mount", p["path"], new_root])
            if os.path.exists(os.path.join(new_root, "etc/os-release")):
                part = p
                break
            _run(["umount", new_root])
        if part is None:
            os.rmdir(new_root)
            raise MigrateError(f"no Linux root partition found on {dev} -- flash Armbian onto it first "
                               f"(see docs/migration.md)")
        mounted_here = new_root

        # A freshly flashed image's root partition is only as big as the
        # image (Armbian normally grows it on first boot). Grow it now,
        # since the archive has to fit before that first boot happens.
        if part is parts[-1]:
            _run(["umount", new_root])
            if not shutil.which("growpart"):
                print("  installing growpart (cloud-guest-utils)...")
                subprocess.run(["apt-get", "install", "-y", "-q", "cloud-guest-utils"], check=True)
            partnum = re.search(r"(\d+)$", part["name"]).group(1)
            grow = _run(["growpart", dev, partnum], check=False)
            if grow.returncode == 0:
                print(f"  grew {part['path']} to fill the drive")
                _run(["e2fsck", "-f", "-y", part["path"]], check=False)
                _run(["resize2fs", part["path"]])
            elif "NOCHANGE" not in grow.stdout + grow.stderr:
                raise MigrateError(f"growpart failed: {grow.stdout}{grow.stderr}")
            _run(["mount", part["path"], new_root])

    try:
        print("Staging installer, login and network config...")
        stage_new_root(new_root, repo)
        export_args = argparse.Namespace(
            archive=os.path.join(new_root, MIGRATION_DIR, "backup.tar.gz"),
            exclude_volume=args.exclude_volume, allow_same_drive=False, dry_run=False,
            from_prepare_drive=True)
        cmd_export(export_args)
    finally:
        if mounted_here:
            _run(["sync"], check=False)
            _run(["umount", mounted_here], check=False)
            os.rmdir(mounted_here)

    print("\nThe new drive is ready. Next:\n"
          "  1. poweroff\n"
          "  2. unplug the OLD drive, leave only the new one in, power on\n"
          "     (or keep both plugged in: python3 scripts/swapboot.py set <new drive> --reboot)\n"
          "  3. wait ~20-40 min (Docker install + image downloads + restore).\n"
          "     Progress: ssh root@<ip>, then  tail -f /root/home-server-migration/restore.log\n"
          "Keep the old drive untouched until the new one is confirmed working.")


# ------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description="Export/import this dashboard's data for moving to a new drive or device.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("export", help="write everything personal to one verified archive")
    p.add_argument("archive", help="output path, e.g. /mnt/backup/home-server.tar.gz (ideally on a different drive)")
    p.add_argument("--exclude-volume", action="append", metavar="NAME",
                   help="skip a volume, e.g. syncthing_data if its folders can re-sync from peers (repeatable)")
    p.add_argument("--allow-same-drive", action="store_true",
                   help="allow writing the archive onto the root drive itself")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("verify", help="check an archive's checksums without changing anything")
    p.add_argument("archive")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("import", help="restore an archive onto this (freshly set up) device")
    p.add_argument("archive")
    p.add_argument("--host-ip", help="this device's IP, if different from the old one")
    p.add_argument("--yes", action="store_true", help="don't ask for confirmation")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("prepare-drive",
                       help="turn a freshly flashed drive into a self-installing replacement for this one")
    p.add_argument("device", nargs="?", help="the NEW drive's whole-disk device, e.g. /dev/sdb")
    p.add_argument("--mounted-root", help="use an already-mounted new root filesystem instead of a device")
    p.add_argument("--exclude-volume", action="append", metavar="NAME")
    p.add_argument("--yes", action="store_true", help="skip the type-the-device-name confirmation")
    p.set_defaults(func=cmd_prepare_drive)

    args = parser.parse_args()
    if args.command == "prepare-drive" and not (args.device or args.mounted_root):
        parser.error("prepare-drive needs a device (e.g. /dev/sdb) or --mounted-root")
    try:
        args.func(args)
    except MigrateError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
