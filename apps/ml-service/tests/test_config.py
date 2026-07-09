import os
import pytest
from pydantic import ValidationError
from app.core.config import Settings

def test_missing_env_vars_raises_error():
    # Temporarily remove a required env variable
    db_url = os.environ.pop("DATABASE_URL", None)
    try:
        # Re-evaluating Settings should raise ValidationError because DATABASE_URL is missing
        with pytest.raises(ValidationError):
            # We override env_file to bypass reading local .env during testing
            Settings(_env_file=None)
    finally:
        # Restore environment variable
        if db_url:
            os.environ["DATABASE_URL"] = db_url
