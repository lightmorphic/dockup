#!/bin/sh
# Installs dockle-companion as a systemd service directly on the host (not
# in a container). Needs root. Safe to re-run.
set -e

if [ "$(id -u)" != "0" ]; then
  echo "Run this as root: sudo sh install.sh"
  exit 1
fi

mkdir -p /opt/dockle-companion
cp "$(dirname "$0")/dockle-companion.py" /opt/dockle-companion/dockle-companion.py
cp "$(dirname "$0")/dockle-companion.service" /etc/systemd/system/dockle-companion.service

# A dedicated group, not the docker group - this socket only reaches
# the narrow OS-update/Tailscale command set, nothing Docker-related,
# so it doesn't need or want docker-group members to have it by default.
getent group dockle-companion >/dev/null || groupadd --system dockle-companion

systemctl daemon-reload
systemctl enable --now dockle-companion

# The socket is created fresh on each start with group dockle-companion -
# fix the group here too in case something recreated it before the
# service unit's own permissions applied.
sleep 1
[ -S /run/dockle-companion.sock ] && chgrp dockle-companion /run/dockle-companion.sock

echo "dockle-companion installed and running."
echo "Group GID for compose.yaml/entrypoint reference: $(getent group dockle-companion | cut -d: -f3)"
echo "Add Dockle's container to this group (compose.override.yaml or matching entrypoint logic) so it can reach /run/dockle-companion.sock."
