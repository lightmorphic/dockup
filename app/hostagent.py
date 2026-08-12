"""Client for the optional dockle-agent host service (see agent/ in the
repo) - the narrow, fixed-command-set helper that runs directly on the
host for the two things the Docker socket alone can't reach: host OS
updates and Tailscale Serve. Entirely optional; every call here reports
a plain "not available" rather than erroring if it isn't installed.
"""

import json
import socket

from . import config

SOCKET_PATH = "/run/dockle-agent.sock"


class AgentUnavailable(Exception):
    pass


def _call(cmd: str, timeout=20, **kwargs) -> dict:
    if config.MOCK_MODE:
        return _mock_call(cmd, **kwargs)
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(SOCKET_PATH)
    except OSError as exc:
        raise AgentUnavailable(
            "dockle-agent isn't reachable - not installed, or its socket "
            "isn't mounted into Dockle's container yet. See the runbook."
        ) from exc
    try:
        payload = {"cmd": cmd, **kwargs}
        s.sendall((json.dumps(payload) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        if not data:
            raise AgentUnavailable("dockle-agent closed the connection without responding")
        return json.loads(data.decode())
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentUnavailable(f"dockle-agent didn't respond properly: {exc}") from exc
    finally:
        s.close()


def is_available() -> bool:
    try:
        return bool(_call("ping", timeout=3).get("ok"))
    except AgentUnavailable:
        return False


def os_info() -> dict:
    return _call("os_info")


def os_update_check() -> dict:
    return _call("os_update_check", timeout=120)


def os_update_apply() -> dict:
    return _call("os_update_apply", timeout=1800)


def tailscale_status() -> dict:
    return _call("tailscale_status", timeout=15)


def tailscale_install() -> dict:
    return _call("tailscale_install", timeout=300)


def tailscale_serve(port: int, on: bool) -> dict:
    return _call("tailscale_serve", port=port, on=on)


def tailscale_serve_list() -> dict:
    return _call("tailscale_serve_list", timeout=15)


# -- mock support, for development without the agent installed ----------

def _mock_call(cmd: str, **kwargs) -> dict:
    if cmd == "ping":
        return {"ok": True, "version": "mock"}
    if cmd == "os_info":
        return {"ok": True, "id": "debian", "name": "Debian GNU/Linux 12 (mock)", "supported": True}
    if cmd == "os_update_check":
        return {"ok": True, "upgradable": 4, "packages": ["libc6/stable 2.36 amd64", "openssl/stable 3.0.11 amd64"]}
    if cmd == "os_update_apply":
        return {"ok": True, "message": "Host packages updated (mock).", "log": "(mock) 4 packages upgraded."}
    if cmd == "tailscale_status":
        return {"ok": True, "installed": True, "running": True,
                "dnsName": "homelab.mock-tailnet.ts.net", "backendState": "Running"}
    if cmd == "tailscale_install":
        return {"ok": True, "message": "Tailscale installed (mock)."}
    if cmd == "tailscale_serve":
        port, on = kwargs.get("port"), kwargs.get("on")
        if on and port not in _mock_call.served_ports:
            _mock_call.served_ports.append(port)
        elif not on and port in _mock_call.served_ports:
            _mock_call.served_ports.remove(port)
        return {"ok": True, "message": f"Serve {'enabled' if on else 'disabled'} for port {port} (mock)."}
    if cmd == "tailscale_serve_list":
        return {"ok": True, "installed": True, "ports": list(_mock_call.served_ports)}
    return {"ok": False, "error": "Unknown command"}


_mock_call.served_ports = []
