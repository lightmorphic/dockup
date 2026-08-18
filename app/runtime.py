"""The engine layer. Everything Dockle does to containers goes through here.

Both Docker and Podman expose the same command interface, so one code path
serves both: the docker CLI (and its compose plugin) is pointed at whichever
socket the settings choose. Swapping engine = swapping socket path.

DOCKLE_MOCK=1 replaces the whole layer with an in-memory pretend engine so
the full UI can be exercised on a machine with no container runtime.
"""

import json
import os
import shlex
import shutil
import subprocess

from . import config, settingsvc

_DOCKER_BIN = shutil.which("docker") or "docker"

COMPOSE_ACTIONS = {
    "up": ["up", "-d", "--remove-orphans"],
    "down": ["down"],
    "stop": ["stop"],
    "start": ["start"],
    "restart": ["restart"],
    # Deliberately no --ignore-pull-failures here: a real pull failure
    # (bad tag, auth, registry down) should hard-stop Update rather than
    # silently redeploy the old image and report success. A stack whose
    # image genuinely isn't in a registry needs fixing at the source
    # (its own compose file), not tolerated here where it'd mask a real
    # failure for every other stack too.
    "pull": ["pull"],
    # Recreates every container from the compose file and whatever
    # image is already pulled - unlike restart (which just restarts the
    # same container process), this tears down and rebuilds it, which
    # is what actually clears a container stuck in a bad state that a
    # plain restart doesn't fix. No image pull, unlike Update.
    "redeploy": ["up", "-d", "--force-recreate", "--remove-orphans"],
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

    def _compose_env(self):
        """Same as _env(), minus PATH. `docker compose` substitutes a
        stack's own compose.yaml variables from its .env file, but the
        shell environment always wins over the .env file - so if a
        stack's .env defines its own PATH variable (a real pattern in
        imported Arcane stacks, e.g. PATH=/opt/stirling-pdf), Dockle's
        own container PATH silently overrides it and every ${PATH}
        reference resolves to garbage. Dropping it here is safe:
        _DOCKER_BIN is resolved to an absolute path up front."""
        env = self._env()
        env.pop("PATH", None)
        return env

    def _run(self, args, timeout=60, cwd=None, compose=False):
        try:
            proc = subprocess.run(
                [_DOCKER_BIN, *args], capture_output=True, text=True,
                timeout=timeout, env=self._compose_env() if compose else self._env(), cwd=cwd,
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
                "ports": c.get("Ports", ""),
            })
        return rows

    def inspect(self, names: list[str]) -> list[dict]:
        if not names:
            return []
        out = self._run(["inspect", *names], timeout=60)
        return json.loads(out)

    def remove_image(self, image: str):
        self._run(["rmi", image], timeout=60)

    # -- compose ---------------------------------------------------------

    def compose_stream(self, stack_dir, project, action, extra_args=None):
        """Run a compose action, yielding output lines as they arrive."""
        args = [_DOCKER_BIN, "compose", "-p", project, *COMPOSE_ACTIONS[action]]
        if extra_args:
            args += extra_args
        proc = subprocess.Popen(
            args, cwd=stack_dir, env=self._compose_env(),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"

    def logs_process(self, stack_dir, project, tail=200):
        """A Popen streaming `compose logs -f` for the websocket to relay."""
        return subprocess.Popen(
            [_DOCKER_BIN, "compose", "-p", project, "logs", "-f", "--tail", str(tail)],
            cwd=stack_dir, env=self._compose_env(),
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
        # --ignore-pull-failures: locally-built services (no registry image
        # to pull) shouldn't abort the update check for the rest of the
        # stack's services.
        self._run(["compose", "-p", project, "pull", "-q", "--ignore-pull-failures"],
                   timeout=300, cwd=stack_dir, compose=True)

        # `compose ps`'s own "Image" column isn't reliable for this - for
        # some published images it reports the frozen digest the running
        # container was created from instead of the tag (e.g.
        # "sha256:01fd..." instead of "ghcr.io/x/y:latest"), which then
        # only ever compares against itself and never detects an update.
        # `compose config --images` always resolves to the tag actually
        # declared in the compose file, so use that as the source of
        # truth for what "latest" means here.
        services = self._run(["compose", "-p", project, "config", "--services"],
                              timeout=30, cwd=stack_dir, compose=True).splitlines()
        images = self._run(["compose", "-p", project, "config", "--images"],
                            timeout=30, cwd=stack_dir, compose=True).splitlines()
        service_images = dict(zip(services, images))

        out = self._run(["compose", "-p", project, "ps", "-a", "--format", "{{json .}}"],
                        timeout=30, cwd=stack_dir, compose=True)
        for line in out.splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            name, service = c.get("Name"), c.get("Service")
            image_ref = service_images.get(service)
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

    def force_remove_dir(self, parent_host_path: str, dirname: str):
        """Remove a stack's folder via a throwaway root container when
        Dockle's own non-root process can't - a real, hit-in-production
        case for stacks adopted from a previous manager (Arcane) that
        left the folder root-owned. /opt/stacks is mounted at the same
        path in both Dockle's container and the host, so no host-path
        translation is needed here unlike the backup helpers below."""
        self._run(["run", "--rm", "-v", f"{parent_host_path}:/target",
                   "alpine", "rm", "-rf", f"/target/{dirname}"], timeout=60)

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

    # -- one-click companion install --------------------------------------
    # `install.sh` writes to /etc/systemd/system, creates a group, and
    # runs `systemctl enable --now` - real root-on-host actions. Tried a
    # lighter `-v /:/host` + chroot first (no --privileged/--pid=host),
    # but systemctl failed with "Failed to connect to system scope bus
    # via local transport: No data available" - sd-bus validates the
    # connecting process's *actual* PID namespace against systemd's own
    # (PID 1's), and chroot only changes filesystem path resolution, not
    # namespace membership, so the credential check fails. Actually
    # joining the host's PID namespace via nsenter (which needs
    # --pid=host + --privileged for CAP_SYS_PTRACE/CAP_SYS_ADMIN) is
    # what real host-systemd-management tools use for exactly this
    # reason. Still a single short-lived container - nothing standing
    # on Dockle's own container afterward.

    def install_companion_stream(self, staging_host_dir: str):
        args = [
            _DOCKER_BIN, "run", "--rm", "--privileged", "--pid=host",
            "-v", "/:/host", "-v", f"{staging_host_dir}:/staging:ro",
            "alpine", "sh", "-c",
            "apk add --no-cache util-linux-misc >/dev/null && "
            "mkdir -p /host/tmp/dockle-companion-install && "
            "cp /staging/dockle-companion.py /staging/dockle-companion.service /staging/install.sh "
            "/host/tmp/dockle-companion-install/ && "
            "chmod +x /host/tmp/dockle-companion-install/install.sh && "
            "nsenter --target 1 --mount --uts --ipc --net --pid -- "
            "sh /tmp/dockle-companion-install/install.sh && "
            "rm -rf /host/tmp/dockle-companion-install",
        ]
        proc = subprocess.Popen(args, env=self._env(), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"

    def reconnect_companion_stream(self, compose_host_path: str, compose_host_dir: str):
        """Uncomment the companion socket line in Dockle's own compose.yaml
        and run `docker compose up -d` for real, via the host's own
        namespaces - not a bind-mounted view from inside Dockle's own
        container, where compose's relative-path resolution (./data
        etc) would produce the wrong absolute host paths. This
        recreates Dockle's own container, so the stream (and the HTTP
        request carrying it) ends abruptly partway through - expected,
        not a failure. The daemon completes the restart independently
        of whether anything is still reading this output."""
        script = (
            f"sed -i 's|# - /run/dockle-companion.sock:/run/dockle-companion.sock|"
            f"- /run/dockle-companion.sock:/run/dockle-companion.sock|' {shlex.quote('/host' + compose_host_path)} && "
            "apk add --no-cache util-linux-misc >/dev/null && "
            "nsenter --target 1 --mount --uts --ipc --net --pid -- "
            f"sh -c 'cd {shlex.quote(compose_host_dir)} && docker compose config --quiet' && "
            "nsenter --target 1 --mount --uts --ipc --net --pid -- "
            f"sh -c 'cd {shlex.quote(compose_host_dir)} && docker compose up -d'"
        )
        args = [_DOCKER_BIN, "run", "--rm", "--privileged", "--pid=host", "-v", "/:/host",
                "alpine", "sh", "-c", script]
        proc = subprocess.Popen(args, env=self._env(), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"
