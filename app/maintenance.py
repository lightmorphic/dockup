"""Maintenance: disk usage and pruning - each type separately or all at
once. Volume pruning always shows exactly what will be deleted first.
Also updating Dockle itself via the top-bar widget's download/restart
endpoints: download is a plain pull of the published image, restart
recreates the container from it - see runtime.self_pull_stream /
self_update_apply_stream.
"""

import math
import re
import socket
import threading
import time
import urllib.request
from pathlib import Path

import yaml
from flask import Blueprint, Response, jsonify, request, stream_with_context

from . import activity, config, envsub, runtime

bp = Blueprint("maintenance", __name__, url_prefix="/api/system")

SAFE_ORDER = ["containers", "images", "networks", "buildcache", "volumes"]


@bp.get("/df")
def disk_usage():
    try:
        return jsonify({"usage": runtime.current().disk_usage()})
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502


def _declared_volumes() -> dict[str, str]:
    """Full docker volume name -> the managed stack that declares it in its
    compose file. Compose prefixes named volumes with the project name unless
    the volume sets an explicit `name:` or is `external`."""
    from . import stacks, stackbackup

    owners: dict[str, str] = {}
    if not config.STACKS_DIR.exists():
        return owners
    for d in sorted(config.STACKS_DIR.iterdir()):
        if d.name.startswith(".") or not d.is_dir():
            continue
        cp = next((d / f for f in config.COMPOSE_FILENAMES if (d / f).exists()), None)
        if cp is None:
            continue
        compose_text = cp.read_text()
        envp = d / ".env"
        env_text = envp.read_text() if envp.exists() else ""
        env = envsub.parse_env(env_text)
        try:
            doc = yaml.safe_load(compose_text) or {}
        except yaml.YAMLError:
            doc = {}
        top = doc.get("volumes") if isinstance(doc, dict) else None
        top = top if isinstance(top, dict) else {}
        project = stacks._safe_project(d.name)
        for m in stackbackup._parse_mounts(compose_text, env_text):
            if m["type"] != "volume":
                continue
            short = m["source"]
            spec = top.get(short)
            if isinstance(spec, dict) and spec.get("name"):
                full = envsub.substitute(str(spec["name"]), env)
            elif isinstance(spec, dict) and spec.get("external"):
                full = short
            else:
                full = f"{project}_{short}"
            owners[full] = d.name
    return owners


def _known_projects() -> dict[str, str]:
    """Compose project name -> stack name, for every stack Dockle can see."""
    from . import stacks

    out = {}
    try:
        listed, _ = stacks.list_stacks()
    except Exception:
        return out
    for s in listed:
        out[stacks._safe_project(s["name"])] = s["name"]
        out[s["name"]] = s["name"]
    return out


def _flatten(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def _classify(name: str, declared: dict[str, str], projects: dict[str, str]) -> dict:
    """Say whose data a volume is, so the confirmation step is a decision and
    not a guess. Errs toward claiming an owner: a volume wrongly called
    orphaned is the one mistake that loses data."""
    stack = declared.get(name)
    if stack:
        return {"verdict": "in-use", "stack": stack,
                "note": f"belongs to stack “{stack}”, which isn't running - "
                        f"this is its live data, not leftovers"}
    # Compare with separators stripped: compose drops them from project names,
    # so uptimekuma owns uptime-kuma_data. Longest match wins.
    flat = _flatten(name)
    for project in sorted(projects, key=len, reverse=True):
        if project and flat.startswith(_flatten(project)):
            return {"verdict": "superseded", "stack": projects[project],
                    "note": f"left over from stack “{projects[project]}”, "
                            f"which no longer uses it"}
    return {"verdict": "orphaned", "stack": "",
            "note": "no stack on this host claims it"}


@bp.get("/prune/volumes/preview")
def volume_preview():
    try:
        vols = runtime.current().dangling_volumes()
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502
    declared, projects = _declared_volumes(), _known_projects()
    return jsonify({"volumes": [v | _classify(v["name"], declared, projects) for v in vols]})


@bp.post("/prune")
def prune():
    targets = request.get_json(force=True).get("targets", [])
    unknown = [t for t in targets if t not in runtime.PRUNE_TARGETS]
    if unknown or not targets:
        return jsonify({"error": "Pick at least one valid thing to prune"}), 400
    rt = runtime.current()
    results = {}
    ok = True
    for target in [t for t in SAFE_ORDER if t in targets]:
        try:
            results[target] = {"ok": True, "message": rt.prune(target)}
            activity.log("info", "prune", f"Pruned {target}: {results[target]['message']}")
        except runtime.RuntimeError_ as exc:
            ok = False
            results[target] = {"ok": False, "message": str(exc)}
            activity.log("error", "prune", f"Prune of {target} FAILED", str(exc))
    return jsonify({"ok": ok, "results": results})


# -- updating Dockle itself -----------------------------------------------


def _dockle_compose_dir():
    """Dockle's own folder as the HOST sees it. compose.yaml lives one
    level up from the data dir it mounts as ./data - true by construction
    for every install this project documents, and the same derivation the
    companion installer already relies on."""
    if config.MOCK_MODE:
        return "/opt/dockle"
    if not config.DATA_HOST_PATH:
        return None
    return str(Path(config.DATA_HOST_PATH).parent)


_VERSION_LINE_RE = re.compile(r'VERSION = "([0-9][0-9.]*)"')


def _fetch_remote_version() -> str:
    """The newest published version, read from the VERSION line of
    app/config.py on main - the same single line CI reads to tag the
    image, so the two can't disagree. Raises on any failure; callers
    decide what a failed check should look like."""
    if config.MOCK_MODE:
        return runtime.current().remote_version()
    req = urllib.request.Request(config.UPDATE_VERSION_URL,
                                 headers={"User-Agent": f"dockle/{config.VERSION}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        text = resp.read(65536).decode("utf-8", "replace")
    m = _VERSION_LINE_RE.search(text)
    if not m:
        raise RuntimeError("No VERSION line found at the update URL")
    return m.group(1)


@bp.get("/self-update/check")
def api_self_update_check():
    """Is there a newer Dockle published? One HTTPS request, no git, no
    helper container - works identically for every install style."""
    try:
        latest = _fetch_remote_version()
    except Exception as exc:
        note_self_check({"latest": None, "error": str(exc)})
        return jsonify({"current": config.VERSION, "latest": None, "error": str(exc)}), 502
    note_self_check({"latest": latest, "error": None})
    return jsonify({"current": config.VERSION, "latest": latest})


# The top-bar update widget's two-step flow (see the update-widget
# skill): download pulls the published image without touching the
# running container - Dockle stays up throughout, and a browser can walk
# away mid-pull; restart is the short, separate step that actually
# replaces it. "Ready to restart" isn't remembered in a flag anywhere:
# it's computed from the daemon's own state (is the pulled image newer
# than the one running?), so it survives page reloads, Dockle restarts,
# and even a `docker compose pull` done entirely outside Dockle.


def _progress_fraction(lines_seen: int) -> float:
    """A pull has no fixed, predictable line count - layer count and
    sizes vary per release - so this doesn't try to track "layer 3 of
    9". Instead each real line of pull output nudges an asymptotic curve
    that climbs fast at first and slows near the end, capped below 1.0
    until the process has actually exited 0. Approximate, not exact, but
    genuinely driven by real Docker output rather than a fake clock."""
    return min(0.95, 1 - math.exp(-0.12 * lines_seen))


@bp.post("/self-update/download")
def api_self_update_download():
    """Pull the published image - see runtime.self_pull_stream. Only
    progress fractions are streamed to the client; the widget has no
    text log by design (see the update-widget skill), the real pull
    output still goes to Activity on failure for anyone who wants it."""
    rt = runtime.current()
    activity.log("info", "dockle-update", f"Pulling {config.UPDATE_IMAGE}")

    def generate():
        ok = True
        lines, seen = [], 0
        try:
            for line in rt.self_pull_stream(config.UPDATE_IMAGE):
                if line.startswith("[dockle-exit:"):
                    ok = line == "[dockle-exit:0]"
                    continue
                lines.append(line)
                seen += 1
                yield f"[dockle-progress:{_progress_fraction(seen):.3f}]\n"
        except runtime.RuntimeError_ as exc:
            ok = False
            lines.append(f"ERROR: {exc}")
        except Exception as exc:
            ok = False
            lines.append(f"ERROR: unexpected {type(exc).__name__}: {exc}")
        if ok:
            activity.log("info", "dockle-update", "Dockle update downloaded - ready to restart")
            yield "[dockle-progress:1.000]\n[dockle-done:ok]\n"
        else:
            activity.log("error", "dockle-update", "Dockle update download FAILED", "\n".join(lines[-40:]))
            yield "[dockle-done:error]\n"

    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


@bp.post("/self-update/restart")
def api_self_update_restart():
    """Recreate Dockle's container from the image /self-update/download
    already built. Replaces the container serving this very request, so
    the stream ends abruptly right after "[dockle-restarting]" - the
    browser waits for /health to answer again rather than treating the
    dropped connection as a failure."""
    compose_dir = _dockle_compose_dir()
    if not compose_dir:
        return jsonify({"error": "DOCKLE_DATA_HOST_PATH isn't set, so Dockle doesn't know its own "
                                 "real path on the host - see the runbook to set it in compose.yaml."}), 400
    rt = runtime.current()
    activity.log("info", "dockle-update", "Dockle restart-to-update started")

    def generate():
        ok = True
        restarting = False
        lines = []
        try:
            for line in rt.self_update_apply_stream(compose_dir):
                if line.startswith("[dockle-exit:"):
                    ok = line == "[dockle-exit:0]"
                    continue
                lines.append(line)
                if not restarting and "recreat" in line.lower():
                    restarting = True
                    yield "[dockle-restarting]\n"
        except runtime.RuntimeError_ as exc:
            ok = False
            lines.append(f"ERROR: {exc}")
        except Exception as exc:
            ok = False
            lines.append(f"ERROR: unexpected {type(exc).__name__}: {exc}")
        if ok:
            # In real life this generator usually dies with the replaced
            # container and a fresh process re-checks on its own; when it
            # does survive (mock mode, or compose deciding nothing needed
            # recreating), refresh the cached remote version so the dot
            # doesn't keep advertising the update just applied.
            _refresh_self_check()
            activity.log("info", "dockle-update", "Dockle restarted on the new version")
            yield "[dockle-done:ok]\n"
        else:
            activity.log("error", "dockle-update", "Dockle restart FAILED", "\n".join(lines[-40:]))
            yield "[dockle-done:error]\n"

    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# -- versions in the sidebar ----------------------------------------------
# The remote-version lookup is one HTTPS request, but still not something
# every page load should wait on (or hammer GitHub with) - so the answer
# is cached, served instantly however stale, and refreshed in the
# background when it ages out. The sidebar shows a tick or nothing; it
# never blocks on a check.

_SELF_CHECK_TTL = 6 * 60 * 60
_self_check = {"at": 0.0, "result": None}
_self_check_lock = threading.Lock()


def note_self_check(result: dict):
    """Remember a check someone else already paid for - the update dot's
    click-to-check refreshes this cache rather than racing it."""
    with _self_check_lock:
        _self_check["at"] = time.time()
        _self_check["result"] = result


def _refresh_self_check():
    try:
        note_self_check({"latest": _fetch_remote_version(), "error": None})
    except Exception as exc:
        # A failed check must never be worse than no check: the sidebar
        # simply shows the version without a tick.
        note_self_check({"latest": None, "error": str(exc)})


def _self_container_id() -> str:
    """Docker sets a container's hostname to its short id - the same
    fact the adopt list's self-exclusion already relies on."""
    return socket.gethostname()[:12]


@bp.get("/versions")
def api_versions():
    rt = runtime.current()
    try:
        engine = rt.ping()
    except runtime.RuntimeError_ as exc:
        engine = {"ok": False, "engine": "Docker", "version": "", "error": str(exc)}

    with _self_check_lock:
        cached, checked_at = _self_check["result"], _self_check["at"]
    if time.time() - checked_at > _SELF_CHECK_TTL:
        note_self_check(cached or {"latest": None, "error": None})  # claim the slot before the thread runs
        threading.Thread(target=_refresh_self_check, daemon=True).start()

    latest = cached.get("latest") if cached else None
    try:
        download_ready = rt.self_update_ready(_self_container_id(), config.UPDATE_IMAGE)
    except Exception:
        download_ready = False
    return jsonify({
        "dockle": {
            "version": config.VERSION,
            # None means "not known yet" - a tick is only ever shown for
            # a real, current answer.
            "latest": latest,
            "upToDate": (latest == config.VERSION) if latest else None,
            "checkedAt": checked_at or None,
            # A newer image already pulled, waiting only on the restart
            # click. Computed from the daemon's state, not remembered -
            # right after page reloads, Dockle restarts, or a pull done
            # entirely outside Dockle.
            "downloadReady": download_ready,
        },
        "docker": {
            "engine": engine.get("engine", "Docker"),
            "version": engine.get("version", ""),
            "ok": bool(engine.get("ok")),
            "error": engine.get("error", ""),
        },
    })
