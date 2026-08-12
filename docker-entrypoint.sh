#!/bin/sh
# Starts as root (needed once, to read the mounted socket's group and
# create the data dirs), then drops to the unprivileged dockle user for
# the actual app process. This is the standard pattern for containers
# that need to match a host-specific group at runtime - the docker.sock
# group ID varies per host and can't be baked into the image.
set -e

mkdir -p "$DOCKLE_DATA" "$DOCKLE_STACKS"
chown dockle:dockle "$DOCKLE_DATA" 2>/dev/null || true

# Join the group that owns each mounted socket, whatever GID it happens
# to have on this host - same trick for docker.sock and the optional
# dockle-agent.sock (see agent/install.sh, only mounted in if you've
# set that up).
for SOCK in /var/run/docker.sock /run/dockle-agent.sock; do
  if [ -S "$SOCK" ]; then
    SOCK_GID=$(stat -c '%g' "$SOCK")
    if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
      addgroup -g "$SOCK_GID" "grp$SOCK_GID"
    fi
    GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
    adduser dockle "$GROUP_NAME" >/dev/null 2>&1 || true
  fi
done

exec su-exec dockle "$@"
