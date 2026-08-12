"""The engine layer. Everything Dockle does to containers goes through here.

Both Docker and Podman expose the same command interface, so one code path
serves both: the docker CLI (and its compose plugin) is pointed at whichever
socket the settings choose. Swapping engine = swapping socket path.

DOCKLE_MOCK=1 replaces the whole layer with an in-memory pretend engine so
the full UI can be exercised on a machine with no container runtime.
"""

import json
import os
import subprocess

from . import config, settingsvc

COMPOSE_ACTIONS = {
    "up": ["up", "-d", "--remove-orphans"],
    "down": ["down"],
    "stop": ["stop"],
    "start": ["start"],
    "restart": ["restart"],
    "pull": ["pull"],
}

PRUNE_TARGETS = {
    "images": ["image", "prune", "-af"],
    "containers": ["container", "prune", "-f"],
    "networks": ["network", "prune", "-f"],
    "volumes": ["volume", "prune", "-f"],
    "buildcache": ["builder", "prune", "-af"],
}


class RuntimeError_(Exception):
    pass


def current():
    if config.MOCK_MODE:
        from . import runtime_mock
        return runtime_mock.MockRuntime.instance()
    return Runtime(settingsvc.get("runtime.engine"), settingsvc.get("runtime.socket"))


class Runtime:
    def __init__(self, engine: str, socket_path: str):
        self.engine = engine
        self.socket_path = socket_path

    def _env(self):
        env = dict(os.environ)
        env["DOCKER_HOST"] = f"unix://{self.socket_path}"
        return env

    def _run(self, args, timeout=60, cwd=None):
        try:
            proc = subprocess.run(
                ["docker", *args], capture_output=True, text=True,
                timeout=timeout, env=self._env(), cwd=cwd,
            )
        except FileNotFoundError:
            raise RuntimeError_("The docker CLI is not installed in the Dockle container")
        except subprocess.TimeoutExpired:
            raise RuntimeError_(f"Command timed out: docker {' '.join(args[:3])}...")
        if proc.returncode != 0:
            raise RuntimeError_((proc.stderr or proc.stdout or "command failed").strip())
        return proc.stdout

    # -- status ----------------------------------------------------------

    def ping(self) -> dict:
        try:
            out = self._run(["version", "--format", "{{json .Server}}"], timeout=10)
            server = json.loads(out) or {}
            name = "Podman" if "podman" in json.dumps(server).lower() else "Docker"
            return {"ok": True, "engine": name, "version": server.get("Version", "?")}
        except (RuntimeError_, json.JSONDecodeError) as exc:
            return {"ok": False, "engine": self.engine, "error": str(exc)}

    def ps(self) -> list[dict]:
        out = self._run(["ps", "-a", "--no-trunc", "--format", "{{json .}}"])
        rows = []
        for line in out.splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            labels = {}
            for pair in (c.get("Labels") or "").split(","):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    labels[k] = v
            rows.append({
                "id": (c.get("ID") or "")[:12],
                "name": c.get("Names", ""),
                "image": c.get("Image", ""),
                "state": c.get("State", ""),
                "status": c.get("Status", ""),
                "project": labels.get("com.docker.compose.project", ""),
                "service": labels.get("com.docker.compose.service", ""),
                "workingDir": labels.get("com.docker.compose.project.working_dir", ""),
                "configFiles": labels.get("com.docker.compose.project.config_files", ""),
            })
        return rows

    def inspect(self, names: list[str]) -> list[dict]:
        if not names:
            return []
        out = self._run(["inspect", *names], timeout=60)
        return json.loads(out)

    # -- compose ---------------------------------------------------------

    def compose_stream(self, stack_dir, project, action, extra_args=None):
        """Run a compose action, yielding output lines as they arrive."""
        args = ["docker", "compose", "-p", project, *COMPOSE_ACTIONS[action]]
        if extra_args:
            args += extra_args
        proc = subprocess.Popen(
            args, cwd=stack_dir, env=self._env(),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"

    def logs_process(self, stack_dir, project, tail=200):
        """A Popen streaming `compose logs -f` for the websocket to relay."""
        return subprocess.Popen(
            ["docker", "compose", "-p", project, "logs", "-f", "--tail", str(tail)],
            cwd=stack_dir, env=self._env(),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )

    def exec_argv(self, container: str) -> list[str]:
        """argv for an interactive shell in a container, run under a PTY."""
        return [
            "docker", "exec", "-it", container,
            "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
        ]

    def exec_env(self):
        return self._env()

    # -- maintenance -----------------------------------------------------

    def disk_usage(self) -> list[dict]:
        out = self._run(["system", "df", "--format", "{{json .}}"], timeout=120)
        rows = []
        for line in out.splitlines():
            if line.strip():
                d = json.loads(line)
                rows.append({
                    "type": d.get("Type", ""),
                    "total": d.get("TotalCount", ""),
                    "active": d.get("Active", ""),
                    "size": d.get("Size", ""),
                    "reclaimable": d.get("Reclaimable", ""),
                })
        return rows

    def dangling_volumes(self) -> list[str]:
        out = self._run(["volume", "ls", "-f", "dangling=true", "--format", "{{.Name}}"])
        return [v for v in out.splitlines() if v.strip()]

    def prune(self, target: str) -> str:
        out = self._run(PRUNE_TARGETS[target], timeout=600)
        for line in reversed(out.splitlines()):
            if "reclaimed" in line.lower():
                return line.strip()
        return "Nothing to remove"

    def pull_image_updates(self, stack_dir, project):
        return self.compose_stream(stack_dir, project, "pull")

    def check_stack_update(self, stack_dir, project) -> bool:
        """Quietly pull each service's image and compare against what's
        actually running. True if anything's out of date."""
        self._run(["compose", "-p", project, "pull", "-q"], timeout=300, cwd=stack_dir)
        out = self._run(["compose", "-p", project, "ps", "-a", "--format", "{{json .}}"],
                        timeout=30, cwd=stack_dir)
        for line in out.splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            name, image_ref = c.get("Name"), c.get("Image")
            if not name or not image_ref:
                continue
            try:
                running_id = self._run(["inspect", name, "--format", "{{.Image}}"], timeout=15).strip()
                latest_id = self._run(["image", "inspect", image_ref, "--format", "{{.Id}}"], timeout=15).strip()
            except RuntimeError_:
                continue
            if running_id and latest_id and running_id != latest_id:
                return True
        return False

    # -- per-stack data backup/restore ------------------------------------
    # A short-lived helper container does the actual file access, mounting
    # the source and Dockle's own backup folder side by side - the daemon
    # resolves both against the real host filesystem, so this reaches
    # bind-mount paths Dockle's own container can't see directly, and
    # named volumes wherever Docker actually stores them. Nothing is ever
    # relocated - everything restores to exactly the path it came from.

    def _require_host_path(self):
        if not config.DATA_HOST_PATH:
            raise RuntimeError_(
                "DOCKLE_DATA_HOST_PATH isn't set, so Dockle doesn't know its own "
                "real path on the host - see the runbook to set it in compose.yaml."
            )
        return f"{config.DATA_HOST_PATH.rstrip('/')}/stack-backups"

    def archive_path_to_backup(self, host_source: str, dest_filename: str):
        dest_host_dir = self._require_host_path()
        self._run(["run", "--rm", "-v", f"{host_source}:/src:ro", "-v", f"{dest_host_dir}:/dest",
                   "alpine", "tar", "czf", f"/dest/{dest_filename}", "-C", "/src", "."], timeout=900)

    def archive_volume_to_backup(self, volume_name: str, dest_filename: str):
        dest_host_dir = self._require_host_path()
        self._run(["run", "--rm", "-v", f"{volume_name}:/src:ro", "-v", f"{dest_host_dir}:/dest",
                   "alpine", "tar", "czf", f"/dest/{dest_filename}", "-C", "/src", "."], timeout=900)

    def restore_path_from_backup(self, host_dest: str, src_filename: str):
        dest_host_dir = self._require_host_path()
        # bind-mounting a path that doesn't exist yet needs it created
        # first - do both in one helper container.
        self._run(["run", "--rm", "-v", f"{host_dest}:/dest", "-v", f"{dest_host_dir}:/src:ro",
                   "alpine", "sh", "-c", f"mkdir -p /dest && tar xzf /src/{src_filename} -C /dest"], timeout=900)

    def restore_volume_from_backup(self, volume_name: str, src_filename: str):
        dest_host_dir = self._require_host_path()
        self._run(["run", "--rm", "-v", f"{volume_name}:/dest", "-v", f"{dest_host_dir}:/src:ro",
                   "alpine", "tar", "xzf", f"/src/{src_filename}", "-C", "/dest"], timeout=900)
