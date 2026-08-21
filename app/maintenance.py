"""Maintenance: disk usage and pruning - each type separately or all at
once. Volume pruning always shows exactly what will be deleted first.
Also updating Dockle itself, the one stack its own Update button can't
apply (see runtime.self_update_stream for why).
"""

import re
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


@bp.get("/self-update/check")
def api_self_update_check():
    """Is there a newer Dockle to move to? Answerable only for a git
    checkout; anything else reports plainly that it can't tell, rather
    than guessing."""
    compose_dir = _dockle_compose_dir()
    if not compose_dir:
        return jsonify({"error": "DOCKLE_DATA_HOST_PATH isn't set, so Dockle doesn't know its own "
                                 "real path on the host - see the runbook to set it in compose.yaml."}), 400
    try:
        return jsonify(runtime.current().self_update_check(compose_dir))
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502


@bp.post("/self-update")
def api_self_update():
    """Update Dockle in place: newer source, newer images, rebuild,
    recreate. The last step replaces the container serving this very
    request, so the stream ends abruptly right after
    "[dockle-restarting]" - the browser waits for /health to answer
    again rather than treating the dropped connection as a failure."""
    compose_dir = _dockle_compose_dir()
    if not compose_dir:
        return jsonify({"error": "DOCKLE_DATA_HOST_PATH isn't set, so Dockle doesn't know its own "
                                 "real path on the host - see the runbook to set it in compose.yaml."}), 400
    rt = runtime.current()
    activity.log("info", "dockle-update", "Dockle self-update started")

    def generate():
        ok = True
        restarting = False
        try:
            for line in rt.self_update_stream(compose_dir):
                if line.startswith("[dockle-exit:"):
                    ok = line == "[dockle-exit:0]"
                    continue
                yield line + "\n"
                # Compose says "Container dockle  Recreate/Recreating"
                # just before it replaces the container this request is
                # being served from - so everything after this point can
                # be cut off mid-word. Tell the browser once, so it waits
                # for Dockle to come back instead of reporting the
                # dropped connection as a failure.
                if not restarting and "recreat" in line.lower():
                    restarting = True
                    yield "[dockle-restarting]\n"
        except runtime.RuntimeError_ as exc:
            ok = False
            yield f"ERROR: {exc}\n"
        except Exception as exc:
            ok = False
            yield f"ERROR: unexpected {type(exc).__name__}: {exc}\n"
        if ok:
            activity.log("info", "dockle-update", "Dockle self-update finished")
            yield "[dockle-done:ok]\n"
        else:
            activity.log("error", "dockle-update", "Dockle self-update FAILED",
                         "Open Settings and read the update output panel for the full text.")
            yield "[dockle-done:error]\n"

    # stream_with_context for the same reason as every other streaming
    # action here: the generator outlives the request otherwise, and
    # activity.log() then throws well after the response has started.
    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# -- Dockle as a stack of its own -----------------------------------------
# Dockle is an ordinary container started by an ordinary compose file, and
# the dashboard shows it as an ordinary card. The only thing that isn't
# ordinary is how its actions run: every one of them goes through a helper
# container (runtime.self_compose_stream), because a command that stops or
# replaces Dockle's own container would otherwise kill the process running
# it halfway through.

SELF_ACTIONS = {
    "up": ["up", "-d"],
    "start": ["start"],
    "stop": ["stop"],
    "restart": ["restart"],
    "redeploy": ["up", "-d", "--force-recreate"],
    "down": ["down"],
    # --rmi all: compose.yaml gives the image a tag of its own
    # (dockle:latest), which --rmi local deliberately leaves alone.
    "delete": ["down", "--rmi", "all"],
}

_PORT_RE = re.compile(r":(\d+)->")


def _self_stack():
    """Dockle's own container(s), shaped like any other stack entry so the
    dashboard can render one card for everything."""
    rt = runtime.current()
    try:
        containers = rt.ps()
    except runtime.RuntimeError_ as exc:
        return {"available": False, "error": str(exc)}

    from . import stacks
    project = stacks.own_compose_project(containers)
    if not project:
        # Not running under Docker at all (a bare `python run.py`), or the
        # container was started without compose - either way there's no
        # compose project to act on, so no card rather than a broken one.
        return {"available": False, "error": "Dockle isn't running as a compose project on this host."}

    mine = [c for c in containers if (c["project"] or c["name"]) == project]
    states = {c["state"] for c in mine}
    if not mine:
        status = "inactive"
    elif states == {"running"}:
        status = "running"
    elif "running" in states:
        status = "partial"
    else:
        status = "stopped"

    ports = sorted({int(p) for c in mine for p in _PORT_RE.findall(c.get("ports") or "")})
    return {
        "available": True,
        "name": project,
        "status": status,
        "containers": mine,
        "ports": ports,
        "dir": _dockle_compose_dir(),
        # Without its own host path Dockle can't act on itself at all -
        # the card still shows, the buttons explain why they can't.
        "canAct": bool(_dockle_compose_dir()),
    }


@bp.get("/self")
def api_self():
    return jsonify(_self_stack())


@bp.post("/self/action/<action>")
def api_self_action(action):
    if action not in SELF_ACTIONS and action != "update":
        return jsonify({"error": "Unknown action"}), 400
    compose_dir = _dockle_compose_dir()
    if not compose_dir:
        return jsonify({"error": "DOCKLE_DATA_HOST_PATH isn't set, so Dockle doesn't know its own "
                                 "real path on the host - see the runbook to set it in compose.yaml."}), 400
    delete_data = action == "delete" and request.args.get("deleteData") == "1"
    rt = runtime.current()
    activity.log("warning" if action in ("down", "delete") else "info", "dockle",
                 f"{action.capitalize()} requested on Dockle itself")
    # Update is the one action that isn't a plain compose command: it
    # pulls newer source and rebuilds first (see self_update_stream).
    steps = (rt.self_update_stream(compose_dir) if action == "update"
             else rt.self_compose_stream(compose_dir, SELF_ACTIONS[action]))

    def generate():
        ok = True
        stopping = action in ("stop", "down", "delete", "restart", "redeploy", "update")
        warned = False
        try:
            for line in steps:
                if line.startswith("[dockle-exit:"):
                    ok = line == "[dockle-exit:0]"
                    continue
                yield line + "\n"
                if stopping and not warned and ("recreat" in line.lower() or "stopp" in line.lower()
                                                 or "remov" in line.lower()):
                    warned = True
                    yield "[dockle-restarting]\n"
            if ok and delete_data:
                # Dockle's own folder, compose file, database and all -
                # the deliberate opt-in half of a delete, matching what
                # the same checkbox does for any other stack.
                d = Path(compose_dir)
                yield f"Deleting Dockle's own folder {d}...\n"
                rt.force_remove_dir(str(d.parent), d.name)
                yield "Deleted.\n"
        except runtime.RuntimeError_ as exc:
            ok = False
            yield f"ERROR: {exc}\n"
        except Exception as exc:
            ok = False
            yield f"ERROR: unexpected {type(exc).__name__}: {exc}\n"
        if ok:
            activity.log("info", "dockle", f"{action.capitalize()} completed on Dockle itself")
            yield "[dockle-done:ok]\n"
        else:
            activity.log("error", "dockle", f"{action.capitalize()} FAILED on Dockle itself")
            yield "[dockle-done:error]\n"

    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
