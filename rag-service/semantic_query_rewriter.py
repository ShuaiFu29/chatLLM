import hashlib
import json
import re

from compatible_api import post_json
from config import settings
from reranker import extract_exact_markers


QUERY_REWRITER_VERSION = "semantic-query-rewrite-v2"
_ROOT_FIELDS = {"standalone_query", "alternative_queries", "context_dependent", "reasoning"}
_IDENTIFIER_RE = re.compile(
    r"\b(?:[A-Z][a-z0-9]+){2,}\b|\b[A-Z]{2,}(?:[-_.][A-Za-z0-9]+)*\b|`([^`\n]+)`"
)
_QUOTED_PHRASE_RE = re.compile(r"[`\"'“”‘’]([^`\"'“”‘’\n]{1,120})[`\"'“”‘’]")
_BARE_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_.])\d+(?:\.\d+)?(?![A-Za-z0-9_.])")
_NEGATION_RE = re.compile(
    r"(?:不能|不可|不要|无需|不需要|不得|未能|没有|并非|不是|不支持|禁止|"
    r"\b(?:not|never|without|cannot|can't|mustn't|shouldn't|isn't|aren't|no)\b)",
    re.IGNORECASE,
)


def _identifier_markers(value: str) -> set[str]:
    markers = set(extract_exact_markers(value))
    for match in _IDENTIFIER_RE.finditer(value or ""):
        markers.add((match.group(1) or match.group(0)).strip().casefold())
    return {marker.casefold() for marker in markers if str(marker).strip()}


def _protected_markers(value: str) -> set[str]:
    """Return retrieval constraints that a semantic rewrite may not alter.

    These markers are validation guards rather than semantic facts. Prefixes
    keep an identifier, quoted phrase, bare number, and negation distinct even
    when their normalized text happens to be equal.
    """
    markers = {f"identifier:{marker}" for marker in _identifier_markers(value)}
    markers.update(
        f"quote:{re.sub(r'\s+', ' ', match.group(1)).strip().casefold()}"
        for match in _QUOTED_PHRASE_RE.finditer(value or "")
        if match.group(1).strip()
    )
    markers.update(f"number:{match.group(0)}" for match in _BARE_NUMBER_RE.finditer(value or ""))
    markers.update(
        f"negation:{re.sub(r'\s+', '', match.group(0)).casefold()}"
        for match in _NEGATION_RE.finditer(value or "")
    )
    return markers


def query_rewriter_fingerprint() -> str:
    if not settings.query_rewrite_enabled:
        return "deterministic-query-rewrite-v1"
    payload = {
        "version": QUERY_REWRITER_VERSION,
        "base_url": settings.query_rewrite_base_url.rstrip("/"),
        "model": settings.query_rewrite_model,
        "max_alternatives": settings.query_rewrite_max_alternatives,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _fallback(resolution: dict, reason: str) -> dict:
    return {
        **resolution,
        "semantic_rewrite": {
            "enabled": bool(settings.query_rewrite_enabled),
            "applied": False,
            "status": "fallback" if settings.query_rewrite_enabled else "disabled",
            "reason": reason,
            "version": QUERY_REWRITER_VERSION,
            "model": settings.query_rewrite_model if settings.query_rewrite_enabled else "",
        },
        "semantic_alternatives": [],
    }


def _response_content(response: dict) -> str:
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("query rewriter returned no choices")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise ValueError("query rewriter returned no content")
    return message["content"].strip()


def _validate_payload(payload: object, resolution: dict, conversation_context: list[dict] | None) -> dict:
    if not isinstance(payload, dict) or set(payload) != _ROOT_FIELDS:
        raise ValueError("query rewriter JSON schema is invalid")
    standalone = payload.get("standalone_query")
    alternatives = payload.get("alternative_queries")
    context_dependent = payload.get("context_dependent")
    reasoning = payload.get("reasoning")
    if not isinstance(standalone, str) or not standalone.strip() or len(standalone.strip()) > 4096:
        raise ValueError("query rewriter standalone_query is invalid")
    if not isinstance(alternatives, list) or len(alternatives) > settings.query_rewrite_max_alternatives:
        raise ValueError("query rewriter alternative_queries is invalid")
    if not isinstance(context_dependent, bool) or not isinstance(reasoning, str):
        raise ValueError("query rewriter metadata is invalid")

    normalized_alternatives: list[str] = []
    for value in alternatives:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 4096:
            raise ValueError("query rewriter alternative query is invalid")
        candidate = value.strip()
        if candidate != standalone.strip() and candidate not in normalized_alternatives:
            normalized_alternatives.append(candidate)

    context_text = "\n".join(
        str(turn.get("content") or "")
        for turn in conversation_context or []
        if isinstance(turn, dict)
    )
    allowed_text = "\n".join([
        str(resolution.get("original_query") or ""),
        str(resolution.get("standalone_query") or ""),
        context_text,
    ])
    allowed_markers = _protected_markers(allowed_text)
    standalone_markers = _protected_markers(standalone)
    original_markers = _protected_markers(str(resolution.get("original_query") or ""))
    output_markers = _protected_markers("\n".join([standalone, *normalized_alternatives]))
    if output_markers - allowed_markers:
        raise ValueError("query rewriter invented a protected retrieval constraint")
    if not original_markers.issubset(standalone_markers):
        raise ValueError("query rewriter removed a protected retrieval constraint")

    return {
        "standalone_query": standalone.strip(),
        "alternative_queries": normalized_alternatives,
        "context_dependent": context_dependent,
        "reasoning": reasoning.strip()[:500],
    }


def rewrite_query_resolution(
    resolution: dict,
    conversation_context: list[dict] | None = None,
) -> dict:
    if not settings.query_rewrite_enabled:
        return _fallback(resolution, "QUERY_REWRITE_ENABLED is false")

    turns = [
        {
            "role": str(turn.get("role") or ""),
            "content": str(turn.get("content") or "")[:2000],
        }
        for turn in (conversation_context or [])[-8:]
        if isinstance(turn, dict) and str(turn.get("content") or "").strip()
    ]
    request_payload = {
        "original_query": str(resolution.get("original_query") or ""),
        "deterministic_standalone_query": str(resolution.get("standalone_query") or ""),
        "deterministic_context_dependent": bool(resolution.get("context_dependent")),
        "conversation": turns,
        "max_alternatives": settings.query_rewrite_max_alternatives,
    }
    try:
        response = post_json(
            settings.query_rewrite_base_url,
            settings.query_rewrite_api_key,
            "/chat/completions",
            {
                "model": settings.query_rewrite_model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Rewrite the user question for document retrieval. Return exactly one JSON object with "
                            "standalone_query, alternative_queries, context_dependent, and reasoning. Preserve every "
                            "identifier, number, version, filename, quoted phrase, and negation. Resolve references only "
                            "from the supplied conversation. Never invent entities or facts. alternative_queries must "
                            "contain at most the requested count of concise semantic retrieval variants."
                        ),
                    },
                    {"role": "user", "content": json.dumps(request_payload, ensure_ascii=False)},
                ],
            },
            settings.query_rewrite_timeout_ms / 1000,
        )
        parsed = json.loads(_response_content(response))
        validated = _validate_payload(parsed, resolution, conversation_context)
    except Exception:
        return _fallback(resolution, "semantic query rewrite failed validation or transport")

    return {
        **resolution,
        "standalone_query": validated["standalone_query"],
        "context_dependent": validated["context_dependent"],
        "resolution_method": "llm_semantic_rewrite",
        "confidence": "high",
        "semantic_alternatives": validated["alternative_queries"],
        "semantic_rewrite": {
            "enabled": True,
            "applied": True,
            "status": "success",
            "reason": validated["reasoning"],
            "version": QUERY_REWRITER_VERSION,
            "model": settings.query_rewrite_model,
        },
    }
