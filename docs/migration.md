tags: backup, migration, setup, backend

# Moving to a New Drive or Device (Export / Import)

`scripts/migrate.py` packs everything personal on this device into one
archive, and restores it onto a fresh install. Use it to replace a
failing boot drive, move to a new board, or rebuild after a factory reset.

```bash
python3 scripts/migrate.py export /mnt/backup/home-server.tar.gz   # on the old device
python3 scripts/migrate.py verify /mnt/backup/home-server.tar.gz   # anywhere, read-only
python3 scripts/migrate.py import /root/home-server.tar.gz --host-ip <new-ip>   # on the new one
python3 scripts/migrate.py prepare-drive /dev/sdb   # or: make a new drive restore itself on first boot
```

`export` and `import` both take `--dry-run`, which shows the plan
(including sizes) and changes nothing.

## What's in the archive

| Included | Not included |
|---|---|
| Every Docker volume in the compose project: Mealie (recipes, images, DB), Kanboard, Pi-hole, Syncthing | The repo itself (a fresh `git clone` provides it) |
| `.env`, `js/config.js`, TLS certs, `dnsmasq-custom.conf` | Docker images (pulled fresh on import, on purpose; see below) |
| Mealie/Kanboard tokens, meal history, calendar settings, Syncthing config | Tailscale login, icecast2 config: `prepare-drive` carries these over automatically; after a manual import, set them up by hand |
| Streams library, profiles, progress, and `audiobooks/local_files` | |

The archive contains secrets (`.env`, API tokens), so it's written as
mode `600`. Keep it private.

`--exclude-volume syncthing_data` leaves out Syncthing's data if its
folders can re-sync from your other devices instead. It's repeatable.

## Why not just clone the drive?

The reason this exists is that the original USB boot drive returns
corrupted bytes on read (see "Mealie 'bad marshal data' crash loops" in
`system-panel.md`). A disk-level clone (`dd`, Etcher, Win32DiskImager)
would copy that corruption onto the new drive, including the damaged
Docker image layers that caused the crash loops. A fresh OS install plus
`migrate.py import` brings over only your data, and pulls clean images.

## How it protects against a flaky drive

- **Consistent snapshot:** export stops the containers and the
  `mealie-trigger` service, so SQLite databases aren't caught mid-write,
  then starts everything again. Downtime is however long the copy takes.
- **Verified reads:** every 1 MiB chunk is read twice, with that chunk
  evicted from the page cache in between (`posix_fadvise DONTNEED`), so
  the second read really comes from the drive. A chunk is accepted only
  once two consecutive reads agree. The summary line reports how many
  inconsistent reads were caught. A non-zero count confirms the drive is
  bad, and that the export worked around it.
- **Checksummed:** `MANIFEST.json` in the archive records the sha256 of
  every file. Export re-reads the finished archive from disk to check
  it. Import checks it again before touching anything, then re-hashes
  every restored file after extraction. A bad copy at any step (export,
  `scp`, a dodgy stick in between) gets caught instead of silently
  restored.
- **Database check:** after restoring, import runs SQLite's
  `PRAGMA integrity_check` on every `.db`/`.sqlite` file, on a temporary
  copy, so the real files never get root-owned `-wal`/`-shm` files.
  A failure there means the DB was already damaged on the old drive.
  Mealie's own backups (Settings → Backups, stored inside `mealie_data`)
  are the fallback.

## Step by step: replacing the boot drive (easy path)

`prepare-drive` writes your data **straight onto the new drive**, plus a
first-boot installer. You then swap drives and it sets itself up.

1. **On your PC: flash Armbian onto the new drive** (balenaEtcher,
   Raspberry Pi Imager, etc., same as SETUP.md step 1, using the
   Armbian image for your board). Flashing wipes the drive, which is why
   this has to happen first.
2. **Make sure this device's code is pushed to GitHub.** The new drive
   fetches exactly the commit this device is running, and
   `prepare-drive` refuses if that commit isn't on GitHub.
3. **Plug the new drive into the old device's spare USB port and run:**
   ```bash
   lsblk                                           # find it, e.g. sdb
   python3 /root/scripts/migrate.py prepare-drive /dev/sdb
   ```
   You'll be asked to type the device name to confirm. It refuses the
   drive the system is running from, and anything with a mounted
   partition. It then:
   - finds the flashed root partition and grows it to fill the drive
     (normally Armbian does that on first boot, but the archive has to
     fit before then)
   - copies root's password and SSH keys, the SSH host keys, the
     hostname, and the network config (`/etc/netplan`, NetworkManager
     connections, so Wi-Fi credentials and any static IP carry over),
     and skips Armbian's interactive first-login wizard
   - installs `home-server-restore.service`, a run-once first-boot
     service
   - runs a full `export` onto the drive (containers stopped for the
     duration, then started again)
4. **`poweroff`, unplug the old drive, leave only the new one in, and
   power on.** Expect it to take about 20–40 minutes: the installer
   waits for the network, installs Docker and git, checks out the repo,
   then runs `migrate.py import`. That import detects the device's
   current IP automatically, so a changed DHCP address is handled.
   Watch it with:
   ```bash
   ssh root@<ip>          # same password/keys and same host key as before
   tail -f /root/home-server-migration/restore.log
   ```
   If a step fails (say the network is down), the service retries every
   2 minutes, up to 6 times. Run `systemctl start home-server-restore` to
   try again after that.
5. **Once everything works:** delete
   `/root/home-server-migration/backup.tar.gz` (it holds secrets). Tailscale
   and icecast2 come back on their own: their config and Tailscale's node
   identity are copied over, so the server keeps its Tailscale IP with no
   re-login. Keep the old drive untouched until then, as your fallback.

## Manual path (separate backup stick)

If you'd rather keep a standalone backup, or are moving to a different
kind of device:

1. Export onto any spare stick:
   `python3 /root/scripts/migrate.py export /mnt/backup/home-server.tar.gz`.
   Export refuses to write onto the root drive itself unless you pass
   `--allow-same-drive`.
2. On the new device, do SETUP.md steps 1–3 (OS, Docker, clone into
   `/root`). Skip `setup.sh`.
3. `python3 /root/scripts/migrate.py import /mnt/backup/home-server.tar.gz --host-ip <ip>`

## Keeping it in sync

`PERSONAL_PATHS` in `scripts/migrate.py` mirrors the "Personal data"
sections of `.gitignore`. When you add a new gitignored file that someone
would miss after a rebuild, add it to both.
