import json
import sys
import unittest
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from converted_ingestion import (
    ConvertedIngestionError,
    split_converted_document,
)


def build_artifacts(
    units: list[tuple[str, dict]],
) -> tuple[bytes, bytes, list[dict]]:
    document = bytearray()
    records = []
    for index, (text, locator) in enumerate(units, start=1):
        if index > 1:
            document.extend(b"\n")
        unit_id = f"u_{index:032x}"
        document.extend(f"<!-- source-unit:{unit_id} -->\n".encode())
        start = len(document)
        document.extend(text.encode("utf-8"))
        end = len(document)
        records.append(
            {
                "schema_version": "source-map-unit-v1",
                "unit_id": unit_id,
                "markdown": {"byte_start": start, "byte_end": end},
                "source": locator,
            }
        )
    return bytes(document), compress_records(records), records


def compress_records(records: list[dict]) -> bytes:
    payload = "".join(
        json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
        for record in records
    ).encode("utf-8")
    return zstandard.ZstdCompressor(level=3, write_checksum=True).compress(payload)


class ConvertedIngestionTests(unittest.TestCase):
    def test_seven_source_types_produce_stable_locator_envelopes(self):
        cases = {
            "markdown": (
                [
                    {
                        "type": "markdown",
                        "kind": "paragraph",
                        "line_start": 1,
                        "line_end": 1,
                    },
                    {
                        "type": "markdown",
                        "kind": "paragraph",
                        "line_start": 2,
                        "line_end": 3,
                    },
                ],
                {"line_start": 1, "line_end": 3},
            ),
            "plaintext": (
                [
                    {
                        "type": "plaintext",
                        "kind": "paragraph",
                        "line_start": 4,
                        "line_end": 4,
                    },
                    {
                        "type": "plaintext",
                        "kind": "paragraph",
                        "line_start": 5,
                        "line_end": 7,
                    },
                ],
                {"line_start": 4, "line_end": 7},
            ),
            "pdf": (
                [
                    {"type": "pdf", "kind": "page_text", "page": 2, "block": 1},
                    {"type": "pdf", "kind": "page_text", "page": 3, "block": 1},
                ],
                {"page_start": 2, "page_end": 3},
            ),
            "docx": (
                [
                    {"type": "docx", "kind": "paragraph", "paragraph": 7},
                    {
                        "type": "docx",
                        "kind": "table",
                        "table": 2,
                        "row_start": 1,
                        "row_end": 3,
                    },
                ],
                {
                    "paragraph_start": 7,
                    "paragraph_end": 7,
                    "table_start": 2,
                    "table_end": 2,
                },
            ),
            "pptx": (
                [
                    {"type": "pptx", "kind": "text", "slide": 4, "shape": 2},
                    {"type": "pptx", "kind": "text", "slide": 5, "shape": 1},
                ],
                {"slide_start": 4, "slide_end": 5},
            ),
            "xlsx": (
                [
                    {
                        "type": "xlsx",
                        "kind": "table",
                        "sheet": "数据",
                        "sheet_index": 1,
                        "row_start": 1,
                        "row_end": 10,
                    },
                    {
                        "type": "xlsx",
                        "kind": "table",
                        "sheet": "数据",
                        "sheet_index": 1,
                        "row_start": 11,
                        "row_end": 20,
                    },
                ],
                {"sheet": "数据", "sheet_index": 1, "row_start": 1, "row_end": 20},
            ),
            "csv": (
                [
                    {"type": "csv", "kind": "table", "row_start": 1, "row_end": 25},
                    {"type": "csv", "kind": "table", "row_start": 26, "row_end": 50},
                ],
                {"row_start": 1, "row_end": 50},
            ),
        }

        for source_type, (locators, expected) in cases.items():
            with self.subTest(source_type=source_type):
                document, source_map, _records = build_artifacts(
                    [("第一单元。\n", locators[0]), ("第二单元。\n", locators[1])]
                )
                chunks = split_converted_document(document, source_map)

                self.assertEqual(len(chunks), 1)
                self.assertEqual(chunks[0].source_locator["type"], source_type)
                for key, value in expected.items():
                    self.assertEqual(chunks[0].source_locator[key], value)
                self.assertEqual(len(chunks[0].source_unit_ids), 2)
                self.assertEqual(len(chunks[0].source_locator["locators"]), 2)
                self.assertNotIn("source-unit", chunks[0].content)
                self.assertEqual(
                    chunks[0].to_dict()["source_unit_ids"],
                    list(chunks[0].source_unit_ids),
                )

    def test_chinese_utf8_offsets_and_markdown_heading_context_are_preserved(self):
        document, source_map, _records = build_artifacts(
            [
                (
                    "# 中文标题\n",
                    {
                        "type": "markdown",
                        "kind": "heading",
                        "line_start": 1,
                        "line_end": 1,
                    },
                ),
                (
                    "这是需要保留来源定位的正文。\n",
                    {
                        "type": "markdown",
                        "kind": "paragraph",
                        "line_start": 2,
                        "line_end": 2,
                    },
                ),
            ]
        )

        chunks = split_converted_document(document.decode("utf-8"), source_map)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(
            chunks[0].content, "# 中文标题\n\n这是需要保留来源定位的正文。"
        )
        self.assertEqual(chunks[0].source_unit_ids, (f"u_{1:032x}", f"u_{2:032x}"))
        self.assertEqual(chunks[0].source_locator["line_start"], 1)
        self.assertEqual(chunks[0].source_locator["line_end"], 2)

    def test_large_unit_uses_recursive_splitter_and_replicates_locator(self):
        locator = {"type": "pdf", "kind": "page_text", "page": 12, "block": 1}
        text = "长文本。" * 100
        document, source_map, _records = build_artifacts([(text, locator)])

        chunks = split_converted_document(
            document,
            source_map,
            chunk_size=80,
            chunk_overlap=10,
        )

        self.assertGreater(len(chunks), 1)
        self.assertTrue(
            all(chunk.source_unit_ids == (f"u_{1:032x}",) for chunk in chunks)
        )
        self.assertTrue(
            all(chunk.source_locator["page_start"] == 12 for chunk in chunks)
        )
        self.assertTrue(all("source-unit" not in chunk.content for chunk in chunks))

    def test_xlsx_units_merge_within_sheet_but_never_across_sheets(self):
        units = [
            (
                "A1\n",
                {
                    "type": "xlsx",
                    "kind": "table",
                    "sheet": "A",
                    "sheet_index": 1,
                    "row_start": 1,
                    "row_end": 10,
                },
            ),
            (
                "A2\n",
                {
                    "type": "xlsx",
                    "kind": "table",
                    "sheet": "A",
                    "sheet_index": 1,
                    "row_start": 11,
                    "row_end": 20,
                },
            ),
            (
                "B1\n",
                {
                    "type": "xlsx",
                    "kind": "table",
                    "sheet": "B",
                    "sheet_index": 2,
                    "row_start": 1,
                    "row_end": 5,
                },
            ),
        ]
        document, source_map, _records = build_artifacts(units)

        chunks = split_converted_document(document, source_map)

        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0].source_locator["sheet"], "A")
        self.assertEqual(chunks[0].source_locator["row_start"], 1)
        self.assertEqual(chunks[0].source_locator["row_end"], 20)
        self.assertEqual(chunks[1].source_locator["sheet"], "B")

    def test_marker_map_order_mismatch_is_rejected(self):
        document, _source_map, records = build_artifacts(
            [
                (
                    "one\n",
                    {
                        "type": "plaintext",
                        "kind": "paragraph",
                        "line_start": 1,
                        "line_end": 1,
                    },
                ),
                (
                    "two\n",
                    {
                        "type": "plaintext",
                        "kind": "paragraph",
                        "line_start": 2,
                        "line_end": 2,
                    },
                ),
            ]
        )

        with self.assertRaises(ConvertedIngestionError) as context:
            split_converted_document(
                document, compress_records(list(reversed(records)))
            )

        self.assertEqual(context.exception.code, "SOURCE_UNIT_ORDER_MISMATCH")

    def test_utf8_offset_inside_chinese_character_is_rejected(self):
        document, _source_map, records = build_artifacts(
            [
                (
                    "中文\n",
                    {
                        "type": "plaintext",
                        "kind": "paragraph",
                        "line_start": 1,
                        "line_end": 1,
                    },
                )
            ]
        )
        records[0]["markdown"]["byte_end"] = records[0]["markdown"]["byte_start"] + 1

        with self.assertRaises(ConvertedIngestionError) as context:
            split_converted_document(document, compress_records(records))

        self.assertEqual(context.exception.code, "SOURCE_MAP_OFFSET_INVALID_UTF8")

    def test_invalid_locator_and_corrupt_zstd_are_rejected(self):
        document, _source_map, records = build_artifacts(
            [
                (
                    "value\n",
                    {
                        "type": "xlsx",
                        "kind": "table",
                        "sheet_index": 1,
                        "row_start": 1,
                        "row_end": 2,
                    },
                )
            ]
        )
        with self.assertRaises(ConvertedIngestionError) as context:
            split_converted_document(document, compress_records(records))
        self.assertEqual(context.exception.code, "SOURCE_LOCATOR_INVALID")

        with self.assertRaises(ConvertedIngestionError) as context:
            split_converted_document(document, b"damaged-zstd")
        self.assertEqual(context.exception.code, "SOURCE_MAP_DECOMPRESSION_FAILED")


if __name__ == "__main__":
    unittest.main()
