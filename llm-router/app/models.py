"""Database tables. All datetimes are naive UTC."""

from datetime import datetime, timezone

from pydantic import NaiveDatetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Provider(SQLModel, table=True):
    __tablename__ = "providers"

    id: int | None = Field(default=None, primary_key=True)
    name: str
    preset: str
    base_url: str
    free_only: bool = False
    created_at: NaiveDatetime = Field(default_factory=utcnow)


class ApiKey(SQLModel, table=True):
    __tablename__ = "api_keys"

    id: int | None = Field(default=None, primary_key=True)
    provider_id: int = Field(foreign_key="providers.id", index=True)
    label: str
    key_value: str
    status: str = "active"  # active | disabled
    last_error: str | None = None
    created_at: NaiveDatetime = Field(default_factory=utcnow)


class ModelEntry(SQLModel, table=True):
    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("key_id", "model_id"),)

    id: int | None = Field(default=None, primary_key=True)
    key_id: int = Field(foreign_key="api_keys.id", index=True)
    model_id: str = Field(index=True)
    enabled: bool = True
    priority: int = 100  # lower = tried first
    status: str = "active"  # active | cooling_down | disabled
    cooldown_until: NaiveDatetime | None = None
    last_error: str | None = None


class Setting(SQLModel, table=True):
    __tablename__ = "settings"

    key: str = Field(primary_key=True)
    value: str


class RequestLog(SQLModel, table=True):
    __tablename__ = "request_log"

    id: int | None = Field(default=None, primary_key=True)
    ts: NaiveDatetime = Field(default_factory=utcnow)
    requested_model: str
    provider: str | None = None
    model: str | None = None
    key_label: str | None = None
    status_code: int
    latency_ms: int
    attempts: int = 0
    fallback_reason: str | None = None
    stream: bool = False
