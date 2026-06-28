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
