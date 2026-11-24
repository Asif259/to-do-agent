"""JSON API behind the dashboard. Keys are only ever returned masked."""

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlmodel import col, delete, select

from app.auth import require_auth
from app.discovery import DiscoveryError, fetch_chat_models
from app.models import ApiKey, ModelEntry, Provider, RequestLog, utcnow
from app.presets import PRESETS
from app.router_engine import STRATEGIES, effective_status, get_setting, set_setting

router = APIRouter(prefix="/admin", dependencies=[Depends(require_auth)])


def mask_key(value: str) -> str:
    if len(value) <= 8:
        return "••••"
    return f"{value[:3]}…{value[-4:]}"


def _iso(dt) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _db(request: Request):
    return request.app.state.sessionmaker()


# --------------------------------------------------------------------------- schemas


class KeyIn(BaseModel):
    preset: str
    label: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    base_url: str | None = None
    name: str | None = None


class KeyPatch(BaseModel):
    label: str | None = Field(default=None, min_length=1)
    status: str | None = None


class ProviderPatch(BaseModel):
    free_only: bool | None = None


class ModelPatch(BaseModel):
    enabled: bool | None = None
    priority: int | None = None


class SettingsIn(BaseModel):
    strategy: str


# --------------------------------------------------------------------------- serialisers


def _key_dict(key: ApiKey, model_count: int = 0) -> dict:
    return {
        "id": key.id,
        "provider_id": key.provider_id,
        "label": key.label,
        "masked_key": mask_key(key.key_value),
        "status": key.status,
        "last_error": key.last_error,
        "model_count": model_count,
    }


def _provider_dict(p: Provider, keys: list[dict]) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "preset": p.preset,
        "base_url": p.base_url,
        "free_only": p.free_only,
        "keys": keys,
    }


# --------------------------------------------------------------------------- presets & providers


@router.get("/presets")
async def presets():
    return [{"id": k, "name": v["name"], "base_url": v["base_url"]} for k, v in PRESETS.items()]


@router.get("/providers")
async def providers(request: Request):
    async with _db(request) as s:
        provs = (await s.exec(select(Provider).order_by(Provider.id))).all()
        keys = (await s.exec(select(ApiKey).order_by(ApiKey.id))).all()
        entries = (await s.exec(select(ModelEntry.key_id))).all()
    counts: dict[int, int] = {}
    for key_id in entries:
        counts[key_id] = counts.get(key_id, 0) + 1
    return [
        _provider_dict(p, [_key_dict(k, counts.get(k.id, 0)) for k in keys if k.provider_id == p.id])
        for p in provs
    ]


@router.patch("/providers/{provider_id}")
async def patch_provider(provider_id: int, body: ProviderPatch, request: Request):
    async with _db(request) as s:
        p = await s.get(Provider, provider_id)
        if not p:
            raise HTTPException(404, "Provider not found")
        if body.free_only is not None:
            p.free_only = body.free_only
        s.add(p)
        await s.commit()
        return _provider_dict(p, [])


# --------------------------------------------------------------------------- keys


@router.post("/keys", status_code=201)
async def add_key(body: KeyIn, request: Request):
    preset = PRESETS.get(body.preset)
    if preset is None:
        raise HTTPException(422, f"Unknown preset '{body.preset}'")
    base_url = (body.base_url or preset["base_url"] or "").strip().rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(422, "A base URL starting with http:// or https:// is required")
    default_name = preset["name"] if body.preset != "custom" else urlparse(base_url).netloc
    name = (body.name or default_name or "Custom").strip()

    async with _db(request) as s:
        prov = (await s.exec(select(Provider).where(Provider.base_url == base_url))).first()
        if prov is None:
            prov = Provider(name=name, preset=body.preset, base_url=base_url)
            s.add(prov)
            await s.commit()
        key = ApiKey(provider_id=prov.id, label=body.label.strip(), key_value=body.api_key.strip())
        s.add(key)
        await s.commit()
        return _key_dict(key)


@router.patch("/keys/{key_id}")
async def patch_key(key_id: int, body: KeyPatch, request: Request):
    async with _db(request) as s:
        key = await s.get(ApiKey, key_id)
        if not key:
            raise HTTPException(404, "Key not found")
        if body.label:
            key.label = body.label.strip()
        if body.status:
            if body.status not in ("active", "disabled"):
                raise HTTPException(422, "status must be 'active' or 'disabled'")
            key.status = body.status
            if body.status == "active":
                key.last_error = None
        s.add(key)
        await s.commit()
        return _key_dict(key)


@router.delete("/keys/{key_id}", status_code=204)
async def delete_key(key_id: int, request: Request):
    async with _db(request) as s:
        key = await s.get(ApiKey, key_id)
        if not key:
            raise HTTPException(404, "Key not found")
        provider_id = key.provider_id
        await s.exec(delete(ModelEntry).where(col(ModelEntry.key_id) == key_id))
        await s.exec(delete(ApiKey).where(col(ApiKey.id) == key_id))
        remaining = (await s.exec(select(ApiKey.id).where(ApiKey.provider_id == provider_id))).first()
        if remaining is None:
            await s.exec(delete(Provider).where(col(Provider.id) == provider_id))
        await s.commit()
    return Response(status_code=204)


@router.post("/keys/{key_id}/sync")
async def sync_key(key_id: int, request: Request):
    async with _db(request) as s:
        key = await s.get(ApiKey, key_id)
        if not key:
            raise HTTPException(404, "Key not found")
        provider = await s.get(Provider, key.provider_id)
        try:
            ids = await fetch_chat_models(request.app.state.client, provider, key.key_value)
        except DiscoveryError as exc:
            key.last_error = f"sync: {exc}"
            s.add(key)
            await s.commit()
            raise HTTPException(502, str(exc)) from exc

        existing = {
            e.model_id: e
            for e in (await s.exec(select(ModelEntry).where(ModelEntry.key_id == key_id))).all()
        }
        added = kept = 0
        for model_id in ids:
            if model_id in existing:
                kept += 1
            else:
                s.add(ModelEntry(key_id=key_id, model_id=model_id))
                added += 1
        removed = 0
        for model_id, entry in existing.items():
            if model_id not in ids:
                await s.delete(entry)
                removed += 1
        if key.last_error and key.last_error.startswith("sync:"):
            key.last_error = None
            s.add(key)
        await s.commit()
    return {"added": added, "kept": kept, "removed": removed, "total": added + kept}


# --------------------------------------------------------------------------- models


@router.get("/models")
async def models(request: Request):
    now = utcnow()
    async with _db(request) as s:
        rows = (
            await s.exec(
                select(ModelEntry, ApiKey, Provider)
                .join(ApiKey, ModelEntry.key_id == ApiKey.id)
                .join(Provider, ApiKey.provider_id == Provider.id)
                .order_by(ModelEntry.priority, ModelEntry.id)
            )
        ).all()
    out = []
    for e, k, p in rows:
        remaining = int((e.cooldown_until - now).total_seconds()) + 1 if e.cooldown_until and e.cooldown_until > now else 0
        out.append(
            {
                "id": e.id,
                "model_id": e.model_id,
                "provider_id": p.id,
                "provider": p.name,
                "key_id": k.id,
                "key_label": k.label,
                "enabled": e.enabled,
                "priority": e.priority,
                "status": effective_status(e, k, now),
                "cooldown_remaining": remaining,
                "cooldown_until": _iso(e.cooldown_until),
                "last_error": e.last_error or (k.last_error if k.status == "disabled" else None),
            }
        )
    return out


@router.patch("/models/{model_pk}")
async def patch_model(model_pk: int, body: ModelPatch, request: Request):
    async with _db(request) as s:
        e = await s.get(ModelEntry, model_pk)
        if not e:
            raise HTTPException(404, "Model not found")
        if body.priority is not None:
            e.priority = body.priority
        if body.enabled is not None:
            e.enabled = body.enabled
            if body.enabled:  # turning a model back on is an explicit retry
                e.status, e.cooldown_until, e.last_error = "active", None, None
        s.add(e)
        await s.commit()
        return {"id": e.id, "enabled": e.enabled, "priority": e.priority, "status": e.status}


@router.post("/cooldowns/reset")
async def reset_cooldowns(request: Request):
    async with _db(request) as s:
        rows = (
            await s.exec(
                select(ModelEntry).where(
                    (ModelEntry.status == "cooling_down") | (col(ModelEntry.cooldown_until).is_not(None))
                )
            )
        ).all()
        for e in rows:
            e.status, e.cooldown_until = "active", None
            s.add(e)
        await s.commit()
    return {"reset": len(rows)}


# --------------------------------------------------------------------------- settings & logs


@router.get("/settings")
async def get_settings(request: Request):
    async with _db(request) as s:
        return {"strategy": await get_setting(s, "strategy", "waterfall")}


@router.put("/settings")
async def put_settings(body: SettingsIn, request: Request):
    if body.strategy not in STRATEGIES:
        raise HTTPException(422, f"strategy must be one of {', '.join(STRATEGIES)}")
    async with _db(request) as s:
        await set_setting(s, "strategy", body.strategy)
    return {"strategy": body.strategy}


@router.get("/logs")
async def logs(request: Request, limit: int = 50):
    limit = max(1, min(limit, 200))
    async with _db(request) as s:
        rows = (await s.exec(select(RequestLog).order_by(col(RequestLog.id).desc()).limit(limit))).all()
    return [
        {
            "id": r.id,
            "ts": _iso(r.ts),
            "requested_model": r.requested_model,
            "provider": r.provider,
            "model": r.model,
            "key_label": r.key_label,
            "status_code": r.status_code,
            "latency_ms": r.latency_ms,
            "attempts": r.attempts,
            "fallback_reason": r.fallback_reason,
            "stream": r.stream,
        }
        for r in rows
    ]
