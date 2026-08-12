# Scoping: features that need more than Docker access

Two of Charlie's requests - managing Tailscale Serve per-stack (including
installing Tailscale on a bare VPS) and checking/applying host OS updates
(Debian/Ubuntu) - share the same underlying problem: **Dockle runs inside
a container, and neither of these is something the Docker socket can do.**
Everything Dockle does today (start/stop containers, read logs, prune,
adopt) goes through the Docker socket, which is a well-defined, narrow
interface. Installing packages, running `apt`, or controlling `tailscale`
on the host means reaching *outside* that container entirely.

This doc lays out the options before any code gets written, per the
"scope it properly first" call.

## What each feature actually needs

**Tailscale Serve management** (Settings: MagicDNS address; per-stack:
expose a port via Serve or turn it off; auto-install Tailscale if
missing):
- Read Tailscale's status and MagicDNS name on the host
- Run `tailscale serve --https=<port> http://127.0.0.1:<port>` /
  `... off` on the host, per stack
- On a bare VPS with no Tailscale: install the `tailscale` package and
  bring up the daemon
- Certificates are the easy part - Tailscale auto-issues them the
  moment `serve --https` is turned on for a node with HTTPS certs
  enabled in the admin console; Dockle doesn't need to touch certs
  directly

**Host OS update check + one-click apply** (Debian/Ubuntu only):
- Detect the OS (`/etc/os-release`)
- Run `apt-get update` and list upgradable packages
- Run `apt-get upgrade` on demand

Both need to **run commands as root on the host**, not inside Dockle's
own container namespace.

## The access-model options

### A. Bind-mount the host root into Dockle's container (`-v /:/host`)

Mount the host filesystem into Dockle, `chroot`/`nsenter` into it to run
`apt`/`tailscale` commands.

- **Pro:** no second thing to install; works today's architecture
  as-is.
- **Con:** this is close to giving Dockle root on the host outright -
  worse than the Docker socket alone, because it also reaches files
  and processes Docker doesn't touch (SSH keys, other users' data,
  systemd). A bug or compromise in Dockle becomes a full host
  compromise, not just a Docker-scoped one. This is a large step up
  in blast radius for the whole app, not just these two features.

### B. A small companion agent installed directly on the host (not in a container)

A tiny script/binary Charlie installs once on the host (`curl | sh`
style, like Tailscale's own installer), running as a systemd service
with a narrow, fixed command set - not a general shell. Dockle's
container talks to it over a local Unix socket or loopback port,
exactly the way it already talks to `docker.sock`.

- **Pro:** keeps root-level actions behind a small, auditable surface
  (a handful of allowed commands: `apt-get update`, `apt-get upgrade`,
  `tailscale serve ...`, `tailscale up`) rather than a full shell.
  Dockle's own container stays exactly as locked-down as it is today -
  this whole capability lives in a separate, minimal piece.
- **Con:** a second thing to install and keep updated; on a VPS this
  means one extra `curl | sh` step during setup (the same shape as
  installing Tailscale itself, so not an unfamiliar pattern).

### C. SSH from Dockle's container back to the host

Bake a key into Dockle, SSH to `host.docker.internal` or similar, run
commands.

- **Pro:** no new install - most hosts already run sshd.
- **Con:** means storing a private key with host root access *inside*
  a container that's reachable from the web UI - if Dockle's container
  is ever compromised, that key walks straight out. Also fights with
  whatever SSH hardening/key rotation Charlie already does. Weakest
  option of the three on security grounds.

## Recommendation

**Option B** - a small companion host agent with a fixed, narrow command
set - is the only one that doesn't meaningfully increase what a bug in
Dockle could do to the host. It costs one extra install step (matching
the existing "install Tailscale" step conceptually), but keeps the
"Dockle's own container is not privileged" property that's been true of
every feature so far.

Concretely, if this gets built:
- `dockle-agent`: a small Go or Python binary, systemd unit, listens on
  a Unix socket only `root` can reach (matching how `docker.sock`
  itself is locked down)
- Fixed command set, no arbitrary shell - each capability (update
  check, update apply, tailscale serve on/off, tailscale install) is
  its own explicit RPC, not "run this string"
- Dockle's container gets the socket bind-mounted in, same shape as
  `docker.sock` today
- Every action the agent takes gets logged to Dockle's existing
  Activity log, same as everything else

This is a real, multi-day feature - new host-side install docs, a new
service to version and update, and its own security review before it
ships (the "run arbitrary root commands from a web UI" shape is exactly
the kind of thing that needs care, not haste). Worth building once
prioritised, not worth rushing into the current pass.

## What's NOT recommended

Option A (bind-mounting host root) - flagging clearly: don't do this
even under time pressure. It quietly undoes the non-root-container work
already shipped, for the sake of two features that don't need that much
access.
