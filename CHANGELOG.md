# Changelog

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
