from datetime import timedelta

import httpx

from app.models import ModelEntry, utcnow
from tests.conftest import ok_response, sse_response

A = "https://a.test/v1"
B = "https://b.test/v1"


def near(actual, expected, tolerance=5):
    return abs((actual - expected).total_seconds()) <= tolerance


async def test_success_sets_router_headers_and_rewrites_model(env, upstream):
    await env.add_model(A, "real-model", key="sk-a", provider="Alpha")
    route = upstream.post(f"{A}/chat/completions").mock(return_value=ok_response("hello back"))

    r = await env.chat()

    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "hello back"
    assert r.headers["x-router-provider"] == "Alpha"
    assert r.headers["x-router-model"] == "real-model"
    assert r.headers["x-router-attempts"] == "1"
    sent = route.calls.last.request
    assert sent.headers["authorization"] == "Bearer sk-a"
    assert b'"model":"real-model"' in sent.content.replace(b" ", b"")


async def test_429_with_retry_after_cools_down_and_falls_back(env, upstream):
    a = await env.add_model(A, "ma", priority=1)
    await env.add_model(B, "mb", priority=2)
    ra = upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "120"}, json={"error": "slow"})
    )
    rb = upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 200
    assert r.headers["x-router-model"] == "mb"
    assert r.headers["x-router-attempts"] == "2"
    entry = await env.get(ModelEntry, a)
    assert entry.status == "cooling_down"
    assert near(entry.cooldown_until, utcnow() + timedelta(seconds=120))

    await env.chat()
    assert ra.call_count == 1, "cooling entry must be skipped on the next request"
    assert rb.call_count == 2


async def test_429_defaults_to_60_seconds(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(429, json={"error": {"message": "Too many requests"}})
    )
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    await env.chat()

    entry = await env.get(ModelEntry, a)
    assert near(entry.cooldown_until, utcnow() + timedelta(seconds=60))


async def test_429_daily_quota_waits_until_utc_midnight(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(
            429,
            json={"error": {"message": "Rate limit reached on tokens per day (TPD): Limit 100000"}},
        )
    )
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    await env.chat()

    now = utcnow()
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    entry = await env.get(ModelEntry, a)
    assert entry.cooldown_until == midnight


async def test_401_disables_the_whole_key(env, upstream):
    first = await env.add_model(A, "m1", key="sk-bad", priority=1)
    second = await env.add_model(A, "m2", key="sk-bad", priority=2)
    await env.add_model(B, "mb", priority=3)
    ra = upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": {"message": "Invalid API key"}})
    )
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 200
    assert r.headers["x-router-model"] == "mb"
    assert ra.call_count == 1, "second model on the dead key must not be tried"
    key = await env.key_of(first)
    assert key.status == "disabled"
    assert "401" in key.last_error
    assert (await env.get(ModelEntry, second)).status == "active"


async def test_402_disables_the_key(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(402, text="no credits"))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    await env.chat()

    assert (await env.key_of(a)).status == "disabled"


async def test_403_disables_only_that_model(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(403, text="forbidden"))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    await env.chat()

    assert (await env.get(ModelEntry, a)).status == "disabled"
    assert (await env.key_of(a)).status == "active"


async def test_503_short_cooldown_and_fallback(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(503, text="overloaded"))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 200
    entry = await env.get(ModelEntry, a)
    assert entry.status == "cooling_down"
    assert near(entry.cooldown_until, utcnow() + timedelta(seconds=30))


async def test_connection_timeout_short_cooldown_and_fallback(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(side_effect=httpx.ConnectTimeout("slow"))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 200
    entry = await env.get(ModelEntry, a)
    assert near(entry.cooldown_until, utcnow() + timedelta(seconds=30))
    assert "timeout" in entry.last_error.lower()


async def test_400_is_passed_through_without_penalty(env, upstream):
    a = await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(400, json={"error": {"message": "bad messages"}})
    )
    rb = upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 400
    assert r.json()["error"]["message"] == "bad messages"
    assert rb.call_count == 0
    assert (await env.get(ModelEntry, a)).status == "active"


async def test_all_exhausted_returns_503_with_earliest_time(env, upstream):
    await env.add_model(A, priority=1)
    await env.add_model(B, priority=2)
    upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "90"})
    )
    upstream.post(f"{B}/chat/completions").mock(return_value=httpx.Response(503))

    r = await env.chat()

    assert r.status_code == 503
    err = r.json()["error"]
    assert err["code"] == "all_models_exhausted"
    assert err["type"] == "server_error"
    # B cools down for 30s, which is earlier than A's 90s
    expected = utcnow() + timedelta(seconds=30)
    assert expected.strftime("%Y-%m-%dT%H:%M") in err["message"]
    assert 1 <= int(r.headers["retry-after"]) <= 31
    assert r.headers["x-router-attempts"] == "2"


async def test_no_models_configured(env):
    r = await env.chat()
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "no_models_available"


async def test_explicit_model_only_uses_matching_entries(env, upstream):
    await env.add_model(A, "other", priority=1)
    await env.add_model(B, "wanted", priority=2)
    ra = upstream.post(f"{A}/chat/completions").mock(return_value=ok_response())
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat(model="wanted")

    assert r.headers["x-router-model"] == "wanted"
    assert ra.call_count == 0


async def test_explicit_model_fails_over_between_keys(env, upstream):
    await env.add_model(A, "shared", key="sk-1", priority=1)
    await env.add_model(B, "shared", key="sk-2", priority=2)
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(429))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    r = await env.chat(model="shared")

    assert r.status_code == 200
    assert r.headers["x-router-attempts"] == "2"


async def test_request_is_logged_with_fallback_reason(env, upstream):
    await env.add_model(A, "ma", priority=1, provider="Alpha")
    await env.add_model(B, "mb", priority=2, provider="Beta")
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(429))
    upstream.post(f"{B}/chat/completions").mock(return_value=ok_response())

    await env.chat()

    (log,) = await env.logs()
    assert (log.provider, log.model, log.status_code, log.attempts) == ("Beta", "mb", 200, 2)
    assert "Alpha" in log.fallback_reason and "429" in log.fallback_reason
    assert log.requested_model == "auto"


async def test_stream_fails_over_before_first_chunk(env, upstream):
    await env.add_model(A, "ma", priority=1)
    await env.add_model(B, "mb", priority=2)
    upstream.post(f"{A}/chat/completions").mock(return_value=httpx.Response(429))
    upstream.post(f"{B}/chat/completions").mock(
        return_value=sse_response('{"choices":[{"delta":{"content":"he"}}]}', '{"choices":[{"delta":{"content":"llo"}}]}')
    )

    r = await env.chat(stream=True)

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["x-router-model"] == "mb"
    assert r.headers["x-router-attempts"] == "2"
    assert '"content":"he"' in r.text and r.text.rstrip().endswith("data: [DONE]")


async def test_stream_error_after_first_chunk_ends_with_sse_error(env, upstream):
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"par"}}]}\n\n'
            raise httpx.ReadError("connection reset")

    await env.add_model(A, "ma")
    upstream.post(f"{A}/chat/completions").mock(
        return_value=httpx.Response(200, stream=Broken(), headers={"content-type": "text/event-stream"})
    )

    r = await env.chat(stream=True)

    assert r.status_code == 200
    assert '"content":"par"' in r.text
    assert "upstream_stream_error" in r.text


async def test_invalid_json_body(env):
    r = await env.client.post("/v1/chat/completions", content=b"not json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_json"


async def test_success_clears_expired_cooldown(env, upstream):
    a = await env.add_model(A)
    async with env.sessionmaker() as s:
        entry = await s.get(ModelEntry, a)
        entry.status = "cooling_down"
        entry.cooldown_until = utcnow() - timedelta(seconds=5)
        entry.last_error = "429"
        s.add(entry)
        await s.commit()
    upstream.post(f"{A}/chat/completions").mock(return_value=ok_response())

    r = await env.chat()

    assert r.status_code == 200
    entry = await env.get(ModelEntry, a)
    assert (entry.status, entry.cooldown_until, entry.last_error) == ("active", None, None)
