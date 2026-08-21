"""Resolve ${VAR}/$VAR the way `docker compose` does when reading a
stack's own .env file - shared by anything that needs to interpret a
compose.yaml without actually invoking the compose CLI (backups, the
Tailscale Serve port list). A bind-mount path like ${BASE}/data or a
published port like ${PORT} (both common - Arcane-managed stacks use
this convention throughout) resolve to their real value instead of the
literal unexpanded string.
"""

import os
import re

from . import config

_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def parse_env(env_text: str) -> dict:
    values = {}
    for line in (env_text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def substitute(text: str, env: dict) -> str:
    """Resolve ${VAR} the way compose will, given a stack's .env values.

    The fallback is limited to config.COMPOSE_PASSTHROUGH because that is
    now all compose itself receives from Dockle's environment (see
    Runtime._compose_env). Falling back to the whole of os.environ made
    this disagree with reality: a stack referencing ${SECRET_KEY} resolved
    here to Dockle's key, so backup source paths and Serve ports could be
    computed from values the container never saw."""
    def repl(m):
        name = m.group(1) or m.group(2)
        if name in env:
            return env[name]
        if name in config.COMPOSE_PASSTHROUGH:
            return os.environ.get(name, m.group(0))
        return m.group(0)
    return _VAR_RE.sub(repl, text)
