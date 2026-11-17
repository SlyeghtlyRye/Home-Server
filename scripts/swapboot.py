#!/usr/bin/env python3
"""
swapboot.py -- choose which plugged-in drive the board boots from, with
both drives left plugged in. See docs/migration.md "Switching drives
without unplugging (swapboot)".

How it works: the bootloader (U-Boot in the board's SPI flash) scans USB
drives and runs the first /boot/boot.scr it finds; Armbian's boot script
then boots the drive it was read from. `install` adds a few lines to
that script so that, before booting, it checks every USB drive for a
/boot/swapboot-target file and, if it finds one, boots THAT drive
instead. `set` just moves that one marker file between drives.

No marker anywhere = stock behaviour, so the patch is inert until used.

    python3 scripts/swapboot.py status
    python3 scripts/swapboot.py set other --reboot      # boot the other drive
    python3 scripts/swapboot.py set /dev/sdb            # pick explicitly
    python3 scripts/swapboot.py install [--drive /dev/sdX]
    python3 scripts/swapboot.py uninstall [--drive /dev/sdX]
"""
import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

MARKER = "swapboot-target"          # lives in /boot on the target drive
BEGIN = "# >>> home-server swapboot >>>"
END = "# <<< home-server swapboot <<<"
ANCHOR = "# get PARTUUID"           # patch goes right before this line

# U-Boot hush script. Kept deliberately minimal, using only constructs
# the stock script itself already uses (for-loops, test -e, setenv).
PATCH = f"""{BEGIN}
# Boot whichever USB drive holds /boot/{MARKER} (managed by
# /root/scripts/swapboot.py). No marker on any drive = stock behaviour.
setenv swapboot_from "${{devtype}}${{devnum}}"
for n in 0 1 2 3 4 5; do
\tif test -e usb ${{n}}:1 /boot/{MARKER}; then setenv devtype usb; setenv devnum ${{n}}; fi
done
setenv extraargs "${{extraargs}} swapboot=${{swapboot_from}}:${{devtype}}${{devnum}}"
{END}
"""

BACKUP_SUFFIX = ".pre-swapboot"


class SwapbootError(Exception):
    pass


def _run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SwapbootError(f"{' '.join(cmd)} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r


def _root_partition():
    return os.path.realpath(_run(["findmnt", "-no", "SOURCE", "/"]).stdout.strip())


def drives():
    """Whole disks whose first partition is ext4. Returns dicts with
    disk, part, model, size, partuuid, mountpoint, is_root."""
    tree = json.loads(_run(["lsblk", "-J", "-b", "-o",
                            "NAME,PATH,TYPE,SIZE,MODEL,FSTYPE,PARTUUID,MOUNTPOINT"]).stdout)
    root = _root_partition()
    out = []
    for d in tree["blockdevices"]:
        if d.get("type") != "disk":
            continue
        parts = [p for p in (d.get("children") or []) if p.get("type") == "part"]
        if not parts or parts[0].get("fstype") != "ext4":
            continue
        p = parts[0]
        out.append({
            "disk": d["path"], "part": p["path"], "model": (d.get("model") or "").strip(),
            "size": int(d.get("size") or 0), "partuuid": p.get("partuuid") or "",
            "mountpoint": p.get("mountpoint"), "is_root": os.path.realpath(p["path"]) == root,
        })
    return out


@contextlib.contextmanager
def mounted(drive):
    """Yields the drive's filesystem root, mounting it temporarily if needed."""
    if drive["is_root"]:
        yield "/"
        return
    if drive["mountpoint"]:
        yield drive["mountpoint"]
        return
    tmp = tempfile.mkdtemp(prefix="swapboot-")
    _run(["mount", drive["part"], tmp])
    try:
        yield tmp
    finally:
        _run(["sync"], check=False)
        _run(["umount", tmp], check=False)
        os.rmdir(tmp)


def _boot_dir(fsroot):
    b = os.path.join(fsroot, "boot")
    return b if os.path.isfile(os.path.join(b, "boot.cmd")) else None


def _patched(boot):
    with open(os.path.join(boot, "boot.cmd")) as f:
        return BEGIN in f.read()


def patch_text(text):
    """Pure function (unit-tested): stock boot.cmd -> patched boot.cmd."""
    if BEGIN in text:
        return text
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.startswith(ANCHOR):
            return "".join(lines[:i]) + PATCH + "\n" + "".join(lines[i:])
    raise SwapbootError(f"boot.cmd has no '{ANCHOR}' line -- unrecognised boot script, not patching")


def unpatch_text(text):
    if BEGIN not in text:
        return text
    head, rest = text.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    return head + tail.lstrip("\n")


def _compile(boot):
    cmd, scr = os.path.join(boot, "boot.cmd"), os.path.join(boot, "boot.scr")
    tmp = scr + ".new"
    _run(["mkimage", "-C", "none", "-A", "arm", "-T", "script", "-d", cmd, tmp])
    os.replace(tmp, scr)


def install_on(drive):
    with mounted(drive) as fs:
        boot = _boot_dir(fs)
        if not boot:
            print(f"  {drive['disk']}: no /boot/boot.cmd -- skipped")
            return
        if _patched(boot):
            print(f"  {drive['disk']}: already patched")
            return
        cmd = os.path.join(boot, "boot.cmd")
        with open(cmd) as f:
            new = patch_text(f.read())
        for name in ("boot.cmd", "boot.scr"):
            src = os.path.join(boot, name)
            if os.path.exists(src) and not os.path.exists(src + BACKUP_SUFFIX):
                shutil.copy2(src, src + BACKUP_SUFFIX)
        with open(cmd, "w") as f:
            f.write(new)
        _compile(boot)
        print(f"  {drive['disk']}: patched boot script (originals kept as *{BACKUP_SUFFIX})")


def uninstall_on(drive):
    with mounted(drive) as fs:
        boot = _boot_dir(fs)
        if not boot or not _patched(boot):
            print(f"  {drive['disk']}: not patched")
            return
        cmd = os.path.join(boot, "boot.cmd")
        with open(cmd) as f:
            text = f.read()
        with open(cmd, "w") as f:
            f.write(unpatch_text(text))
        _compile(boot)
        m = os.path.join(boot, MARKER)
        if os.path.exists(m):
            os.remove(m)
        print(f"  {drive['disk']}: patch removed")


def _pick(drvs, which):
    if which in ("current", "this"):
        return next(d for d in drvs if d["is_root"])
    if which == "other":
        others = [d for d in drvs if not d["is_root"]]
        if len(others) != 1:
            raise SwapbootError(f"'other' needs exactly one non-running drive; found {len(others)} "
                                f"-- name it explicitly (e.g. /dev/sdb)")
        return others[0]
    real = os.path.realpath(which)
    for d in drvs:
        if real in (os.path.realpath(d["disk"]), os.path.realpath(d["part"])):
            return d
    raise SwapbootError(f"{which} is not one of the bootable drives: {[d['disk'] for d in drvs]}")


def cmd_status(_args):
    cmdline = open("/proc/cmdline").read()
    sb = next((t.split("=", 1)[1] for t in cmdline.split() if t.startswith("swapboot=")), None)
    print("Booted from:", next((f"{d['disk']} ({d['model']})" for d in drives() if d["is_root"]), "?"))
    if sb:
        frm, to = sb.split(":", 1)
        print(f"  bootloader read the script from {frm}, booted {to}"
              + ("  (swapboot redirected this boot)" if frm != to else ""))
    print()
    print(f"{'drive':10} {'model':16} {'size':>8}  {'running':8} {'patched':8} target")
    for d in drives():
        with mounted(d) as fs:
            boot = _boot_dir(fs)
            patched = "yes" if boot and _patched(boot) else ("-" if not boot else "no")
            target = "<-- boots next" if boot and os.path.exists(os.path.join(boot, MARKER)) else ""
        print(f"{d['disk']:10} {d['model'][:16]:16} {d['size'] / 2**30:7.1f}G  "
              f"{'yes' if d['is_root'] else '':8} {patched:8} {target}")


def cmd_install(args):
    drvs = drives()
    targets = [_pick(drvs, args.drive)] if args.drive else drvs
    for d in targets:
        install_on(d)


def cmd_uninstall(args):
    drvs = drives()
    targets = [_pick(drvs, args.drive)] if args.drive else drvs
    for d in targets:
        uninstall_on(d)


def cmd_set(args):
    drvs = drives()
    target = _pick(drvs, args.target)
    if not args.no_install:
        for d in drvs:
            install_on(d)
    patched_any = False
    for d in drvs:
        with mounted(d) as fs:
            boot = _boot_dir(fs)
            if not boot:
                continue
            patched_any = patched_any or _patched(boot)
            m = os.path.join(boot, MARKER)
            if d is target:
                with open(m, "w") as f:
                    f.write(f"set {time.strftime('%F %T')} by swapboot.py\n")
            elif os.path.exists(m):
                os.remove(m)
    if not patched_any:
        print("WARNING: no drive has the swapboot patch -- run `swapboot.py install` first.")
    print(f"Next boot: {target['disk']} ({target['model']})")
    if args.reboot:
        print("Rebooting...")
        _run(["sync"], check=False)
        subprocess.run(["systemctl", "reboot"])
    else:
        print("Reboot to switch:  systemctl reboot")


def main():
    ap = argparse.ArgumentParser(description="Pick which plugged-in drive boots next.")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="show drives, which is running, which boots next")
    p = sub.add_parser("set", help="make TARGET boot next: a device (/dev/sdb), 'other' or 'current'")
    p.add_argument("target")
    p.add_argument("--reboot", action="store_true", help="reboot right away")
    p.add_argument("--no-install", action="store_true",
                   help="only move the marker; don't patch drives that lack the boot-script patch")
    p = sub.add_parser("install", help="add the boot-script patch (all drives, or --drive)")
    p.add_argument("--drive")
    p = sub.add_parser("uninstall", help="remove the patch and marker (all drives, or --drive)")
    p.add_argument("--drive")
    args = ap.parse_args()
    if os.geteuid() != 0:
        sys.exit("run as root")
    try:
        {"status": cmd_status, "set": cmd_set, "install": cmd_install,
         "uninstall": cmd_uninstall}[args.command](args)
    except SwapbootError as e:
        sys.exit(f"ERROR: {e}")


if __name__ == "__main__":
    main()
