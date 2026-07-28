import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import storage


def client_error(code: str, operation: str, message: str = "provider detail") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


class FakeS3Client:
    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.put_calls: list[str] = []
        self.delete_calls: list[str] = []
        self.fail_put_keys: set[str] = set()
        self.fail_get_keys: set[str] = set()
        self.fail_delete_keys: set[str] = set()

    def get_object(self, *, Bucket, Key):
        del Bucket
        if Key in self.fail_get_keys:
            raise client_error("AccessDenied", "GetObject", "secret-access-token")
        try:
            stored = self.objects[Key]
        except KeyError as error:
            raise client_error("NoSuchKey", "GetObject") from error
        return {"Body": io.BytesIO(stored["Body"])}

    def head_object(self, *, Bucket, Key):
        del Bucket
        try:
            stored = self.objects[Key]
        except KeyError as error:
            raise client_error("404", "HeadObject") from error
        return {
            "ContentLength": len(stored["Body"]),
            "ContentType": stored.get("ContentType"),
            "Metadata": dict(stored["Metadata"]),
        }

    def put_object(self, *, Bucket, Key, Body, ContentLength, ContentType, Metadata, IfNoneMatch):
        del Bucket
        self.put_calls.append(Key)
        if Key in self.fail_put_keys:
            raise client_error("InternalError", "PutObject", "secret-upload-token")
        if IfNoneMatch == "*" and Key in self.objects:
            raise client_error("PreconditionFailed", "PutObject")
        payload = Body.read()
        if len(payload) != ContentLength:
            raise AssertionError("test upload supplied the wrong content length")
        self.objects[Key] = {
            "Body": payload,
            "ContentType": ContentType,
            "Metadata": dict(Metadata),
        }
        return {"ETag": "ignored"}

    def delete_object(self, *, Bucket, Key):
        del Bucket
        self.delete_calls.append(Key)
        if Key in self.fail_delete_keys:
            raise client_error("InternalError", "DeleteObject", "secret-delete-token")
        self.objects.pop(Key, None)
        return {}


class DerivedStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.client = FakeS3Client()
        self.client_patch = patch.object(storage, "s3_client", self.client)
        self.client_patch.start()

    def tearDown(self):
        self.client_patch.stop()
        self.temporary_directory.cleanup()

    def write_artifact(self, name: str, content: bytes) -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_derived_key_builder_is_fixed_and_rejects_path_injection(self):
        self.assertEqual(
            storage.build_derived_artifact_key("user-1", "file_2", "gen.3", "source_map"),
            "users/user-1/files/file_2/derived/gen.3/source-map.jsonl.zst",
        )
        for field, values in (
            ("user", ("../user", "user/name", "", "用户")),
            ("file", ("..", "file\\name")),
            ("generation", (" generation", "generation/next")),
        ):
            for value in values:
                arguments = {"user_id": "user", "file_id": "file", "generation_id": "generation"}
                arguments[f"{field}_id"] = value
                with self.subTest(field=field, value=value):
                    with self.assertRaises(storage.StorageError) as context:
                        storage.build_derived_artifact_key(**arguments, role="document")
                    self.assertEqual(context.exception.code, "INVALID_STORAGE_IDENTIFIER")
        with self.assertRaises(storage.StorageError) as context:
            storage.build_derived_artifact_key("user", "file", "generation", "other")
        self.assertEqual(context.exception.code, "INVALID_ARTIFACT_ROLE")

    def test_streaming_download_supports_path_file_and_legacy_bytes_api(self):
        key = "raw/object"
        payload = (b"streamed-data-" * 1000) + b"tail"
        digest = hashlib.sha256(payload).hexdigest()
        self.client.objects[key] = {"Body": payload, "Metadata": {}}

        destination = self.root / "download.bin"
        integrity = storage.download_object_to_file(
            key,
            destination,
            expected_sha256=digest,
            expected_size=len(payload),
        )
        self.assertEqual(destination.read_bytes(), payload)
        self.assertEqual(integrity, storage.ObjectIntegrity(digest, len(payload)))

        output = io.BytesIO()
        self.assertEqual(storage.download_object_to_file(key, output), integrity)
        self.assertEqual(output.getvalue(), payload)
        self.assertEqual(storage.download_object(key), payload)

    def test_failed_download_does_not_replace_path_and_hides_provider_details(self):
        key = "raw/failure"
        self.client.fail_get_keys.add(key)
        destination = self.root / "preserved.bin"
        destination.write_bytes(b"existing")

        with self.assertRaises(storage.StorageError) as context:
            storage.download_object_to_file(key, destination)

        self.assertEqual(context.exception.code, "OBJECT_DOWNLOAD_FAILED")
        self.assertNotIn("secret-access-token", str(context.exception))
        self.assertEqual(destination.read_bytes(), b"existing")
        self.assertEqual(list(self.root.glob("*.download")), [])

    def test_upload_adds_integrity_metadata_and_identical_retry_is_idempotent(self):
        source = self.write_artifact("document.md", b"# deterministic\n")
        expected_hash = hashlib.sha256(source.read_bytes()).hexdigest()

        first = storage.upload_derived_artifact(
            source,
            user_id="user-1",
            file_id="file-1",
            generation_id="generation-1",
            role="document",
        )
        second = storage.upload_derived_artifact(
            source,
            user_id="user-1",
            file_id="file-1",
            generation_id="generation-1",
            role="document",
        )

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(first.integrity, storage.ObjectIntegrity(expected_hash, source.stat().st_size))
        self.assertEqual(self.client.put_calls, [first.key])
        self.assertEqual(
            self.client.objects[first.key]["Metadata"],
            {
                "artifact-role": "document",
                "sha256": expected_hash,
                "file-id": "file-1",
                "generation-id": "generation-1",
                "user-id": "user-1",
            },
        )
        self.assertEqual(
            storage.head_derived_artifact(
                user_id="user-1",
                file_id="file-1",
                generation_id="generation-1",
                role="document",
                expected_sha256=expected_hash,
                expected_size=source.stat().st_size,
            ),
            first.integrity,
        )

    def test_upload_never_overwrites_conflicting_existing_object(self):
        source = self.write_artifact("document.md", b"first")
        result = storage.upload_derived_artifact(
            source,
            user_id="user",
            file_id="file",
            generation_id="generation",
            role="document",
        )
        original = self.client.objects[result.key]["Body"]
        source.write_bytes(b"different")

        with self.assertRaises(storage.StorageError) as context:
            storage.upload_derived_artifact(
                source,
                user_id="user",
                file_id="file",
                generation_id="generation",
                role="document",
            )

        self.assertEqual(context.exception.code, "DERIVED_OBJECT_CONFLICT")
        self.assertEqual(self.client.objects[result.key]["Body"], original)
        self.assertEqual(self.client.put_calls, [result.key])

    def test_partial_generation_upload_cleans_only_objects_created_by_attempt(self):
        artifacts = {
            "document": self.write_artifact("document.md", b"document"),
            "source_map": self.write_artifact("source-map.jsonl.zst", b"map"),
            "manifest": self.write_artifact("manifest.json", b"manifest"),
        }
        source_map_key = storage.build_derived_artifact_key(
            "user", "file", "generation", "source_map"
        )
        document_key = storage.build_derived_artifact_key("user", "file", "generation", "document")
        self.client.fail_put_keys.add(source_map_key)

        with self.assertRaises(storage.StorageError) as context:
            storage.upload_derived_artifacts(
                artifacts,
                user_id="user",
                file_id="file",
                generation_id="generation",
            )

        self.assertEqual(context.exception.code, "OBJECT_UPLOAD_FAILED")
        self.assertNotIn(document_key, self.client.objects)
        self.assertIn(document_key, self.client.delete_calls)

        existing = storage.upload_derived_artifact(
            artifacts["document"],
            user_id="user",
            file_id="file",
            generation_id="generation-2",
            role="document",
        )
        second_map_key = storage.build_derived_artifact_key(
            "user", "file", "generation-2", "source_map"
        )
        self.client.fail_put_keys.add(second_map_key)
        with self.assertRaises(storage.StorageError):
            storage.upload_derived_artifacts(
                artifacts,
                user_id="user",
                file_id="file",
                generation_id="generation-2",
            )
        self.assertIn(existing.key, self.client.objects)

    def test_cleanup_attempts_every_key_and_reports_failure_without_provider_text(self):
        self.client.objects["one"] = {"Body": b"1", "Metadata": {}}
        self.client.objects["two"] = {"Body": b"2", "Metadata": {}}
        self.client.fail_delete_keys.add("one")

        with self.assertRaises(storage.StorageError) as context:
            storage.cleanup_object_keys(["one", "two"])

        self.assertEqual(context.exception.code, "OBJECT_CLEANUP_FAILED")
        self.assertNotIn("secret-delete-token", str(context.exception))
        self.assertEqual(self.client.delete_calls, ["one", "two"])
        self.assertIn("one", self.client.objects)
        self.assertNotIn("two", self.client.objects)


if __name__ == "__main__":
    unittest.main()
