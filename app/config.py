import os
import sys
from pathlib import Path

DATA_DIR = Path(os.environ.get("DOCKLE_DATA", "/app/data"))
STACKS_DIR = Path(os.environ.get("DOCKLE_STACKS", "/opt/stacks"))
MOCK_MODE = os.environ.get("DOCKLE_MOCK") == "1"

DB_PATH = DATA_DIR / "dockle.db"
BACKUP_DIR = DATA_DIR / "backups"
STACK_BACKUP_DIR = DATA_DIR / "stack-backups"

# The real host-filesystem path of DATA_DIR, needed when Dockle asks the
# Docker socket to start a helper container with a bind mount destined
# for this folder - the daemon resolves that against the host, not
# Dockle's own container, so a container-internal path won't do.
DATA_HOST_PATH = os.environ.get("DOCKLE_DATA_HOST_PATH", "")

SECRET_KEY = os.environ.get("SECRET_KEY", "")

STACK_NAME_RE = r"^[a-z0-9][a-z0-9_-]{0,62}$"
COMPOSE_FILENAMES = ("compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")

SESSION_DAYS = 7
LOGIN_MAX_FAILS = 5
LOGIN_WINDOW_MIN = 15


def validate():
    if not SECRET_KEY:
        sys.exit("SECRET_KEY is not set. Generate one with:\n"
                 '  python3 -c "import secrets;print(secrets.token_urlsafe(48))"')
    if len(SECRET_KEY) < 32:
        sys.exit("SECRET_KEY is too short - use at least 32 characters.")


def ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    STACK_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    STACKS_DIR.mkdir(parents=True, exist_ok=True)
