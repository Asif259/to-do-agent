"""OpenAI-format errors."""

from fastapi import Request
from fastapi.responses import JSONResponse


class OpenAIError(Exception):
    def __init__(
        self,
        status_code: int,
        message: str,
        type_: str = "invalid_request_error",
        code: str | None = None,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.type = type_
        self.code = code
        self.headers = headers or {}


def error_body(message: str, type_: str, code: str | None) -> dict:
    return {"error": {"message": message, "type": type_, "param": None, "code": code}}


async def openai_error_handler(_: Request, exc: OpenAIError) -> JSONResponse:
    return JSONResponse(
        error_body(exc.message, exc.type, exc.code),
        status_code=exc.status_code,
        headers=exc.headers,
    )
