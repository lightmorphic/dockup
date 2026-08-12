# Dockle runbook

Plain-language guide for running Dockle. Everything here works from the
UI or a couple of copy-paste commands - no deep terminal knowledge needed.

## Install (Docker host)

```bash
mkdir -p /opt/dockle /opt/stacks && cd /opt/dockle
# copy the repo contents here, then:
echo "SECRET_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > .env
docker compose up -d --build
```

Dockle runs as a non-root user with UID 1000 inside its container, matching
the usual first-user account on a fresh Linux install. If your own user
isn't UID 1000 (check with `id -u`), the container still starts fine but
can't write to `data/` - fix it once:

```bash
sudo chown -R 1000:1000 /opt/dockle/data /opt/stacks
```

Open `http://<server-ip>:5001` and create the admin account.
Keep a copy of the `.env` file's SECRET_KEY somewhere safe (password
manager). It encrypts your saved settings - lose it and saved passwords
in Settings have to be re-entered.

## Optional: the dockle-companion (Tailscale Serve + OS updates)

Everything above is all Dockle needs to run. This second, separate step
is only for two extra features - checking/applying host OS updates, and
turning Tailscale Serve on/off per stack - and it's the one part of
Dockle that needs root on the actual server, not just Docker access.
Skip it entirely if you don't want those two features; everything else
works the same either way.

**One click**: Settings → Host → "Install companion". This installs
the systemd service on the host for you (a short-lived, one-time
privileged action - nothing standing afterward beyond the service
itself), then tells you the one remaining manual step below.

**Manually**, if you'd rather:

```bash
cd /opt/dockle/companion && sudo sh install.sh
```

Either way, finish by uncommenting the companion socket line in
`compose.yaml`:

```yaml
- /run/dockle-companion.sock:/run/dockle-companion.sock
```

and restart Dockle (`docker compose up -d`). Settings → Host and each
stack's Serve tab go from "not set up" to working once that's done.

Also worth knowing: once the companion is installed, Dockle
automatically pauses any Tailscale Serve rule that's using a port a
stack is about to bind to, and restores it right after - this is what
prevents the classic "address already in use" failure when a stack you
deleted and recreated tries to grab a port Tailscale Serve is still
holding open. Without the companion, Dockle can't do this for you and
will just explain what happened and how to fix it by hand.

## First steps after install

1. **Settings → Email alerts**: fill in SMTP and press *Send test email*.
   Until this works, error alerts only show in Activity.
2. **Settings → Account**: consider switching on 2FA.
3. **Dashboard**: if you already had things running, an "adopt" panel
   lists them - adopt what you want Dockle to manage.

## Daily use

Everything is a button: start/stop/restart/update per stack, logs and
terminal per stack, pruning under Maintenance, backups under Backups.
Errors show in red in Activity, and email you if SMTP is set up.

## Restore a backup

Backups run daily (hour and retention set in Settings) and cover the
stacks folder plus Dockle's own database.

- **From the UI**: Backups → pick one → Restore (click twice). The
  current files are kept at `data/pre-restore-stacks` first, so a restore
  can itself be undone by copying that folder back.
- Restored stacks aren't restarted automatically - press play on each
  when you're ready.

## Back up one stack, including its real data

Open a stack → **Backup** tab → **Back up now**. Unlike the daily backup
above (which only covers compose files), this also archives the stack's
actual data - bind-mounted folders and named volumes, read straight from
wherever they already live. Restoring puts everything back to exactly
the same place, nothing gets relocated.

This needs Dockle to know its own real path on the host, since it asks
Docker to start small helper containers that mount both the stack's data
and Dockle's own backup folder side by side. If you installed Dockle
somewhere other than `/opt/dockle`, set this in `.env`:

```
DOCKLE_DATA_HOST_PATH=/wherever/you/put/dockle/data
```

If it's missing or wrong, per-stack backups fail with a clear error
telling you to set it - the daily/global backup above doesn't need it.

## Roll back Dockle itself

Dockle's code is in git. To go back to the previous working version:

```bash
cd /opt/dockle
git log --oneline -5        # find the commit you want
git checkout <commit> && docker compose up -d --build
```

Your data (stacks, database, backups) is untouched by rollbacks - it
lives in `/opt/stacks` and `/opt/dockle/data`, outside the image.

## Restart / update Dockle

```bash
cd /opt/dockle
docker compose restart            # just restart
git pull && docker compose up -d --build   # update to latest
```

## Switch to Podman (no daemon)

1. On the host: `systemctl enable --now podman.socket`
   (rootful; for rootless see the Podman docs - the socket path differs).
2. In `compose.yaml`, replace the Docker socket line with the Podman one
   (the comment in the file shows exactly which line).
3. `docker compose up -d` (or `podman compose up -d`) to restart Dockle.
4. In Settings → Engine, pick Podman, set the socket path to
   `/var/run/docker.sock` (that's where the mount lands inside the
   container) and press *Test connection*.

## If Dockle is down

```bash
cd /opt/dockle && docker compose ps      # is it running?
docker compose logs --tail 50 dockle     # what happened?
docker compose up -d                     # start it again
```

The container restarts itself (`restart: unless-stopped`) and has a
health check, so a crash normally self-heals within a minute.

## Uptime check

Dockle answers on `/health` without a login. Point any LAN uptime tool
(Uptime Kuma, etc.) at `http://<server-ip>:5001/health` and alert on
non-200. That way you hear about it even if Dockle itself is the thing
that's down.

## Full export / moving house

Backups → *Download everything (zip)* gives you the stacks folder and
Dockle's database in one file. The stacks folder alone is enough to run
everything with plain `docker compose` anywhere - no lock-in.
