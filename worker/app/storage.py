from pathlib import Path

import boto3
from botocore.config import Config

from .config import Settings


class Storage:
    def __init__(self, settings: Settings):
        self.bucket = settings.r2_bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 5, "mode": "adaptive"},
                s3={"addressing_style": "path" if settings.r2_endpoint else "auto"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def download(self, key: str, dest: Path) -> Path:
        self._s3.download_file(self.bucket, key, str(dest))
        return dest

    def upload(self, src: Path, key: str, content_type: str, cache_control: str = "private, max-age=31536000, immutable") -> str:
        self._s3.upload_file(
            str(src), self.bucket, key, ExtraArgs={"ContentType": content_type, "CacheControl": cache_control}
        )
        return key

    def put_text(self, key: str, text: str, content_type: str) -> str:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=text.encode("utf-8"), ContentType=content_type)
        return key

    def delete(self, keys: list[str]) -> None:
        if keys:
            self._s3.delete_objects(Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True})
