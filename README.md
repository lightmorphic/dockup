# Dockle

A self-hosted Docker Compose stack manager for **home labs**, with a proper
login. Inspired by [Dockge](https://github.com/louislam/dockge) - same idea,
fresh code, different look, security first.

> **Home labs only (for now).** Dockle is built for a machine on your own
> network. It is not hardened for internet-facing VPS use - don't put it on
> a public server.

## What it does

- All your compose stacks on one dashboard, live status, one window
- Create stacks in a web editor with colour-highlighted YAML and live
  validation, or paste a `docker run ...` command and have it converted
  to compose
- Start / stop / restart / update (pull newest images) / delete - one click
- Checks every 30 minutes for a newer image per stack and flags it on
  the card - update one or "Update all", nothing pulls on its own
- **Adopt** what's already running, one at a time or all in one go:
  Dockle scans the system for compose projects and standalone containers
  it doesn't manage and pulls their setup into the stacks folder
- Live log streaming with errors highlighted in red
- Web terminal into any running container
- Prune unused images, containers, networks, volumes and build cache -
  separately or together, with volumes always a deliberate two-step
- Persistent activity log, optional email alerts on errors
- Daily backups with one-click (reversible) restore, plus a
  download-everything zip
- **Per-stack backup including real data** - bind mounts and named
  volumes, not just the compose file - with download and upload for
  moving a stack's backup to another machine or keeping a copy yourself
- Works with **Docker or Podman** - same UI, just point it at the other socket
- Optional host agent for host OS update checks and per-stack Tailscale
  Serve toggles - the one part of Dockle that needs root on the actual
  server rather than just Docker access, so it's a separate install step

## Security

- Real server-side login with rate limiting and optional 2FA (TOTP)
- One secret in the environment (`SECRET_KEY`); everything else lives in
  the Settings screen, encrypted at rest
- Session cookies are HttpOnly + SameSite; CSRF-checked API; strict CSP;
  no CDNs, no external calls, no tracking - everything served from Dockle

## Install

```bash
mkdir -p /opt/dockle /opt/stacks && cd /opt/dockle
# (copy this repo here)
echo "SECRET_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > .env
docker compose up -d --build
```

Open `http://<server-ip>:5001`, create the admin account, done.
`/opt/stacks` is the recommended stacks folder - each stack is a plain
folder with a compose file, so there's no lock-in: the folder works with
plain `docker compose` (or any other manager) at any time.

### Optional: host agent (Tailscale Serve + OS updates)

A second, separate step - only needed for host OS update checks and
per-stack Tailscale Serve toggles. Everything else works without it.

```bash
cd agent && sudo sh install.sh
```

Then uncomment the agent socket line in `compose.yaml` and restart
Dockle. Full steps in [runbook.md](runbook.md).

### Podman instead of Docker

Enable the Podman socket, then swap the socket mount in `compose.yaml`
(see the comment there) and flip the engine in Settings. The full steps
are in [runbook.md](runbook.md).

## Day to day

Everything routine - restart, backups, restore, logs, pruning - is a
button in the UI. The [runbook](runbook.md) covers the rest in plain
language: install, restore, rollback, moving to Podman, and what to do
when something's wrong.

## Licence notes

Bundled third-party bits: [xterm.js](https://github.com/xtermjs/xterm.js)
(MIT) for the terminal, [Manrope](https://fonts.google.com/specimen/Manrope)
(SIL OFL) for the type. Python dependencies are in `requirements.txt` -
all permissively licensed (BSD/MIT/Apache).
