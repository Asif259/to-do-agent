"""Candidate selection, failure classification and cooldown bookkeeping.

Everything that decides *what to do after an upstream call* lives here as small,
pure functions so it can be tested without HTTP.
"""

import email.utils
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum

import httpx
from sqlalchemy import func, or_
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import ApiKey, ModelEntry, Provider, Setting, utcnow

SHORT_COOLDOWN = timedelta(seconds=30)
RATE_LIMIT_COOLDOWN = timedelta(seconds=60)

STRATEGIES = ("waterfall", "round_robin")
_DAILY_RE = re.compile(r"per[\s_-]?day|daily|\bRPD\b|\bTPD\b", re.IGNORECASE)


class Action(str, Enum):
    COOLDOWN = "cooldown"
    DISABLE_KEY = "disable_key"
    DISABLE_ENTRY = "disable_entry"
    PASSTHROUGH = "passthrough"


@dataclass(frozen=True)
class Failure:
    action: Action
    reason: str
    cooldown_until: datetime | None = None


@dataclass
class Candidate:
    entry: ModelEntry
    key: ApiKey
    provider: Provider

    @property
    def label(self) -> str:
        return f"{self.provider.name}/{self.entry.model_id}"


# --------------------------------------------------------------------------- time helpers


def next_utc_midnight(now: datetime) -> datetime:
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def parse_retry_after(value: str | None, now: datetime) -> datetime | None:
    """Retry-After is either delta-seconds or an HTTP date. Returns naive UTC or None."""
    if not value:
        return None
    value = value.strip()
    try:
        return now + timedelta(seconds=max(float(value), 1.0))
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return max(parsed, now + timedelta(seconds=1))


def is_daily_quota(body: str) -> bool:
    return bool(_DAILY_RE.search(body or ""))


# --------------------------------------------------------------------------- classification


def _snippet(body: str, limit: int = 160) -> str:
    text = " ".join((body or "").split())
    return text[:limit] + ("…" if len(text) > limit else "")


def classify_response(status: int, headers: httpx.Headers, body: str, now: datetime) -> Failure:
    """Map a non-2xx upstream response to what the router should do about it."""
    detail = _snippet(body)
    reason = f"HTTP {status}" + (f": {detail}" if detail else "")

    if status == 429:
        until = parse_retry_after(headers.get("retry-after"), now)
        if until is None:
            until = next_utc_midnight(now) if is_daily_quota(body) else now + RATE_LIMIT_COOLDOWN
        return Failure(Action.COOLDOWN, reason, until)
    if status in (401, 402):
        return Failure(Action.DISABLE_KEY, reason)
    if status in (403, 404):
        return Failure(Action.DISABLE_ENTRY, reason)
    if status == 408 or status >= 500:
        return Failure(Action.COOLDOWN, reason, now + SHORT_COOLDOWN)
    return Failure(Action.PASSTHROUGH, reason)


def classify_exception(exc: BaseException, now: datetime) -> Failure:
    if isinstance(exc, httpx.TimeoutException):
        kind = "timeout"
    elif isinstance(exc, httpx.TransportError):
        kind = "connection error"
    else:
        kind = "unexpected error"
    return Failure(Action.COOLDOWN, f"{kind}: {type(exc).__name__}", now + SHORT_COOLDOWN)


# --------------------------------------------------------------------------- settings


async def get_setting(session: AsyncSession, key: str, default: str) -> str:
    row = await session.get(Setting, key)
    return row.value if row else default


async def set_setting(session: AsyncSession, key: str, value: str) -> None:
    row = await session.get(Setting, key)
    if row:
        row.value = value
    else:
        row = Setting(key=key, value=value)
    session.add(row)
    await session.commit()


# --------------------------------------------------------------------------- selection


def _eligible_clauses(now: datetime):
    return (
        col(ModelEntry.enabled).is_(True),
        ModelEntry.status != "disabled",
        ApiKey.status == "active",
        or_(col(ModelEntry.cooldown_until).is_(None), ModelEntry.cooldown_until <= now),
    )


async def select_candidates(
    session: AsyncSession, requested_model: str, strategy: str, now: datetime | None = None
) -> list[Candidate]:
    """Ordered list of entries to try for this request."""
    now = now or utcnow()
    stmt = (
        select(ModelEntry, ApiKey, Provider)
        .join(ApiKey, ModelEntry.key_id == ApiKey.id)
        .join(Provider, ApiKey.provider_id == Provider.id)
        .where(*_eligible_clauses(now))
    )
    if requested_model != "auto":
        stmt = stmt.where(ModelEntry.model_id == requested_model)

    if strategy == "round_robin":
        rows = (await session.exec(stmt.order_by(ModelEntry.id))).all()
        if rows:
            cursor = int(await get_setting(session, "rr_cursor", "0"))
            start = cursor % len(rows)
            rows = list(rows[start:]) + list(rows[:start])
            await set_setting(session, "rr_cursor", str(cursor + 1))
    else:
        rows = (await session.exec(stmt.order_by(ModelEntry.priority, ModelEntry.id))).all()
    return [Candidate(e, k, p) for e, k, p in rows]


async def earliest_available(session: AsyncSession, now: datetime | None = None) -> datetime | None:
    """When the soonest cooling-down (but otherwise usable) entry comes back."""
    now = now or utcnow()
    stmt = (
        select(func.min(ModelEntry.cooldown_until))
        .join(ApiKey, ModelEntry.key_id == ApiKey.id)
        .where(
            col(ModelEntry.enabled).is_(True),
            ModelEntry.status != "disabled",
            ApiKey.status == "active",
            ModelEntry.cooldown_until > now,
        )
    )
    return (await session.exec(stmt)).one()


# --------------------------------------------------------------------------- state changes


async def apply_failure(session: AsyncSession, cand: Candidate, failure: Failure) -> None:
    entry, key = cand.entry, cand.key
    entry.last_error = failure.reason
    if failure.action is Action.COOLDOWN:
        entry.status = "cooling_down"
        entry.cooldown_until = failure.cooldown_until
    elif failure.action is Action.DISABLE_ENTRY:
        entry.status = "disabled"
        entry.cooldown_until = None
    elif failure.action is Action.DISABLE_KEY:
        key.status = "disabled"
        key.last_error = failure.reason
        session.add(key)
    session.add(entry)
    await session.commit()


async def record_success(session: AsyncSession, cand: Candidate) -> None:
    entry = cand.entry
    if entry.status != "active" or entry.cooldown_until or entry.last_error:
        entry.status = "active"
        entry.cooldown_until = None
        entry.last_error = None
        session.add(entry)
        await session.commit()


def effective_status(entry: ModelEntry, key: ApiKey, now: datetime) -> str:
    if key.status == "disabled" or entry.status == "disabled":
        return "disabled"
    if entry.cooldown_until and entry.cooldown_until > now:
        return "cooling_down"
    return "active"
