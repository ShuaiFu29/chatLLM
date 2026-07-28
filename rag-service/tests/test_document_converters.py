import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from converted_document import DocumentConversionError
from converters import ConversionLimits, convert_document, get_converter
from converters.markdown import MarkdownConverter
from converters.plaintext import PlainTextConverter
from source_map import iter_source_unit_ids, strip_source_unit_markers


def read_source_map(path: Path) -> list[dict]:
    with (
        path.open("rb") as raw,
        zstandard.ZstdDecompressor().stream_reader(raw) as reader,
    ):
        payload = reader.read().decode("utf-8")
    return [json.loads(line) for line in payload.splitlines()]


class DocumentConverterTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_markdown_conversion_is_deterministic_and_preserves_embeddable_text(self):
        source = self.root / "知识.md"
        source.write_bytes("\ufeff# 标题\r\n\r\n第一段。\r\n第二行。".encode("utf-8"))

        first = convert_document(source, self.root / "first")
        second = convert_document(source, self.root / "second")

        first_markdown = first.document.path.read_text(encoding="utf-8")
        self.assertEqual(strip_source_unit_markers(first_markdown), "# 标题\n\n第一段。\n第二行。\n")
        self.assertEqual(first.document.sha256, second.document.sha256)
        self.assertEqual(first.source_map.sha256, second.source_map.sha256)
        self.assertEqual(first.manifest_artifact.sha256, second.manifest_artifact.sha256)
        self.assertEqual(len(list(iter_source_unit_ids(first_markdown))), 2)

        manifest = json.loads(first.manifest_artifact.path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema_version"], "converted-document-v1")
        self.assertEqual(manifest["converter"], {"name": "markdown-local", "version": "1.0.0"})
        self.assertEqual(manifest["conversion_profile"], "markdown-v1")
        self.assertEqual(manifest["source"]["encoding"], "utf-8")
        self.assertEqual(manifest["unit_count"], 2)
        self.assertNotIn("created_at", manifest)

    def test_source_map_offsets_point_to_markdown_content_and_not_markers(self):
        source = self.root / "sample.md"
        source.write_text("# Heading\n\nParagraph with café.\n", encoding="utf-8")

        result = MarkdownConverter().convert(source, self.root / "derived")
        markdown_bytes = result.document.path.read_bytes()
        units = read_source_map(result.source_map.path)

        self.assertEqual(len(units), 2)
        extracted = []
        for unit in units:
            byte_range = unit["markdown"]
            extracted.append(
                markdown_bytes[byte_range["byte_start"] : byte_range["byte_end"]].decode("utf-8")
            )
            self.assertEqual(unit["schema_version"], "source-map-unit-v1")
            self.assertEqual(unit["source"]["type"], "markdown")
        self.assertEqual(extracted, ["# Heading\n", "Paragraph with café.\n"])
        self.assertEqual(units[0]["source"]["kind"], "heading")

    def test_fenced_code_with_blank_lines_stays_in_one_source_unit(self):
        source = self.root / "code.markdown"
        source.write_text("```python\nprint('a')\n\nprint('b')\n```\n", encoding="utf-8")

        result = convert_document(source, self.root / "derived")
        markdown = result.document.path.read_text(encoding="utf-8")
        units = read_source_map(result.source_map.path)

        self.assertEqual(strip_source_unit_markers(markdown), source.read_text(encoding="utf-8"))
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["source"]["kind"], "code")
        self.assertNotIn("source-unit", strip_source_unit_markers(markdown))

    def test_plain_text_utf8_and_gb18030_are_converted_locally(self):
        utf8_source = self.root / "utf8.txt"
        utf8_source.write_bytes("第一段\r\n\r\n第二段".encode())
        utf8_result = PlainTextConverter().convert(utf8_source, self.root / "utf8-derived")
        self.assertEqual(
            strip_source_unit_markers(utf8_result.document.path.read_text(encoding="utf-8")),
            "第一段\n\n第二段\n",
        )
        self.assertEqual(utf8_result.manifest.source_encoding, "utf-8")
        self.assertEqual(utf8_result.manifest.document_kind, "plaintext")
        self.assertEqual(utf8_result.manifest.conversion_profile, "plaintext-v1")

        gb_source = self.root / "gb18030.txt"
        expected = "这是一个用于知识库编码检测的中文段落。" * 20
        gb_source.write_bytes(expected.encode("gb18030"))
        gb_result = convert_document(gb_source, self.root / "gb-derived")
        self.assertEqual(
            strip_source_unit_markers(gb_result.document.path.read_text(encoding="utf-8")),
            expected + "\n",
        )
        self.assertNotEqual(gb_result.manifest.source_encoding, "utf-8")

    def test_utf16_bom_is_supported_and_binary_text_is_rejected(self):
        utf16_source = self.root / "utf16.txt"
        utf16_source.write_bytes("UTF-16 文本".encode("utf-16"))
        result = convert_document(utf16_source, self.root / "utf16-derived")
        self.assertEqual(
            strip_source_unit_markers(result.document.path.read_text(encoding="utf-8")),
            "UTF-16 文本\n",
        )
        self.assertEqual(result.manifest.source_encoding, "utf-16")

        binary_source = self.root / "binary.txt"
        binary_source.write_bytes(b"abc\x00def\x00ghi")
        with self.assertRaises(DocumentConversionError) as context:
            convert_document(binary_source, self.root / "binary-derived")
        self.assertEqual(context.exception.code, "TEXT_BINARY_CONTENT")

    def test_invalid_empty_oversized_and_unsupported_inputs_have_stable_codes(self):
        invalid_markdown = self.root / "invalid.md"
        invalid_markdown.write_bytes(b"valid prefix\n\xff")
        with self.assertRaises(DocumentConversionError) as context:
            convert_document(invalid_markdown, self.root / "invalid-derived")
        self.assertEqual(context.exception.code, "MARKDOWN_INVALID_UTF8")

        empty = self.root / "empty.txt"
        empty.write_bytes(b"")
        with self.assertRaises(DocumentConversionError) as context:
            convert_document(empty, self.root / "empty-derived")
        self.assertEqual(context.exception.code, "EMPTY_DOCUMENT")

        large = self.root / "large.txt"
        large.write_bytes(b"12345")
        with self.assertRaises(DocumentConversionError) as context:
            convert_document(
                large,
                self.root / "large-derived",
                ConversionLimits(max_source_bytes=4),
            )
        self.assertEqual(context.exception.code, "SOURCE_TOO_LARGE")

        unsupported = self.root / "document.rtf"
        unsupported.write_bytes(b"{\\rtf1}")
        with self.assertRaises(DocumentConversionError) as context:
            get_converter(unsupported)
        self.assertEqual(context.exception.code, "UNSUPPORTED_DOCUMENT_TYPE")

    def test_oversized_logical_unit_is_rejected_and_leaves_no_partial_outputs(self):
        source = self.root / "unit.md"
        source.write_text("a" * 20, encoding="utf-8")
        output = self.root / "derived"

        with self.assertRaises(DocumentConversionError) as context:
            convert_document(
                source,
                output,
                ConversionLimits(max_source_bytes=100, max_unit_chars=10),
            )

        self.assertEqual(context.exception.code, "SOURCE_UNIT_TOO_LARGE")
        self.assertFalse((output / "document.md").exists())
        self.assertFalse((output / "source-map.jsonl.zst").exists())
        self.assertFalse((output / "manifest.json").exists())
        self.assertEqual(list(output.glob("*.tmp")), [])

    def test_reserved_source_markers_are_rejected_even_inside_code(self):
        source = self.root / "reserved.md"
        source.write_text(
            "```html\n<!-- source-unit:u_0123456789abcdef0123456789abcdef -->\n```\n",
            encoding="utf-8",
        )

        with self.assertRaises(DocumentConversionError) as context:
            convert_document(source, self.root / "derived")

        self.assertEqual(context.exception.code, "RESERVED_SOURCE_MARKER")
        self.assertFalse((self.root / "derived" / "document.md").exists())

    def test_source_cannot_alias_a_conversion_output(self):
        output = self.root / "derived"
        output.mkdir()
        source = output / "document.md"
        source.write_text("do not overwrite", encoding="utf-8")

        with self.assertRaises(DocumentConversionError) as context:
            convert_document(source, output)

        self.assertEqual(context.exception.code, "UNSAFE_OUTPUT_PATH")
        self.assertEqual(source.read_text(encoding="utf-8"), "do not overwrite")

    def test_existing_generation_outputs_are_never_overwritten(self):
        source = self.root / "source.md"
        source.write_text("new content", encoding="utf-8")
        output = self.root / "derived"
        output.mkdir()
        existing = output / "manifest.json"
        existing.write_text("existing generation", encoding="utf-8")

        with self.assertRaises(DocumentConversionError) as context:
            convert_document(source, output)

        self.assertEqual(context.exception.code, "OUTPUT_ALREADY_EXISTS")
        self.assertEqual(existing.read_text(encoding="utf-8"), "existing generation")
        self.assertFalse((output / "document.md").exists())

    def test_artifact_hashes_and_sizes_match_files(self):
        source = self.root / "hashes.txt"
        source.write_text("hash me", encoding="utf-8")
        result = convert_document(source, self.root / "derived")

        for artifact in (result.document, result.source_map, result.manifest_artifact):
            content = artifact.path.read_bytes()
            self.assertEqual(artifact.byte_size, len(content))
            self.assertEqual(artifact.sha256, hashlib.sha256(content).hexdigest())

    def test_converter_registry_matches_shared_document_type_contract(self):
        contract = json.loads((ROOT.parent / "shared" / "document-types.json").read_text(encoding="utf-8"))

        for document_type in contract["documentTypes"]:
            for extension in document_type["extensions"]:
                converter = get_converter(self.root / f"sample.{extension.upper()}")
                self.assertEqual(converter.document_kind, document_type["documentKind"])
                self.assertEqual(converter.conversion_profile, document_type["conversionProfile"])


if __name__ == "__main__":
    unittest.main()
