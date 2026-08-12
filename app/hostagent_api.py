"""API for the optional dockle-agent host service: host OS update
checks/apply, and Tailscale Serve status/install/toggle. Everything
here degrades to a plain "not available" if the agent isn't installed -
see agent/install.sh and the runbook.
"""

import yaml
from flask import Blueprint, jsonify, request

from . import activity, hostagent, stacks

bp = Blueprint("hostagent_api", __name__, url_prefix="/api/hostagent")


@bp.get("/status")
def api_status():
    if not hostagent.is_available():
        return jsonify({"available": False})
    try:
        os_info = hostagent.os_info()
        ts = hostagent.tailscale_status()
    except hostagent.AgentUnavailable as exc:
        return jsonify({"available": False, "error": str(exc)})
    return jsonify({"available": True, "os": os_info, "tailscale": ts})


@bp.post("/os-update-check")
def api_os_update_check():
    try:
        result = hostagent.os_update_check()
    except hostagent.AgentUnavailable as exc:
        return jsonify({"error": str(exc)}), 502
    if not result.get("ok"):
        return jsonify({"error": result.get("error", "Check failed")}), 400
    return jsonify(result)


@bp.post("/os-update-apply")
def api_os_update_apply():
    try:
        result = hostagent.os_update_apply()
    except hostagent.AgentUnavailable as exc:
        return jsonify({"error": str(exc)}), 502
    if not result.get("ok"):
        activity.log("error", "host-update", "Host OS update failed", result.get("error", ""))
        return jsonify({"error": result.get("error", "Update failed")}), 400
    activity.log("info", "host-update", "Host OS packages updated")
    return jsonify(result)


@bp.post("/tailscale/install")
def api_tailscale_install():
    try:
        result = hostagent.tailscale_install()
    except hostagent.AgentUnavailable as exc:
        return jsonify({"error": str(exc)}), 502
    if not result.get("ok"):
        return jsonify({"error": result.get("error", "Install failed")}), 400
    activity.log("info", "tailscale", "Tailscale installed on the host")
    return jsonify(result)


def _published_ports(compose_text: str) -> list:
    """Host-side ports this stack publishes, straight off its own
    `ports:` list - what Tailscale Serve would actually front."""
    try:
        doc = yaml.safe_load(compose_text) or {}
    except yaml.YAMLError:
        return []
    if not isinstance(doc, dict):
        return []
    ports, seen = [], set()
    for svc in (doc.get("services") or {}).values():
        if not isinstance(svc, dict):
            continue
        for p in svc.get("ports") or []:
            host_port = None
            if isinstance(p, dict):
                host_port = p.get("published")
            elif isinstance(p, (str, int)):
                left = str(p).split("/")[0].split(":")
                # "80" (no colon) publishes on the same port as target;
                # "8080:80" or "127.0.0.1:8080:80" - host port is the
                # second-to-last segment.
                host_port = left[-2] if len(left) > 1 else left[0]
            try:
                port = int(host_port)
            except (TypeError, ValueError):
                continue
            if port not in seen:
                seen.add(port)
                ports.append(port)
    return ports


@bp.get("/stacks/<name>/serve")
def api_stack_serve_status(name):
    try:
        cp = stacks.compose_path(name)
        compose_text = cp.read_text() if cp.exists() else ""
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    ports = _published_ports(compose_text)
    if not hostagent.is_available():
        return jsonify({"available": False, "ports": ports, "served": []})
    try:
        served = hostagent.tailscale_serve_list()
    except hostagent.AgentUnavailable:
        return jsonify({"available": False, "ports": ports, "served": []})
    return jsonify({"available": True, "ports": ports, "served": served.get("ports", [])})


@bp.post("/stacks/<name>/serve")
def api_stack_serve_toggle(name):
    data = request.get_json(force=True)
    port = data.get("port")
    on = bool(data.get("on"))
    if not isinstance(port, int) or not (1 <= port <= 65535):
        return jsonify({"error": "Invalid port"}), 400
    try:
        result = hostagent.tailscale_serve(port, on)
    except hostagent.AgentUnavailable as exc:
        return jsonify({"error": str(exc)}), 502
    if not result.get("ok"):
        return jsonify({"error": result.get("error", "Failed")}), 400
    activity.log("info", "tailscale", f"Serve {'enabled' if on else 'disabled'} for '{name}' port {port}")
    return jsonify(result)
