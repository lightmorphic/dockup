#!/bin/sh
# Starts as root (needed once, to read the mounted socket's group and
# create the data dirs), then drops to the unprivileged dockle user for
# the actual app process. This is the standard pattern for containers
# that need to match a host-specific group at runtime - the docker.sock
# group ID varies per host and can't be baked into the image.
set -e

mkdir -p "$DOCKLE_DATA" "$DOCKLE_STACKS"
chown dockle:dockle "$DOCKLE_DATA" 2>/dev/null || true

if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    addgroup -g "$SOCK_GID" dockersock
  fi
  GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
  adduser dockle "$GROUP_NAME" >/dev/null 2>&1 || true
fi

exec su-exec dockle "$@"
