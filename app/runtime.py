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
import signal
import subprocess
import threading

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
    # -a is required: since API 1.42 a bare `volume prune` removes only
    # anonymous volumes, so named ones were listed in the preview and
    # then silently left behind ("0B reclaimed").
    "volumes": ["volume", "prune", "-af"],
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
        """The environment `docker compose` runs with: only the few
        variables in config.COMPOSE_PASSTHROUGH, plus DOCKER_HOST.

        Compose substitutes a stack's compose.yaml variables from its .env
        file, but the environment it runs in always wins over that file. So
        every variable Dockle passes down silently overrides the stack's own
        value of the same name - Dockle's SECRET_KEY became the secret key
        of any stack referencing ${SECRET_KEY}, PATH broke stacks defining
        their own, and TZ would quietly reset a stack's timezone. An
        allowlist is the only version of this that stays fixed as Dockle
        gains environment variables of its own."""
        env = {k: v for k, v in os.environ.items() if k in config.COMPOSE_PASSTHROUGH}
        env["DOCKER_HOST"] = f"unix://{self.socket_path}"
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

    def remove_volume(self, name: str):
        self._run(["volume", "rm", "-f", name], timeout=30)

    # -- compose ---------------------------------------------------------

    def compose_stream(self, stack_dir, project, action, extra_args=None, timeout=None):
        """Run a compose action, yielding output lines as they arrive.

        If timeout (seconds) is given and the process is still running
        when it elapses, it's killed and a [dockle-timeout] marker is
        yielded before the exit line - a container stuck because its
        bind-mount source vanished out from under it (e.g. deleted by
        hand while running) can hang `compose down` indefinitely
        otherwise, and a caller that needs this to always finish (like
        deleting a stack) can fall back to a more forceful cleanup on
        seeing that marker instead of hanging the whole request."""
        args = [_DOCKER_BIN, "compose", "-p", project, *COMPOSE_ACTIONS[action]]
        if extra_args:
            args += extra_args
        proc = subprocess.Popen(
            args, cwd=stack_dir, env=self._compose_env(),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            start_new_session=True,  # own process group, so a timeout kill
            # below can take out the whole tree - killing just the direct
            # child leaves any grandchild still holding the stdout pipe
            # open, which would keep this generator blocked forever
            # despite the "kill" appearing to have happened.
        )
        timed_out = [False]
        timer = None
        if timeout:
            def _on_timeout():
                timed_out[0] = True
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # already exited between the timer firing and this running
            timer = threading.Timer(timeout, _on_timeout)
            timer.start()
        try:
            for line in proc.stdout:
                yield line.rstrip("\n")
        finally:
            if timer:
                timer.cancel()
        proc.wait()
        if timed_out[0]:
            yield "[dockle-timeout]"
        yield f"[dockle-exit:{proc.returncode}]"

    def force_remove_containers(self, project: str):
        """Forcefully remove every container belonging to this compose
        project, bypassing graceful stop entirely - the fallback when
        `compose down` can't finish on its own. Also drops the
        project's default network, same as a normal `down` would."""
        names = [c["name"] for c in self.ps() if c["project"] == project]
        if names:
            self._run(["rm", "-f", *names], timeout=30)
        try:
            self._run(["network", "rm", f"{project}_default"], timeout=15)
        except RuntimeError_:
            pass  # never created, external, or already gone - all fine

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

    def dangling_volumes(self) -> list[dict]:
        """Unused volumes, with sizes so the confirmation step can show what
        is actually at stake. Names come from `volume ls` because that is the
        same set `volume prune -a` acts on; sizes are best-effort."""
        out = self._run(["volume", "ls", "-f", "dangling=true", "--format", "{{.Name}}"])
        names = [v for v in out.splitlines() if v.strip()]
        sizes = {}
        try:
            raw = self._run(["system", "df", "-v", "--format", "{{json .Volumes}}"], timeout=120)
            for vol in json.loads(raw or "[]"):
                sizes[vol.get("Name", "")] = vol.get("Size", "")
        except (RuntimeError_, ValueError):
            pass
        return [{"name": n, "size": sizes.get(n, "")} for n in names]

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

    def rmdir_if_empty(self, parent_host_path: str, dirname: str):
        """Remove a directory only if it's genuinely empty - `rmdir`
        fails safely otherwise, unlike force_remove_dir's rm -rf. Used
        after deleting a stack's declared data mounts, to clean up the
        now-likely-empty parent (e.g. /opt/<stack>) those mounts lived
        under - otherwise it's left behind as an empty husk, which
        Docker itself creates as a side effect of bind-mounting a path
        that didn't exist yet (a real case: the mount's own parent can
        vanish - deleted by hand, or never created - between when the
        stack stopped and when this cleanup runs)."""
        self._run(["run", "--rm", "-v", f"{parent_host_path}:/target",
                   "alpine", "rmdir", f"/target/{dirname}"], timeout=30)

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

    # -- updating Dockle itself -------------------------------------------
    # Dockle cannot recreate its own container from inside it: `compose up`
    # stops that container, which kills the very process running the
    # command, so the "start it again" half never happens and Dockle stays
    # down until someone opens a shell. Both methods below therefore do
    # the work from a short-lived container that ISN'T the one being
    # replaced, entering the host's own namespaces the same way the
    # companion install does - the daemon finishes the job whether or not
    # anything is still listening.

    def _host_nsenter(self, inner_script: str) -> str:
        return ("nsenter --target 1 --mount --uts --ipc --net --pid -- "
                f"sh -c {shlex.quote(inner_script)}")

    def self_update_check(self, compose_host_dir: str) -> dict:
        """How far behind is this install? Only answerable for a git
        checkout (what the README's install steps produce); a copied or
        unpacked folder has nothing to compare against, which is not an
        error - it just means "rebuild" is the only thing on offer."""
        d = shlex.quote(compose_host_dir)
        script = ("apk add --no-cache util-linux-misc >/dev/null && " + self._host_nsenter(
            f"cd {d} || exit 9; "
            "if [ ! -d .git ]; then echo dockle-nogit; exit 0; fi; "
            "command -v git >/dev/null || { echo dockle-nogitbin; exit 0; }; "
            "git fetch --quiet 2>&1 || { echo dockle-fetchfail; exit 0; }; "
            'echo "dockle-behind=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo unknown)"'
        ))
        out = self._run(["run", "--rm", "--privileged", "--pid=host", "-v", "/:/host",
                         "alpine", "sh", "-c", script], timeout=180)
        for line in out.splitlines():
            line = line.strip()
            if line == "dockle-nogit":
                return {"git": False, "reason": "not a git checkout"}
            if line == "dockle-nogitbin":
                return {"git": False, "reason": "git isn't installed on the host"}
            if line == "dockle-fetchfail":
                return {"git": True, "behind": None, "reason": "couldn't reach the remote"}
            if line.startswith("dockle-behind="):
                value = line.split("=", 1)[1]
                return {"git": True, "behind": None if value == "unknown" else int(value)}
        raise RuntimeError_("Couldn't work out whether an update is available:\n" + out.strip()[-400:])

    def self_compose_stream(self, compose_host_dir: str, args: list):
        """One `docker compose <args>` against Dockle's own folder, run
        from a helper container in the host's namespaces. Dockle's own
        lifecycle actions all come through here for the same reason the
        update does: any command that stops Dockle's container would
        otherwise kill the process running it, leaving the job half
        done. Streams output; ends abruptly whenever the action being
        run is one that replaces or stops Dockle itself."""
        inner = (f"cd {shlex.quote(compose_host_dir)} && docker compose "
                 + " ".join(shlex.quote(a) for a in args))
        script = "apk add --no-cache util-linux-misc >/dev/null && " + self._host_nsenter(inner)
        proc = subprocess.Popen(
            [_DOCKER_BIN, "run", "--rm", "--privileged", "--pid=host", "-v", "/:/host",
             "alpine", "sh", "-c", script],
            env=self._env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"

    def container_logs_process(self, container: str, tail=200):
        """`docker logs -f` for one container. Dockle's own stack streams
        its logs this way rather than through `compose logs`, which needs
        the compose file - and Dockle's own folder isn't mounted into its
        container."""
        return subprocess.Popen(
            [_DOCKER_BIN, "logs", "-f", "--tail", str(tail), container],
            env=self._env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)

    def self_update_stream(self, compose_host_dir: str):
        """Pull newer source (git checkouts), pull newer published images,
        then rebuild and recreate. Covers both install styles: built from
        source (`build: .`, the documented one) and plain published
        images, where the build step simply has nothing to do. Recreating
        Dockle's own container ends this stream abruptly partway through -
        expected, not a failure."""
        d = shlex.quote(compose_host_dir)
        script = " && ".join([
            "apk add --no-cache util-linux-misc >/dev/null",
            self._host_nsenter(
                f"cd {d} || exit 9; "
                "if [ -d .git ] && command -v git >/dev/null; then "
                'echo "Pulling the latest source..."; git pull --ff-only || exit 1; '
                'else echo "Not a git checkout - rebuilding from the files already here."; fi'),
            # Published-image installs get their new image here; a
            # build-from-source install has nothing to pull, which is why
            # a failure at this step is never fatal on its own.
            self._host_nsenter(f"cd {d} && docker compose pull --ignore-pull-failures || true"),
            # Refuse to touch a running Dockle if the compose file it
            # would be recreated from doesn't parse - better to stop here
            # with Dockle still up than halfway through with it down.
            self._host_nsenter(f"cd {d} && docker compose config --quiet"),
            self._host_nsenter(f"cd {d} && docker compose up -d --build"),
        ])
        args = [_DOCKER_BIN, "run", "--rm", "--privileged", "--pid=host", "-v", "/:/host",
                "alpine", "sh", "-c", script]
        proc = subprocess.Popen(args, env=self._env(), stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            yield line.rstrip("\n")
        proc.wait()
        yield f"[dockle-exit:{proc.returncode}]"
