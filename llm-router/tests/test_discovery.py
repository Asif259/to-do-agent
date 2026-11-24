import httpx

from app.discovery import is_chat_model

OR = "https://openrouter.ai/api/v1"


def test_is_chat_model_filters_non_chat_ids():
    assert is_chat_model({"id": "llama-3.3-70b-versatile"})
    assert is_chat_model({"id": "gemini-2.0-flash"})
    for bad in [
        "text-embedding-004",
        "nomic-embed-text",
        "whisper-large-v3",
        "playai-tts",
        "dall-e-3",
        "omni-moderation-latest",
        "gpt-4o-audio-preview",
    ]:
        assert not is_chat_model({"id": bad}), bad


def test_is_chat_model_uses_openrouter_modalities():
    assert is_chat_model({"id": "a/b", "architecture": {"output_modalities": ["text"]}})
    assert not is_chat_model({"id": "a/img", "architecture": {"output_modalities": ["image"]}})
    assert not is_chat_model({"id": "a/img2", "architecture": {"modality": "text->image"}})


async def _add_key(env, preset="openrouter", **extra):
    r = await env.client.post(
        "/admin/keys",
        json={"preset": preset, "label": "main", "api_key": "sk-or-v1-abcdef123456", **extra},
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_add_key_masks_secret_everywhere(env):
    created = await _add_key(env)
    assert "abcdef123456" not in str(created)
    assert created["masked_key"].endswith("3456")

    providers = (await env.client.get("/admin/providers")).json()
    assert "abcdef123456" not in str(providers)
    assert providers[0]["name"] == "OpenRouter"
    assert providers[0]["keys"][0]["masked_key"] == created["masked_key"]


async def test_two_keys_share_one_provider(env):
    await _add_key(env)
    await env.client.post(
        "/admin/keys", json={"preset": "openrouter", "label": "second", "api_key": "sk-other-key-9999"}
    )
    providers = (await env.client.get("/admin/providers")).json()
    assert len(providers) == 1 and len(providers[0]["keys"]) == 2


async def test_custom_provider_requires_base_url(env):
    r = await env.client.post("/admin/keys", json={"preset": "custom", "label": "x", "api_key": "k"})
    assert r.status_code == 422
    r = await env.client.post(
        "/admin/keys",
        json={"preset": "custom", "label": "x", "api_key": "k", "base_url": "http://localhost:11434/v1/", "name": "Ollama"},
    )
    assert r.status_code == 201
    provider = (await env.client.get("/admin/providers")).json()[0]
    assert provider["base_url"] == "http://localhost:11434/v1"
    assert provider["name"] == "Ollama"


async def test_sync_filters_non_chat_models_and_keeps_user_settings(env, upstream):
    key = await _add_key(env)
    listing = {
        "data": [
            {"id": "meta/llama-3:free"},
            {"id": "openai/text-embedding-3-small"},
            {"id": "openai/gpt-4o"},
        ]
    }
    route = upstream.get(f"{OR}/models").mock(return_value=httpx.Response(200, json=listing))

    r = await env.client.post(f"/admin/keys/{key['id']}/sync")

    assert r.status_code == 200
    assert r.json() == {"added": 2, "kept": 0, "removed": 0, "total": 2}
    assert route.calls.last.request.headers["authorization"] == "Bearer sk-or-v1-abcdef123456"
    models = (await env.client.get("/admin/models")).json()
    assert sorted(m["model_id"] for m in models) == ["meta/llama-3:free", "openai/gpt-4o"]

    # user edits survive a re-sync, and models gone upstream are removed
    llama = next(m for m in models if m["model_id"] == "meta/llama-3:free")
    await env.client.patch(f"/admin/models/{llama['id']}", json={"priority": 7})
    upstream.get(f"{OR}/models").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "meta/llama-3:free"}]})
    )
    r = await env.client.post(f"/admin/keys/{key['id']}/sync")
    assert r.json() == {"added": 0, "kept": 1, "removed": 1, "total": 1}
    models = (await env.client.get("/admin/models")).json()
    assert [(m["model_id"], m["priority"]) for m in models] == [("meta/llama-3:free", 7)]


async def test_openrouter_free_only_toggle(env, upstream):
    key = await _add_key(env)
    upstream.get(f"{OR}/models").mock(
        return_value=httpx.Response(
            200, json={"data": [{"id": "meta/llama-3:free"}, {"id": "openai/gpt-4o"}]}
        )
    )
    provider_id = key["provider_id"]
    r = await env.client.patch(f"/admin/providers/{provider_id}", json={"free_only": True})
    assert r.status_code == 200

    await env.client.post(f"/admin/keys/{key['id']}/sync")

    models = (await env.client.get("/admin/models")).json()
    assert [m["model_id"] for m in models] == ["meta/llama-3:free"]


async def test_sync_reports_upstream_failure(env, upstream):
    key = await _add_key(env)
    upstream.get(f"{OR}/models").mock(return_value=httpx.Response(401, json={"error": "nope"}))

    r = await env.client.post(f"/admin/keys/{key['id']}/sync")

    assert r.status_code == 502
    providers = (await env.client.get("/admin/providers")).json()
    assert "401" in providers[0]["keys"][0]["last_error"]


async def test_delete_key_removes_models_and_empty_provider(env, upstream):
    key = await _add_key(env)
    upstream.get(f"{OR}/models").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "meta/llama-3:free"}]})
    )
    await env.client.post(f"/admin/keys/{key['id']}/sync")

    r = await env.client.delete(f"/admin/keys/{key['id']}")

    assert r.status_code == 204
    assert (await env.client.get("/admin/models")).json() == []
    assert (await env.client.get("/admin/providers")).json() == []
