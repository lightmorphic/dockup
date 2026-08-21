# Changelog

## 1.5.2 - 2026-08-21

- **Dockle now appears on the dashboard as a card like any other
  stack** - same status dot, containers, logs and terminal, and the full
  set of buttons: Start, Stop, Restart, Redeploy, Update, Down and
  Delete, Delete included with the same opt-in "and its data" checkbox
  every other stack has. It used to hide itself from the dashboard
  entirely, which was a blunt way of avoiding buttons that would shoot
  it in the foot; the buttons now work instead, because every action
  runs from a helper container rather than from the container being
  acted on. Actions that deliberately leave Dockle down say so plainly
  rather than waiting for a page that isn't coming back
- **Update Dockle itself from Settings too**, no terminal needed. Settings
  now has a "Dockle itself" panel: check how many new commits are
  available, then one button pulls the newest source, pulls/rebuilds the
  image and recreates the container, streaming the output as it goes.
  Dockle can't apply this through its own Redeploy button - `compose up`
  stops the container running the command before it can start anything
  again - so the job is handed to a short-lived helper container that
  isn't the one being replaced, the same approach the companion
  installer already uses. When Dockle's own container goes down the
  output stops mid-flight; the page then waits for Dockle to answer
  again and refreshes itself. Managed stacks keep running throughout
- Dockle's own default port is now 4000 (`127.0.0.1:4000:5001` in
  compose.yaml), and the install steps everywhere say so. Only the host
  side moved - inside the container gunicorn still listens on 5001, so
  the right-hand number stays put. An existing install keeps whatever
  port its own compose.yaml already has until you change it
- Buttons no longer jump sideways when a check runs: "Check for
  updates" shrinking to "Checking..." used to reflow the whole row and
  slide the button next to it out from under the cursor. Both check
  buttons now reserve room for their longest label. The host OS result
  ("Everything is up to date") also sits to the right of Apply updates
  now, matching Dockle's own row instead of dropping onto a line below
- The sidebar now ends with two version numbers - Dockle's own and the
  container engine's - each with a green tick when there's something
  real to tick: for Dockle, up to date with the repo; for Docker, that
  Dockle is talking to it. (A tick claiming Docker itself is the newest
  release would be a guess: that isn't knowable from inside a
  container.) An amber arrow appears when Dockle is behind, with the
  commit count in the tooltip. This replaces the engine badge that used
  to sit in the top bar, and the check behind it is cached and refreshed
  in the background, so no page ever waits on it
- Fixed the Dockle update check failing with "couldn't reach the
  remote" on a normal install: git commands run as root over a folder
  owned by the admin who cloned it, and git refuses that with "detected
  dubious ownership in repository". Every git call the update path makes
  now declares that one directory safe, scoped per command rather than
  changing anything on the host. The check also reports git's own words
  now instead of swallowing them
- A stack's "Serve" tab is now called "Tailscale" - it only ever did
  Tailscale Serve, and "Serve" read like a generic hosting setting
- `compose.override.yaml` is gitignored and documented as the place for
  per-machine settings (the companion socket mount, a different port).
  Editing the tracked `compose.yaml` instead is what makes `git pull` -
  and so the in-app update button, which uses `git pull --ff-only` -
  refuse to run
- A session no longer outlives the account it belongs to: every request
  now checks the user still exists, not just that the browser is
  carrying a session cookie
- Clicking the cloud to update a stack now shows the update happening,
  line by line, the same way pressing Start or Update does. It used to
  run silently behind a spinner and come back with one word ("Updated"
  or an error), so a slow pull looked like nothing at all and a
  failure gave you nothing to read. From a stack's own page the output
  streams straight into its output panel; from a dashboard card - which
  has nowhere to show output - it opens that stack's page and starts
  the update there

## 1.5.1 - 2026-08-20

- Fixed Prune volumes doing nothing: it listed the volumes it would
  remove, then reclaimed 0B every time. Since Docker API 1.42 a bare
  `docker volume prune` removes only anonymous volumes, so every named
  volume named in the confirmation was silently left behind - the
  preview and the action were asking the engine two different
  questions
- Prune volumes now says whose data each volume is before deleting it.
  "Unused" only means no container is using it right now, which also
  describes every volume belonging to a stack you have merely stopped
  - so each one is now listed with its size and its origin: in use by
  a stopped stack (its live data), left over from a stack that no
  longer uses it, or claimed by no stack at all. If any belong to a
  stopped stack, the confirmation says so plainly instead of relying
  on the button being red
- Maintenance now explains that images, containers, networks and build
  cache are all rebuildable and cost nothing to prune, and that
  volumes are the only thing on the page that can lose real data

## 1.5.0 - 2026-08-18

- Delete now purges the image unconditionally (previously only Purge
  did), and offers an explicit, opt-in option to permanently delete a
  stack's actual data too - bind-mount folders and named volumes,
  listing the real paths involved before you opt in
- Fixed a real bug where deleting a stack could crash mid-stream with
  no trace anywhere (client saw a bare "network error", nothing in
  Activity) - the streaming actions (delete, redeploy, update, and the
  companion installer) now correctly keep Flask's request context
  alive for their whole run, and any unexpected error is now always
  caught and reported instead of failing silently
- Delete can no longer hang forever on a container stuck in a bad
  state (e.g. its bind-mount source deleted while still running) - a
  45s cap now falls back to forcefully removing it
- Fixed a real update-check bug: some images report a frozen digest
  instead of their tag, which made Dockle permanently report "up to
  date" even when a real update was sitting on the registry
- Every contextual message in the app (save confirmations, errors,
  update results) is now a small bubble anchored to the actual button
  or field it's about, with an arrow pointing at it - replacing the
  old toast that sat easy-to-miss at the bottom of the page
- New Stack's default port changed from 8080 to 8001 to avoid a
  common collision
- Container hardened further: dropped capabilities to only what the
  entrypoint's privilege drop needs, no-new-privileges, a process and
  memory ceiling, rotated logs, and a .dockerignore trimming the build
  context

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
