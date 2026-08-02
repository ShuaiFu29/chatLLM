from reranker import classify_source_role, extract_exact_markers, score_answer_bearing, score_query_coverage


def _clamp_score(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))


def _document_rank_signal(document: dict) -> float:
    for key in ("agentic_score", "rerank_score", "retrieval_confidence", "similarity", "retrieval_score"):
        try:
            value = float(document.get(key) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return _clamp_score(value)
    return 0.0


def _normalize_source_name(value: object) -> str:
    normalized = str(value or "").replace("\\", "/").rsplit("/", 1)[-1].strip().casefold()
    for suffix in (".markdown", ".md"):
        if normalized.endswith(suffix):
            return normalized[:-len(suffix)]
    return normalized


def _document_source_identities(document: dict) -> set[str]:
    metadata = document.get("metadata") or {}
    return {
        normalized
        for value in (
            metadata.get("file_id"),
            document.get("file_id"),
            metadata.get("filename"),
            document.get("filename"),
        )
        if (normalized := _normalize_source_name(value))
    }


def _document_canonical_source(document: dict) -> str:
    metadata = document.get("metadata") or {}
    for value in (
        metadata.get("file_id"),
        document.get("file_id"),
        metadata.get("filename"),
        document.get("filename"),
    ):
        if normalized := _normalize_source_name(value):
            return normalized
    return ""


def evaluate_gold_retrieval_quality(
    expected_source_files: list[str],
    documents: list[dict],
    k: int = 5,
) -> dict:
    """Evaluate source-level retrieval with the gold labels the current schema supports.

    The numeric fields remain zero when the metric is not applicable so existing
    database columns stay compatible. Callers must use ``applicable`` rather than
    interpreting that zero as a measured failure.
    """
    if k <= 0:
        raise ValueError("k must be positive")

    expected_sources = {
        normalized
        for source in expected_source_files or []
        if (normalized := _normalize_source_name(source))
    }
    if not expected_sources:
        return {
            "applicable": False,
            "reason": "no_gold_sources",
            "k": k,
            "retrieval_score": 0.0,
            "recall_at_k": 0.0,
            "mrr_at_k": 0.0,
            "source_precision_at_k": 0.0,
            "matched_sources": [],
            "missing_sources": [],
        }

    top_documents = documents[:k]
    ranked_source_identities = [_document_source_identities(document) for document in top_documents]
    retrieved_sources = {
        source
        for document in top_documents
        if (source := _document_canonical_source(document))
    }
    matched_sources = {
        source
        for source in expected_sources
        if any(source in identities for identities in ranked_source_identities)
    }
    matched_retrieved_sources = {
        canonical_source
        for document, identities in zip(top_documents, ranked_source_identities)
        if identities & expected_sources
        and (canonical_source := _document_canonical_source(document))
    }
    recall_at_k = len(matched_sources) / len(expected_sources)
    source_precision_at_k = (
        len(matched_retrieved_sources) / len(retrieved_sources)
        if retrieved_sources else 0.0
    )
    reciprocal_rank = 0.0
    for rank, identities in enumerate(ranked_source_identities, start=1):
        if identities & expected_sources:
            reciprocal_rank = 1.0 / rank
            break

    recall_at_k = _clamp_score(recall_at_k)
    reciprocal_rank = _clamp_score(reciprocal_rank)
    return {
        "applicable": True,
        "reason": "",
        "k": k,
        "retrieval_score": _clamp_score(recall_at_k * 0.70 + reciprocal_rank * 0.30),
        "recall_at_k": recall_at_k,
        "mrr_at_k": reciprocal_rank,
        "source_precision_at_k": _clamp_score(source_precision_at_k),
        "matched_sources": sorted(matched_sources),
        "missing_sources": sorted(expected_sources - matched_sources),
    }


def _normalize_identity(value: object) -> str:
    return str(value or "").strip().casefold()


def _document_chunk_identities(document: dict) -> set[str]:
    metadata = document.get("metadata") or {}
    matched_children = metadata.get("matched_child_ids")
    if isinstance(matched_children, list) and matched_children:
        return {
            normalized
            for value in matched_children
            if (normalized := _normalize_identity(value))
        }
    return {
        normalized
        for value in (
            document.get("id"),
            document.get("chunk_id"),
            metadata.get("chunk_id"),
        )
        if (normalized := _normalize_identity(value))
    }


def evaluate_gold_chunk_quality(expected_chunk_ids: list[str], documents: list[dict], k: int = 5) -> dict:
    expected = {
        normalized for value in expected_chunk_ids or []
        if (normalized := _normalize_identity(value))
    }
    if not expected:
        return {
            "applicable": False,
            "reason": "no_gold_chunks",
            "k": k,
            "recall_at_k": 0.0,
            "mrr_at_k": 0.0,
            "precision_at_k": 0.0,
            "matched_chunk_ids": [],
            "missing_chunk_ids": [],
        }
    ranked = [_document_chunk_identities(document) for document in documents[:k]]
    retrieved = set().union(*ranked) if ranked else set()
    matched = expected & retrieved
    reciprocal_rank = next(
        (1.0 / rank for rank, identities in enumerate(ranked, start=1) if identities & expected),
        0.0,
    )
    return {
        "applicable": True,
        "reason": "",
        "k": k,
        "recall_at_k": _clamp_score(len(matched) / len(expected)),
        "mrr_at_k": _clamp_score(reciprocal_rank),
        "precision_at_k": _clamp_score(len(matched) / len(retrieved)) if retrieved else 0.0,
        "matched_chunk_ids": sorted(matched),
        "missing_chunk_ids": sorted(expected - matched),
    }


def _normalize_evidence(value: object) -> str:
    return " ".join(str(value or "").split()).casefold()


def evaluate_gold_evidence_quality(expected_evidence: list[str], documents: list[dict], k: int = 5) -> dict:
    expected = [
        normalized for value in expected_evidence or []
        if (normalized := _normalize_evidence(value))
    ]
    if not expected:
        return {
            "applicable": False,
            "reason": "no_gold_evidence",
            "k": k,
            "recall_at_k": 0.0,
            "mrr_at_k": 0.0,
            "matched_evidence": [],
            "missing_evidence": [],
        }
    contents = [_normalize_evidence(document.get("content")) for document in documents[:k]]
    matched = [evidence for evidence in expected if any(evidence in content for content in contents)]
    first_rank = next(
        (
            rank
            for rank, content in enumerate(contents, start=1)
            if any(evidence in content for evidence in expected)
        ),
        None,
    )
    return {
        "applicable": True,
        "reason": "",
        "k": k,
        "recall_at_k": _clamp_score(len(matched) / len(expected)),
        "mrr_at_k": _clamp_score(1.0 / first_rank) if first_rank else 0.0,
        "matched_evidence": matched,
        "missing_evidence": [evidence for evidence in expected if evidence not in matched],
    }


_GRAPH_POLARITIES = {"affirmative", "negative"}
_GRAPH_MODALITIES = {"asserted", "conditional", "planned_or_obligatory", "historical"}


def _normalize_graph_qualifier(value: object, default: str, allowed: set[str]) -> str | None:
    if value in (None, ""):
        return default
    normalized = _normalize_evidence(value).replace(" ", "_")
    return normalized if normalized in allowed else None


def _normalize_graph_expectation(value: object) -> tuple[str, str, str, str, str] | None:
    if not isinstance(value, dict):
        return None
    source = _normalize_evidence(value.get("source"))
    relation = _normalize_evidence(value.get("relation"))
    target = _normalize_evidence(value.get("target"))
    polarity = _normalize_graph_qualifier(value.get("polarity"), "affirmative", _GRAPH_POLARITIES)
    modality = _normalize_graph_qualifier(value.get("modality"), "asserted", _GRAPH_MODALITIES)
    return (
        (source, relation, target, polarity, modality)
        if source and relation and target and polarity and modality
        else None
    )


def _document_graph_relations(document: dict) -> list[dict]:
    metadata = document.get("metadata") or {}
    relations = metadata.get("graph_relations") or []
    return [relation for relation in relations if isinstance(relation, dict)]


def _normalized_graph_relation_key(relation: dict) -> tuple[str, str, str, str, str] | None:
    source = _normalize_evidence(relation.get("from") or relation.get("source"))
    predicate = _normalize_evidence(
        relation.get("type") or relation.get("label") or relation.get("relation_label")
    )
    target = _normalize_evidence(relation.get("to") or relation.get("target"))
    polarity = _normalize_graph_qualifier(relation.get("polarity"), "affirmative", _GRAPH_POLARITIES)
    modality = _normalize_graph_qualifier(relation.get("modality"), "asserted", _GRAPH_MODALITIES)
    return (
        (source, predicate, target, polarity, modality)
        if source and predicate and target and polarity and modality
        else None
    )


def _relation_matches(
    expected: tuple[str, str, str, str, str],
    relation: dict,
    *,
    qualified: bool = True,
) -> bool:
    source, predicate, target, polarity, modality = expected
    relation_source = _normalize_evidence(relation.get("from") or relation.get("source"))
    relation_target = _normalize_evidence(relation.get("to") or relation.get("target"))
    relation_predicates = {
        normalized for value in (relation.get("type"), relation.get("label"), relation.get("relation_label"))
        if (normalized := _normalize_evidence(value))
    }
    if source != relation_source or target != relation_target or predicate not in relation_predicates:
        return False
    if not qualified:
        return True
    relation_polarity = _normalize_graph_qualifier(
        relation.get("polarity"), "affirmative", _GRAPH_POLARITIES,
    )
    relation_modality = _normalize_graph_qualifier(
        relation.get("modality"), "asserted", _GRAPH_MODALITIES,
    )
    return polarity == relation_polarity and modality == relation_modality


def evaluate_gold_graph_quality(expected_relations: list[dict], documents: list[dict], k: int = 5) -> dict:
    expected = [
        normalized for value in expected_relations or []
        if (normalized := _normalize_graph_expectation(value))
    ]
    if not expected:
        return {
            "applicable": False,
            "reason": "no_gold_graph_relations",
            "k": k,
            "recall_at_k": 0.0,
            "mrr_at_k": 0.0,
            "precision_at_k": 0.0,
            "matched_relations": [],
            "missing_relations": [],
            "endpoint_only": {
                "applicable": False,
                "reason": "no_gold_graph_relations",
                "recall_at_k": 0.0,
                "mrr_at_k": 0.0,
                "precision_at_k": 0.0,
            },
        }
    ranked_relations = [_document_graph_relations(document) for document in documents[:k]]

    def calculate(*, qualified: bool) -> dict:
        retrieved_by_key: dict[tuple[str, ...], dict] = {}
        for relations in ranked_relations:
            for relation in relations:
                normalized_key = _normalized_graph_relation_key(relation)
                if normalized_key is None:
                    continue
                dedupe_key = normalized_key if qualified else normalized_key[:3]
                retrieved_by_key.setdefault(dedupe_key, relation)
        retrieved_relations = list(retrieved_by_key.values())
        matched = [
            relation for relation in expected
            if any(_relation_matches(relation, retrieved, qualified=qualified) for retrieved in retrieved_relations)
        ]
        matched_retrieved = [
            relation for relation in retrieved_relations
            if any(_relation_matches(expected_relation, relation, qualified=qualified) for expected_relation in expected)
        ]
        first_rank = next(
            (
                rank
                for rank, relations in enumerate(ranked_relations, start=1)
                if any(
                    _relation_matches(expected_relation, relation, qualified=qualified)
                    for expected_relation in expected
                    for relation in relations
                )
            ),
            None,
        )
        return {
            "recall_at_k": _clamp_score(len(matched) / len(expected)),
            "mrr_at_k": _clamp_score(1.0 / first_rank) if first_rank else 0.0,
            "precision_at_k": (
                _clamp_score(len(matched_retrieved) / len(retrieved_relations))
                if retrieved_relations else 0.0
            ),
            "matched": matched,
        }

    exact = calculate(qualified=True)
    endpoint_only = calculate(qualified=False)
    serialize = lambda relation: {
        "source": relation[0],
        "relation": relation[1],
        "target": relation[2],
        "polarity": relation[3],
        "modality": relation[4],
    }
    return {
        "applicable": True,
        "reason": "",
        "k": k,
        "matching_mode": "exact_qualified",
        "recall_at_k": exact["recall_at_k"],
        "mrr_at_k": exact["mrr_at_k"],
        "precision_at_k": exact["precision_at_k"],
        "matched_relations": [serialize(relation) for relation in exact["matched"]],
        "missing_relations": [
            serialize(relation) for relation in expected if relation not in exact["matched"]
        ],
        "endpoint_only": {
            "applicable": True,
            "reason": "diagnostic_only_qualifiers_ignored",
            "recall_at_k": endpoint_only["recall_at_k"],
            "mrr_at_k": endpoint_only["mrr_at_k"],
            "precision_at_k": endpoint_only["precision_at_k"],
        },
    }


def evaluate_retrieval_quality(query: str, documents: list[dict]) -> dict:
    if not documents:
        return {
            "retrieval_score": 0,
            "citation_score": 0,
            "evidence_score": 0,
            "overall_score": 0,
            "evidence_label": "weak",
            "provenance_score": 0,
            "rank_signal_score": 0,
            "score_type": "heuristic_evidence_quality",
            "calibrated": False,
            "metric_applicability": {
                "retrieval_score": True,
                "evidence_score": True,
                "citation_score": False,
                "exact_marker_coverage": False,
                "answer_bearing_score": False,
                "primary_source_ratio": False,
            },
        }

    coverage_scores = [score_query_coverage(query, str(document.get("content") or ""))[0] for document in documents]
    answer_bearing_scores = [score_answer_bearing(query, str(document.get("content") or "")) for document in documents]
    rank_signals = [_document_rank_signal(document) for document in documents]
    source_roles = [document.get("source_role") or classify_source_role(document) for document in documents]
    query_exact_markers = extract_exact_markers(query)
    document_exact_markers: set[str] = set()
    for document in documents:
        document_exact_markers.update(extract_exact_markers(str(document.get("content") or "")))
        metadata = document.get("metadata") or {}
        document_exact_markers.update(extract_exact_markers(str(metadata.get("filename") or "")))
    exact_marker_applicable = bool(query_exact_markers)
    exact_marker_coverage = (
        len(query_exact_markers & document_exact_markers) / len(query_exact_markers)
        if exact_marker_applicable else 0.0
    )
    cited_count = 0
    source_ids: set[str] = set()
    for document in documents:
        metadata = document.get("metadata") or {}
        if metadata.get("file_id") and metadata.get("filename") and metadata.get("chunk_index") is not None:
            cited_count += 1
        if metadata.get("file_id") or metadata.get("filename"):
            source_ids.add(str(metadata.get("file_id") or metadata.get("filename")))

    average_coverage = sum(coverage_scores) / len(coverage_scores)
    top_rank_signal = max(rank_signals or [0])
    classified_roles = [role for role in source_roles if role in {"primary", "deprecated"}]
    primary_source_ratio = (
        len([role for role in classified_roles if role == "primary"]) / len(classified_roles)
        if classified_roles else None
    )
    average_answer_bearing = sum(answer_bearing_scores) / len(answer_bearing_scores)
    direct_evidence_ratio = len([
        document
        for document, coverage, answer_bearing in zip(documents, coverage_scores, answer_bearing_scores)
        if answer_bearing >= 0.34
        and (float(document.get("evidence_specificity") or 0) >= 0.45 or coverage >= 0.35)
    ]) / len(documents)
    source_diversity = min(len(source_ids), min(len(documents), 4)) / max(1, min(len(documents), 4))

    retrieval_components = [
        (average_coverage, 0.65),
        (direct_evidence_ratio, 0.25),
    ]
    evidence_components = [
        (average_coverage, 0.35),
        (direct_evidence_ratio, 0.20),
        (cited_count / len(documents), 0.20),
        (average_answer_bearing, 0.25),
    ]
    if exact_marker_applicable:
        retrieval_components.append((exact_marker_coverage, 0.10))
        evidence_components.append((exact_marker_coverage, 0.10))
    provenance_score = _clamp_score(cited_count / len(documents))

    def weighted(components: list[tuple[float, float]]) -> float:
        total_weight = sum(weight for _, weight in components)
        return _clamp_score(sum(score * weight for score, weight in components) / total_weight)

    retrieval_score = weighted(retrieval_components)
    evidence_score = weighted(evidence_components)
    overall_score = _clamp_score(retrieval_score * 0.55 + evidence_score * 0.45)

    if (
        overall_score >= 0.68
        and retrieval_score >= 0.52
        and evidence_score >= 0.55
        and provenance_score >= 0.8
        and (not exact_marker_applicable or exact_marker_coverage >= 0.75)
        and direct_evidence_ratio >= 0.30
        and average_answer_bearing >= 0.34
    ):
        label = "strong"
    elif overall_score >= 0.38:
        label = "partial"
    else:
        label = "weak"

    return {
        "retrieval_score": retrieval_score,
        # Compatibility alias only. This measures source provenance completeness,
        # not citations in a generated answer; see metric_applicability below.
        "citation_score": provenance_score,
        "provenance_score": provenance_score,
        "evidence_score": evidence_score,
        "overall_score": overall_score,
        "evidence_label": label,
        "source_diversity_score": _clamp_score(source_diversity),
        "primary_source_ratio": _clamp_score(primary_source_ratio) if primary_source_ratio is not None else None,
        "source_role_applicable": bool(classified_roles),
        "answer_bearing_score": _clamp_score(average_answer_bearing),
        "exact_marker_coverage": _clamp_score(exact_marker_coverage),
        "direct_evidence_ratio": _clamp_score(direct_evidence_ratio),
        "rank_signal_score": _clamp_score(top_rank_signal),
        "score_type": "heuristic_evidence_quality",
        "calibrated": False,
        "metric_applicability": {
            "retrieval_score": True,
            "evidence_score": True,
            "citation_score": False,
            "exact_marker_coverage": exact_marker_applicable,
            "answer_bearing_score": True,
            "primary_source_ratio": bool(classified_roles),
        },
        "citation_score_type": "legacy_provenance_alias",
    }
