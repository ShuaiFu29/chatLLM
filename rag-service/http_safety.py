import re
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.types import ASGIApp, Message, Receive, Scope, Send


_REQUEST_TOO_LARGE_BODY = b'{"detail":{"code":"request_too_large"}}'
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class StrictRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def validate_http_url(value: str, field_name: str) -> str:
    candidate = value.strip()
    scheme = ""
    try:
        parsed = urlsplit(candidate)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
    except ValueError:
        hostname = None

    if candidate != value or scheme not in {"http", "https"} or not hostname:
        raise ValueError(f"{field_name} must use http or https with a host")
    return candidate


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_body_bytes: int):
        if max_body_bytes <= 0:
            raise ValueError("max_body_bytes must be positive")
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_bytes:
            await self._send_too_large(send)
            return

        buffered_messages: list[Message] = []
        received_bytes = 0
        while True:
            message = await receive()
            if message["type"] == "http.request":
                body = message.get("body", b"")
                received_bytes += len(body)
                if received_bytes > self.max_body_bytes:
                    await self._send_too_large(send)
                    return
                buffered_messages.append(message)
                if not message.get("more_body", False):
                    break
                continue

            buffered_messages.append(message)
            break

        message_index = 0

        async def replay_receive() -> Message:
            nonlocal message_index
            if message_index < len(buffered_messages):
                message = buffered_messages[message_index]
                message_index += 1
                return message
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        for raw_name, raw_value in scope.get("headers", []):
            if raw_name.lower() != b"content-length":
                continue
            try:
                value = int(raw_value)
            except ValueError:
                return None
            return value if value >= 0 else None
        return None

    @staticmethod
    async def _send_too_large(send: Send):
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_REQUEST_TOO_LARGE_BODY)).encode("ascii")),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": _REQUEST_TOO_LARGE_BODY,
        })


def request_id_for(request: Request) -> str:
    candidate = request.headers.get("X-Request-ID", "").strip()
    if _REQUEST_ID_PATTERN.fullmatch(candidate):
        return candidate
    return uuid4().hex


def public_internal_error(request_id: str) -> HTTPException:
    return HTTPException(
        status_code=500,
        detail={"code": "internal_error", "request_id": request_id},
    )


async def public_internal_error_handler(request: Request, _error: Exception) -> JSONResponse:
    request_id = request_id_for(request)
    public_error = public_internal_error(request_id)
    return JSONResponse(
        status_code=public_error.status_code,
        content={"detail": public_error.detail},
        headers={"X-Request-ID": request_id},
    )
