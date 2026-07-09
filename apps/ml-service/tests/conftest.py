import os
import sys

# Add ml-service root directory to sys.path
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

# Inject mock environment variables before any application code is imported
os.environ["DATABASE_URL"] = "postgresql://postgres:password@localhost:5432/test"
os.environ["REDIS_URL"] = "redis://localhost:6379"
os.environ["MINIO_ENDPOINT"] = "localhost:9000"
os.environ["MINIO_ACCESS_KEY"] = "minioadmin"
os.environ["MINIO_SECRET_KEY"] = "minioadminpassword"
os.environ["MINIO_BUCKET"] = "proctor-flagged-frames"
