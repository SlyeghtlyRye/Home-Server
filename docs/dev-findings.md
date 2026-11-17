tags: debugging, lessons, infra, history

# Findings From Development (Debugging Case Studies)

Real problems hit while building and running this server, written up as
case studies: what it looked like, how it was tracked down, what it
actually was, and the general lesson. The goal is to record *how* each
one was found, since the method transfers to other problems more than
the specific fix does.

Each entry links to the doc that holds the full technical detail.

## The method, in one paragraph

Most of these were solved the same way: **read the exact error, form a
hypothesis, then design a test whose result could prove that hypothesis
wrong.** Don't apply fixes until a test points at the cause. Several of
the problems below survived months of "optimizations" because each fix
addressed a plausible cause without first checking whether it was the
real one.

## 1. Mealie crash loops: a drive that silently returned wrong bytes

**Symptom.** Mealie stopped loading, sometimes for hours or days. Its
logs showed `ValueError: bad marshal data` and similar errors. Restarting
didn't help, and neither did repeated memory and performance tuning.

**How it was found.**

1. *Read the exact error.* `bad marshal data` means Python loaded a
   compiled `.pyc` file whose bytes were wrong. That's not a logic bug in
   Mealie. Something handed Python corrupted bytes, which points at
   storage or RAM.
2. *Ask why restarts don't fix it.* Linux keeps recently read files in
   spare RAM, the **page cache**. If one read comes back corrupted, the
   bad copy sits in the cache, and every restart is served that same bad
   copy without the drive being read again. The failure looks permanent,
   and because it only clears when memory pressure evicts that page, it
   *looked* memory-related. That's why earlier fixes targeted memory.
3. *Test the drive.* Hash a file, force the next read to come from the
   drive instead of the cache, and hash it again. Nothing had written to
   the file, so the hashes should match. They didn't:
   ```
   # evict one file from the page cache, then re-read it from the drive
   python3 -c "import os; fd=os.open('FILE', os.O_RDONLY); os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)"
   sha256sum FILE
   ```
   A scan of all 9,225 `.pyc` files in the Mealie image, run twice with
   the cache dropped in between, flagged a *different* set of "corrupt"
   files on each pass. The data on the drive was fine; individual reads
   weren't.
4. *Test the RAM separately.* Load a 64 MB buffer and hash it 2,000
   times without touching the drive. It never changed, so RAM was ruled
   out.
5. *Check the kernel log.* `dmesg` showed **no I/O errors at all.** The
   drive never reported a failure; it simply returned wrong data. This is
   called *silent data corruption*, and it's why nothing looked unhealthy.
6. *Watch the trend.* In the morning a full scan found 1 to 3 bad files.
   By evening a single 26 KB file read back 21 different ways in 40
   attempts. The drive was failing fast.

**Root cause.** The root filesystem lived on a cheap USB flash drive
(USB ID `346d:5678`, reporting itself as "VendorCo ProductCode"). An
unbranded ID like that is a classic sign of a counterfeit or
lowest-grade drive.

**Fix.**

- **Short term:** `scripts/storage_watchdog.py` spots the corruption
  errors in Mealie's logs, drops the page cache, and restarts Mealie, so
  a bad read heals itself instead of sticking.
- **Real fix:** move to a new drive with `scripts/migrate.py
  prepare-drive`. Every file is read twice and must match before it's
  trusted, so the corruption couldn't follow the data onto the new drive.

**Lessons.**

- When a problem "sticks" across restarts, ask what's being *cached*.
- No errors in the logs doesn't mean the hardware is healthy.
- Never clone a failing drive byte for byte. The clone copies the
  corruption too. Copy files with verification instead.

Details: `docs/system-panel.md` section *"Mealie 'bad marshal
data' crash loops"*, and `docs/migration.md` section *"How it
protects against a flaky drive"*.

## 2. The watchdog's first live run: too strict, and too slow

**Symptom.** Right after deployment, the watchdog healed Mealie once and
then ignored a 25-minute crash loop.

**How it was found.** Comparing its log against Mealie's showed the
later crashes said `EOFError: marshal data too short`. Same corruption,
different wording. The watchdog only matched `bad marshal data`. Its
5-minute cooldown also meant one heal at most per 5 minutes, while a
degrading drive needed a fresh heal after every crash.

**Fix.** Match the shared phrase `marshal data`, plus the other
corrupted-file errors seen live. Check every 30 seconds with a 60-second
cooldown, and escalate if it needs more than 10 heals in an hour.

**Lesson.** Corrupted data fails in many different ways. Match errors
loosely, and test detection against the variants actually seen in
production, not just the first example.

## 3. Kanboard's data was never in its volume

**Symptom.** After the drive migration, the dashboard asked for the
Kanboard token again. The token file had been restored correctly.

**How it was found.** Kanboard's own log showed `API authentication
failure`. Opening its database showed a different API token than the
saved one. The named volume `kanboard_data` was **empty**, on the old
drive too. `docker image inspect` showed the image keeps its data in
`/var/www/app/data`, while the compose file mounted the volume at
`/var/www/html/data`, a folder Kanboard never uses.

**Root cause.** Because the image declares `/var/www/app/data` as a
volume, Docker quietly created an **anonymous volume** there instead.
The old drive held 9 of them, one per time the container was rebuilt
from scratch. The backup only copies named volumes, so it never saw the
real database. The new drive started Kanboard with a fresh, empty
database and a new token.

**Fix.** Mount `kanboard_data` at `/var/www/app/data`, and copy the most
recent database across from the old drive (read twice and integrity
checked). No tasks were lost; Kanboard only holds the dashboard's own
"Tasks" project.

**Lessons.**

- Check `docker image inspect -f '{{json .Config.Volumes}}' IMAGE`
  against your mounts. A typo in a mount path doesn't cause an error; it
  silently creates a second, unbacked-up storage location.
- A backup isn't proven until it has been restored. This bug was only
  found because a real restore happened.

## 4. Pi-hole couldn't bind port 53 on a fresh install

**Symptom.** On the new drive, the Pi-hole container failed with
`failed to bind host port 0.0.0.0:53/tcp: address already in use`.

**How it was found.** `ss -lntup | grep :53` showed `systemd-resolved`
listening on `127.0.0.53:53` and `127.0.0.54:53`. On Linux, binding the
wildcard address `0.0.0.0:53` fails if any specific address already
holds that port. The old drive had `systemd-resolved` disabled entirely,
a hand-made change that had never been recorded anywhere.

**Fix.** Turn off just resolved's stub listener
(`DNSStubListener=no`), which keeps Tailscale's DNS integration working.
The new-drive installer now does this automatically.

**A second trap in the same incident.** After that first failure, Docker
reported the restarted Pi-hole as **healthy**, but it had no network
attached at all, so it answered no DNS queries. Its health check runs
*inside* the container, so it passed. Recreating the container fixed it.
The lesson: a passing health check only proves what it actually tests.
Test the service the way its users reach it, here a DNS query sent to
the LAN IP.

**Lesson.** Every manual change to a server is undocumented state that a
rebuild will lose. Rebuilding onto a fresh install is the best way to
find those changes.

## 5. Two ordering bugs in the first-boot installer

**SSH host keys reverted.** The installer restored the old SSH keys and
then saw them replaced 5 seconds later. Its systemd unit was ordered
`After=armbian-firstrun.service`, but that service is `Type=simple`,
and for that type `After=` only waits for it to **start**, not finish.
Armbian's script was still running and deleted the keys. The fix: wait
until that service has actually exited, and re-apply the keys at the
end as a safety net.

**`set -e` silently ignored.** The Tailscale and Icecast restore steps
run as functions inside an `if restore_x; then ...`. Bash **disables
`set -e` inside a command used as an `if` condition**, so a failed
install inside the function would have carried on and reported success.
A test that made `apt-get` fail caught this. The fix: chain the steps
with `&&` so any failure propagates.

**Lesson.** Read the semantics, not just the keywords. `After=` and
`set -e` both sound like guarantees that they aren't. Write tests that
force the failure path, not just the happy path.

## 6. Smaller ones worth knowing

- **One container down took the whole dashboard down.** nginx `upstream`
  blocks look up hostnames once, at startup, and nginx refuses to start
  if any lookup fails. Resolving per request (`resolver 127.0.0.11` plus
  a variable in `proxy_pass`) fixed it. See
  `docs/nginx-and-networking.md`.
- **No clock battery.** The board has no real-time clock, so a fresh
  install boots with the image's build date. HTTPS then fails with
  `certificate is not yet valid` until network time syncs. The installer
  retries until the network check passes.
- **Windows line endings.** A Windows checkout converts files to CRLF,
  which broke the docs renderer's list detection until it split lines on
  `\r?\n`. Files on the server stay LF.
- **Images without pinned versions.** Unversioned image tags meant a
  restart could silently pull a new version. All images are now pinned
  to exact versions in `docker-compose.yml`.

## Toolkit: commands used above

| Question | Command |
|---|---|
| Is a file reading back consistently from the drive? | evict with `posix_fadvise(..., POSIX_FADV_DONTNEED)`, then `sha256sum`, then repeat |
| Drop the whole page cache | `sync; echo 1 > /proc/sys/vm/drop_caches` |
| Did the kernel see disk errors? | `dmesg -T` or `journalctl -k` |
| What is this USB device really? | `lsusb`, `lsblk -o NAME,MODEL,SERIAL,TRAN` |
| Who holds a port? | `ss -lntup` |
| Where does an image keep its data? | `docker image inspect -f '{{json .Config.Volumes}}' IMAGE` |
| What is mounted into a container? | `docker inspect -f '{{json .Mounts}}' NAME` |
| What did a systemd unit really wait for? | `systemctl show UNIT -p Type -p After` |

## Further reading

Search terms that lead to good material on these topics:

- **Linux page cache**, `drop_caches`, `posix_fadvise`: how file caching
  works and how to bypass it.
- **Silent data corruption** (also called bit rot): why checksumming
  filesystems like **ZFS** and **btrfs** exist. Their *scrub* feature
  detects automatically what finding #1 did by hand.
- **Counterfeit USB flash drives**: tools like **f3** (Linux) and
  **H2testw** (Windows) write known data across the whole drive and
  verify it.
- **memtest86+** and **memtester**: how to properly confirm or rule out
  bad RAM.
- **systemd unit types and ordering** (`Type=`, `After=` vs `Requires=`)
  and **Bash `set -e` pitfalls**.
