"""Stack management: every folder in the stacks directory containing a
compose file is a stack, exactly as Dockge treats them. API + streaming
actions live here.
"""

import re
import shutil
import socket
from pathlib import Path

import yaml
from flask import Blueprint, Response, jsonify, request

from . import activity, composeconv, composegen, config, runtime

bp = Blueprint("stacks", __name__, url_prefix="/api")

NAME_RE = re.compile(config.STACK_NAME_RE)


def stack_dir(name):
    if not NAME_RE.match(name or ""):
        raise ValueError("Stack names are lowercase letters, numbers, - and _ only")
    d = (config.STACKS_DIR / name).resolve()
    if d.parent != config.STACKS_DIR.resolve():
        raise ValueError("Invalid stack name")
    return d


def compose_path(name):
    d = stack_dir(name)
    for fname in config.COMPOSE_FILENAMES:
        p = d / fname
        if p.exists():
            return p
    return d / "compose.yaml"


def list_stacks():
    rt = runtime.current()
    containers = []
    engine_error = None
    try:
        containers = rt.ps()
    except runtime.RuntimeError_ as exc:
        engine_error = str(exc)

    by_project: dict[str, list] = {}
    for c in containers:
        if c["project"]:
            by_project.setdefault(c["project"], []).append(c)

    stacks = {}
    if config.STACKS_DIR.exists():
        for d in sorted(config.STACKS_DIR.iterdir()):
            if d.is_dir() and any((d / f).exists() for f in config.COMPOSE_FILENAMES):
                stacks[d.name] = {"name": d.name, "managed": True, "containers": []}
    for project, cs in by_project.items():
        entry = stacks.setdefault(project, {"name": project, "managed": False, "containers": []})
        entry["containers"] = cs

    for s in stacks.values():
        states = {c["state"] for c in s["containers"]}
        if not s["containers"]:
            s["status"] = "inactive"
        elif states == {"running"}:
            s["status"] = "running"
        elif "running" in states:
            s["status"] = "partial"
        else:
            s["status"] = "stopped"
    return sorted(stacks.values(), key=lambda s: s["name"]), engine_error


def validate_compose(text):
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return f"YAML problem: {exc}"
    if not isinstance(doc, dict) or not isinstance(doc.get("services"), dict) or not doc["services"]:
        return "A compose file needs a 'services:' section with at least one service"
    return None


# -- API ----------------------------------------------------------------


@bp.get("/stacks")
def api_list():
    from . import updatecheck
    result, engine_error = list_stacks()
    flags = updatecheck.get_flags()
    for s in result:
        s["updateAvailable"] = flags.get(s["name"], False)
    rt = runtime.current()
    return jsonify({"stacks": result, "engine": rt.ping(), "engineError": engine_error})


@bp.get("/stacks/<name>")
def api_get(name):
    d = stack_dir(name)
    cp = compose_path(name)
    envp = d / ".env"
    stacks, _ = list_stacks()
    match = next((s for s in stacks if s["name"] == name), None)
    return jsonify({
        "name": name,
        "exists": d.exists(),
        "managed": cp.exists(),
        "compose": cp.read_text() if cp.exists() else "",
        "composeFile": cp.name,
        "env": envp.read_text() if envp.exists() else "",
        "status": (match or {}).get("status", "inactive"),
        "containers": (match or {}).get("containers", []),
    })


@bp.post("/stacks")
def api_create():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    compose_text = data.get("compose") or ""
    try:
        d = stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if any((d / f).exists() for f in config.COMPOSE_FILENAMES):
        return jsonify({"error": f"A stack called '{name}' already exists"}), 409
    problem = validate_compose(compose_text)
    if problem:
        return jsonify({"error": problem}), 400
    d.mkdir(parents=True, exist_ok=True)
    (d / "compose.yaml").write_text(compose_text)
    if data.get("env"):
        (d / ".env").write_text(data["env"])
    activity.log("info", "stack", f"Created stack '{name}'")
    return jsonify({"ok": True, "name": name})


@bp.put("/stacks/<name>")
def api_save(name):
    data = request.get_json(force=True)
    try:
        d = stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not d.exists():
        return jsonify({"error": "Stack not found"}), 404
    if "compose" in data:
        problem = validate_compose(data["compose"])
        if problem:
            return jsonify({"error": problem}), 400
        compose_path(name).write_text(data["compose"])
    if "env" in data:
        envp = d / ".env"
        if data["env"]:
            envp.write_text(data["env"])
        elif envp.exists():
            envp.unlink()
    activity.log("info", "stack", f"Saved changes to '{name}'")
    return jsonify({"ok": True})


@bp.post("/stacks/<name>/action/<action>")
def api_action(name, action):
    if action not in ("up", "down", "stop", "start", "restart", "update", "delete"):
        return jsonify({"error": "Unknown action"}), 400
    try:
        d = stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not d.exists() and action != "delete":
        return jsonify({"error": f"'{name}' hasn't been adopted into the stacks folder yet"}), 404
    rt = runtime.current()

    def generate():
        ok = True
        try:
            if action == "update":
                for line in rt.compose_stream(str(d), name, "pull"):
                    if line.startswith("[dockle-exit:"):
                        ok = ok and line == "[dockle-exit:0]"
                    else:
                        yield line + "\n"
                for line in rt.compose_stream(str(d), name, "up"):
                    if line.startswith("[dockle-exit:"):
                        ok = ok and line == "[dockle-exit:0]"
                    else:
                        yield line + "\n"
            elif action == "delete":
                if d.exists():
                    for line in rt.compose_stream(str(d), name, "down"):
                        if line.startswith("[dockle-exit:"):
                            ok = line == "[dockle-exit:0]"
                        else:
                            yield line + "\n"
                    shutil.rmtree(d)
                    yield f"Removed {d}\n"
            else:
                for line in rt.compose_stream(str(d), name, action):
                    if line.startswith("[dockle-exit:"):
                        ok = line == "[dockle-exit:0]"
                    else:
                        yield line + "\n"
        except runtime.RuntimeError_ as exc:
            ok = False
            yield f"ERROR: {exc}\n"
        if ok:
            activity.log("info", "stack", f"{action.capitalize()} completed on '{name}'")
            yield "[dockle-done:ok]\n"
        else:
            activity.log("error", "stack", f"{action.capitalize()} FAILED on '{name}'",
                         "Open the stack's output panel for the full error text.")
            yield "[dockle-done:error]\n"

    return Response(generate(), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


@bp.get("/discover")
def api_discover():
    """What's running on this system that Dockle doesn't manage yet?"""
    projects, standalone, error = discover()
    if error:
        return jsonify({"error": error}), 502
    return jsonify({"projects": projects, "standalone": standalone})


def discover():
    """Everything running that Dockle doesn't manage yet, minus anything
    under an excluded path (another tool's territory - see settingsvc
    adopt.exclude_paths). Returns (projects, standalone, error)."""
    from . import settingsvc
    rt = runtime.current()
    try:
        containers = rt.ps()
    except runtime.RuntimeError_ as exc:
        return [], [], str(exc)
    managed = {d.name for d in config.STACKS_DIR.iterdir()
               if d.is_dir() and any((d / f).exists() for f in config.COMPOSE_FILENAMES)} \
        if config.STACKS_DIR.exists() else set()

    # the project Dockle itself belongs to shouldn't offer to adopt itself
    own_id = socket.gethostname()[:12]
    own_project = next((c["project"] for c in containers if c["id"] == own_id), None)

    exclude = [p.strip() for p in (settingsvc.get("adopt.exclude_paths") or "").split(",") if p.strip()]

    projects: dict[str, dict] = {}
    standalone = []
    for c in containers:
        if c["project"]:
            if c["project"] in managed or c["project"] == own_project:
                continue
            working_dir = c.get("workingDir", "")
            if any(working_dir.startswith(prefix) for prefix in exclude):
                continue
            entry = projects.setdefault(c["project"], {
                "name": c["project"],
                "workingDir": working_dir,
                "configFiles": c.get("configFiles", ""),
                "containers": [],
            })
            entry["containers"].append(c["name"])
        else:
            standalone.append({"name": c["name"], "image": c["image"], "state": c["state"]})
    for p in projects.values():
        cf = (p["configFiles"] or "").split(",")[0]
        p["fileReadable"] = bool(cf) and Path(cf).is_file()
    return list(projects.values()), standalone, None


def _adopt_one(kind, name, workingDir="", configFiles=""):
    """Core of adopting a single project or standalone container. Returns
    (result_dict, error_message) - exactly one is set."""
    rt = runtime.current()
    try:
        if kind == "project":
            target = stack_dir(_safe_project(name))
        else:
            target = stack_dir(composegen._safe(name).lower())
    except ValueError as exc:
        return None, str(exc)
    if any((target / f).exists() for f in config.COMPOSE_FILENAMES):
        return None, f"'{target.name}' already exists in the stacks folder"

    try:
        if kind == "project":
            config_file = (configFiles or "").split(",")[0]
            if config_file and Path(config_file).is_file():
                text = Path(config_file).read_text()
                text = composegen.rewrite_relative_binds(text, workingDir or str(Path(config_file).parent))
                note = "Adopted from its original compose file"
                env_src = Path(config_file).parent / ".env"
            else:
                containers = [c["name"] for c in rt.ps() if c["project"] == name]
                text = composegen.containers_to_compose(rt.inspect(containers))
                note = "Original file wasn't readable - rebuilt from the running containers"
                env_src = None
        elif kind == "container":
            text = composegen.containers_to_compose(rt.inspect([name]))
            note = "Rebuilt from the running container"
            env_src = None
        else:
            return None, "Unknown adopt type"
    except runtime.RuntimeError_ as exc:
        activity.log("error", "adopt", f"Adopting '{name}' FAILED", str(exc))
        return None, str(exc)

    problem = validate_compose(text)
    if problem:
        activity.log("error", "adopt", f"Adopting '{name}' FAILED", problem)
        return None, f"The rebuilt compose file didn't validate: {problem}"
    target.mkdir(parents=True, exist_ok=True)
    (target / "compose.yaml").write_text(text)
    if env_src and env_src.is_file():
        (target / ".env").write_text(env_src.read_text())
    activity.log("info", "adopt", f"Adopted '{name}' into stacks/{target.name}", note)
    return {"ok": True, "name": target.name, "note": note}, None


@bp.post("/adopt")
def api_adopt():
    """Bring an existing compose project or standalone container under
    Dockle's wing: its compose file lands in the stacks folder."""
    data = request.get_json(force=True)
    result, error = _adopt_one(
        data.get("kind"), (data.get("name") or "").strip(),
        data.get("workingDir", ""), data.get("configFiles", ""),
    )
    if error:
        return jsonify({"error": error}), 400 if "already exists" in error or "Unknown" in error else 502
    return jsonify(result)


@bp.post("/adopt/all")
def api_adopt_all():
    """Adopt everything currently discoverable in one pass. Running two
    Docker managers pointed at the same containers can fight over the same
    files, so this only ever touches things nothing else is already
    managing (see adopt.exclude_paths in Settings)."""
    projects, standalone, error = discover()
    if error:
        return jsonify({"error": error}), 502
    results = []
    for p in projects:
        result, err = _adopt_one("project", p["name"], p.get("workingDir", ""), p.get("configFiles", ""))
        results.append({"name": p["name"], "ok": result is not None, "message": err or result["note"]})
    for c in standalone:
        result, err = _adopt_one("container", c["name"])
        results.append({"name": c["name"], "ok": result is not None, "message": err or result["note"]})
    ok_count = sum(1 for r in results if r["ok"])
    activity.log("info", "adopt", f"Bulk adopt: {ok_count}/{len(results)} succeeded")
    return jsonify({"results": results, "adopted": ok_count, "total": len(results)})


def _safe_project(name):
    cleaned = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.lower()).strip("-")
    return cleaned or "adopted"


@bp.post("/convert")
def api_convert():
    data = request.get_json(force=True)
    try:
        return jsonify({"compose": composeconv.docker_run_to_compose(data.get("command", ""))})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@bp.post("/validate")
def api_validate():
    data = request.get_json(force=True)
    problem = validate_compose(data.get("compose", ""))
    return jsonify({"ok": problem is None, "error": problem})
