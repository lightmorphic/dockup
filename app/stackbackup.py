"""Per-stack backup: archives one stack's compose config plus its actual
data - bind-mount directories and named volumes - and can restore both
back to exactly where they came from. Nothing is ever relocated into a
different layout; a helper container does the real file access so this
reaches paths Dockle's own container can't see directly (see runtime.py).
"""

import json
import os
import re
import shutil
import tarfile
import time
from pathlib import Path

import yaml

from . import activity, config, runtime, stacks

_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def _parse_env(env_text: str) -> dict:
    values = {}
    for line in (env_text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _substitute(text: str, env: dict) -> str:
    """Resolve ${VAR}/$VAR the way compose does, so a bind-mount path
    like ${BASE}/data (very common - Arcane-managed stacks all use this)
    gets classified and archived from its real location, not the literal
    unexpanded string."""
    def repl(m):
        name = m.group(1) or m.group(2)
        return env.get(name, os.environ.get(name, m.group(0)))
    return _VAR_RE.sub(repl, text)


def _parse_mounts(compose_text: str, env_text: str = "") -> list:
    """Every bind mount and named volume referenced by any service,
    de-duplicated (several services can share one volume)."""
    try:
        doc = yaml.safe_load(compose_text) or {}
    except yaml.YAMLError:
        return []
    if not isinstance(doc, dict):
        return []
    env = _parse_env(env_text)
    mounts, seen = [], set()
    for service_name, svc in (doc.get("services") or {}).items():
        if not isinstance(svc, dict):
            continue
        for v in svc.get("volumes") or []:
            if isinstance(v, str):
                source = _substitute(v.split(":")[0], env)
                kind = "bind" if source.startswith(("/", "./", "../", "~")) else "volume"
            elif isinstance(v, dict) and v.get("type") in ("bind", "volume"):
                kind, source = v["type"], _substitute(v.get("source", ""), env)
            else:
                continue
            if not source or (kind, source) in seen:
                continue
            seen.add((kind, source))
            mounts.append({"service": service_name, "type": kind, "source": source})
    return mounts


def _resolve_bind_source(source: str, stack_dir: Path) -> str:
    return source if source.startswith("/") else str((stack_dir / source).resolve())


def list_backups(name: str) -> list:
    files = sorted(config.STACK_BACKUP_DIR.glob(f"{name}-*.tar.gz"), reverse=True)
    return [{"name": f.name, "size": f.stat().st_size,
             "made": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime))}
            for f in files]


def backup_stack(name: str) -> Path:
    d = stacks.stack_dir(name)
    compose_path = stacks.compose_path(name)
    if not compose_path.exists():
        raise ValueError(f"'{name}' has no compose file to back up")
    compose_text = compose_path.read_text()
    env_path = d / ".env"
    env_text = env_path.read_text() if env_path.exists() else ""
    mounts = _parse_mounts(compose_text, env_text)
    rt = runtime.current()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    work_name = f".work-{name}-{stamp}"
    work_dir = config.STACK_BACKUP_DIR / work_name
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        (work_dir / "compose.yaml").write_text(compose_text)
        if env_text:
            (work_dir / ".env").write_text(env_text)

        manifest = {"stack": name, "made": stamp, "mounts": []}
        errors = []
        for i, m in enumerate(mounts):
            piece = f"data-{i}.tar.gz"
            try:
                if m["type"] == "bind":
                    rt.archive_path_to_backup(_resolve_bind_source(m["source"], d), f"{work_name}/{piece}")
                else:
                    rt.archive_volume_to_backup(m["source"], f"{work_name}/{piece}")
                manifest["mounts"].append({**m, "archive": piece, "ok": True})
            except runtime.RuntimeError_ as exc:
                errors.append(f"{m['type']} '{m['source']}': {exc}")
                manifest["mounts"].append({**m, "archive": None, "ok": False, "error": str(exc)})
        (work_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

        final_path = config.STACK_BACKUP_DIR / f"{name}-{stamp}.tar.gz"
        with tarfile.open(final_path, "w:gz") as tar:
            tar.add(work_dir, arcname=".")

        if errors:
            note = f"{len(errors)} of {len(mounts)} data location(s) failed: " + "; ".join(errors)
            activity.log("error", "backup", f"Stack backup of '{name}' had problems", note)
        else:
            activity.log("info", "backup",
                         f"Backed up '{name}'" + (f" ({len(mounts)} data location(s))" if mounts else " (config only)"))
        return final_path
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def restore_stack(name: str, backup_filename: str) -> str:
    path = (config.STACK_BACKUP_DIR / backup_filename).resolve()
    if path.parent != config.STACK_BACKUP_DIR.resolve() or not path.exists():
        raise ValueError("That backup file doesn't exist")
    rt = runtime.current()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    work_name = f".restore-{name}-{stamp}"
    work_dir = config.STACK_BACKUP_DIR / work_name
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(path, "r:gz") as tar:
            tar.extractall(work_dir, filter="data")
        manifest_path = work_dir / "manifest.json"
        if not manifest_path.exists():
            raise ValueError("That archive doesn't look like a Dockle stack backup")
        manifest = json.loads(manifest_path.read_text())

        d = stacks.stack_dir(name)
        d.mkdir(parents=True, exist_ok=True)
        (d / "compose.yaml").write_text((work_dir / "compose.yaml").read_text())
        env_src = work_dir / ".env"
        if env_src.exists():
            (d / ".env").write_text(env_src.read_text())

        errors = []
        for m in manifest.get("mounts", []):
            if not m.get("ok") or not m.get("archive"):
                continue
            piece_rel = f"{work_name}/{m['archive']}"
            try:
                if m["type"] == "bind":
                    rt.restore_path_from_backup(_resolve_bind_source(m["source"], d), piece_rel)
                else:
                    rt.restore_volume_from_backup(m["source"], piece_rel)
            except runtime.RuntimeError_ as exc:
                errors.append(f"{m['type']} '{m['source']}': {exc}")

        if errors:
            note = f"{len(errors)} data location(s) failed to restore: " + "; ".join(errors)
            activity.log("error", "backup", f"Restore of '{name}' had problems", note)
            raise ValueError(note)
        activity.log("info", "backup", f"Restored '{name}' from {backup_filename}")
        return f"Restored '{name}'. Config and data went back to exactly where they were."
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
