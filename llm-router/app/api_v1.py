"""OpenAI-compatible surface: /v1/chat/completions and /v1/models."""

import json

from fastapi import APIRouter, Depends, Request
from sqlmodel import col, select

from app.auth import require_auth
from app.errors import OpenAIError
from app.models import ApiKey, ModelEntry, Provider
from app.proxy import handle_chat

router = APIRouter(prefix="/v1", dependencies=[Depends(require_auth)])


@router.post("/chat/completions")
async def chat_completions(request: Request):
    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        payload = None
    if not isinstance(payload, dict):
        raise OpenAIError(400, "Request body must be a JSON object.", "invalid_request_error", "invalid_json")
    return await handle_chat(request, payload)


@router.get("/models")
async def list_models(request: Request):
    """`auto` plus every distinct model id that is enabled on a working key.

    Models that are only cooling down stay listed so IDE model pickers do not flicker.
    """
    async with request.app.state.sessionmaker() as session:
        rows = (
            await session.exec(
                select(ModelEntry.model_id, Provider.name, ModelEntry.id)
                .join(ApiKey, ModelEntry.key_id == ApiKey.id)
                .join(Provider, ApiKey.provider_id == Provider.id)
                .where(
                    col(ModelEntry.enabled).is_(True),
                    ModelEntry.status != "disabled",
                    ApiKey.status == "active",
                )
                .order_by(ModelEntry.priority, ModelEntry.id)
            )
        ).all()
    data = [{"id": "auto", "object": "model", "created": 0, "owned_by": "llm-router"}]
    seen: set[str] = {"auto"}
    for model_id, provider_name, _ in rows:
        if model_id not in seen:
            seen.add(model_id)
            data.append({"id": model_id, "object": "model", "created": 0, "owned_by": provider_name})
    return {"object": "list", "data": data}
