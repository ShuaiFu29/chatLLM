import boto3
from botocore.config import Config
from config import settings

s3_client = boto3.client(
    "s3",
    endpoint_url=settings.s3_endpoint,
    aws_access_key_id=settings.s3_access_key,
    aws_secret_access_key=settings.s3_secret_key,
    region_name=settings.s3_region,
    config=Config(s3={"addressing_style": "path"}),
)


def download_object(object_key: str) -> bytes:
    response = s3_client.get_object(Bucket=settings.s3_bucket, Key=object_key)
    return response["Body"].read()


def stream_object_bytes(object_key: str, chunk_size: int = 1024 * 1024):
    response = s3_client.get_object(Bucket=settings.s3_bucket, Key=object_key)
    body = response["Body"]
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        body.close()
