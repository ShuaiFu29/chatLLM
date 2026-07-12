import re
from typing import Any


_ERROR_CODE_PATTERN = re.compile(r"^(?:[A-Z][A-Z0-9_.-]{0,63}|[0-9][A-Z0-9]{4})$")
_SAFE_ERROR_NAMES = {
    "AssertionError",
    "ConnectionError",
    "DatabaseError",
    "HTTPError",
    "IndexError",
    "KeyError",
    "LookupError",
    "OSError",
    "RuntimeError",
    "TimeoutError",
    "TypeError",
    "UnicodeError",
    "URLError",
    "ValueError",
}


def _read_property(value: object, name: str) -> Any:
    try:
        return getattr(value, name, None)
    except Exception:
        return None


def _safe_status(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 100 <= value <= 599 else None


def safe_error_fields(error: object) -> dict[str, object]:
    name = type(error).__name__
    fields: dict[str, object] = {
        "name": name if name in _SAFE_ERROR_NAMES else "UnknownError",
    }

    raw_code = _read_property(error, "code")
    code = str(raw_code) if isinstance(raw_code, int) and not isinstance(raw_code, bool) else raw_code
    if isinstance(code, str) and _ERROR_CODE_PATTERN.fullmatch(code):
        fields["code"] = code

    status = _safe_status(_read_property(error, "status_code"))
    if status is None:
        status = _safe_status(_read_property(error, "status"))
    if status is None:
        status = _safe_status(_read_property(_read_property(error, "response"), "status"))
    if status is not None:
        fields["status"] = status

    return fields
