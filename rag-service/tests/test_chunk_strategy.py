import unittest
from pathlib import Path

import chunk_strategy
import converted_ingestion
import db
import ingestion

_RAG_ROOT = Path(__file__).resolve().parent.parent


class ChunkStrategyIdentityTests(unittest.TestCase):
    def test_the_strategy_version_is_derived_from_the_parameters_in_use(self):
        # The identifier used to spell the parameters out by hand while the
        # splitters passed separate literals, so a splitter change could leave
        # every stale chunk advertising the current strategy.
        self.assertEqual(
            chunk_strategy.CHUNK_PARAMETER_SUFFIX,
            f"chunk{chunk_strategy.CHUNK_SIZE}-overlap{chunk_strategy.CHUNK_OVERLAP}",
        )
        self.assertTrue(
            chunk_strategy.CHUNK_STRATEGY_VERSION.endswith(
                chunk_strategy.CHUNK_PARAMETER_SUFFIX
            )
        )

    def test_the_current_strategy_version_is_pinned(self):
        # Changing the chunking parameters invalidates every stored chunk. This
        # pin makes that a deliberate act: update it together with a reindex
        # plan, never as a silent side effect of tuning the splitter.
        self.assertEqual(chunk_strategy.CHUNK_SIZE, 1000)
        self.assertEqual(chunk_strategy.CHUNK_OVERLAP, 100)
        self.assertEqual(
            chunk_strategy.CHUNK_STRATEGY_VERSION,
            "markdown-v4:parent-child:metadata-embedding:chunk1000-overlap100",
        )

    def test_the_database_layer_reuses_the_shared_identifier(self):
        self.assertEqual(db.CHUNK_STRATEGY_VERSION, chunk_strategy.CHUNK_STRATEGY_VERSION)
        # The v1 identifier names chunks that are already stored, so it stays a
        # frozen literal rather than being re-derived from current parameters.
        self.assertEqual(
            db.LEGACY_CHUNK_STRATEGY_VERSION,
            "markdown-v1:chunk1000-overlap100",
        )

    def test_the_splitters_take_their_parameters_from_the_shared_module(self):
        for module in (ingestion, converted_ingestion):
            source = Path(module.__file__).read_text(encoding="utf-8")
            self.assertNotIn(
                "chunk_size=1000",
                source,
                f"{module.__name__} must not hard-code the chunk size",
            )
            self.assertNotIn(
                "chunk_overlap=100",
                source,
                f"{module.__name__} must not hard-code the chunk overlap",
            )
            self.assertIn("CHUNK_SIZE", source)
            self.assertIn("CHUNK_OVERLAP", source)


class TokenCountEstimatorTests(unittest.TestCase):
    def test_empty_text_costs_nothing(self):
        self.assertEqual(chunk_strategy.estimate_token_count(""), 0)

    def test_dense_scripts_are_counted_per_character(self):
        self.assertEqual(chunk_strategy.estimate_token_count("标题正文"), 4)
        self.assertEqual(chunk_strategy.estimate_token_count("こんにちは"), 5)
        self.assertEqual(chunk_strategy.estimate_token_count("한국어"), 3)

    def test_alphabetic_text_is_counted_per_four_characters(self):
        self.assertEqual(chunk_strategy.estimate_token_count("abcd"), 1)
        # A trailing partial word still costs a token.
        self.assertEqual(chunk_strategy.estimate_token_count("abcde"), 2)

    def test_mixed_text_combines_both_rules(self):
        # Two dense characters plus four other characters.
        self.assertEqual(chunk_strategy.estimate_token_count("标题abcd"), 3)

    def test_the_estimate_never_shrinks_as_text_grows(self):
        text = "Retrieval augmented generation 检索增强生成 " * 8
        previous = 0
        for end in range(0, len(text) + 1, 7):
            current = chunk_strategy.estimate_token_count(text[:end])
            self.assertGreaterEqual(current, previous)
            previous = current

    def test_the_estimator_is_versioned_and_documented_as_approximate(self):
        # The value lands in a column named token_count, so the fact that it is
        # an estimate has to travel with it.
        self.assertEqual(chunk_strategy.TOKEN_COUNT_ESTIMATOR, "heuristic-cjk-v1")
        migration = (
            _RAG_ROOT.parent
            / "server"
            / "migrations"
            / "0043_conversion_warning_details.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("file_chunks.token_count", migration)
        self.assertIn(chunk_strategy.TOKEN_COUNT_ESTIMATOR, migration)
        self.assertIn("not an exact tokenizer count", migration)


if __name__ == "__main__":
    unittest.main()
