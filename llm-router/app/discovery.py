"""Pull a key's model list from the provider and keep only chat models."""

import httpx

from app.models import Provider

# Substrings that mark a model as not usable for chat completions.
EXCLUDED = (
    "embed",
    "whisper",
    "tts",
    "dall-e",
    "dalle",
    "moderation",
    "audio",
    "rerank",
    "transcribe",
    "speech",
    "imagen",
    "veo-",
)


class DiscoveryError(Exception):
    pass


def is_chat_model(item: dict) -> bool:
    model_id = str(item.get("id", "")).lower()
    if not model_id or any(bad in model_id for bad in EXCLUDED):
        return False
    arch = item.get("architecture") or {}  # OpenRouter reports modalities
    outputs = arch.get("output_modalities")
    if outputs is not None and "text" not in outputs:
        return False
    modality = arch.get("modality")
    if isinstance(modality, str) and "->" in modality and "text" not in modality.split("->")[-1]:
        return False
    return True


def _items(payload) -> list[dict]:
    if isinstance(payload, dict):
        raw = payload.get("data", payload.get("models", []))
    else:
        raw = payload
    out = []
    for item in raw or []:
        if isinstance(item, str):
            item = {"id": item}
        if isinstance(item, dict):
            ident = item.get("id") or item.get("name")
            if ident:
                out.append({**item, "id": str(ident)})
    return out


async def fetch_chat_models(client: httpx.AsyncClient, provider: Provider, api_key: str) -> list[str]:
    url = f"{provider.base_url.rstrip('/')}/models"
    try:
        resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        raise DiscoveryError(f"{type(exc).__name__} while contacting {url}") from exc
    if not resp.is_success:
        snippet = " ".join(resp.text.split())[:160]
        raise DiscoveryError(f"HTTP {resp.status_code}: {snippet}")
    try:
        items = _items(resp.json())
    except ValueError as exc:
        raise DiscoveryError("Provider returned invalid JSON for /models") from exc

    free_only = provider.preset == "openrouter" and provider.free_only
    ids: list[str] = []
    for item in items:
        if not is_chat_model(item):
            continue
        if free_only and not item["id"].endswith(":free"):
            continue
        if item["id"] not in ids:
            ids.append(item["id"])
    return ids
