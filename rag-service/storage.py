import os

import boto3
from botocore.config import Config
from dotenv import load_dotenv

load_dotenv()

S3_ENDPOINT = os.environ.get("S3_ENDPOINT")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY")
S3_BUCKET = os.environ.get("S3_BUCKET", "documents")

if not S3_ENDPOINT or not S3_ACCESS_KEY or not S3_SECRET_KEY:
    raise ValueError("S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY must be set")

s3_client = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    aws_access_key_id=S3_ACCESS_KEY,
    aws_secret_access_key=S3_SECRET_KEY,
    region_name=os.environ.get("S3_REGION", "us-east-1"),
    config=Config(s3={"addressing_style": "path"}),
)


def download_object(object_key: str) -> bytes:
    response = s3_client.get_object(Bucket=S3_BUCKET, Key=object_key)
    return response["Body"].read()
