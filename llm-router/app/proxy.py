"""Forward one chat-completion request through the pool, failing over as needed."""

import asyncio
import json
import time
from dataclasses import dataclass

import httpx
from fastapi import Request, Response
from fastapi.responses import StreamingResponse
from sqlmodel import col, delete

from app.errors import OpenAIError
from app.models import RequestLog, utcnow
from app.router_engine import (
    Action,
    Candidate,
    apply_failure,
    classify_exception,
    classify_response,
    earliest_available,
    get_setting,
    record_success,
    select_candidates,
)

LOG_KEEP = 500


@dataclass
class Upstream:
    """Outcome of one upstream call. Either `ok` or one of the failure fields is set."""

    ok: bool = False
    status: int = 0
    headers: httpx.Headers | None = None
    body: bytes = b""
    response: httpx.Response | None = None  # open stream (stream mode, ok only)
    chunks: object | None = None  # async iterator over the rest of the stream
    first_chunk: bytes = b""
    error: BaseException | None = None


async def _call(client: httpx.AsyncClient, cand: Candidate, payload: dict, stream: bool, first_byte_timeout: float) -> Upstream:
    url = f"{cand.provider.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {cand.key.key_value}",
        "Content-Type": "application/json",
    }
    body = {**payload, "model": cand.entry.model_id}
    try:
        if not stream:
            resp = await client.post(url, json=body, headers=headers)
            return Upstream(ok=resp.is_success, status=resp.status_code, headers=resp.headers, body=resp.content)

        req = client.build_request("POST", url, json=body, headers=headers)
        resp = await client.send(req, stream=True)
        if not resp.is_success:
            data = await resp.aread()
            await resp.aclose()
            return Upstream(status=resp.status_code, headers=resp.headers, body=data)
        chunks = resp.aiter_bytes()
        try:
            first = await asyncio.wait_for(anext(chunks), first_byte_timeout)
        except StopAsyncIteration:
            await resp.aclose()
            return Upstream(status=502, headers=resp.headers, body=b"upstream closed stream with no data")
        except BaseException:
            await resp.aclose()
            raise
        return Upstream(ok=True, status=resp.status_code, headers=resp.headers, response=resp, chunks=chunks, first_chunk=first)
    except asyncio.CancelledError:
        raise
    except (httpx.HTTPError, asyncio.TimeoutError) as exc:
        return Upstream(error=exc)


def _sse_error(message: str) -> bytes:
    payload = {"error": {"message": message, "type": "server_error", "code": "upstream_stream_error"}}
    return f"data: {json.dumps(payload)}\n\n".encode()


async def _write_log(state, **fields) -> int:
    async with state.sessionmaker() as session:
        row = RequestLog(**fields)
        session.add(row)
        await session.commit()
        if row.id and row.id > LOG_KEEP:
            await session.exec(delete(RequestLog).where(col(RequestLog.id) <= row.id - LOG_KEEP))
            await session.commit()
        return row.id


async def _annotate_log(state, log_id: int, reason: str) -> None:
    async with state.sessionmaker() as session:
        row = await session.get(RequestLog, log_id)
        if row:
            row.status_code = 502
            row.fallback_reason = "; ".join(filter(None, [row.fallback_reason, reason]))
            session.add(row)
            await session.commit()


async def handle_chat(request: Request, payload: dict) -> Response:
    state = request.app.state
    cfg = state.settings
    requested = str(payload.get("model") or "auto")
    stream = bool(payload.get("stream"))
    started = time.monotonic()
    notes: list[str] = []
    attempts = 0
    dead_keys: set[int] = set()
    passthrough: tuple[Candidate, Upstream] | None = None

    def latency() -> int:
        return int((time.monotonic() - started) * 1000)

    async with state.sessionmaker() as session:
        strategy = await get_setting(session, "strategy", "waterfall")
        candidates = await select_candidates(session, requested, strategy)

        for cand in candidates:
            if cand.key.id in dead_keys:
                continue
            if attempts >= cfg.max_attempts:
                break
            attempts += 1
            result = await _call(state.client, cand, payload, stream, cfg.first_byte_timeout)

            if result.ok:
                await record_success(session, cand)
                headers = {
                    "X-Router-Provider": cand.provider.name,
                    "X-Router-Model": cand.entry.model_id,
                    "X-Router-Attempts": str(attempts),
                }
                reason = "; ".join(notes) or None
                log_id = await _write_log(
                    state,
                    requested_model=requested,
                    provider=cand.provider.name,
                    model=cand.entry.model_id,
                    key_label=cand.key.label,
                    status_code=result.status,
                    latency_ms=latency(),
                    attempts=attempts,
                    fallback_reason=reason,
                    stream=stream,
                )
                if not stream:
                    media = result.headers.get("content-type", "application/json")
                    return Response(result.body, status_code=result.status, media_type=media, headers=headers)
                return _stream_response(state, cand, result, headers, log_id)

            now = utcnow()
            if result.error is not None:
                failure = classify_exception(result.error, now)
            else:
                failure = classify_response(result.status, result.headers, result.body.decode("utf-8", "replace"), now)

            if failure.action is Action.PASSTHROUGH:
                passthrough = (cand, result)
                notes.append(f"{cand.label} → {failure.reason}")
                break

            notes.append(f"{cand.label} → {failure.reason}")
            await apply_failure(session, cand, failure)
            if failure.action is Action.DISABLE_KEY:
                dead_keys.add(cand.key.id)

        if passthrough is not None:
            cand, result = passthrough
            await _write_log(
                state,
                requested_model=requested,
                provider=cand.provider.name,
                model=cand.entry.model_id,
                key_label=cand.key.label,
                status_code=result.status,
                latency_ms=latency(),
                attempts=attempts,
                fallback_reason="; ".join(notes) or None,
                stream=stream,
            )
            media = result.headers.get("content-type", "application/json")
            return Response(
                result.body,
                status_code=result.status,
                media_type=media,
                headers={
                    "X-Router-Provider": cand.provider.name,
                    "X-Router-Model": cand.entry.model_id,
                    "X-Router-Attempts": str(attempts),
                },
            )

        until = await earliest_available(session)

    if until is not None:
        wait = max(1, int((until - utcnow()).total_seconds()) + 1)
        message = (
            f"All candidate models are cooling down or failed. "
            f"The earliest one is available again at {until.strftime('%Y-%m-%dT%H:%M:%S')}Z."
        )
        code = "all_models_exhausted"
        extra = {"Retry-After": str(wait)}
    else:
        message = (
            "No usable models for this request. Add an API key, sync its models, "
            "and make sure the model is enabled."
            if requested == "auto"
            else f"No enabled model named '{requested}' is available."
        )
        if attempts:
            message = "All candidate models failed and none is scheduled to recover. Check keys and models in the dashboard."
            code = "all_models_exhausted"
        else:
            code = "no_models_available"
        extra = {}
    await _write_log(
        state,
        requested_model=requested,
        status_code=503,
        latency_ms=latency(),
        attempts=attempts,
        fallback_reason="; ".join(notes) or message,
        stream=stream,
    )
    raise OpenAIError(
        503,
        message,
        "server_error",
        code,
        headers={"X-Router-Attempts": str(attempts), **extra},
    )


def _stream_response(state, cand: Candidate, result: Upstream, headers: dict[str, str], log_id: int) -> StreamingResponse:
    async def body():
        try:
            yield result.first_chunk
            async for chunk in result.chunks:
                yield chunk
        except Exception as exc:  # noqa: BLE001 - past the first byte we can only report, not retry
            message = f"{cand.label} stream failed: {type(exc).__name__}"
            yield _sse_error(message)
            await _annotate_log(state, log_id, message)
        finally:
            await result.response.aclose()

    return StreamingResponse(
        body(),
        status_code=result.status,
        media_type="text/event-stream",
        headers={**headers, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
