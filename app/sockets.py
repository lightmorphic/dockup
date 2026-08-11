"""Websockets: live compose logs and the interactive terminal.

Both check the login session before doing anything - a websocket is a
door too.
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import threading

from flask import session
from flask_sock import Sock

from . import config, runtime, stacks

sock = Sock()


def _authed():
    return bool(session.get("uid"))


@sock.route("/ws/logs/<name>")
def ws_logs(ws, name):
    if not _authed():
        ws.close()
        return
    try:
        d = stacks.stack_dir(name)
    except ValueError:
        ws.close()
        return
    rt = runtime.current()
    proc = rt.logs_process(str(d), name)
    stop = threading.Event()

    def watch_client():
        # receive() returns None when the client goes away
        try:
            while ws.receive() is not None:
                pass
        except Exception:
            pass
        stop.set()
        try:
            proc.terminate()
        except Exception:
            pass

    threading.Thread(target=watch_client, daemon=True).start()
    try:
        for line in proc.stdout:
            if stop.is_set():
                break
            ws.send(line.rstrip("\n"))
    except Exception:
        pass
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


@sock.route("/ws/terminal/<container>")
def ws_terminal(ws, container):
    if not _authed():
        ws.close()
        return
    if not all(c.isalnum() or c in "-_." for c in container) or not container:
        ws.close()
        return
    rt = runtime.current()
    argv = rt.exec_argv(container)

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        argv, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        env=rt.exec_env(), preexec_fn=os.setsid, close_fds=True,
    )
    os.close(slave_fd)
    stop = threading.Event()

    def pump_output():
        try:
            while not stop.is_set():
                r, _w, _x = select.select([master_fd], [], [], 0.5)
                if master_fd in r:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    ws.send(data.decode(errors="replace"))
        except Exception:
            pass
        finally:
            stop.set()
            try:
                ws.close()
            except Exception:
                pass

    threading.Thread(target=pump_output, daemon=True).start()
    try:
        while not stop.is_set():
            msg = ws.receive()
            if msg is None:
                break
            if msg.startswith("\x00resize:"):
                try:
                    cols, rows = msg[8:].split("x")
                    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except (ValueError, OSError):
                    pass
            else:
                os.write(master_fd, msg.encode())
    except Exception:
        pass
    finally:
        stop.set()
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
