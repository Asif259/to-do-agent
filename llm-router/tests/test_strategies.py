import httpx

from tests.conftest import ok_response

HOSTS = ["https://a.test/v1", "https://b.test/v1", "https://c.test/v1"]


async def test_waterfall_always_prefers_lowest_priority_number(env, upstream):
    await env.add_model(HOSTS[0], "slow", priority=50)
    await env.add_model(HOSTS[1], "best", priority=1)
    await env.add_model(HOSTS[2], "mid", priority=10)
    for host in HOSTS:
        upstream.post(f"{host}/chat/completions").mock(return_value=ok_response())

    models = [(await env.chat()).headers["x-router-model"] for _ in range(3)]

    assert models == ["best", "best", "best"]


async def test_round_robin_rotates_through_entries(env, upstream):
    for i, host in enumerate(HOSTS):
        await env.add_model(host, f"m{i}", priority=100 - i)
        upstream.post(f"{host}/chat/completions").mock(return_value=ok_response())
    r = await env.client.put("/admin/settings", json={"strategy": "round_robin"})
    assert r.status_code == 200

    models = [(await env.chat()).headers["x-router-model"] for _ in range(4)]

    assert models == ["m0", "m1", "m2", "m0"]


async def test_round_robin_still_fails_over(env, upstream):
    await env.add_model(HOSTS[0], "m0")
    await env.add_model(HOSTS[1], "m1")
    upstream.post(f"{HOSTS[0]}/chat/completions").mock(return_value=httpx.Response(429))
    upstream.post(f"{HOSTS[1]}/chat/completions").mock(return_value=ok_response())
    await env.client.put("/admin/settings", json={"strategy": "round_robin"})

    r = await env.chat()

    assert r.status_code == 200
    assert r.headers["x-router-model"] == "m1"


async def test_disabled_toggle_is_respected_and_reversible(env, upstream):
    first = await env.add_model(HOSTS[0], "first", priority=1)
    await env.add_model(HOSTS[1], "second", priority=2)
    for host in HOSTS[:2]:
        upstream.post(f"{host}/chat/completions").mock(return_value=ok_response())

    await env.client.patch(f"/admin/models/{first}", json={"enabled": False})
    assert (await env.chat()).headers["x-router-model"] == "second"

    await env.client.patch(f"/admin/models/{first}", json={"enabled": True})
    assert (await env.chat()).headers["x-router-model"] == "first"


async def test_priority_edit_changes_order(env, upstream):
    await env.add_model(HOSTS[0], "first", priority=1)
    second = await env.add_model(HOSTS[1], "second", priority=2)
    for host in HOSTS[:2]:
        upstream.post(f"{host}/chat/completions").mock(return_value=ok_response())

    await env.client.patch(f"/admin/models/{second}", json={"priority": 0})

    assert (await env.chat()).headers["x-router-model"] == "second"


async def test_reset_cooldowns_makes_entries_eligible_again(env, upstream):
    a = await env.add_model(HOSTS[0], "first", priority=1)
    await env.add_model(HOSTS[1], "second", priority=2)
    ra = upstream.post(f"{HOSTS[0]}/chat/completions").mock(
        side_effect=[httpx.Response(429), ok_response()]
    )
    upstream.post(f"{HOSTS[1]}/chat/completions").mock(return_value=ok_response())
    await env.chat()  # first goes into cooldown
    models = (await env.client.get("/admin/models")).json()
    assert next(m for m in models if m["id"] == a)["status"] == "cooling_down"

    r = await env.client.post("/admin/cooldowns/reset")

    assert r.json() == {"reset": 1}
    assert (await env.chat()).headers["x-router-model"] == "first"
    assert ra.call_count == 2


async def test_v1_models_lists_auto_and_unique_enabled_models(env):
    await env.add_model(HOSTS[0], "shared", key="k1", provider="Alpha")
    await env.add_model(HOSTS[1], "shared", key="k2", provider="Beta")
    off = await env.add_model(HOSTS[1], "hidden", key="k2")
    await env.client.patch(f"/admin/models/{off}", json={"enabled": False})

    r = await env.client.get("/v1/models")

    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "list"
    assert [m["id"] for m in body["data"]] == ["auto", "shared"]
    assert all(m["object"] == "model" for m in body["data"])
