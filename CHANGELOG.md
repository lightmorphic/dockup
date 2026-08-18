# Changelog

## 1.4.0 - 2026-08-18

- Port-conflict warnings: creating or editing a compose file now checks
  every port it publishes against every other managed stack's declared
  ports and every container's actual live binding, and shows an inline
  warning before you ever hit deploy - instead of finding out from a
  failed "address already in use" after the fact
- Stack detail page: a status dot (green running, yellow update ready,
  red an issue, gray no container) next to the title, plus a button to
  force an update check for just that one stack without waiting for
  the dashboard's full sweep
- Reboot server and Restart Docker actions, moved to the top bar next
  to Sign out
- Redeploy failures caused by a network that predates Dockle managing
  a stack now self-heal automatically instead of failing every time
- Dashboard cards show the stack's port and an open-web-UI link, and
  the status dot itself doubles as a one-click update button when
  yellow
- Icon buttons are circular across the app, matching the house style
- Container runtime hardened: capabilities dropped to only what the
  entrypoint's privilege drop needs, no-new-privileges, a process and
  memory ceiling, and rotated logs

## 1.3.0 - 2026-08-12

- Companion install is now fully automated end to end: after installing
  the host service, Dockle edits its own compose.yaml and restarts
  itself to reconnect, with a live, dismissible progress panel showing
  each step instead of a bare "Installing…" label
- Redeploy action: recreates a stack's containers from the compose file
  and whatever image is already pulled, for a container stuck in a bad
  state that a plain restart doesn't fix
- A stack with no container at all now shows a neutral gray status dot
  instead of red (which means a real problem) - gray stacks get
  Archive (move the folder aside, restorable later) and Delete (folder
  and every referenced image, nothing left behind) actions, with
  archived stacks listed in a collapsed section at the bottom of the
  dashboard
- Deleting a stack now turns off any Tailscale Serve mapping for its
  ports for good, instead of leaving a stale rule that breaks the next
  stack trying to bind that port
- Fixed a real crash: deleting a stack whose folder was left root-owned
  by a previous manager (a real state for anything adopted from
  Arcane) threw an unhandled permission error partway through,
  container removed but the folder stuck behind as a ghost card
- Fixed a real bug in `composegen.py` (used when adopting a container
  whose original compose file is missing): it wrote the container's
  live network name as `network_mode:`, which never gets created if
  pruned, and never captured `command`/`entrypoint` overrides at all -
  together these could leave an adopted stack unable to restart, or
  running with silently dropped startup arguments
- Serve tab now shows plain status ("Exposed at https://real-host:port"
  / "Not exposed") using the real Tailscale hostname, instead of a
  placeholder and unlabeled port checkboxes
- New open-web-UI icon next to the stack name: opens the real Tailscale
  Serve URL if set up, otherwise the host address the browser is
  already using, on the stack's own port
- Security: login lockout was keyed partly on the client-supplied
  `X-Forwarded-For` header, letting anyone bypass the 5-attempts limit
  by sending a fresh fake IP on every request - fixed to use the real
  connecting address only

## 1.2.0 - 2026-08-12

- Renamed the optional host helper from `dockle-agent` to
  `dockle-companion` (it isn't an AI agent - a small, fixed-command-set
  systemd service)
- One-click "Install companion" button in Settings → Host: runs the
  host-side install for you via a short-lived privileged action, no
  standing extra permissions for Dockle's own container afterward
- Dockle now automatically pauses and restores any Tailscale Serve rule
  that's holding a port a stack is about to bind to (when the companion
  is installed), fixing the "address already in use" failure that hits
  a deleted-and-recreated stack whose old Serve mapping is still live
- When that specific conflict happens without the companion installed,
  Dockle explains exactly what's wrong and how to fix it instead of
  just showing Docker's raw error text
- Stack name input now filters to lowercase/digits/-/_ as you type
  instead of failing validation after the fact
- Fixed a real bug in the same area: `docker compose` was reading
  Dockle's own container `PATH` instead of a stack's `.env` definition
  of the same name (a real pattern in imported Arcane stacks, e.g.
  stirling-pdf), corrupting `${PATH}`-based volume paths on every
  update check

## 1.1.0 - 2026-08-12

- Per-stack backup/restore including real data (bind mounts and named
  volumes, not just the compose file), with download and upload
- CodeMirror-based YAML editor with live validation, matching plain
  editor for `.env` files
- Update checking every 30 minutes with an icon badge and "Update all";
  status dots now reflect container health (red/yellow/green), not just
  running/stopped
- Bulk "Adopt all" plus a one-time first-run prompt
- Optional `dockle-companion` host helper: host OS update checks/apply
  on Debian/Ubuntu, and per-stack Tailscale Serve toggles - a separate,
  narrowly-scoped install since it needs root on the host itself
- Security hardening: container runs as non-root, port bound to
  localhost only, WebSocket Origin checks, secure session cookies,
  pip/setuptools stripped from the shipped image

## 1.0.0 - 2026-08-12

First release.

- Stack dashboard, compose editor, `docker run` → compose converter
- Adopt: pull existing compose projects and standalone containers under management
- Live log streaming with error/warning highlighting, web terminal
- Prune per resource type or all together, with a confirm step before deleting volumes
- Persistent activity log, optional email alerts on errors
- Settings screen with encrypted secrets, SMTP test button, Docker/Podman toggle
- Server-side login, rate limiting, optional TOTP 2FA
- Daily backups, reversible restore, full export
- Lightmorphic-styled one-window UI, PWA-installable
