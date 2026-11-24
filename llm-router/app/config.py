"""Runtime settings, read from the environment (and an optional .env file)."""

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader. Real environment variables win over the file."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(name.strip(), value)


@dataclass(frozen=True)
class Settings:
    proxy_api_key: str | None = None
    db_url: str = "sqlite+aiosqlite:///./router.db"
    host: str = "127.0.0.1"
    port: int = 8000
    connect_timeout: float = 10.0
    read_timeout: float = 120.0
    first_byte_timeout: float = 30.0
    max_attempts: int = 20

    @classmethod
    def from_env(cls) -> "Settings":
        _load_dotenv(Path(".env"))
        env = os.environ.get
        return cls(
            proxy_api_key=env("PROXY_API_KEY") or None,
            db_url=env("DB_URL", cls.db_url),
            host=env("HOST", cls.host),
            port=int(env("PORT", cls.port)),
            connect_timeout=float(env("CONNECT_TIMEOUT", cls.connect_timeout)),
            read_timeout=float(env("READ_TIMEOUT", cls.read_timeout)),
            first_byte_timeout=float(env("FIRST_BYTE_TIMEOUT", cls.first_byte_timeout)),
            max_attempts=int(env("MAX_ATTEMPTS", cls.max_attempts)),
        )
