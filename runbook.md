# Dockle runbook

Plain-language guide for running Dockle. Everything here works from the
UI or a couple of copy-paste commands - no deep terminal knowledge needed.

## Install (Docker host)

Dockle is a normal pre-built image (`ghcr.io/lightmorphic/dockle`) -
nothing to clone or build, just its compose file:

```bash
mkdir -p /opt/dockle /opt/stacks && cd /opt/dockle
curl -fsSLO https://raw.githubusercontent.com/lightmorphic/dockle/main/compose.yaml
echo "SECRET_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > .env
docker compose up -d
```

Dockle runs as a non-root user with UID 1000 inside its container, matching
the usual first-user account on a fresh Linux install. If your own user
isn't UID 1000 (check with `id -u`), the container still starts fine but
can't write to `data/` - fix it once:

```bash
sudo chown -R 1000:1000 /opt/dockle/data /opt/stacks
```

Open `http://<server-ip>:4000` and create the admin account.
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

**One click**: Settings → Host OS & Tailscale → "Install companion". This installs
the systemd service on the host for you (a short-lived, one-time
privileged action - nothing standing afterward beyond the service
itself), then tells you the one remaining manual step below.

**Manually**, if you'd rather (the companion's three files live in the
repo, not the image, so grab them with a throwaway clone):

```bash
git clone https://github.com/lightmorphic/dockle /tmp/dockle-src
cd /tmp/dockle-src/companion && sudo sh install.sh
```

Either way, finish by giving Dockle the companion socket in
`compose.override.yaml` (see the per-machine settings section below):

```yaml
services:
  dockle:
    volumes:
      - /run/dockle-companion.sock:/run/dockle-companion.sock
```

and restart Dockle (`docker compose up -d`). Settings → Host OS & Tailscale and each
stack's Tailscale tab go from "not set up" to working once that's done.

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

Every release is published as its own image tag. To go back to a
previous version, pin the tag in `compose.override.yaml`:

```yaml
services:
  dockle:
    image: ghcr.io/lightmorphic/dockle:1.5.11
```

then `docker compose up -d`. Remove the override and pull to move
forward again. Your data (stacks, database, backups) is untouched by
rollbacks - it lives in `/opt/stacks` and `/opt/dockle/data`, outside
the image.

## Restart / update Dockle

The small dot next to "Dockle" in the top bar, top-left of every page,
is the only control Dockle offers over itself - deliberately not a
stack you can act on otherwise. Green means up to date; amber means a
new version is published - click it to download the new image in the
background (Dockle keeps running as-is the whole time), then click the
same dot again once it turns blue. No separate check button - it keeps
itself current on its own, same pattern as Charlie's other self-hosted
tools.

Dockle can't apply that update the way it redeploys any other stack:
`compose up` stops Dockle's container, which kills the process running
the command before it can start anything again. So the update is handed
to a short-lived helper container that isn't the one being replaced -
the same approach the companion installer already uses. That's also why
the page briefly goes away when you click restart: the container
serving it just got replaced.

Needs `DOCKLE_DATA_HOST_PATH` set in compose.yaml (it's how Dockle knows
its own folder on the host) - the documented install already sets this,
so it's only a concern if compose.yaml was hand-edited.

From a shell, if you prefer or if Dockle won't start - the same two
commands as any other composed app:

```bash
cd /opt/dockle
docker compose restart                     # just restart
docker compose pull && docker compose up -d   # update to latest
```

## Per-machine settings: compose.override.yaml

Anything specific to one server - the companion socket mount, a
different published port, an extra volume - belongs in
`compose.override.yaml` next to `compose.yaml`, not in `compose.yaml`
itself. Compose reads and merges it automatically, so a newer
`compose.yaml` (fetched by hand, or by a future Dockle) never collides
with your local edits.

```yaml
services:
  dockle:
    volumes:
      - /run/dockle-companion.sock:/run/dockle-companion.sock
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
(Uptime Kuma, etc.) at `http://<server-ip>:4000/health` and alert on
non-200. That way you hear about it even if Dockle itself is the thing
that's down.

## Full export / moving house

Backups → *Download everything (zip)* gives you the stacks folder and
Dockle's database in one file. The stacks folder alone is enough to run
everything with plain `docker compose` anywhere - no lock-in.
