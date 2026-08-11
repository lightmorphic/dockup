"""Maintenance: disk usage and pruning - each type separately or all at
once. Volume pruning always shows exactly what will be deleted first.
"""

from flask import Blueprint, jsonify, request

from . import activity, runtime

bp = Blueprint("maintenance", __name__, url_prefix="/api/system")

SAFE_ORDER = ["containers", "images", "networks", "buildcache", "volumes"]


@bp.get("/df")
def disk_usage():
    try:
        return jsonify({"usage": runtime.current().disk_usage()})
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502


@bp.get("/prune/volumes/preview")
def volume_preview():
    try:
        return jsonify({"volumes": runtime.current().dangling_volumes()})
    except runtime.RuntimeError_ as exc:
        return jsonify({"error": str(exc)}), 502


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
