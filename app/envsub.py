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
    def repl(m):
        name = m.group(1) or m.group(2)
        return env.get(name, os.environ.get(name, m.group(0)))
    return _VAR_RE.sub(repl, text)
