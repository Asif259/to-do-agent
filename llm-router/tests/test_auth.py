async def test_v1_requires_bearer_when_proxy_key_set(secured_env):
    c = secured_env.client
    assert (await c.get("/v1/models")).status_code == 401
    assert (await c.get("/v1/models", headers={"Authorization": "Bearer wrong"})).status_code == 401
    r = await c.get("/v1/models", headers={"Authorization": "Bearer sekret"})
    assert r.status_code == 200


async def test_401_uses_openai_error_shape(secured_env):
    r = await secured_env.client.post("/v1/chat/completions", json={"messages": []})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"


async def test_admin_api_is_protected_too(secured_env):
    c = secured_env.client
    assert (await c.get("/admin/providers")).status_code == 401
    assert (await c.get("/admin/providers", headers={"Authorization": "Bearer sekret"})).status_code == 200


async def test_dashboard_page_is_served_without_auth(secured_env):
    r = await secured_env.client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


async def test_open_when_no_proxy_key(env):
    assert (await env.client.get("/v1/models")).status_code == 200
