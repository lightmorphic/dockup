"""Stack management: every folder in the stacks directory containing a
compose file is a stack, exactly as Dockge treats them. API + streaming
actions live here.
"""

import re
import shutil
import socket
import tarfile
import time
from pathlib import Path

import yaml
from flask import Blueprint, Response, jsonify, request, stream_with_context

from . import activity, composeconv, composegen, config, runtime

bp = Blueprint("stacks", __name__, url_prefix="/api")

NAME_RE = re.compile(config.STACK_NAME_RE)
ARCHIVE_DIR = config.STACKS_DIR / ".archived"


def stack_dir(name):
    if not NAME_RE.match(name or ""):
        raise ValueError("Stack names are lowercase letters, numbers, - and _ only")
    d = (config.STACKS_DIR / name).resolve()
    if d.parent != config.STACKS_DIR.resolve():
        raise ValueError("Invalid stack name")
    return d


def archived_stack_dir(name):
    if not NAME_RE.match(name or ""):
        raise ValueError("Stack names are lowercase letters, numbers, - and _ only")
    d = (ARCHIVE_DIR / name).resolve()
    if d.parent != ARCHIVE_DIR.resolve():
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
            if d.name.startswith("."):
                continue  # .archived and any other dotfile/dir aren't stacks
            if d.is_dir() and any((d / f).exists() for f in config.COMPOSE_FILENAMES):
                stacks[d.name] = {"name": d.name, "managed": True, "containers": []}
    for project, cs in by_project.items():
        entry = stacks.setdefault(project, {"name": project, "managed": False, "containers": []})
        entry["containers"] = cs

    for s in stacks.values():
        states = {c["state"] for c in s["containers"]}
        has_warning = any(
            c["state"] == "restarting" or (c["state"] == "running" and "unhealthy" in c.get("status", "").lower())
            for c in s["containers"]
        )
        if not s["containers"]:
            s["status"] = "inactive"
        elif has_warning and "running" in states:
            s["status"] = "warning"
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


_LIVE_PORT_RE = re.compile(r":(\d+)->")


def _declared_ports_by_stack(exclude=""):
    """port -> stack name, from every OTHER managed stack's own compose
    file. Checked even if that stack isn't currently running, since the
    whole point is to catch a collision before either side is deployed."""
    from . import hostcompanion
    result = {}
    if not config.STACKS_DIR.exists():
        return result
    for d in sorted(config.STACKS_DIR.iterdir()):
        if d.name.startswith(".") or d.name == exclude:
            continue
        if not d.is_dir() or not any((d / f).exists() for f in config.COMPOSE_FILENAMES):
            continue
        try:
            cp = compose_path(d.name)
            compose_text = cp.read_text() if cp.exists() else ""
            envp = d / ".env"
            env_text = envp.read_text() if envp.exists() else ""
            ports = hostcompanion.published_ports(compose_text, env_text)
        except OSError:
            continue
        for p in ports:
            result.setdefault(p, d.name)
    return result


def _live_bound_ports(exclude_names=frozenset()):
    """port -> container name, from every running container's actual
    port binding right now - catches anything Dockle doesn't manage
    (adopted elsewhere, started with a bare `docker run`) that a
    compose-file-only comparison would miss."""
    result = {}
    try:
        containers = runtime.current().ps()
    except runtime.RuntimeError_:
        return result
    for c in containers:
        if c["state"] != "running" or c["name"] in exclude_names:
            continue
        for m in _LIVE_PORT_RE.finditer(c.get("ports", "")):
            result.setdefault(int(m.group(1)), c["name"])
    return result


def check_port_conflicts(name, compose_text, env_text):
    """Ports this compose file would publish that collide with another
    managed stack's declared ports, or with any container's actual live
    binding right now. Returns [{"port": int, "with": str}, ...]."""
    from . import hostcompanion
    try:
        ports = hostcompanion.published_ports(compose_text, env_text)
    except Exception:
        return []
    if not ports:
        return []
    declared = _declared_ports_by_stack(exclude=name)
    own_containers = set()
    if name:
        try:
            own_containers = {c["name"] for c in runtime.current().ps() if c.get("project") == name}
        except runtime.RuntimeError_:
            pass
    live = _live_bound_ports(exclude_names=own_containers)
    conflicts = []
    for p in ports:
        source = declared.get(p) or live.get(p)
        if source and source != name:
            conflicts.append({"port": p, "with": source})
    return conflicts


# -- API ----------------------------------------------------------------


@bp.get("/stacks")
def api_list():
    from . import hostcompanion, updatecheck
    result, engine_error = list_stacks()
    flags = updatecheck.get_flags()

    # One companion round-trip for the whole list, not one per stack -
    # every card's "open web UI" link and served-port state comes from
    # this single check.
    served_ports, dns_name = [], ""
    try:
        if hostcompanion.is_available():
            served_ports = hostcompanion.tailscale_serve_list().get("ports", [])
            dns_name = hostcompanion.tailscale_status().get("dnsName", "")
    except hostcompanion.CompanionUnavailable:
        pass

    for s in result:
        s["updateAvailable"] = flags.get(s["name"], False)
        ports = []
        if s["managed"]:
            try:
                cp = compose_path(s["name"])
                compose_text = cp.read_text() if cp.exists() else ""
                envp = stack_dir(s["name"]) / ".env"
                env_text = envp.read_text() if envp.exists() else ""
                ports = hostcompanion.published_ports(compose_text, env_text)
            except (ValueError, OSError):
                pass
        s["ports"] = ports
        s["served"] = [p for p in ports if p in served_ports]

    rt = runtime.current()
    return jsonify({"stacks": result, "engine": rt.ping(), "engineError": engine_error, "dnsName": dns_name})


def _stack_data_paths(name):
    """Every bind mount and named volume this stack actually uses, for
    showing the user exactly what "also delete this stack's data" would
    remove - same mount parsing stackbackup already relies on, so the
    list here is guaranteed to match what a backup would have covered."""
    from . import stackbackup
    d = stack_dir(name)
    cp = compose_path(name)
    if not cp.exists():
        return []
    compose_text = cp.read_text()
    envp = d / ".env"
    env_text = envp.read_text() if envp.exists() else ""
    mounts = stackbackup._parse_mounts(compose_text, env_text)
    for m in mounts:
        if m["type"] == "bind":
            m["source"] = stackbackup._resolve_bind_source(m["source"], d)
    return mounts


@bp.get("/stacks/<name>")
def api_get(name):
    from . import updatecheck
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
        "updateAvailable": updatecheck.get_flags().get(name, False),
        "dataPaths": _stack_data_paths(name),
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


_STARTING_ACTIONS = {"up", "start", "restart", "update", "redeploy"}
_PORT_CONFLICT_RE = re.compile(r"bind host port (?:[\w.:]+:)?(\d+)/tcp: address already in use")


def _tailscale_pause_ports(name, d, available):
    """Before a stack binds its ports, pause any Tailscale Serve rule
    already holding one of them - the exact cause of "address already
    in use" when a stack is deleted and recreated while its old Serve
    mapping is still live (Tailscale's own listener keeps the port even
    though nothing is using it anymore). Returns the ports paused, to
    resume after; does nothing if the companion isn't installed."""
    if not available:
        return []
    from . import hostcompanion
    try:
        cp = compose_path(name)
        compose_text = cp.read_text() if cp.exists() else ""
        envp = d / ".env"
        env_text = envp.read_text() if envp.exists() else ""
        published = hostcompanion.published_ports(compose_text, env_text)
        served = hostcompanion.tailscale_serve_list().get("ports", [])
    except (hostcompanion.CompanionUnavailable, OSError):
        return []
    paused = []
    for port in published:
        if port not in served:
            continue
        try:
            hostcompanion.tailscale_serve(port, False)
            paused.append(port)
        except hostcompanion.CompanionUnavailable:
            pass
    return paused


def _tailscale_resume_ports(ports):
    if not ports:
        return
    from . import hostcompanion
    for port in ports:
        try:
            hostcompanion.tailscale_serve(port, True)
        except hostcompanion.CompanionUnavailable:
            pass


def _port_conflict_hint(line, available):
    """If this line is Docker's own port-bind-conflict error, translate
    it into a sentinel the frontend renders as a clear explanation
    instead of raw stderr. Fires even when the companion auto-paused
    Serve above - e.g. a second, unrelated process could hold the port -
    so it's a general safety net, not just a companion-missing fallback."""
    m = _PORT_CONFLICT_RE.search(line)
    if not m:
        return None
    return f"[dockle-hint:tailscale-port-conflict:{m.group(1)}:{1 if available else 0}]"


_NETWORK_LABEL_RE = re.compile(r"network (\S+) was found but has incorrect label com\.docker\.compose\.network")


def _fix_unlabeled_network(project: str, network_name: str) -> bool:
    """One-time repair for a network that predates Dockle managing this
    stack (or any docker-compose lifecycle ownership) - a real, common
    state for anything adopted from a previous manager. Labels can't be
    edited on an existing network, so the only fix is telling compose
    to treat it as external and just use it as-is, instead of trying
    to validate ownership it was never given."""
    cp = compose_path(project)
    if not cp.exists():
        return False
    text = cp.read_text()
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        return False
    if not isinstance(doc, dict):
        return False
    networks = doc.get("networks")
    if isinstance(networks, dict):
        # A networks: block already exists (composegen's own output, or a
        # user's) - if one of its entries already declares this exact
        # network by name but is missing external: true, that's this same
        # bug wearing a different hat (adopting a container whose network
        # predates it, same as the no-networks-block case below), so patch
        # it in place instead of blindly appending a second networks: key.
        # Anything else about the file - comments, key order, unrelated
        # entries - isn't something to guess at, so leave those alone.
        for key, val in networks.items():
            if isinstance(val, dict) and val.get("name") == network_name:
                if val.get("external"):
                    return False  # already external - a different failure
                val["external"] = True
                cp.write_text(yaml.safe_dump(doc, sort_keys=False, default_flow_style=False))
                return True
        return False  # networks: exists but none of it is this network
    key = network_name[len(project) + 1:] if network_name.startswith(project + "_") else network_name
    if not text.endswith("\n"):
        text += "\n"
    text += f"\nnetworks:\n  {key}:\n    name: {network_name}\n    external: true\n"
    cp.write_text(text)
    return True


@bp.post("/stacks/<name>/action/<action>")
def api_action(name, action):
    if action not in ("up", "down", "stop", "start", "restart", "update", "redeploy", "delete"):
        return jsonify({"error": "Unknown action"}), 400
    try:
        d = stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not d.exists() and action != "delete":
        return jsonify({"error": f"'{name}' hasn't been adopted into the stacks folder yet"}), 404
    rt = runtime.current()
    delete_data = action == "delete" and request.args.get("deleteData") == "1"

    def generate():
        ok = True
        from . import hostcompanion
        companion_available = (action in _STARTING_ACTIONS or action == "delete") and hostcompanion.is_available()
        paused_ports = []

        def run_compose(sub_action):
            nonlocal ok
            local_ok = [True]
            fix_network = None
            for line in rt.compose_stream(str(d), name, sub_action):
                if line.startswith("[dockle-exit:"):
                    local_ok[0] = line == "[dockle-exit:0]"
                else:
                    yield line + "\n"
                    m = _NETWORK_LABEL_RE.search(line)
                    if m:
                        fix_network = m.group(1)
                    hint = _port_conflict_hint(line, companion_available)
                    if hint:
                        yield hint + "\n"
            if not local_ok[0] and fix_network and _fix_unlabeled_network(name, fix_network):
                yield (f"Network '{fix_network}' predates Dockle managing this stack - declaring it "
                       f"external so compose reuses it instead of trying to own it, and retrying...\n")
                local_ok[0] = True
                for line in rt.compose_stream(str(d), name, sub_action):
                    if line.startswith("[dockle-exit:"):
                        local_ok[0] = line == "[dockle-exit:0]"
                    else:
                        yield line + "\n"
                        hint = _port_conflict_hint(line, companion_available)
                        if hint:
                            yield hint + "\n"
            ok = ok and local_ok[0]

        try:
            if action in _STARTING_ACTIONS:
                paused_ports = _tailscale_pause_ports(name, d, companion_available)
                if paused_ports:
                    yield (f"Pausing Tailscale Serve on port(s) {', '.join(map(str, paused_ports))} "
                           f"so this stack can bind them...\n")
            if action == "update":
                yield from run_compose("pull")
                yield from run_compose("up")
            elif action == "delete":
                if d.exists():
                    # Grab the compose text and data-mount list before the
                    # folder is gone - both the image purge and (if asked)
                    # the data wipe below need it.
                    cp = compose_path(name)
                    compose_text = cp.read_text() if cp.exists() else ""
                    envp = d / ".env"
                    env_text = envp.read_text() if envp.exists() else ""
                    mounts = _stack_data_paths(name) if delete_data else []

                    # Permanent, not a pause: a deleted stack's ports
                    # should stop being served, not just quiet down and
                    # come back - a stale Serve rule left running here is
                    # exactly what caused the "address already in use"
                    # failure this project chased down earlier.
                    cleared_ports = _tailscale_pause_ports(name, d, companion_available)
                    if cleared_ports:
                        yield (f"Turning off Tailscale Serve on port(s) {', '.join(map(str, cleared_ports))} "
                               f"- this stack is being deleted...\n")
                    # 45s cap: a container stuck because its bind-mount
                    # source vanished out from under it (deleted by
                    # hand while running, say) can hang a graceful
                    # `down` forever otherwise - a delete must always
                    # be able to finish, so a hang here falls back to
                    # forcefully removing the containers instead of
                    # leaving the stack stuck in Dockle for good.
                    hung = False
                    for line in rt.compose_stream(str(d), name, "down", timeout=45):
                        if line == "[dockle-timeout]":
                            hung = True
                        elif line.startswith("[dockle-exit:"):
                            ok = hung or line == "[dockle-exit:0]"
                        else:
                            yield line + "\n"
                    if hung:
                        yield ("`down` didn't finish within 45s - forcefully removing "
                               "the container(s) instead...\n")
                        try:
                            rt.force_remove_containers(name)
                            yield "Forced removal complete.\n"
                        except runtime.RuntimeError_ as exc:
                            yield f"Forced removal also failed: {exc}\n"

                    # Every trace of the container/image, unconditionally -
                    # unlike the data below, a cached image is never
                    # something worth keeping around after a deliberate
                    # delete, and re-pulling it later is cheap.
                    removed_images = _purge_images(compose_text, env_text)
                    if removed_images:
                        yield f"Removed image(s): {', '.join(removed_images)}\n"

                    if delete_data and mounts:
                        bind_parents = set()
                        for m in mounts:
                            # Best-effort: a problem wiping one mount
                            # (in use elsewhere, permission denied, a
                            # bug in the runtime backend) shouldn't
                            # abort the delete itself - the stack's
                            # config and containers are already gone
                            # regardless of what happens here.
                            try:
                                if m["type"] == "bind":
                                    src = Path(m["source"])
                                    rt.force_remove_dir(str(src.parent), src.name)
                                    bind_parents.add(src.parent)
                                else:
                                    rt.remove_volume(m["source"])
                                yield f"Deleted data: {m['source']}\n"
                            except Exception as exc:
                                yield f"Couldn't delete data '{m['source']}': {exc}\n"
                        # Clean up each mount's now-likely-empty parent
                        # too (e.g. /opt/<stack> once data/media/backup
                        # are gone) - rmdir only succeeds if it's
                        # genuinely empty, so this never touches
                        # anything not actually cleared above. Floored
                        # at 3 path parts ('/', 'opt', name) so this can
                        # never reach /opt itself even if something
                        # were misconfigured.
                        for parent in bind_parents:
                            if len(parent.parts) < 3:
                                continue
                            try:
                                rt.rmdir_if_empty(str(parent.parent), parent.name)
                            except Exception:
                                pass

                    try:
                        shutil.rmtree(d)
                    except OSError:
                        # A stack folder left root-owned by whatever
                        # managed it before Dockle (a real, hit case for
                        # anything adopted from a previous tool) can't be
                        # removed by Dockle's own non-root process -
                        # fall back to a throwaway root container, the
                        # same trick used for backup/restore.
                        rt.force_remove_dir(str(d.parent), d.name)
                    yield f"Removed {d}\n"
            else:
                yield from run_compose(action)
        except runtime.RuntimeError_ as exc:
            ok = False
            yield f"ERROR: {exc}\n"
        except Exception as exc:
            # A bug anywhere above this point (not a well-understood
            # RuntimeError_ from a docker command) would otherwise
            # crash the stream mid-flight with zero trace anywhere -
            # the client just sees the connection die ("network
            # error"), and since this always sat above the completion
            # logging below, nothing ever made it into Activity either.
            # Whatever this turns out to be, it must never be silent.
            ok = False
            yield f"ERROR: unexpected {type(exc).__name__}: {exc}\n"
            activity.log("error", "stack", f"{action.capitalize()} crashed unexpectedly on '{name}'",
                         f"{type(exc).__name__}: {exc}")
        finally:
            if paused_ports:
                yield f"Restoring Tailscale Serve on port(s) {', '.join(map(str, paused_ports))}...\n"
                _tailscale_resume_ports(paused_ports)
        if ok:
            if action == "update":
                from . import updatecheck
                updatecheck.clear_flag(name)
            activity.log("info", "stack", f"{action.capitalize()} completed on '{name}'")
            yield "[dockle-done:ok]\n"
        else:
            activity.log("error", "stack", f"{action.capitalize()} FAILED on '{name}'",
                         "Open the stack's output panel for the full error text.")
            yield "[dockle-done:error]\n"

    # stream_with_context: without it, Flask doesn't keep the request/app
    # context alive for the generator's whole lifetime - anything deep in
    # here that needs it (runtime.current() -> settingsvc.get() -> db.get(),
    # activity.log()) can then throw "Working outside of application
    # context" mid-stream, well after the response has already started -
    # the client just sees the connection die, and since that crash sits
    # above the completion logging, nothing reaches Activity either. This
    # was the real cause of a delete that streamed real progress lines
    # and then died with no trace.
    return Response(stream_with_context(generate()), mimetype="text/plain",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


def _purge_images(compose_text: str, env_text: str = "") -> list:
    """Best-effort: remove every image a compose file references. Used
    when a stack (already container-less) is being deleted for good -
    "nothing left of that" - never blocks on failure, since another
    stack might legitimately share the same image."""
    from . import envsub
    try:
        doc = yaml.safe_load(compose_text) or {}
    except yaml.YAMLError:
        return []
    if not isinstance(doc, dict):
        return []
    env = envsub.parse_env(env_text)
    images, seen = [], set()
    for svc in (doc.get("services") or {}).values():
        if not isinstance(svc, dict) or not svc.get("image"):
            continue
        image = envsub.substitute(str(svc["image"]), env)
        if image not in seen:
            seen.add(image)
            images.append(image)
    rt = runtime.current()
    removed = []
    for image in images:
        try:
            rt.remove_image(image)
            removed.append(image)
        except runtime.RuntimeError_:
            pass  # in use elsewhere, or already gone - fine either way
    return removed


@bp.post("/stacks/<name>/purge")
def api_purge(name):
    """Delete a container-less stack for good, straight from the main
    list (no need to archive first): folder, compose file, and every
    image it referenced - nothing left behind."""
    d = stack_dir(name)
    if not d.exists():
        return jsonify({"error": f"'{name}' doesn't exist"}), 404
    result, _ = list_stacks()
    match = next((s for s in result if s["name"] == name), None)
    if match and match["containers"]:
        return jsonify({"error": "This stack still has containers - stop and remove them first"}), 400
    cp = compose_path(name)
    compose_text = cp.read_text() if cp.exists() else ""
    envp = d / ".env"
    env_text = envp.read_text() if envp.exists() else ""
    removed_images = _purge_images(compose_text, env_text)
    try:
        shutil.rmtree(d)
    except OSError:
        rt = runtime.current()
        rt.force_remove_dir(str(d.parent), d.name)
    detail = f"Removed image(s): {', '.join(removed_images)}" if removed_images else ""
    activity.log("info", "stack", f"Purged '{name}'", detail)
    return jsonify({"ok": True, "removedImages": removed_images})


@bp.post("/stacks/<name>/archive")
def api_archive(name):
    """Archive a container-less stack: keep the folder (compose file,
    .env, anything else in it) but move it out of the main list, so it
    can come back later without re-typing the config from scratch."""
    d = stack_dir(name)
    if not d.exists():
        return jsonify({"error": f"'{name}' doesn't exist"}), 404
    result, _ = list_stacks()
    match = next((s for s in result if s["name"] == name), None)
    if match and match["containers"]:
        return jsonify({"error": "This stack still has containers - stop and remove them first"}), 400
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    dest = archived_stack_dir(name)
    if dest.exists():
        return jsonify({"error": f"An archived stack named '{name}' already exists"}), 400
    try:
        shutil.move(str(d), str(dest))
    except OSError as exc:
        return jsonify({"error": f"Couldn't archive: {exc}"}), 500
    activity.log("info", "stack", f"Archived '{name}'")
    return jsonify({"ok": True})


@bp.get("/archived")
def api_archived_list():
    if not ARCHIVE_DIR.exists():
        return jsonify({"stacks": []})
    names = sorted(p.name for p in ARCHIVE_DIR.iterdir() if p.is_dir())
    return jsonify({"stacks": names})


@bp.post("/archived/<name>/restore")
def api_archived_restore(name):
    src = archived_stack_dir(name)
    if not src.exists():
        return jsonify({"error": f"'{name}' isn't archived"}), 404
    dest = stack_dir(name)
    if dest.exists():
        return jsonify({"error": f"A stack named '{name}' already exists"}), 400
    try:
        shutil.move(str(src), str(dest))
    except OSError as exc:
        return jsonify({"error": f"Couldn't restore: {exc}"}), 500
    activity.log("info", "stack", f"Restored '{name}' from archive")
    return jsonify({"ok": True})


@bp.post("/archived/<name>/purge")
def api_archived_purge(name):
    """Delete an archived stack for good: folder, compose file, and
    every image it referenced - nothing left behind."""
    d = archived_stack_dir(name)
    if not d.exists():
        return jsonify({"error": f"'{name}' isn't archived"}), 404
    cp = None
    for fname in config.COMPOSE_FILENAMES:
        if (d / fname).exists():
            cp = d / fname
            break
    compose_text = cp.read_text() if cp else ""
    envp = d / ".env"
    env_text = envp.read_text() if envp.exists() else ""
    removed_images = _purge_images(compose_text, env_text)
    try:
        shutil.rmtree(d)
    except OSError:
        rt = runtime.current()
        rt.force_remove_dir(str(d.parent), d.name)
    detail = f"Removed image(s): {', '.join(removed_images)}" if removed_images else ""
    activity.log("info", "stack", f"Purged archived stack '{name}'", detail)
    return jsonify({"ok": True, "removedImages": removed_images})


def _update_one(name, d, rt):
    """Pull + redeploy a single stack, output collected rather than
    streamed. Used by Update all, where there's no per-stack output
    panel to stream into; a single stack's update always runs through
    the streaming action so its output is visible."""
    from . import hostcompanion
    companion_available = hostcompanion.is_available()
    paused_ports = _tailscale_pause_ports(name, d, companion_available)
    conflict_port = None
    try:
        ok = True
        for action in ("pull", "up"):
            local_ok = [True]
            fix_network = None
            for line in rt.compose_stream(str(d), name, action):
                if line.startswith("[dockle-exit:"):
                    local_ok[0] = line == "[dockle-exit:0]"
                    continue
                if not conflict_port:
                    m = _PORT_CONFLICT_RE.search(line)
                    if m:
                        conflict_port = m.group(1)
                m = _NETWORK_LABEL_RE.search(line)
                if m:
                    fix_network = m.group(1)
            if not local_ok[0] and fix_network and _fix_unlabeled_network(name, fix_network):
                local_ok[0] = True
                for line in rt.compose_stream(str(d), name, action):
                    if line.startswith("[dockle-exit:"):
                        local_ok[0] = line == "[dockle-exit:0]"
            ok = ok and local_ok[0]
        if ok:
            from . import updatecheck
            updatecheck.clear_flag(name)
            activity.log("info", "stack", f"Update completed on '{name}'")
            return True, "Updated"
        if conflict_port:
            detail = (f"Port {conflict_port} was still held by a Tailscale Serve rule from a previous "
                      f"version of this stack." + ("" if companion_available else
                      " Installing the dockle-companion (Settings → Host) lets Dockle clear this "
                      "automatically next time."))
            activity.log("error", "stack", f"Update FAILED on '{name}'", detail)
            return False, f"Port {conflict_port} conflict - see Activity for details"
        activity.log("error", "stack", f"Update FAILED on '{name}'",
                     "Open the stack's output panel for the full error text.")
        return False, "Update failed - see Activity for details"
    except runtime.RuntimeError_ as exc:
        activity.log("error", "stack", f"Update FAILED on '{name}'", str(exc))
        return False, str(exc)
    finally:
        _tailscale_resume_ports(paused_ports)


@bp.post("/stacks/update-all")
def api_update_all():
    """Pull + redeploy every managed stack that has an update flagged."""
    from . import updatecheck
    flags = updatecheck.get_flags()
    result, _ = list_stacks()
    due = [s for s in result if s["managed"] and flags.get(s["name"])]
    if not due:
        return jsonify({"results": [], "updated": 0, "total": 0})
    rt = runtime.current()
    results = []
    for s in due:
        ok, message = _update_one(s["name"], stack_dir(s["name"]), rt)
        results.append({"name": s["name"], "ok": ok, "message": message})
    updated = sum(1 for r in results if r["ok"])
    activity.log("info", "stack", f"Update all: {updated}/{len(results)} succeeded")
    return jsonify({"results": results, "updated": updated, "total": len(results)})


@bp.post("/stacks/check-updates")
def api_check_updates_now():
    """Manual override for the 30-minute background check - run one right
    now instead of waiting. Runs in the background since checking every
    stack means a real `docker compose pull` each, which can take a while."""
    from flask import current_app
    from . import updatecheck
    started = updatecheck.trigger_now(current_app._get_current_object())
    if not started:
        return jsonify({"ok": True, "started": False, "message": "A check is already running."})
    activity.log("info", "update-check", "Manual update check started")
    return jsonify({"ok": True, "started": True})


@bp.get("/stacks/check-updates/status")
def api_check_updates_status():
    from . import updatecheck
    return jsonify({"checking": updatecheck.is_checking()})


@bp.post("/stacks/<name>/check-update")
def api_check_update_one(name):
    """Force an update check for just this stack, from its own detail
    page - a real `docker compose pull` against this stack only, not
    the full sweep."""
    from . import updatecheck
    try:
        d = stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not d.exists():
        return jsonify({"error": f"'{name}' hasn't been adopted into the stacks folder yet"}), 404
    try:
        available = updatecheck.check_one(name)
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"ok": True, "available": available})


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
    compose_text = data.get("compose", "")
    problem = validate_compose(compose_text)
    conflicts = []
    if problem is None:
        conflicts = check_port_conflicts(data.get("name", ""), compose_text, data.get("env", ""))
    return jsonify({"ok": problem is None, "error": problem, "portConflicts": conflicts})


@bp.get("/stacks/<name>/backups")
def api_stack_backups_list(name):
    from . import stackbackup
    try:
        stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"backups": stackbackup.list_backups(name)})


@bp.post("/stacks/<name>/backups")
def api_stack_backup_run(name):
    from . import stackbackup
    try:
        path = stackbackup.backup_stack(name)
    except (ValueError, runtime.RuntimeError_) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "name": path.name})


@bp.post("/stacks/<name>/backups/<backup_name>/restore")
def api_stack_backup_restore(name, backup_name):
    from . import stackbackup
    try:
        message = stackbackup.restore_stack(name, backup_name)
    except (ValueError, runtime.RuntimeError_) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "message": message})


_BACKUP_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.tar\.gz$")


@bp.get("/stacks/<name>/backups/<backup_name>/download")
def api_stack_backup_download(name, backup_name):
    if not _BACKUP_FILENAME_RE.match(backup_name):
        return jsonify({"error": "Not found"}), 404
    path = (config.STACK_BACKUP_DIR / backup_name).resolve()
    if path.parent != config.STACK_BACKUP_DIR.resolve() or not path.exists():
        return jsonify({"error": "Not found"}), 404
    from flask import send_file
    return send_file(path, as_attachment=True)


@bp.post("/stacks/<name>/backups/upload")
def api_stack_backup_upload(name):
    """Bring in a backup file from elsewhere - downloaded earlier, or
    moved from another machine - so it can be restored the same way as
    one Dockle made itself."""
    try:
        stack_dir(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "No file received"}), 400
    if not f.filename.endswith(".tar.gz"):
        return jsonify({"error": "That doesn't look like a Dockle stack backup (.tar.gz)"}), 400
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = config.STACK_BACKUP_DIR / f"{name}-uploaded-{stamp}.tar.gz"
    f.save(dest)
    try:
        with tarfile.open(dest, "r:gz") as tar:
            if "./manifest.json" not in tar.getnames() and "manifest.json" not in tar.getnames():
                raise ValueError("missing manifest.json")
    except (tarfile.TarError, ValueError):
        dest.unlink(missing_ok=True)
        return jsonify({"error": "That file doesn't look like a Dockle stack backup"}), 400
    activity.log("info", "backup", f"Backup file uploaded for '{name}'", dest.name)
    return jsonify({"ok": True, "name": dest.name})
