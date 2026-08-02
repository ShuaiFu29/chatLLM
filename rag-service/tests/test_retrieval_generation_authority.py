import unittest
from unittest.mock import patch

import db
import keyword_store
import vector_store
from retrieval import (
    _authoritative_chunk,
    _keyword_documents,
    _prepare_chunk_result,
    _vector_documents_from_hits,
    retrieve_documents,
)

CHUNK_A = "11111111-1111-4111-8111-111111111111"
CHUNK_B = "22222222-2222-4222-8222-222222222222"
FILE_ID = "33333333-3333-4333-8333-333333333333"
GENERATION_ID = "44444444-4444-4444-8444-444444444444"


def authoritative_chunk(chunk_id=CHUNK_A, content="PostgreSQL authority"):
    return {
        "id": chunk_id,
        "file_id": FILE_ID,
        "user_id": "user-1",
        "chunk_index": 7,
        "content": content,
        "metadata": {
            "filename": "canonical.pdf",
            "file_id": FILE_ID,
            "chunk_index": 7,
            "source_locator": {"type": "stale-metadata"},
        },
        "project_space_id": "space-1",
        "filename": "canonical.pdf",
        "document_kind": "pdf",
        "conversion_generation_id": GENERATION_ID,
        "active_conversion_generation_id": GENERATION_ID,
        "source_unit_ids": ["u_11111111111111111111111111111111"],
        "source_locator": {"type": "pdf", "page": 4},
        "content_hash": "a" * 64,
    }


class RetrievalAuthorityDatabaseTests(unittest.TestCase):
    def test_active_chunk_hydration_filters_invalid_ids_deduplicates_and_preserves_order(self):
        with patch("db.get_conn") as get_conn:
            cursor = get_conn.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
            cursor.fetchall.return_value = [
                authoritative_chunk(CHUNK_B, "B"),
                authoritative_chunk(CHUNK_A, "A"),
            ]

            rows = db.get_active_chunks_by_ids(
                ["not-a-uuid", CHUNK_A.upper(), CHUNK_B, CHUNK_A],
                "user-1",
                "space-1",
            )

        self.assertEqual([str(row["id"]) for row in rows], [CHUNK_A, CHUNK_B])
        statement, params = cursor.execute.call_args.args
        self.assertEqual(params, ([CHUNK_A, CHUNK_B], "user-1", "user-1", "space-1", "space-1"))
        self.assertIn("target_chunk.user_id::text = %s", statement)
        self.assertIn("target_file.user_id::text = %s", statement)
        self.assertIn("target_file.status = 'completed'", statement)
        self.assertIn(
            "target_chunk.conversion_generation_id = target_file.active_conversion_generation_id",
            statement,
        )
        self.assertIn("active_generation.status in ('completed', 'completed_with_warnings')", statement)
        self.assertIn("target_file.document_kind = 'markdown'", statement)
        self.assertIn("target_chunk.conversion_generation_id is null", statement)
        self.assertIn("target_chunk.source_locator", statement)

    def test_active_chunk_hydration_skips_database_for_only_invalid_ids(self):
        with patch("db.get_conn") as get_conn:
            self.assertEqual(
                db.get_active_chunks_by_ids(["", None, "bad"], "user-1", None),
                [],
            )
        get_conn.assert_not_called()

    def test_postgres_bm25_uses_the_same_generation_authority_predicate(self):
        with patch("db.get_conn") as get_conn:
            cursor = get_conn.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
            cursor.fetchall.return_value = []

            db.search_chunks_by_text("deployment", "user-1", "space-1", 12)

        statement, params = cursor.execute.call_args.args
        self.assertIn("target_file.active_conversion_generation_id", statement)
        self.assertIn("target_file.status = 'completed'", statement)
        self.assertIn("active_generation.status in ('completed', 'completed_with_warnings')", statement)
        self.assertIn("target_file.document_kind = 'markdown'", statement)
        self.assertIn("target_chunk.source_unit_ids", statement)
        self.assertEqual(
            params,
            ("deployment", "user-1", "user-1", "space-1", "space-1", "deployment", 12),
        )

    def test_parent_loading_uses_the_same_generation_authority_predicate(self):
        with patch("db.get_conn") as get_conn:
            cursor = get_conn.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
            cursor.fetchall.return_value = []

            db.list_parent_chunks_for_matches(
                "user-1",
                "space-1",
                [{
                    "metadata": {
                        "file_id": FILE_ID,
                        "parent_section_id": "section-1",
                        "chunk_index": 9,
                    },
                }],
                2,
                4,
            )

        statement, params = cursor.execute.call_args.args
        self.assertIn("target_file.status = 'completed'", statement)
        self.assertIn("active_generation.status in ('completed', 'completed_with_warnings')", statement)
        self.assertIn("target_file.document_kind = 'markdown'", statement)
        self.assertIn("target_chunk.source_locator", statement)
        self.assertEqual(params[3:7], ("user-1", "user-1", "space-1", "space-1"))


class RetrievalAuthorityLaneTests(unittest.TestCase):
    def test_explicit_postgres_provenance_clears_stale_metadata_mirrors(self):
        chunk = authoritative_chunk()
        chunk.update({
            "conversion_generation_id": None,
            "source_unit_ids": [],
            "source_locator": {},
            "metadata": {
                **chunk["metadata"],
                "conversion_generation_id": "stale-generation",
                "source_unit_ids": ["stale-unit"],
                "source_locator": {"type": "stale"},
            },
        })

        authoritative = _authoritative_chunk(chunk)
        prepared = _prepare_chunk_result(
            authoritative,
            similarity=0.5,
            lexical_score=0,
            retrieval_score=1,
            retrieval_mode="vector",
        )

        self.assertIsNone(authoritative["metadata"]["conversion_generation_id"])
        self.assertEqual(authoritative["metadata"]["source_unit_ids"], [])
        self.assertEqual(authoritative["metadata"]["source_locator"], {})
        self.assertIsNone(prepared["metadata"]["conversion_generation_id"])
        self.assertEqual(prepared["metadata"]["source_unit_ids"], [])
        self.assertEqual(prepared["metadata"]["source_locator"], {})

    def test_vector_lane_uses_only_score_from_milvus(self):
        canonical = authoritative_chunk()
        with patch("retrieval.get_active_chunks_by_ids", return_value=[canonical]) as hydrate:
            documents = _vector_documents_from_hits(
                [{
                    "chunk_id": CHUNK_A,
                    "similarity": 0.91,
                    "filename": "spoofed.md",
                    "file_id": "spoofed-file",
                    "chunk_index": 999,
                    "content": "spoofed content",
                }],
                "user-1",
                "space-1",
            )

        hydrate.assert_called_once_with([CHUNK_A], "user-1", "space-1")
        self.assertEqual(documents[0]["content"], "PostgreSQL authority")
        self.assertEqual(documents[0]["metadata"]["filename"], "canonical.pdf")
        self.assertEqual(documents[0]["metadata"]["file_id"], FILE_ID)
        self.assertEqual(documents[0]["metadata"]["chunk_index"], 7)
        self.assertEqual(documents[0]["metadata"]["source_locator"], {"type": "pdf", "page": 4})
        self.assertEqual(documents[0]["similarity"], 0.91)

    def test_stale_elasticsearch_hits_fall_back_to_authoritative_postgres_bm25(self):
        fallback = authoritative_chunk(content="PostgreSQL lexical fallback")
        fallback["lexical_score"] = 2.5
        with patch(
            "retrieval.search_keyword_chunks",
            return_value=[{"chunk_id": CHUNK_A, "lexical_score": 9.0}],
        ), patch(
            "retrieval.get_active_chunks_by_ids",
            return_value=[],
        ), patch(
            "retrieval.search_chunks_by_text",
            return_value=[fallback],
        ) as postgres_search:
            documents = _keyword_documents("deployment", "user-1", "space-1", 20)

        self.assertTrue(documents.backend_degraded)
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0]["content"], "PostgreSQL lexical fallback")
        self.assertEqual(documents[0]["retrieval_score"], 1.0)
        postgres_search.assert_called_once_with(
            query="deployment",
            user_id="user-1",
            project_space_id="space-1",
            limit=20,
        )

    def test_retrieval_oversamples_vector_and_keyword_candidates_for_every_scope(self):
        with patch("retrieval._retrieve_vector_documents", return_value=[]) as vector_lane, patch(
            "retrieval._keyword_documents",
            return_value=[],
        ) as keyword_lane:
            retrieve_documents(
                "deployment",
                "user-1",
                project_space_id=None,
                limit=5,
                routes=["vector", "bm25"],
            )

        self.assertEqual(vector_lane.call_args.args[3], 25)
        self.assertEqual(keyword_lane.call_args.args[3], 25)


class ExternalCandidateShapeTests(unittest.TestCase):
    def test_milvus_search_returns_only_chunk_id_and_similarity(self):
        class FakeClient:
            def search(self, **kwargs):
                self.kwargs = kwargs
                return [[{
                    "distance": 0.8,
                    "entity": {
                        "chunk_id": CHUNK_A,
                        "filename": "must-not-escape.md",
                        "content": "must not escape",
                    },
                }]]

        client = FakeClient()
        with patch("vector_store.get_client", return_value=client), patch(
            "vector_store.ensure_collection",
        ), patch("vector_store._has_project_space_field", return_value=True):
            hits = vector_store.search_vectors("user-1", [0.1, 0.2], 5, 0.1, "space-1")

        self.assertEqual(client.kwargs["output_fields"], ["chunk_id"])
        self.assertEqual(client.kwargs["consistency_level"], "Strong")
        self.assertEqual(hits, [{"chunk_id": CHUNK_A, "similarity": 0.8}])

    def test_elasticsearch_search_returns_only_chunk_id_and_lexical_score(self):
        with patch.object(keyword_store.settings, "elasticsearch_enabled", True), patch.object(
            keyword_store,
            "_request",
            return_value={
                "hits": {
                    "hits": [{
                        "_id": CHUNK_A,
                        "_score": 3.5,
                        "_source": {"content": "must not escape"},
                    }],
                },
            },
        ) as request:
            hits = keyword_store.search_keyword_chunks("deployment", "user-1", "space-1")

        body = request.call_args.args[2]
        self.assertIs(body["_source"], False)
        self.assertEqual(hits, [{"chunk_id": CHUNK_A, "lexical_score": 3.5}])


if __name__ == "__main__":
    unittest.main()
