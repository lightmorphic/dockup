#!/bin/sh
# Installs dockle-agent as a systemd service directly on the host (not
# in a container). Needs root. Safe to re-run.
set -e

if [ "$(id -u)" != "0" ]; then
  echo "Run this as root: sudo sh install.sh"
  exit 1
fi

mkdir -p /opt/dockle-agent
cp "$(dirname "$0")/dockle-agent.py" /opt/dockle-agent/dockle-agent.py
cp "$(dirname "$0")/dockle-agent.service" /etc/systemd/system/dockle-agent.service

# A dedicated group, not the docker group - this socket only reaches
# the narrow OS-update/Tailscale command set, nothing Docker-related,
# so it doesn't need or want docker-group members to have it by default.
getent group dockle-agent >/dev/null || groupadd --system dockle-agent

systemctl daemon-reload
systemctl enable --now dockle-agent

# The socket is created fresh on each start with group dockle-agent -
# fix the group here too in case something recreated it before the
# service unit's own permissions applied.
sleep 1
[ -S /run/dockle-agent.sock ] && chgrp dockle-agent /run/dockle-agent.sock

echo "dockle-agent installed and running."
echo "Group GID for compose.yaml/entrypoint reference: $(getent group dockle-agent | cut -d: -f3)"
echo "Add Dockle's container to this group (compose.override.yaml or matching entrypoint logic) so it can reach /run/dockle-agent.sock."
