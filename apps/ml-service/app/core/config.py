from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # API Settings
    PORT: int = 8000
    ENVIRONMENT: str = "development"

    # Database Configuration
    DATABASE_URL: str

    # Redis Configuration
    REDIS_URL: str

    # MinIO (S3-compatible Object Storage) Configuration
    MINIO_ENDPOINT: str
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_BUCKET: str = "proctor-flagged-frames"

    # Model Configuration
    FACE_CONFIDENCE_THRESHOLD: float = 0.5

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

try:
    settings = Settings()
except Exception as e:
    import sys
    print(f"CRITICAL CONFIGURATION ERROR: Missing or invalid environment variables. Details: {e}", file=sys.stderr)
    sys.exit(1)
