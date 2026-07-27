import re
from typing import Iterable

from reranker import extract_exact_markers


_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "what",
    "when",
    "where",
    "which",
    "why",
    "with",
}

_CJK_STOPWORDS = {
    "关系",
    "内容",
    "文档",
    "问题",
    "说明",
    "情况",
}

_CJK_QUESTION_SPLIT_RE = re.compile(
    r"(?:请问|请说明|请介绍|请分析|请列出|请解释|请概述|请总结|"
    r"如何|怎么|怎样|为什么|为何|是什么|有哪些|有何|有什么|是否|能否|可否)"
)

_CJK_CONNECTOR_SPLIT_RE = re.compile(r"(?:以及|或者|和|与|及|或)")

_FOLLOW_UP_PREFIX_RE = re.compile(
    r"^(?:那|那么|其中|前者|后者|上述|这个|那个|该|这些|它|其|"
    r"and\s+what\b|what\s+about\b|how\s+about\b|then(?:\s+what)?\b|what\s+else\b)",
    re.IGNORECASE,
)

_REFERENCE_TERM_RE = re.compile(
    r"(?:它|其|(?<!应)该(?:服务|系统|组件|机制|策略|规则|流程|方案)?|这个|那个|这些|上述|前者|后者|"
    r"\b(?:it|its|this|that|these|those|former|latter)\b)",
    re.IGNORECASE,
)

_ELLIPTICAL_FOLLOW_UP_RE = re.compile(
    r"^(?:(?:还|再)(?:有)?(?:哪些|什么)?(?:限制|条件|区别|影响|风险|步骤)(?:呢|吗)?|"
    r"(?:失败|成功|完成|超时|重试|取消)(?:后|以后|时|了)?(?:会)?(?:怎样|如何|怎么办|呢|吗)?|"
    r"(?:然后|接着|另外)(?:呢|怎么办)?|(?:为什么|怎么|如何)(?:呢)?)\s*[？?]?$",
    re.IGNORECASE,
)

_IMPLICIT_FOLLOW_UP_RE = re.compile(
    r"^(?:如果|假如|要是|遇到|发生|当).{0,30}(?:呢|吗|怎么办|会怎样|会如何|如何处理)?|"
    r"^(?:具体|实际)(?:要)?(?:怎么|如何)(?:配置|实现|处理|排查|验证|部署|使用)(?:呢|吗)?|"
    r"^(?:能否|可以|能)?(?:举|给)(?:个|一个)?(?:例子|示例)(?:呢|吗)?|"
    r"^(?:和|与).{1,40}(?:相比|比较)(?:有什么)?(?:区别|差异|优劣)?(?:呢|吗)?|"
    r"^(?:这|那)?对.{1,30}(?:有什么)?(?:影响|风险|限制)(?:呢|吗)?|"
    r"^第(?:[一二三四五六七八九十]|\d+)(?:个|种|条|点|项|步|阶段|方案|方法).{0,30}(?:呢|吗)?$",
    re.IGNORECASE,
)

def _normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", query.strip())


def _normalized_conversation_turns(conversation_context: Iterable[dict] | None) -> list[dict[str, str]]:
    turns: list[dict[str, str]] = []
    for raw_turn in conversation_context or []:
        if not isinstance(raw_turn, dict):
            continue
        role = str(raw_turn.get("role") or "").strip().lower()
        content = _normalize_query(str(raw_turn.get("content") or ""))
        if role not in {"user", "assistant"} or not content:
            continue
        turns.append({"role": role, "content": content[:2000]})
    return turns[-8:]


def _looks_context_dependent(query: str) -> bool:
    normalized = _normalize_query(query)
    if not normalized:
        return False
    if _REFERENCE_TERM_RE.search(normalized) or _FOLLOW_UP_PREFIX_RE.search(normalized):
        return True
    return bool(
        _ELLIPTICAL_FOLLOW_UP_RE.match(normalized)
        or _IMPLICIT_FOLLOW_UP_RE.match(normalized)
    )


def resolve_standalone_query(
    query: str,
    conversation_context: Iterable[dict] | None = None,
) -> dict:
    """Resolve a conversational follow-up into a retrieval-safe standalone query.

    This deterministic resolver deliberately carries forward the previous user
    question instead of pretending that it can always identify an ambiguous
    pronoun. A configured semantic rewriter may replace this result later, but
    the fallback remains auditable and cannot invent entities outside history.
    """
    original = _normalize_query(query)
    turns = _normalized_conversation_turns(conversation_context)
    previous_user_turns = [
        turn["content"]
        for turn in turns
        if turn["role"] == "user" and turn["content"] != original
    ]
    previous_question = previous_user_turns[-1] if previous_user_turns else ""
    context_dependent = _looks_context_dependent(original)

    if not context_dependent or not previous_question:
        return {
            "original_query": original,
            "standalone_query": original,
            "context_dependent": context_dependent,
            "resolution_method": "not_required" if not context_dependent else "context_unavailable",
            "confidence": "high" if not context_dependent else "low",
            "context_turns_used": 0,
            "reference_terms": sorted(set(_REFERENCE_TERM_RE.findall(original))),
        }

    # A follow-up may itself follow an earlier elliptical turn. Walk backwards
    # until the nearest standalone user question so a chain such as
    # "Redis 如何持久化" -> "AOF 呢" -> "如果损坏怎么办" does not lose Redis.
    context_questions = [previous_question]
    for earlier_question in reversed(previous_user_turns[:-1]):
        if len(context_questions) >= 3 or not _looks_context_dependent(context_questions[0]):
            break
        context_questions.insert(0, earlier_question)

    previous = "；上下文追问：".join(
        question.rstrip("。！？!?；; ")
        for question in context_questions
    )
    follow_up = original.lstrip("，,。；;:： ")
    standalone = f"{previous}；追问：{follow_up}"
    return {
        "original_query": original,
        "standalone_query": standalone[:4096],
        "context_dependent": True,
        "resolution_method": "previous_user_turn_context",
        "confidence": "medium",
        "context_turns_used": len(context_questions),
        "reference_terms": sorted(set(_REFERENCE_TERM_RE.findall(original))),
    }


def _keywords(query: str) -> list[str]:
    words = []
    seen = set()
    for token in re.findall(r"[A-Za-z][A-Za-z0-9-]*", query):
        normalized = token.lower()
        is_short_acronym = len(token) >= 2 and token.upper() == token and re.search(r"[A-Z]", token)
        if (len(normalized) > 2 or is_short_acronym) and normalized not in _STOPWORDS and normalized not in seen:
            seen.add(normalized)
            words.append(token if is_short_acronym else normalized)

    for cjk_run in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}", query):
        for question_part in _CJK_QUESTION_SPLIT_RE.split(cjk_run):
            for token in _CJK_CONNECTOR_SPLIT_RE.split(question_part):
                normalized = token.strip()
                if (
                    len(normalized) >= 2
                    and normalized not in _CJK_STOPWORDS
                    and normalized not in seen
                ):
                    seen.add(normalized)
                    words.append(normalized)

    return words


def _append_unique(values: list[str], value: str):
    normalized = _normalize_query(value)
    identity = re.sub(r"[^\w\u3400-\u4dbf\u4e00-\u9fff]+", "", normalized).casefold()
    existing_identities = {
        re.sub(r"[^\w\u3400-\u4dbf\u4e00-\u9fff]+", "", item).casefold()
        for item in values
    }
    if normalized and identity and identity not in existing_identities:
        values.append(normalized)


def plan_queries(query: str, max_queries: int = 3) -> list[str]:
    """Create deterministic retrieval queries for the first Agentic RAG pass."""
    original = _normalize_query(query)
    if not original:
        return []

    planned: list[str] = []
    _append_unique(planned, original)

    keywords = _keywords(original)
    exact_markers = sorted(extract_exact_markers(original))

    if exact_markers:
        _append_unique(planned, " ".join(exact_markers + keywords[:6]))

    if keywords:
        _append_unique(planned, " ".join(keywords[:8]))

    if len(keywords) > 3:
        _append_unique(planned, " ".join(keywords[-8:]))

    return planned[:max(1, max_queries)]
