"""Optional bearer-token guard for the proxy and admin API."""

import secrets

from fastapi import Request

from app.errors import OpenAIError


async def require_auth(request: Request) -> None:
    expected = request.app.state.settings.proxy_api_key
    if not expected:
        return
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(
        token.strip().encode(), expected.encode()
    ):
        raise OpenAIError(
            401,
            "Invalid or missing proxy API key.",
            "invalid_request_error",
            "invalid_api_key",
            headers={"WWW-Authenticate": "Bearer"},
        )
