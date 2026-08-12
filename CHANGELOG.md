# Changelog

## 1.1.0 - 2026-08-12

- Per-stack backup/restore including real data (bind mounts and named
  volumes, not just the compose file), with download and upload
- CodeMirror-based YAML editor with live validation, matching plain
  editor for `.env` files
- Update checking every 30 minutes with an icon badge and "Update all";
  status dots now reflect container health (red/yellow/green), not just
  running/stopped
- Bulk "Adopt all" plus a one-time first-run prompt
- Optional `dockle-agent` host companion: host OS update checks/apply on
  Debian/Ubuntu, and per-stack Tailscale Serve toggles - a separate,
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
