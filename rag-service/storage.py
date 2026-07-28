from __future__ import annotations

import hashlib
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from config import settings

s3_client = boto3.client(
    "s3",
    endpoint_url=settings.s3_endpoint,
    aws_access_key_id=settings.s3_access_key,
    aws_secret_access_key=settings.s3_secret_key,
    region_name=settings.s3_region,
    config=Config(s3={"addressing_style": "path"}),
)


DERIVED_ARTIFACT_FILENAMES = {
    "document": "document.md",
    "source_map": "source-map.jsonl.zst",
    "manifest": "manifest.json",
}
_CONTENT_TYPES = {
    "document": "text/markdown; charset=utf-8",
    "source_map": "application/zstd",
    "manifest": "application/json",
}
_SAFE_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_NOT_FOUND_CODES = {"404", "NoSuchKey", "NotFound", "NoSuchObject"}
_PRECONDITION_CODES = {"409", "412", "ConditionalRequestConflict", "PreconditionFailed"}


class StorageError(RuntimeError):
    """A storage failure with a stable message that never exposes provider details."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ObjectIntegrity:
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class DerivedUploadResult:
    key: str
    integrity: ObjectIntegrity
    created: bool


def build_derived_artifact_key(
    user_id: str,
    file_id: str,
    generation_id: str,
    role: str,
) -> str:
    """Build a key whose path segments cannot escape the fixed derived prefix."""

    safe_user_id = _validated_identifier("user_id", user_id)
    safe_file_id = _validated_identifier("file_id", file_id)
    safe_generation_id = _validated_identifier("generation_id", generation_id)
    try:
        filename = DERIVED_ARTIFACT_FILENAMES[role]
    except (KeyError, TypeError) as error:
        raise StorageError("INVALID_ARTIFACT_ROLE", "derived artifact role is not supported") from error
    return (
        f"users/{safe_user_id}/files/{safe_file_id}/derived/"
        f"{safe_generation_id}/{filename}"
    )


def download_object(object_key: str) -> bytes:
    """Backward-compatible in-memory download API."""

    return b"".join(stream_object_bytes(object_key))


def stream_object_bytes(object_key: str, chunk_size: int = 1024 * 1024):
    if not isinstance(chunk_size, int) or chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer")
    try:
        response = s3_client.get_object(Bucket=settings.s3_bucket, Key=object_key)
        body = response["Body"]
    except (BotoCoreError, ClientError, KeyError, TypeError):
        raise StorageError("OBJECT_DOWNLOAD_FAILED", "object could not be downloaded") from None
    try:
        while True:
            try:
                chunk = body.read(chunk_size)
            except (BotoCoreError, ClientError, OSError):
                raise StorageError("OBJECT_DOWNLOAD_FAILED", "object could not be downloaded") from None
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise StorageError("OBJECT_DOWNLOAD_FAILED", "object returned invalid binary content")
            yield chunk
    finally:
        try:
            body.close()
        except (BotoCoreError, OSError):
            raise StorageError("OBJECT_DOWNLOAD_FAILED", "object stream could not be closed") from None


def download_object_to_file(
    object_key: str,
    destination: str | Path | BinaryIO,
    *,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
) -> ObjectIntegrity:
    """Stream an object to a caller-owned file or atomically to a destination path."""

    _validate_expected_integrity(expected_sha256, expected_size)
    if isinstance(destination, (str, Path)):
        return _download_object_to_path(
            object_key,
            Path(destination),
            expected_sha256=expected_sha256,
            expected_size=expected_size,
        )
    if not hasattr(destination, "write"):
        raise TypeError("destination must be a path or writable binary file")
    return _write_download_stream(
        object_key,
        destination,
        expected_sha256=expected_sha256,
        expected_size=expected_size,
    )


def _download_object_to_path(
    object_key: str,
    destination: Path,
    *,
    expected_sha256: str | None,
    expected_size: int | None,
) -> ObjectIntegrity:
    temporary_path: Path | None = None
    try:
        descriptor, raw_path = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".download",
            dir=destination.parent,
        )
        temporary_path = Path(raw_path)
        with os.fdopen(descriptor, "wb") as output:
            integrity = _write_download_stream(
                object_key,
                output,
                expected_sha256=expected_sha256,
                expected_size=expected_size,
            )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, destination)
        temporary_path = None
        return integrity
    except StorageError:
        raise
    except OSError as error:
        raise StorageError("DOWNLOAD_OUTPUT_FAILED", "download output could not be written") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def _write_download_stream(
    object_key: str,
    destination: BinaryIO,
    *,
    expected_sha256: str | None,
    expected_size: int | None,
) -> ObjectIntegrity:
    digest = hashlib.sha256()
    byte_size = 0
    try:
        for chunk in stream_object_bytes(object_key):
            destination.write(chunk)
            digest.update(chunk)
            byte_size += len(chunk)
    except StorageError:
        raise
    except (OSError, TypeError, ValueError) as error:
        raise StorageError("DOWNLOAD_OUTPUT_FAILED", "download output could not be written") from error
    integrity = ObjectIntegrity(digest.hexdigest(), byte_size)
    if expected_size is not None and integrity.byte_size != expected_size:
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "downloaded object failed integrity validation")
    if expected_sha256 is not None and integrity.sha256 != expected_sha256:
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "downloaded object failed integrity validation")
    return integrity


def upload_derived_artifact(
    source_path: str | Path,
    *,
    user_id: str,
    file_id: str,
    generation_id: str,
    role: str,
) -> DerivedUploadResult:
    """Create a derived object once, or accept a byte-identical retry."""

    key = build_derived_artifact_key(user_id, file_id, generation_id, role)
    source = Path(source_path)
    integrity = _hash_local_file(source)
    metadata = {
        "artifact-role": role,
        "sha256": integrity.sha256,
        "file-id": file_id,
        "generation-id": generation_id,
        "user-id": user_id,
    }

    existing = _head_object_or_none(key)
    if existing is not None:
        _validate_existing_object(existing, metadata, integrity)
        return DerivedUploadResult(key, integrity, False)

    try:
        with source.open("rb") as body:
            s3_client.put_object(
                Bucket=settings.s3_bucket,
                Key=key,
                Body=body,
                ContentLength=integrity.byte_size,
                ContentType=_CONTENT_TYPES[role],
                Metadata=metadata,
                IfNoneMatch="*",
            )
    except ClientError as error:
        if _client_error_code(error) in _PRECONDITION_CODES:
            raced = _head_object_or_none(key)
            if raced is not None:
                _validate_existing_object(raced, metadata, integrity)
                return DerivedUploadResult(key, integrity, False)
        raise StorageError("OBJECT_UPLOAD_FAILED", "derived artifact could not be uploaded") from None
    except (BotoCoreError, OSError):
        raise StorageError("OBJECT_UPLOAD_FAILED", "derived artifact could not be uploaded") from None

    head = _head_object_or_none(key)
    if head is None:
        raise StorageError("OBJECT_UPLOAD_VERIFICATION_FAILED", "uploaded artifact could not be verified")
    try:
        _validate_existing_object(head, metadata, integrity)
    except StorageError as error:
        try:
            delete_object_key(key)
        except StorageError:
            pass
        raise StorageError(
            "OBJECT_UPLOAD_VERIFICATION_FAILED",
            "uploaded artifact failed integrity validation",
        ) from error
    return DerivedUploadResult(key, integrity, True)


def upload_derived_artifacts(
    artifacts: Mapping[str, str | Path],
    *,
    user_id: str,
    file_id: str,
    generation_id: str,
) -> dict[str, DerivedUploadResult]:
    """Upload exactly one complete three-artifact generation with compensation."""

    if set(artifacts) != set(DERIVED_ARTIFACT_FILENAMES):
        raise StorageError(
            "INCOMPLETE_DERIVED_GENERATION",
            "derived generation must contain document, source_map, and manifest",
        )
    results: dict[str, DerivedUploadResult] = {}
    created_keys: list[str] = []
    try:
        for role in DERIVED_ARTIFACT_FILENAMES:
            result = upload_derived_artifact(
                artifacts[role],
                user_id=user_id,
                file_id=file_id,
                generation_id=generation_id,
                role=role,
            )
            results[role] = result
            if result.created:
                created_keys.append(result.key)
        return results
    except Exception:
        cleanup_object_keys(reversed(created_keys), suppress_errors=True)
        raise


def head_derived_artifact(
    *,
    user_id: str,
    file_id: str,
    generation_id: str,
    role: str,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
) -> ObjectIntegrity:
    _validate_expected_integrity(expected_sha256, expected_size)
    key = build_derived_artifact_key(user_id, file_id, generation_id, role)
    head = _head_object_or_none(key)
    if head is None:
        raise StorageError("OBJECT_NOT_FOUND", "derived artifact does not exist")
    metadata = _normalized_metadata(head)
    integrity = _integrity_from_head(head, metadata)
    expected_metadata = {
        "artifact-role": role,
        "file-id": file_id,
        "generation-id": generation_id,
        "user-id": user_id,
    }
    if any(metadata.get(key) != value for key, value in expected_metadata.items()):
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "derived artifact metadata is invalid")
    if expected_size is not None and integrity.byte_size != expected_size:
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "derived artifact size does not match")
    if expected_sha256 is not None and integrity.sha256 != expected_sha256:
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "derived artifact hash does not match")
    return integrity


def delete_object_key(object_key: str) -> None:
    if not isinstance(object_key, str) or not object_key or "\x00" in object_key:
        raise StorageError("INVALID_OBJECT_KEY", "object key is invalid")
    try:
        s3_client.delete_object(Bucket=settings.s3_bucket, Key=object_key)
    except (BotoCoreError, ClientError):
        raise StorageError("OBJECT_DELETE_FAILED", "object could not be deleted") from None


def cleanup_object_keys(object_keys, *, suppress_errors: bool = False) -> tuple[str, ...]:
    failed: list[str] = []
    for key in object_keys:
        try:
            delete_object_key(key)
        except StorageError:
            failed.append(key)
    if failed and not suppress_errors:
        raise StorageError("OBJECT_CLEANUP_FAILED", "one or more objects could not be deleted")
    return tuple(failed)


def _validated_identifier(name: str, value: str) -> str:
    if not isinstance(value, str) or not _SAFE_IDENTIFIER_RE.fullmatch(value) or value in {".", ".."}:
        raise StorageError("INVALID_STORAGE_IDENTIFIER", f"{name} is invalid")
    return value


def _validate_expected_integrity(expected_sha256: str | None, expected_size: int | None) -> None:
    if expected_sha256 is not None and not _SHA256_RE.fullmatch(expected_sha256):
        raise ValueError("expected_sha256 must be a lowercase SHA-256 digest")
    if expected_size is not None and (not isinstance(expected_size, int) or expected_size < 0):
        raise ValueError("expected_size must be a non-negative integer")


def _hash_local_file(path: Path) -> ObjectIntegrity:
    if path.is_symlink():
        raise StorageError("INVALID_UPLOAD_SOURCE", "upload source must be a regular file")
    digest = hashlib.sha256()
    byte_size = 0
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise StorageError("INVALID_UPLOAD_SOURCE", "upload source must be a regular file")
        with resolved.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                byte_size += len(chunk)
    except StorageError:
        raise
    except OSError as error:
        raise StorageError("UPLOAD_SOURCE_READ_FAILED", "upload source could not be read") from error
    return ObjectIntegrity(digest.hexdigest(), byte_size)


def _head_object_or_none(key: str) -> dict | None:
    try:
        return s3_client.head_object(Bucket=settings.s3_bucket, Key=key)
    except ClientError as error:
        if _client_error_code(error) in _NOT_FOUND_CODES:
            return None
        raise StorageError("OBJECT_HEAD_FAILED", "object metadata could not be read") from None
    except BotoCoreError:
        raise StorageError("OBJECT_HEAD_FAILED", "object metadata could not be read") from None


def _validate_existing_object(head: dict, metadata: Mapping[str, str], integrity: ObjectIntegrity) -> None:
    actual_metadata = _normalized_metadata(head)
    actual_integrity = _integrity_from_head(head, actual_metadata)
    if actual_integrity != integrity or any(
        actual_metadata.get(key) != value for key, value in metadata.items()
    ):
        raise StorageError(
            "DERIVED_OBJECT_CONFLICT",
            "derived artifact key already contains different content",
        )


def _normalized_metadata(head: Mapping) -> dict[str, str]:
    raw = head.get("Metadata", {})
    if not isinstance(raw, Mapping):
        return {}
    return {str(key).lower(): str(value) for key, value in raw.items()}


def _integrity_from_head(head: Mapping, metadata: Mapping[str, str]) -> ObjectIntegrity:
    sha256 = metadata.get("sha256", "")
    byte_size = head.get("ContentLength")
    if not _SHA256_RE.fullmatch(sha256) or not isinstance(byte_size, int) or byte_size < 0:
        raise StorageError("OBJECT_INTEGRITY_MISMATCH", "derived artifact metadata is invalid")
    return ObjectIntegrity(sha256, byte_size)


def _client_error_code(error: ClientError) -> str:
    try:
        return str(error.response.get("Error", {}).get("Code", ""))
    except (AttributeError, TypeError):
        return ""
